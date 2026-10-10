import { describe, expect, it } from "vitest";
import type {
	RecommendationContext,
	RecommendationResponse,
} from "../../features/decision/index";
import {
	evidenceSummary,
	projectResultCards,
	resultCountSummary,
} from "./model";

describe("results projection", () => {
	it("identifies live candidates and keeps uncertain facts and estimated time distinct", () => {
		const response = fixture();
		const unknown = response.results[1];
		if (unknown === undefined) throw new Error("Missing synthetic result");
		const evidence = evidenceSummary(
			{ ...unknown, tags: [], estimatedMealMinutes: 90 },
			{ ...contextFixture(), excludedCuisines: ["川湘菜"] },
		);
		expect(evidence).toContain("待确认 · 商户人均价格未知");
		expect(evidence).toContain("待确认 · 营业状态未知");
		expect(evidence).toContain("待确认 · 缺少菜系标签，请核对排除项");
		expect(evidence.some((item) => item.startsWith("时间偏紧"))).toBe(true);
		expect(
			resultCountSummary(
				2,
				2,
				{
					openNowOnly: false,
					knownPriceWithinBudgetOnly: false,
					cuisineTagQuery: "",
				},
				true,
			),
		).toBe("本次共 2 个候选");
	});
	it("keeps opaque tokens out of page data and treats unknown facts conservatively", () => {
		const response = fixture();
		const context = contextFixture();
		const all = projectResultCards(response, context, {
			openNowOnly: false,
			knownPriceWithinBudgetOnly: false,
			cuisineTagQuery: "",
		});
		expect(all).toHaveLength(2);
		expect(JSON.stringify(all)).not.toContain(response.results[0]?.resultToken);
		expect(JSON.stringify(all)).not.toContain("resultToken");

		const knownPriceOnly = projectResultCards(response, context, {
			openNowOnly: false,
			knownPriceWithinBudgetOnly: true,
			cuisineTagQuery: "",
		});
		expect(knownPriceOnly.map((item) => item.rank)).toEqual([1]);

		const openOnly = projectResultCards(response, context, {
			openNowOnly: true,
			knownPriceWithinBudgetOnly: false,
			cuisineTagQuery: "",
		});
		expect(openOnly.map((item) => item.rank)).toEqual([1]);
		expect(
			resultCountSummary(1, 2, {
				openNowOnly: true,
				knownPriceWithinBudgetOnly: false,
				cuisineTagQuery: "",
			}),
		).toBe("本地筛选显示 1 / 2 条");
	});
});

function contextFixture(): RecommendationContext {
	return {
		location: { latitude: 39.9, longitude: 116.4, crs: "WGS84" },
		mealPeriod: "LUNCH",
		decisionMode: "QUICK",
		travelMode: "WALK",
		explorationMode: "BALANCED",
		aiAssistanceEnabled: false,
		budgetMaxYuan: 50,
		availableMinutes: 60,
		radiusMeters: 1_500,
		partySize: 1,
		excludedCuisines: [],
		preferredCuisines: [],
		requestTime: "2026-08-30T04:00:00.000Z",
	};
}

function fixture(): RecommendationResponse {
	const common = {
		provider: "DEMO",
		dataMode: "DEMO" as const,
		actions: { navigate: true, call: false, copyAddress: true, share: false },
		address: "测试地址",
		fitScore: null,
		sourceRating: null,
		distanceMeters: 500,
		estimatedTravelMinutes: 8,
		estimatedMealMinutes: 30,
		tags: ["经典川菜"],
		imageUrl: null,
		phone: null,
		location: { latitude: 39.9, longitude: 116.4, crs: "WGS84" as const },
		reasons: [{ code: "DISTANCE_FIT" as const, text: "距离合适" }],
		warnings: [],
		confidence: "LOW" as const,
		aiAssisted: false,
		sourceAttribution: "演示数据",
	};
	return {
		requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
		generatedAt: "2026-08-30T04:00:00.000Z",
		coverage: "NATIONWIDE",
		dataRightsMode: "LIVE_DISPLAY_ONLY",
		ruleVersion: "v1",
		promptVersion: "v1",
		modelVersion: "v1",
		aiFallbackUsed: true,
		results: [
			{
				...common,
				resultToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				name: "第一家",
				rank: 1,
				averageCostYuan: 35,
				openStatus: "OPEN",
			},
			{
				...common,
				resultToken: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
				name: "第二家",
				rank: 2,
				averageCostYuan: null,
				openStatus: "UNKNOWN",
			},
		],
		notice: null,
	};
}
