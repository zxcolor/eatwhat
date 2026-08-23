import { randomUUID } from "node:crypto";
import {
	AdminAuditEventSchema,
	type AdminAuditPageResponse,
	type AdminAuditQuery,
	type AdminCredentialEnrollOptionsResponse,
	type AdminCredentialEnrollVerifyRequest,
	type AdminCredentialEnrollVerifyResponse,
	type AdminCredentialRecord,
	type AdminCredentialsResponse,
	type AdminCurrentSessionResponse,
	type AdminLoginOptionsRequest,
	type AdminLoginOptionsResponse,
	type AdminLoginVerifyRequest,
	type AdminLoginVerifyResponse,
	AdminPermissionCodeSchema,
} from "@chi-shen-me/contracts";
import { HttpException, Injectable } from "@nestjs/common";
import type { AdminPrincipal } from "./admin.guards.js";
import {
	type AdminChallengeProof,
	AdminRepository,
	type AdminSelfCredentialRecord,
	type AdminSessionProof,
} from "./admin.repository.js";
import { AdminAuditCursorService } from "./admin-audit-cursor.js";
import { AdminCrypto } from "./admin-crypto.js";
import { AdminDatabaseQueryError } from "./admin-database.pool.js";
import {
	adminAuthenticationFailed,
	adminCredentialConflict,
	adminCredentialNotFound,
	adminLastCredentialConflict,
	adminSecurityLocked,
	adminSessionInvalid,
	adminUnavailable,
} from "./admin-errors.js";
import {
	type AdminHttpRequest,
	AdminRequestContextFactory,
} from "./admin-request-context.js";
import {
	AdminWebAuthnAdapter,
	AdminWebAuthnVerificationError,
} from "./admin-webauthn.adapter.js";

const CEREMONY_LIFETIME_MS = 5 * 60 * 1_000;
const ADMIN_IDLE_SECONDS = 900 as const;
const OPTIONS_MINIMUM_DURATION_MS = 120;
const VERIFY_MINIMUM_FAILURE_DURATION_MS = 180;

function ceremonyExpiresAt(issuedAt: number): string {
	return new Date(issuedAt + CEREMONY_LIFETIME_MS).toISOString();
}

function toCredentialRecord(
	record: AdminSelfCredentialRecord,
): AdminCredentialRecord {
	return {
		credentialHandle: record.credentialHandle,
		createdAt: record.createdAt,
		lastUsedAt: record.lastUsedAt,
	};
}

function challengeProof(
	challengeId: string,
	challengeHash: { readonly value: string; readonly keyVersion: string },
	session: AdminSessionProof,
): AdminChallengeProof {
	return Object.freeze({
		challengeId,
		challengeHash: challengeHash.value,
		challengeHashKeyVersion: challengeHash.keyVersion,
		requestIpHash: session.requestIpHash,
		deviceHash: session.deviceHash,
		bindingHashKeyVersion: session.bindingHashKeyVersion,
	});
}

@Injectable()
export class AdminLoginService {
	constructor(
		private readonly contexts: AdminRequestContextFactory,
		private readonly crypto: AdminCrypto,
		private readonly repository: AdminRepository,
		private readonly webauthn: AdminWebAuthnAdapter,
	) {}

	async options(
		request: AdminHttpRequest,
		input: AdminLoginOptionsRequest,
	): Promise<AdminLoginOptionsResponse> {
		const startedAt = Date.now();
		this.requireAvailable();
		try {
			const context = this.contexts.current(request);
			const issuedAt = Date.now();
			const challengeId = randomUUID();
			const challenge = this.crypto.issueOpaqueToken();
			const login = input.login.normalize("NFKC").toLowerCase();
			const loginLookupCandidates = this.crypto.hashCandidates(
				"LOGIN_LOOKUP",
				login,
			);
			if (loginLookupCandidates.length === 0) throw adminUnavailable();
			const challengeHash = this.crypto.currentHash("CHALLENGE", challenge);
			await this.repository.beginLoginChallenge({
				challengeId,
				loginLookupCandidates,
				challengeHash: challengeHash.value,
				challengeHashKeyVersion: challengeHash.keyVersion,
				binding: context.binding,
			});
			const publicKey = await this.webauthn.generateLoginOptions(challenge);
			await this.equalize(startedAt, OPTIONS_MINIMUM_DURATION_MS);
			return {
				ceremonyId: challengeId,
				expiresAt: ceremonyExpiresAt(issuedAt),
				publicKey,
			};
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw adminUnavailable();
		}
	}

