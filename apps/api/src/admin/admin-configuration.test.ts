import type { AdminConfigVersion } from "@chi-shen-me/contracts";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "./admin.guards.js";
import type { AdminRepository } from "./admin.repository.js";
import { AdminConfigurationService } from "./admin.services.js";

const SESSION_PROOF = Object.freeze({
	sessionTokenHash: "a".repeat(64),
	sessionTokenHashKeyVersion: "v1",
	requestIpHash: "b".repeat(64),
	deviceHash: "c".repeat(64),
	bindingHashKeyVersion: "v1",
});

const PRINCIPAL: AdminPrincipal = Object.freeze({
	adminUserId: "22222222-2222-4222-8222-222222222222",
	sessionId: "11111111-1111-4111-8111-111111111111",
	sessionProof: SESSION_PROOF,
	permissions: ["ALGORITHM_CONFIG_READ", "ALGORITHM_CONFIG_WRITE"],
	absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
});

const ACTIVE_RECORD: AdminConfigVersion = Object.freeze({
	configKey: "features.ai-assistance",
	configSchema: "FEATURE_FLAGS_V1",
	classification: "PUBLIC",
	version: 3,
	value: { enabled: true },
	changeReason: "ROUTINE_TUNING",
	createdAt: "2026-08-30T00:00:00.000Z",
	activatedAt: "2026-08-30T00:00:00.000Z",
});

function repositoryMock(
	overrides: Partial<AdminRepository> = {},
): AdminRepository {
	return {
		listActiveConfiguration: vi.fn().mockResolvedValue([ACTIVE_RECORD]),
		listConfigurationHistory: vi.fn().mockResolvedValue([ACTIVE_RECORD]),
		publishConfiguration: vi.fn().mockResolvedValue({
			status: "PUBLISHED",
			record: ACTIVE_RECORD,
		}),
		rollbackConfiguration: vi.fn().mockResolvedValue({
			status: "ROLLED_BACK",
			record: { ...ACTIVE_RECORD, version: 4, changeReason: "ROLLBACK" },
		}),
		...overrides,
	} as unknown as AdminRepository;
}

function status(error: unknown): number | undefined {
	return error instanceof HttpException ? error.getStatus() : undefined;
}

describe("administrator configuration service", () => {
	it("maps the atomic release-safety gate on both publish and rollback", async () => {
		const rejected = { status: "CLIENT_RELEASE_UNVERIFIED", record: null };
		const repository = repositoryMock({
			publishConfiguration: vi.fn().mockResolvedValue(rejected),
			rollbackConfiguration: vi.fn().mockResolvedValue(rejected),
		});
		const service = new AdminConfigurationService(repository);
		await expect(
			service.publish(PRINCIPAL, "clients.minimum-version", {
				expectedActiveVersion: null,
				changeReason: "RELEASE_COMPATIBILITY",
				value: { android: "0.1.4" },
			}),
		).rejects.toMatchObject({
			status: 409,
			response: { code: "CLIENT_RELEASE_UNVERIFIED" },
		});
		await expect(
			service.rollback(PRINCIPAL, "clients.minimum-version", {
				expectedActiveVersion: 2,
				targetVersion: 1,
				changeReason: "ROLLBACK",
			}),
		).rejects.toMatchObject({
			status: 409,
			response: { code: "CLIENT_RELEASE_UNVERIFIED" },
		});
	});
	it("returns strictly parsed active and historical versions", async () => {
		const repository = repositoryMock();
		const service = new AdminConfigurationService(repository);

		await expect(service.list(PRINCIPAL)).resolves.toEqual({
			items: [ACTIVE_RECORD],
		});
		await expect(
			service.history(PRINCIPAL, "features.ai-assistance", { limit: 20 }),
		).resolves.toEqual({ items: [ACTIVE_RECORD] });
		expect(repository.listConfigurationHistory).toHaveBeenCalledWith({
			session: SESSION_PROOF,
			configKey: "features.ai-assistance",
			pageSize: 20,
		});
	});

	it("rejects a value that belongs to a different fixed key before SQL", async () => {
		const repository = repositoryMock();
		const service = new AdminConfigurationService(repository);
		let caught: unknown;
		try {
			await service.publish(PRINCIPAL, "coverage.default", {
				expectedActiveVersion: 3,
				changeReason: "ROUTINE_TUNING",
				value: { enabled: false },
			});
		} catch (error) {
			caught = error;
		}
		expect(status(caught)).toBe(400);
		expect(repository.publishConfiguration).not.toHaveBeenCalled();
	});

	it("rejects an unregistered model before SQL", async () => {
		const repository = repositoryMock();
		const service = new AdminConfigurationService(repository);
		await expect(
			service.publish(PRINCIPAL, "recommendations.prompt", {
				expectedActiveVersion: 3,
				changeReason: "ROUTINE_TUNING",
				value: {
					enabled: true,
					promptVersion: "intent-prompt-v1",
					modelVersion: "unregistered-model",
					timeoutMs: 1_800,
				},
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(repository.publishConfiguration).not.toHaveBeenCalled();
	});

	it("maps optimistic conflicts and missing rollback targets without leaking SQL", async () => {
		const conflictService = new AdminConfigurationService(
			repositoryMock({
				publishConfiguration: vi.fn().mockResolvedValue({
					status: "VERSION_CONFLICT",
					record: null,
				}),
			}),
		);
		await expect(
			conflictService.publish(PRINCIPAL, "features.ai-assistance", {
				expectedActiveVersion: 2,
				changeReason: "INCIDENT_RESPONSE",
				value: { enabled: false },
			}),
		).rejects.toMatchObject({ status: 409 });

		const missingService = new AdminConfigurationService(
			repositoryMock({
				rollbackConfiguration: vi.fn().mockResolvedValue({
					status: "TARGET_NOT_FOUND",
					record: null,
				}),
			}),
		);
		await expect(
			missingService.rollback(PRINCIPAL, "features.ai-assistance", {
				expectedActiveVersion: 3,
				targetVersion: 1,
				changeReason: "ROLLBACK",
			}),
		).rejects.toMatchObject({ status: 404 });
	});

	it("publishes and rolls back only the minimal public record", async () => {
		const service = new AdminConfigurationService(repositoryMock());
		await expect(
			service.publish(PRINCIPAL, "features.ai-assistance", {
				expectedActiveVersion: 2,
				changeReason: "RELEASE_COMPATIBILITY",
				value: { enabled: true },
			}),
		).resolves.toEqual(ACTIVE_RECORD);
		await expect(
			service.rollback(PRINCIPAL, "features.ai-assistance", {
				expectedActiveVersion: 3,
				targetVersion: 1,
				changeReason: "ROLLBACK",
			}),
		).resolves.toEqual({
			...ACTIVE_RECORD,
			version: 4,
			changeReason: "ROLLBACK",
		});
	});
});
