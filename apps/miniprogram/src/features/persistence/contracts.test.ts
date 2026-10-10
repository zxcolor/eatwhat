import { describe, expect, it } from "vitest";
import { parseFavoritesPage, parseHistoryPage } from "./contracts";

const available = {
	presentationStatus: "AVAILABLE",
	name: "演示餐厅",
	address: "示例地址",
	sourceLabel: "演示数据",
	dataMode: "DEMO",
	openStatus: "UNKNOWN",
	averageCostYuan: null,
	tags: ["家常菜"],
	resolvedAt: "2026-08-30T00:00:00.000Z",
};

describe("saved-resource response validation", () => {
	it("accepts a strict favorite page without durable provider identifiers", () => {
		expect(
			parseFavoritesPage({
				items: [
					{
						favoriteId: "11111111-1111-4111-8111-111111111111",
						group: "WANT_TO_GO",
						createdAt: "2026-08-30T00:00:00.000Z",
						presentation: available,
					},
				],
				nextCursor: null,
			}).items[0]?.presentation,
		).toEqual(available);
	});

	it("rejects provider identifiers added to a presentation", () => {
		expect(() =>
			parseFavoritesPage({
				items: [
					{
						favoriteId: "11111111-1111-4111-8111-111111111111",
						group: "WANT_TO_GO",
						createdAt: "2026-08-30T00:00:00.000Z",
						presentation: { ...available, providerPlaceId: "must-not-cross" },
					},
				],
				nextCursor: null,
			}),
		).toThrow("PERSISTENCE_RESPONSE_INVALID");
	});

	it("enforces exact 90-day history retention", () => {
		expect(() =>
			parseHistoryPage({
				items: [
					{
						historyId: "22222222-2222-4222-8222-222222222222",
						action: "DETAIL_VIEWED",
						mealPeriod: "LUNCH",
						occurredAt: "2026-08-30T00:00:00.000Z",
						expiresAt: "2026-12-01T00:00:00.000Z",
						presentation: null,
					},
				],
				nextCursor: null,
				retentionDays: 90,
			}),
		).toThrow("PERSISTENCE_RESPONSE_INVALID");
	});
});