	async verify(
		request: AdminHttpRequest,
		input: AdminLoginVerifyRequest,
	): Promise<AdminLoginVerifyResponse> {
		const startedAt = Date.now();
		this.requireAvailable();
		let proof: AdminChallengeProof | null = null;
		try {
			const context = this.contexts.current(request);
			const challenge = this.webauthn.extractAuthenticationChallenge(
				input.response,
			);
			const challengeHash = this.crypto.currentHash("CHALLENGE", challenge);
			proof = Object.freeze({
				challengeId: input.ceremonyId,
				challengeHash: challengeHash.value,
				challengeHashKeyVersion: challengeHash.keyVersion,
				...context.binding,
			});

			let selected:
				| {
						readonly credential: NonNullable<
							Awaited<ReturnType<AdminRepository["getAssertionCredential"]>>
						>;
						readonly credentialHash: {
							readonly value: string;
							readonly keyVersion: string;
						};
				  }
				| undefined;
			for (const credentialHash of this.crypto.hashCandidates(
				"CREDENTIAL_ID",
				input.response.id,
			)) {
				const credential = await this.repository.getAssertionCredential(
					proof,
					credentialHash.value,
					credentialHash.keyVersion,
				);
				if (credential !== null) {
					selected = { credential, credentialHash };
					break;
				}
			}
			if (selected === undefined) {
				await this.recordFailedAttempt(proof);
				await this.equalize(startedAt, VERIFY_MINIMUM_FAILURE_DURATION_MS);
				throw adminAuthenticationFailed();
			}

			const verified = await this.webauthn.verifyAssertion({
				response: input.response,
				expectedChallenge: challenge,
				publicKey: selected.credential.publicKey,
			});
			const originHash = this.matchStoredHash(
				"ORIGIN",
				verified.origin,
				selected.credential.originHash,
				selected.credential.originHashKeyVersion,
			);
			const rpIdHash = this.matchStoredHash(
				"RP_ID",
				verified.rpId,
				selected.credential.rpIdHash,
				selected.credential.rpIdHashKeyVersion,
			);
			const rawSessionToken = this.crypto.issueOpaqueToken();
			const sessionTokenHash = this.crypto.currentHash(
				"SESSION_TOKEN",
				rawSessionToken,
			);
			const completion = await this.repository.completeLoginAssertion({
				proof,
				credentialIdHash: selected.credentialHash.value,
				credentialHashKeyVersion: selected.credentialHash.keyVersion,
				verifiedOriginHash: originHash.value,
				originHashKeyVersion: originHash.keyVersion,
				verifiedRpIdHash: rpIdHash.value,
				rpIdHashKeyVersion: rpIdHash.keyVersion,
				newSignatureCounter: verified.newCounter,
				sessionId: randomUUID(),
				sessionTokenHash: sessionTokenHash.value,
				sessionTokenHashKeyVersion: sessionTokenHash.keyVersion,
			});
			if (completion.securityStatus === "COUNTER_ROLLBACK") {
				throw adminSecurityLocked();
			}
			if (
				completion.securityStatus !== "SESSION_ISSUED" ||
				completion.issuedSessionId === null
			) {
				throw adminAuthenticationFailed();
			}
			const sessionProof: AdminSessionProof = Object.freeze({
				sessionTokenHash: sessionTokenHash.value,
				sessionTokenHashKeyVersion: sessionTokenHash.keyVersion,
				...context.binding,
			});
			const session = await this.repository.authenticateSession(sessionProof);
			if (session === null) throw adminUnavailable();
			const permissions = AdminPermissionCodeSchema.array()
				.max(9)
				.safeParse(session.permissionCodes);
			if (!permissions.success) {
				await this.repository.logoutSession(sessionProof).catch(() => false);
				throw adminUnavailable();
			}
			return {
				adminToken: rawSessionToken,
				tokenType: "Bearer",
				absoluteExpiresAt: session.absoluteExpiresAt,
				idleTimeoutSeconds: ADMIN_IDLE_SECONDS,
				permissions: permissions.data,
			};
		} catch (error) {
			if (error instanceof AdminWebAuthnVerificationError) {
				if (proof !== null) await this.recordFailedAttempt(proof);
				await this.equalize(startedAt, VERIFY_MINIMUM_FAILURE_DURATION_MS);
				throw adminAuthenticationFailed();
			}
			if (error instanceof HttpException) throw error;
			throw adminUnavailable();
		}
	}

