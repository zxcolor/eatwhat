import type {
	AdminAuthenticationOptions,
	AdminAuthenticationResponseJSON,
	AdminRegistrationResponseJSON,
} from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "./admin.guards.js";
import type { AdminRepository } from "./admin.repository.js";
import {
	AdminAuditService,
	AdminCredentialsService,
	AdminLoginService,
} from "./admin.services.js";
import type { AdminAuditCursorService } from "./admin-audit-cursor.js";
import type { AdminCrypto } from "./admin-crypto.js";
import type { AdminRequestContextFactory } from "./admin-request-context.js";
import {
	type AdminWebAuthnAdapter,
	AdminWebAuthnVerificationError,
} from "./admin-webauthn.adapter.js";

const CHALLENGE = Buffer.alloc(32, 0x61).toString("base64url");
const TOKEN = Buffer.alloc(32, 0x62).toString("base64url");
const CREDENTIAL_ID = Buffer.alloc(32, 0x63).toString("base64url");
const HASH = "a".repeat(64);

const BINDING = Object.freeze({
	requestIpHash: "b".repeat(64),
	deviceHash: "c".repeat(64),
	bindingHashKeyVersion: "v1",
});
const SESSION_PROOF = Object.freeze({
	sessionTokenHash: "d".repeat(64),
	sessionTokenHashKeyVersion: "v1",
	...BINDING,
});
const PRINCIPAL: AdminPrincipal = Object.freeze({
	adminUserId: "22222222-2222-4222-8222-222222222222",
	sessionId: "11111111-1111-4111-8111-111111111111",
	sessionProof: SESSION_PROOF,
	permissions: ["CREDENTIAL_SELF_MANAGE"],
	absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
});

const PUBLIC_KEY: AdminAuthenticationOptions = Object.freeze({
	challenge: CHALLENGE,
	timeout: 300_000,
	rpId: "admin.example.cn",
	allowCredentials: [],
	userVerification: "required",
});

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
		},
		clientExtensionResults: {},
	};
}

function cryptoMock(): AdminCrypto {
	return {
		issueOpaqueToken: vi
			.fn()
			.mockReturnValueOnce(CHALLENGE)
			.mockReturnValue(TOKEN),
		currentHash: vi.fn((purpose: string) => ({
			value: purpose === "CHALLENGE" ? HASH : "e".repeat(64),
			keyVersion: "v1",
		})),
		hashCandidates: vi.fn(() => [{ value: HASH, keyVersion: "v1" }]),
		verifyHash: vi.fn(() => true),
		encryptCredentialId: vi.fn(() => ({
			ciphertext: Buffer.from("ciphertext"),
			keyVersion: "e1",
		})),
		decryptCredentialId: vi.fn(() => CREDENTIAL_ID),
	} as unknown as AdminCrypto;
}

function contextMock(): AdminRequestContextFactory {
	return {
		current: vi.fn(() => ({
			deviceId: TOKEN,
			clientIp: "203.0.113.8",
			binding: BINDING,
		})),
	} as unknown as AdminRequestContextFactory;
}

function webauthnMock(): AdminWebAuthnAdapter {
	return {
		generateLoginOptions: vi.fn(async () => PUBLIC_KEY),
		extractAuthenticationChallenge: vi.fn(() => CHALLENGE),
		verifyAssertion: vi.fn(async () => ({
			newCounter: 2,
			origin: "https://admin.example.cn",
			rpId: "admin.example.cn",
			userVerified: true,
		})),
		extractRegistrationChallenge: vi.fn(() => CHALLENGE),
		verifyRegistration: vi.fn(async () => ({
			credentialId: CREDENTIAL_ID,
			publicKey: Uint8Array.from([1, 2, 3]),
			initialCounter: 0,
			origin: "https://admin.example.cn",
			rpId: "admin.example.cn",
			userVerified: true,
		})),
	} as unknown as AdminWebAuthnAdapter;
}

