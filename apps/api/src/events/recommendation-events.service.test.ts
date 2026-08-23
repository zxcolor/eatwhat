import type { RecommendationEvent } from "@chi-shen-me/contracts";
import { UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import type { HistoryPersistenceWriter } from "../history/history.service.js";
import type { PersistenceUserService } from "../persistence/persistence-user.service.js";
import { RecommendationEventsService } from "./recommendation-events.service.js";

const NOW = new Date("2026-08-21T04:00:00.000Z");
const REQUEST_ID = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
const registries: RecommendationRequestRegistry[] = [];

function scenario() {
	const registry = new RecommendationRequestRegistry();
	registries.push(registry);
	const token = registry.issue(
		REQUEST_ID,
		[{ provider: "AMAP", providerPlaceId: "private-amap-id" }],
		"LUNCH",
	)[0];
	if (token === undefined) throw new Error("missing result token");
	const event: RecommendationEvent = {
		requestId: REQUEST_ID,
		resultToken: token,
		type: "DETAIL",
		occurredAt: NOW.toISOString(),
	};
	const users = {
		resolve: vi.fn().mockResolvedValue({
			userId: "3bf305ae-82a1-4f87-86b7-1c97c4a8683f",
			sessionId: "4cf305ae-82a1-4f87-86b7-1c97c4a8683f",
			deviceHash: "0".repeat(64),
		}),
	};
	const history = { record: vi.fn().mockResolvedValue(undefined) };
	const service = new RecommendationEventsService(
		registry,
		users as unknown as PersistenceUserService,
		history as unknown as HistoryPersistenceWriter,
	);
	return { registry, event, users, history, service };
}

afterEach(() => {
	for (const registry of registries.splice(0)) registry.onModuleDestroy();
	vi.useRealTimers();
});

describe("recommendation event account persistence boundary", () => {
	it("keeps a request without Authorization aggregate-only", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { event, users, history, service } = scenario();
		await expect(service.accept(event)).resolves.toMatchObject({
			accepted: true,
		});
		expect(users.resolve).not.toHaveBeenCalled();
		expect(history.record).not.toHaveBeenCalled();
		expect(service.snapshot()).toHaveLength(1);
	});

	it("writes history only for a valid authenticated context", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { event, users, history, service } = scenario();
		await service.accept(event, "Bearer opaque-access-token");
		expect(users.resolve).toHaveBeenCalledWith("Bearer opaque-access-token");
		expect(history.record).toHaveBeenCalledWith(
			"3bf305ae-82a1-4f87-86b7-1c97c4a8683f",
			event,
			expect.objectContaining({
				provider: "AMAP",
				providerPlaceId: "private-amap-id",
				mealPeriod: "LUNCH",
			}),
		);
	});

	it("does not silently downgrade an invalid Authorization header", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { event, users, history, service } = scenario();
		users.resolve.mockRejectedValueOnce(new UnauthorizedException());
		await expect(
			service.accept(event, "Bearer invalid"),
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(history.record).not.toHaveBeenCalled();
		expect(service.snapshot()).toHaveLength(0);
	});

	it("releases event consumption when the database write fails", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { event, history, service } = scenario();
		history.record.mockRejectedValueOnce(new Error("database unavailable"));
		await expect(service.accept(event, "Bearer valid")).rejects.toThrow(
			"database unavailable",
		);
		await expect(service.accept(event)).resolves.toMatchObject({
			accepted: true,
		});
	});
});