	private requireAvailable(): void {
		if (!this.repository.isAvailable()) throw adminUnavailable();
	}

	private matchStoredHash(
		purpose: "ORIGIN" | "RP_ID",
		value: string,
		expected: string,
		version: string,
	): { readonly value: string; readonly keyVersion: string } {
		if (!this.crypto.verifyHash(purpose, value, expected, version)) {
			throw adminUnavailable();
		}
		const candidate = this.crypto
			.hashCandidates(purpose, value)
			.find((hash) => hash.keyVersion === version);
		if (candidate === undefined) throw adminUnavailable();
		return candidate;
	}

	private async recordFailedAttempt(proof: AdminChallengeProof): Promise<void> {
		try {
			await this.repository.failLoginChallenge(proof);
		} catch {
			throw adminUnavailable();
		}
	}

	private async equalize(startedAt: number, minimumMs: number): Promise<void> {
		const remaining = minimumMs - (Date.now() - startedAt);
		if (remaining > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, remaining));
		}
	}
}

@Injectable()
export class AdminSessionService {
	constructor(private readonly repository: AdminRepository) {}

	current(principal: AdminPrincipal): AdminCurrentSessionResponse {
		return {
			absoluteExpiresAt: principal.absoluteExpiresAt,
			idleTimeoutSeconds: ADMIN_IDLE_SECONDS,
			permissions: [...principal.permissions],
		};
	}

	async logout(principal: AdminPrincipal): Promise<void> {
		try {
			const loggedOut = await this.repository.logoutSession(
				principal.sessionProof,
			);
			if (!loggedOut) throw adminSessionInvalid();
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw adminUnavailable();
		}
	}
}

@Injectable()
export class AdminCredentialsService {
	constructor(
		private readonly crypto: AdminCrypto,
		private readonly repository: AdminRepository,
		private readonly webauthn: AdminWebAuthnAdapter,
	) {}

	async list(principal: AdminPrincipal): Promise<AdminCredentialsResponse> {
		try {
			const rows = await this.repository.listSelfCredentials(
				principal.sessionProof,
			);
			return { items: rows.map(toCredentialRecord) };
		} catch {
			throw adminUnavailable();
		}
	}

	async options(
		principal: AdminPrincipal,
	): Promise<AdminCredentialEnrollOptionsResponse> {
		try {
			const issuedAt = Date.now();
			const challengeId = randomUUID();
			const challenge = this.crypto.issueOpaqueToken();
			const hash = this.crypto.currentHash("CHALLENGE", challenge);
			const began = await this.repository.beginEnrollChallenge({
				session: principal.sessionProof,
				challengeId,
				challengeHash: hash.value,
				challengeHashKeyVersion: hash.keyVersion,
			});
			if (!began) throw adminSessionInvalid();
			const proof = challengeProof(challengeId, hash, principal.sessionProof);
			const encrypted = await this.repository.getSelfEnrollCredentialOptions({
				session: principal.sessionProof,
				challenge: proof,
			});
			if (encrypted.length === 0) throw adminUnavailable();
			const credentialIds = encrypted.map((credential) =>
				this.crypto.decryptCredentialId(
					credential.credentialIdCiphertext,
					credential.credentialEncryptionKeyVersion,
				),
			);
			const subjectHandle = Buffer.from(
				this.crypto.currentHash("SUBJECT", principal.adminUserId).value,
				"hex",
			).toString("base64url");
			return {
				ceremonyId: challengeId,
				expiresAt: ceremonyExpiresAt(issuedAt),
				publicKey: await this.webauthn.generateEnrollmentOptions({
					subjectHandle,
					credentialIds,
					challenge,
				}),
			};
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw adminUnavailable();
		}
	}