describe("administrator services", () => {
	it("returns the same discoverable login option shape for every login and persists only hashes", async () => {
		const beginLoginChallenge = vi.fn(async () => undefined);
		const repository = {
			isAvailable: vi.fn(() => true),
			beginLoginChallenge,
		} as unknown as AdminRepository;
		const crypto = cryptoMock();
		const service = new AdminLoginService(
			contextMock(),
			crypto,
			repository,
			webauthnMock(),
		);
		const known = await service.options(
			{ headers: {}, ip: "203.0.113.8" },
			{ login: "Known.Admin" },
		);
		const unknown = await service.options(
			{ headers: {}, ip: "203.0.113.8" },
			{ login: "unknown.admin" },
		);
		expect(known.publicKey.allowCredentials).toEqual([]);
		expect(unknown.publicKey.allowCredentials).toEqual([]);
		expect(Object.keys(known)).toEqual(Object.keys(unknown));
		expect(Object.keys(known.publicKey)).toEqual(
			Object.keys(unknown.publicKey),
		);
		const persisted = JSON.stringify(beginLoginChallenge.mock.calls);
		expect(persisted).not.toMatch(/Known\.Admin|unknown\.admin/iu);
		expect(persisted).not.toContain(CHALLENGE);
	});

	it("turns an atomic counter rollback into a locked response without issuing a token", async () => {
		const repository = {
			isAvailable: vi.fn(() => true),
			getAssertionCredential: vi.fn(async () => ({
				credentialId: "33333333-3333-4333-8333-333333333333",
				publicKey: Uint8Array.from([1]),
				signatureCounter: 5,
				counterMode: "SUPPORTED",
				rpIdHash: HASH,
				rpIdHashKeyVersion: "v1",
				originHash: HASH,
				originHashKeyVersion: "v1",
				userVerificationRequired: true,
			})),
			completeLoginAssertion: vi.fn(async () => ({
				securityStatus: "COUNTER_ROLLBACK",
				issuedSessionId: null,
				authenticatedAdminUserId: null,
			})),
		} as unknown as AdminRepository;
		const service = new AdminLoginService(
			contextMock(),
			cryptoMock(),
			repository,
			webauthnMock(),
		);
		await expect(
			service.verify(
				{ headers: {}, ip: "203.0.113.8" },
				{
					ceremonyId: "11111111-1111-4111-8111-111111111111",
					response: assertion(),
				},
			),
		).rejects.toMatchObject({ status: 423 });
		expect(repository.authenticateSession).toBeUndefined();
	});

	it("fails closed when recording a failed enrollment verification cannot reach the database", async () => {
		const repository = {
			getSelfEnrollCredentialOptions: vi.fn(async () => [
				{
					credentialIdCiphertext: Buffer.from("ciphertext"),
					credentialEncryptionKeyVersion: "e1",
				},
			]),
			failEnrollChallenge: vi.fn(async () => {
				throw new Error("secret database fault");
			}),
		} as unknown as AdminRepository;
		const webauthn = webauthnMock();
		webauthn.verifyRegistration = vi.fn(async () => {
			throw new AdminWebAuthnVerificationError();
		});
		const service = new AdminCredentialsService(
			cryptoMock(),
			repository,
			webauthn,
		);
		await expect(
			service.verify(PRINCIPAL, {
				ceremonyId: "11111111-1111-4111-8111-111111111111",
				response: registration(),
			}),
		).rejects.toMatchObject({ status: 503 });
	});

	it("uses a sentinel audit row so a full final page has no false next cursor", async () => {
		const listSanitizedAuditEvents = vi.fn();
		const repository = {
			listSanitizedAuditEvents,
		} as unknown as AdminRepository;
		const cursors = {
			resolve: vi.fn(() => null),
			issue: vi.fn(() => TOKEN),
		} as unknown as AdminAuditCursorService;
		const service = new AdminAuditService(repository, cursors);
		const row = (index: number) => ({
			eventId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			action: "ADMIN_LOGIN_SUCCEEDED",
			targetType: "ADMIN_USER",
			createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
		});
		listSanitizedAuditEvents.mockResolvedValueOnce(
			Array.from({ length: 100 }, (_, index) => row(index)),
		);
		const finalPage = await service.list(PRINCIPAL, { limit: 100 });
		expect(finalPage.items).toHaveLength(100);
		expect(finalPage.nextCursor).toBeNull();
		expect(listSanitizedAuditEvents).toHaveBeenLastCalledWith(
			expect.objectContaining({ pageSize: 101 }),
		);

		listSanitizedAuditEvents.mockResolvedValueOnce(
			Array.from({ length: 101 }, (_, index) => row(index)),
		);
		const continuingPage = await service.list(PRINCIPAL, { limit: 100 });
		expect(continuingPage.items).toHaveLength(100);
		expect(continuingPage.nextCursor).toBe(TOKEN);
	});
});
