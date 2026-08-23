import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import {
	ADMIN_PRINCIPAL,
	AdminPermissionGuard,
	AdminRateLimitGuard,
	AdminSessionGuard,
	type AuthenticatedAdminHttpRequest,
} from "./admin.guards.js";
import type { AdminRepository, AdminSessionProof } from "./admin.repository.js";
import type { AdminCrypto } from "./admin-crypto.js";
import type { AdminProcessConfig } from "./admin-process-config.js";
import type { AdminRequestContextFactory } from "./admin-request-context.js";

const TOKEN = Buffer.alloc(32, 0x51).toString("base64url");
const PROOF: AdminSessionProof = Object.freeze({
	sessionTokenHash: "a".repeat(64),
	sessionTokenHashKeyVersion: "v1",
	requestIpHash: "b".repeat(64),
	deviceHash: "c".repeat(64),
	bindingHashKeyVersion: "v1",
});

function executionContext(
	request: AuthenticatedAdminHttpRequest,
	setHeader = vi.fn(),
): ExecutionContext {
	const handler = function adminHandler() {};
	class AdminControllerForTest {}
	return {
		getClass: () => AdminControllerForTest,
		getHandler: () => handler,
		switchToHttp: () => ({
			getRequest: () => request,
			getResponse: () => ({ setHeader }),
		}),
	} as unknown as ExecutionContext;
}

function enabledConfig(): AdminProcessConfig {
	return { admin: { enabled: true } } as AdminProcessConfig;
}

describe("administrator HTTP guards", () => {
	it("strictly rejects malformed and ordinary-user bearer values", async () => {
		const contexts = {
			sessionProofCandidates: vi.fn(() => [PROOF]),
		} as unknown as AdminRequestContextFactory;
		const repository = {
			isAvailable: vi.fn(() => true),
			authenticateSession: vi.fn(async () => null),
		} as unknown as AdminRepository;
		const guard = new AdminSessionGuard(enabledConfig(), contexts, repository);

		await expect(
			guard.canActivate(
				executionContext({
					headers: { authorization: `Bearer ${TOKEN} extra` },
				}),
			),
		).rejects.toMatchObject({ status: 401 });
		await expect(
			guard.canActivate(
				executionContext({ headers: { authorization: `Bearer ${TOKEN}` } }),
			),
		).rejects.toMatchObject({ status: 401 });
		expect(repository.authenticateSession).toHaveBeenCalledWith(PROOF);
	});

	it("fails unavailable on database faults and uses current database permissions only", async () => {
		const contexts = {
			sessionProofCandidates: vi.fn(() => [PROOF]),
		} as unknown as AdminRequestContextFactory;
		const repository = {
			isAvailable: vi.fn(() => true),
			authenticateSession: vi.fn(async () => {
				throw new Error("database unavailable at secret-host");
			}),
		} as unknown as AdminRepository;
		const guard = new AdminSessionGuard(enabledConfig(), contexts, repository);
		await expect(
			guard.canActivate(
				executionContext({ headers: { authorization: `Bearer ${TOKEN}` } }),
			),
		).rejects.toMatchObject({ status: 503 });

		repository.authenticateSession = vi.fn(async () => ({
			sessionId: "11111111-1111-4111-8111-111111111111",
			adminUserId: "22222222-2222-4222-8222-222222222222",
			permissionCodes: ["AUDIT_READ"],
			absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
		}));
		const request: AuthenticatedAdminHttpRequest = {
			headers: { authorization: `Bearer ${TOKEN}` },
		};
		await expect(guard.canActivate(executionContext(request))).resolves.toBe(
			true,
		);
		expect(request[ADMIN_PRINCIPAL]?.permissions).toEqual(["AUDIT_READ"]);
	});

	it("enforces endpoint permissions from the freshly authenticated principal", () => {
		const reflector = {
			getAllAndOverride: vi.fn(() => "AUDIT_READ"),
		} as unknown as Reflector;
		const guard = new AdminPermissionGuard(reflector);
		const request: AuthenticatedAdminHttpRequest = {
			headers: {},
			[ADMIN_PRINCIPAL]: {
				adminUserId: "22222222-2222-4222-8222-222222222222",
				sessionId: "11111111-1111-4111-8111-111111111111",
				sessionProof: PROOF,
				permissions: ["CREDENTIAL_SELF_MANAGE"],
				absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
			},
		};
		expect(() => guard.canActivate(executionContext(request))).toThrow(
			expect.objectContaining({ status: 403 }),
		);
		const principal = request[ADMIN_PRINCIPAL];
		if (principal === undefined) throw new Error("missing test principal");
		request[ADMIN_PRINCIPAL] = Object.freeze({
			...principal,
			permissions: ["AUDIT_READ"],
		});
		expect(guard.canActivate(executionContext(request))).toBe(true);
	});

	it("keeps only an IP HMAC in its independent in-memory rate bucket", () => {
		const reflector = {
			getAllAndOverride: vi.fn(() => ({ maximum: 1, windowMs: 60_000 })),
		} as unknown as Reflector;
		const crypto = {
			currentHash: vi.fn(() => ({ value: "d".repeat(64), keyVersion: "v1" })),
		} as unknown as AdminCrypto;
		const guard = new AdminRateLimitGuard(reflector, crypto);
		const setHeader = vi.fn();
		const request = { headers: {}, ip: "203.0.113.8" };
		expect(guard.canActivate(executionContext(request, setHeader))).toBe(true);
		expect(() =>
			guard.canActivate(executionContext(request, setHeader)),
		).toThrow(expect.objectContaining({ status: 429 }));
		expect(crypto.currentHash).toHaveBeenCalledWith(
			"REQUEST_IP",
			"203.0.113.8",
		);
		const buckets = (
			guard as unknown as { readonly buckets: ReadonlyMap<string, unknown> }
		).buckets;
		expect([...buckets.keys()].join("|")).not.toContain("203.0.113.8");
		expect([...buckets.keys()].join("|")).toContain("d".repeat(64));
		expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
	});
});