	async verify(
		principal: AdminPrincipal,
		input: AdminCredentialEnrollVerifyRequest,
	): Promise<AdminCredentialEnrollVerifyResponse> {
		let proof: AdminChallengeProof | null = null;
		try {
			const challenge = this.webauthn.extractRegistrationChallenge(
				input.response,
			);
			const hash = this.crypto.currentHash("CHALLENGE", challenge);
			proof = challengeProof(input.ceremonyId, hash, principal.sessionProof);
			const activeCredentials =
				await this.repository.getSelfEnrollCredentialOptions({
					session: principal.sessionProof,
					challenge: proof,
				});
			if (activeCredentials.length === 0) {
				throw adminAuthenticationFailed();
			}
			const verified = await this.webauthn.verifyRegistration({
				response: input.response,
				expectedChallenge: challenge,
			});
			const credentialHash = this.crypto.currentHash(
				"CREDENTIAL_ID",
				verified.credentialId,
			);
			const encrypted = this.crypto.encryptCredentialId(verified.credentialId);
			const originHash = this.crypto.currentHash("ORIGIN", verified.origin);
			const rpIdHash = this.crypto.currentHash("RP_ID", verified.rpId);
			const internalCredentialId = randomUUID();
			const status = await this.repository.completeCredentialEnrollment({
				proof,
				credentialId: internalCredentialId,
				credentialIdHash: credentialHash.value,
				credentialHashKeyVersion: credentialHash.keyVersion,
				credentialIdCiphertext: encrypted.ciphertext,
				credentialEncryptionKeyVersion: encrypted.keyVersion,
				publicKey: verified.publicKey,
				verifiedOriginHash: originHash.value,
				originHashKeyVersion: originHash.keyVersion,
				verifiedRpIdHash: rpIdHash.value,
				rpIdHashKeyVersion: rpIdHash.keyVersion,
				initialSignatureCounter: verified.initialCounter,
			});
			if (status === "CREDENTIAL_CONFLICT") {
				throw adminCredentialConflict();
			}
			if (status !== "ENROLLED") throw adminAuthenticationFailed();
			const record = await this.repository.getSelfCredentialRecord(
				principal.sessionProof,
				internalCredentialId,
			);
			if (record === null) throw adminUnavailable();
			return { credential: toCredentialRecord(record) };
		} catch (error) {
			if (
				error instanceof AdminDatabaseQueryError &&
				error.databaseCode === "23514" &&
				error.constraint === "admin_active_credential_limit"
			) {
				throw adminCredentialConflict();
			}
			if (error instanceof AdminWebAuthnVerificationError) {
				if (proof !== null) {
					try {
						await this.repository.failEnrollChallenge(proof);
					} catch {
						throw adminUnavailable();
					}
				}
				throw adminAuthenticationFailed();
			}
			if (error instanceof HttpException) throw error;
			throw adminUnavailable();
		}
	}

	async revoke(
		principal: AdminPrincipal,
		credentialHandle: string,
	): Promise<void> {
		try {
			const status = await this.repository.revokeSelfCredential(
				principal.sessionProof,
				credentialHandle,
			);
			switch (status) {
				case "REVOKED":
				case "REVOKED_ALREADY":
					return;
				case "LAST_ACTIVE_CREDENTIAL":
					throw adminLastCredentialConflict();
				case "NOT_FOUND":
					throw adminCredentialNotFound();
				case "UNAUTHORIZED":
					throw adminSessionInvalid();
				default:
					throw adminUnavailable();
			}
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw adminUnavailable();
		}
	}
}

@Injectable()
export class AdminAuditService {
	constructor(
		private readonly repository: AdminRepository,
		private readonly cursors: AdminAuditCursorService,
	) {}

	async list(
		principal: AdminPrincipal,
		query: AdminAuditQuery,
	): Promise<AdminAuditPageResponse> {
		const boundary = this.cursors.resolve(query.cursor, principal.adminUserId);
		try {
			const requested = query.limit + 1;
			const rows = await this.repository.listSanitizedAuditEvents({
				session: principal.sessionProof,
				beforeCreatedAt: boundary?.beforeCreatedAt ?? null,
				beforeEventId: boundary?.beforeEventId ?? null,
				pageSize: requested,
			});
			const retained = rows.slice(0, query.limit);
			const items = retained.map((row) => {
				const parsed = AdminAuditEventSchema.safeParse({
					auditEventId: row.eventId,
					action: row.action,
					targetType: row.targetType,
					occurredAt: row.createdAt,
				});
				if (!parsed.success) throw new Error("invalid audit event");
				return parsed.data;
			});
			const last = retained.at(-1);
			const hasNext = rows.length > query.limit;
			return {
				items,
				nextCursor:
					hasNext && last !== undefined
						? this.cursors.issue(
								principal.adminUserId,
								last.createdAt,
								last.eventId,
							)
						: null,
			};
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw adminUnavailable();
		}
	}
}
