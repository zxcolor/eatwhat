import type {
	AdminAuthenticationResponseJSON,
	AdminRegistrationResponseJSON,
} from "@chi-shen-me/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminProcessConfig } from "./admin-process-config.js";

const webauthnMocks = vi.hoisted(() => ({
	decodeClientDataJSON: vi.fn(),
	generateAuthenticationOptions: vi.fn(),
	generateRegistrationOptions: vi.fn(),
	verifyAuthenticationResponse: vi.fn(),
	verifyRegistrationResponse: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => ({
	generateAuthenticationOptions: webauthnMocks.generateAuthenticationOptions,
	generateRegistrationOptions: webauthnMocks.generateRegistrationOptions,
	verifyAuthenticationResponse: webauthnMocks.verifyAuthenticationResponse,
	verifyRegistrationResponse: webauthnMocks.verifyRegistrationResponse,
}));
vi.mock("@simplewebauthn/server/helpers", () => ({
	decodeClientDataJSON: webauthnMocks.decodeClientDataJSON,
}));

import {
	AdminWebAuthnAdapter,
	AdminWebAuthnVerificationError,
} from "./admin-webauthn.adapter.js";

const CHALLENGE = Buffer.alloc(32, 0x61).toString("base64url");
const CREDENTIAL_ID = Buffer.alloc(32, 0x62).toString("base64url");

function config(): AdminProcessConfig {
	return {
		nodeEnv: "test",
		port: 3_002,
		bindHost: "127.0.0.1",
		trustedProxyCidrs: [],
		admin: {
			enabled: true,
			database: {
				enabled: true,
				connectionString: "postgresql://unused:unused@unused:5432/unused",
				ssl: { rejectUnauthorized: true },
				poolMaximum: 1,
				connectionTimeoutMs: 500,
				idleTimeoutMs: 1_000,
			},
			webauthn: {
				rpName: "吃什么管理后台",
				rpId: "admin.example.cn",
				expectedOrigins: ["https://admin.example.cn"],
			},
			hmacKeys: [],
			credentialEncryptionKeys: [],
		},
	};
}

function assertion(): AdminAuthenticationResponseJSON {
	return {
		id: CREDENTIAL_ID,
		rawId: CREDENTIAL_ID,
		type: "public-key",
		response: {
			clientDataJSON: "Y2xpZW50",
			authenticatorData: "YXV0aGVudGljYXRvcg",
			signature: "c2lnbmF0dXJl",
			userHandle: null,
		},
		clientExtensionResults: {},
	};
}

function registration(): AdminRegistrationResponseJSON {
	return {
		id: CREDENTIAL_ID,
		rawId: CREDENTIAL_ID,
		type: "public-key",
		response: {
			clientDataJSON: "Y2xpZW50",
			attestationObject: "YXR0ZXN0YXRpb24",
			transports: ["internal"],
		},
		clientExtensionResults: {},
	};
}

describe("official administrator WebAuthn adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		webauthnMocks.generateAuthenticationOptions.mockResolvedValue({
			challenge: CHALLENGE,
			timeout: 300_000,
			rpId: "admin.example.cn",
			allowCredentials: [{ id: "must-not-be-exposed" }],
			userVerification: "required",
		});
		webauthnMocks.generateRegistrationOptions.mockResolvedValue({
			rp: { id: "admin.example.cn", name: "吃什么管理后台" },
			user: {
				id: Buffer.alloc(32, 0x63).toString("base64url"),
				name: "administrator-subject",
				displayName: "Administrator",
			},
			challenge: CHALLENGE,
			pubKeyCredParams: [{ alg: -7, type: "public-key" }],
			timeout: 300_000,
			excludeCredentials: [{ id: CREDENTIAL_ID, type: "public-key" }],
		});
	});

	it("always emits username-enumeration-safe discoverable login options", async () => {
		const adapter = new AdminWebAuthnAdapter(config());
		await expect(
			adapter.generateLoginOptions(CHALLENGE),
		).resolves.toMatchObject({
			challenge: CHALLENGE,
			rpId: "admin.example.cn",
			allowCredentials: [],
			userVerification: "required",
		});
		expect(webauthnMocks.generateAuthenticationOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				rpID: "admin.example.cn",
				userVerification: "required",
			}),
		);
	});

	it("requires a discoverable resident credential and user verification for enrollment", async () => {
		const adapter = new AdminWebAuthnAdapter(config());
		const subjectHandle = Buffer.alloc(32, 0x63).toString("base64url");
		const options = await adapter.generateEnrollmentOptions({
			subjectHandle,
			credentialIds: [CREDENTIAL_ID],
			challenge: CHALLENGE,
		});
		expect(options.authenticatorSelection).toEqual({
			residentKey: "required",
			userVerification: "required",
		});
		expect(webauthnMocks.generateRegistrationOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				rpID: "admin.example.cn",
				authenticatorSelection: {
					residentKey: "required",
					userVerification: "required",
				},
			}),
		);
	});

	it("uses the official verifier for exact origin, RP ID and UV, leaving counter enforcement to the DB", async () => {
		webauthnMocks.verifyAuthenticationResponse.mockResolvedValue({
			verified: true,
			authenticationInfo: {
				userVerified: true,
				newCounter: 9,
				origin: "https://admin.example.cn",
				rpID: "admin.example.cn",
			},
		});
		const adapter = new AdminWebAuthnAdapter(config());
		await expect(
			adapter.verifyAssertion({
				response: assertion(),
				expectedChallenge: CHALLENGE,
				publicKey: Uint8Array.from([1, 2, 3]),
			}),
		).resolves.toEqual({
			newCounter: 9,
			origin: "https://admin.example.cn",
			rpId: "admin.example.cn",
			userVerified: true,
		});
		expect(webauthnMocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedOrigin: ["https://admin.example.cn"],
				expectedRPID: "admin.example.cn",
				requireUserVerification: true,
				expectedType: "webauthn.get",
				credential: expect.objectContaining({ counter: 0 }),
			}),
		);
	});

	it("returns one generic verification error for origin, RP ID, UV and malformed client data failures", async () => {
		const adapter = new AdminWebAuthnAdapter(config());
		webauthnMocks.verifyAuthenticationResponse.mockRejectedValue(
			new Error("expected origin leaked detail"),
		);
		await expect(
			adapter.verifyAssertion({
				response: assertion(),
				expectedChallenge: CHALLENGE,
				publicKey: Uint8Array.from([1]),
			}),
		).rejects.toEqual(expect.any(AdminWebAuthnVerificationError));

		webauthnMocks.decodeClientDataJSON.mockImplementation(() => {
			throw new Error("raw clientData leak");
		});
		expect(() => adapter.extractAuthenticationChallenge(assertion())).toThrow(
			AdminWebAuthnVerificationError,
		);
	});

	it("accepts registration output only after official UV verification", async () => {
		webauthnMocks.verifyRegistrationResponse.mockResolvedValue({
			verified: true,
			registrationInfo: {
				userVerified: true,
				origin: "https://admin.example.cn",
				rpID: "admin.example.cn",
				credential: {
					id: CREDENTIAL_ID,
					publicKey: Uint8Array.from([4, 5, 6]),
					counter: 0,
				},
			},
		});
		const adapter = new AdminWebAuthnAdapter(config());
		await expect(
			adapter.verifyRegistration({
				response: registration(),
				expectedChallenge: CHALLENGE,
			}),
		).resolves.toMatchObject({
			credentialId: CREDENTIAL_ID,
			origin: "https://admin.example.cn",
			rpId: "admin.example.cn",
			userVerified: true,
		});
		expect(webauthnMocks.verifyRegistrationResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				requireUserPresence: true,
				requireUserVerification: true,
				expectedType: "webauthn.create",
			}),
		);
	});
});
