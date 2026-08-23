import type {
	AdminAuthenticationOptions,
	AdminAuthenticationResponseJSON,
	AdminRegistrationOptions,
	AdminRegistrationResponseJSON,
} from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import {
	type AuthenticationResponseJSON,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import {
	ADMIN_PROCESS_CONFIG,
	type AdminProcessConfig,
} from "./admin-process-config.js";

export interface VerifiedAdminAssertion {
	readonly newCounter: number;
	readonly origin: string;
	readonly rpId: string;
	readonly userVerified: true;
}

export interface VerifiedAdminRegistration {
	readonly credentialId: string;
	readonly publicKey: Uint8Array;
	readonly initialCounter: number;
	readonly origin: string;
	readonly rpId: string;
	readonly userVerified: true;
}

export class AdminWebAuthnVerificationError extends Error {
	constructor() {
		super("管理员 WebAuthn 验证失败");
		this.name = "AdminWebAuthnVerificationError";
	}
}

const CEREMONY_TIMEOUT_MS = 5 * 60 * 1_000;

@Injectable()
export class AdminWebAuthnAdapter {
	constructor(
		@Inject(ADMIN_PROCESS_CONFIG) private readonly config: AdminProcessConfig,
	) {}

	async generateLoginOptions(
		challenge: string,
	): Promise<AdminAuthenticationOptions> {
		const rpId = this.requiredRpId();
		const options = await generateAuthenticationOptions({
			rpID: rpId,
			challenge: Buffer.from(challenge, "base64url"),
			timeout: CEREMONY_TIMEOUT_MS,
			userVerification: "required",
		});
		if (options.challenge !== challenge) {
			throw new Error("管理员 WebAuthn challenge 编码不一致");
		}
		return Object.freeze({
			challenge: options.challenge,
			timeout: options.timeout ?? CEREMONY_TIMEOUT_MS,
			rpId: options.rpId ?? rpId,
			allowCredentials: [],
			userVerification: "required",
		});
	}

	async generateEnrollmentOptions(input: {
		readonly subjectHandle: string;
		readonly credentialIds: readonly string[];
		readonly challenge: string;
	}): Promise<AdminRegistrationOptions> {
		const rpId = this.requiredRpId();
		const rpName = this.config.admin.webauthn.rpName;
		if (rpName === null) throw new Error("管理员 WebAuthn 配置不可用");
		const userName = `administrator-${input.subjectHandle.slice(0, 12)}`;
		const options = await generateRegistrationOptions({
			rpName,
			rpID: rpId,
			userID: Buffer.from(input.subjectHandle, "base64url"),
			userName,
			userDisplayName: "Administrator",
			challenge: Buffer.from(input.challenge, "base64url"),
			timeout: CEREMONY_TIMEOUT_MS,
			attestationType: "none",
			excludeCredentials: input.credentialIds
				.slice(0, 20)
				.map((id) => ({ id })),
			authenticatorSelection: {
				residentKey: "required",
				userVerification: "required",
			},
		});
		if (options.challenge !== input.challenge) {
			throw new Error("管理员 WebAuthn challenge 编码不一致");
		}
		return Object.freeze({
			rp: Object.freeze({ id: rpId, name: rpName }),
			user: Object.freeze({
				id: options.user.id,
				name: options.user.name,
				displayName: options.user.displayName,
			}),
			challenge: options.challenge,
			pubKeyCredParams: options.pubKeyCredParams.map((parameter) => ({
				alg: parameter.alg,
				type: "public-key" as const,
			})),
			timeout: options.timeout ?? CEREMONY_TIMEOUT_MS,
			excludeCredentials: (options.excludeCredentials ?? []).map(
				(credential) => ({ id: credential.id, type: "public-key" as const }),
			),
			authenticatorSelection: Object.freeze({
				residentKey: "required" as const,
				userVerification: "required" as const,
			}),
			attestation: "none",
		});
	}

	extractAuthenticationChallenge(
		response: AdminAuthenticationResponseJSON,
	): string {
		return this.extractChallenge(response.response.clientDataJSON);
	}

	extractRegistrationChallenge(
		response: AdminRegistrationResponseJSON,
	): string {
		return this.extractChallenge(response.response.clientDataJSON);
	}

	async verifyAssertion(input: {
		readonly response: AdminAuthenticationResponseJSON;
		readonly expectedChallenge: string;
		readonly publicKey: Uint8Array;
	}): Promise<VerifiedAdminAssertion> {
		try {
			const verification = await verifyAuthenticationResponse({
				response: input.response as AuthenticationResponseJSON,
				expectedChallenge: input.expectedChallenge,
				expectedOrigin: [...this.config.admin.webauthn.expectedOrigins],
				expectedRPID: this.requiredRpId(),
				credential: {
					id: input.response.id,
					publicKey: Uint8Array.from(input.publicKey),
					// Counter comparison is intentionally delegated to the atomic 0003
					// completion function after this signature verification. Passing the
					// stored counter here would make the library throw before verifying the
					// signature, preventing a safe counter-rollback lock decision.
					counter: 0,
				},
				requireUserVerification: true,
				expectedType: "webauthn.get",
			});
			if (
				!verification.verified ||
				verification.authenticationInfo.userVerified !== true
			) {
				throw new AdminWebAuthnVerificationError();
			}
			return Object.freeze({
				newCounter: verification.authenticationInfo.newCounter,
				origin: verification.authenticationInfo.origin,
				rpId: verification.authenticationInfo.rpID,
				userVerified: true,
			});
		} catch {
			throw new AdminWebAuthnVerificationError();
		}
	}

	async verifyRegistration(input: {
		readonly response: AdminRegistrationResponseJSON;
		readonly expectedChallenge: string;
	}): Promise<VerifiedAdminRegistration> {
		try {
			const verification = await verifyRegistrationResponse({
				response: input.response as RegistrationResponseJSON,
				expectedChallenge: input.expectedChallenge,
				expectedOrigin: [...this.config.admin.webauthn.expectedOrigins],
				expectedRPID: this.requiredRpId(),
				expectedType: "webauthn.create",
				requireUserPresence: true,
				requireUserVerification: true,
			});
			if (
				!verification.verified ||
				verification.registrationInfo.userVerified !== true ||
				typeof verification.registrationInfo.rpID !== "string"
			) {
				throw new AdminWebAuthnVerificationError();
			}
			const credential = verification.registrationInfo.credential;
			return Object.freeze({
				credentialId: credential.id,
				publicKey: credential.publicKey,
				initialCounter: credential.counter,
				origin: verification.registrationInfo.origin,
				rpId: verification.registrationInfo.rpID,
				userVerified: true,
			});
		} catch {
			throw new AdminWebAuthnVerificationError();
		}
	}

	private extractChallenge(clientDataJson: string): string {
		try {
			const decoded = decodeClientDataJSON(clientDataJson);
			if (!/^[A-Za-z0-9_-]{32,128}$/u.test(decoded.challenge)) {
				throw new Error("invalid challenge");
			}
			return decoded.challenge;
		} catch {
			throw new AdminWebAuthnVerificationError();
		}
	}

	private requiredRpId(): string {
		const rpId = this.config.admin.webauthn.rpId;
		if (rpId === null) throw new Error("管理员 WebAuthn 配置不可用");
		return rpId;
	}
}
