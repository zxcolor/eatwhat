import {
	IntentProfileSchema,
	type RecommendationContext,
	RecommendationContextSchema,
} from "@chi-shen-me/contracts";
import { describe, expect, it } from "vitest";
import type { PlaceCandidate } from "./place-candidate.js";
import { rankCandidates } from "./recommendation-engine.js";

const context = (overrides: Partial<RecommendationContext> = {}) =>
	RecommendationContextSchema.parse({
		location: { latitude: 39.9928, longitude: 116.3109 },
		mealPeriod: "LUNCH",
		radiusMeters: 1_500,
		budgetMaxYuan: 40,
		availableMinutes: 60,
		...overrides,
	});

const intent = (provider: "QWEN" | "RULE_FALLBACK" = "RULE_FALLBACK") =>
	IntentProfileSchema.parse({
		cuisineWeights: { 面食: 1 },
		mealTypes: ["午餐", "快餐", "面食"],
		speedPreference: "FAST",
		diversityTarget: 0.55,
		explanationSeed: "测试",
		provider,
	});

function candidate(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
	return {
		provider: "DEMO",
		providerPlaceId: "place-1",
		providerRank: 1,
		dataMode: "DEMO",
		actions: {
			navigate: true,
			call: true,
			copyAddress: true,
			share: true,
		},
		name: "测试面馆",
		address: "测试地址",
		sourceRating: 4.5,
		averageCostYuan: 25,
		distanceMeters: 500,
		estimatedTravelMinutes: 7,
		estimatedMealMinutes: 30,
		openStatus: "OPEN",
		tags: ["面食", "快餐"],
		imageUrl: null,
		phone: null,
		location: { latitude: 39.993, longitude: 116.315, crs: "WGS84" },
		sourceAttribution: "测试来源",
		editorialAdjustment: 0,
		blocked: false,
		...overrides,
	};
}

it("passes through vendor-neutral source and action metadata", () => {
	const [liveResult] = rankCandidates({
		context: context(),
		intent: intent(),
		dataRightsMode: "LIVE_DISPLAY_ONLY",
		candidates: [
			candidate({
				provider: "AUTHORIZED_VENDOR",
				dataMode: "LIVE",
				actions: {
					navigate: true,
					call: false,
					copyAddress: true,
					share: false,
				},
			}),
		],
	});

	expect(liveResult).toMatchObject({
		provider: "AUTHORIZED_VENDOR",
		dataMode: "LIVE",
		actions: {
			navigate: true,
			call: false,
			copyAddress: true,
			share: false,
		},
	});

	const [demoResult] = rankCandidates({
		context: context(),
		intent: intent(),
		dataRightsMode: "LIVE_DISPLAY_ONLY",
		candidates: [
			candidate({ provider: "AUTHORIZED_VENDOR", dataMode: "DEMO" }),
		],
	});
	expect(demoResult).toMatchObject({
		provider: "AUTHORIZED_VENDOR",
		dataMode: "DEMO",
	});
});

it("rejects malformed generic provider and action metadata", () => {
	const results = rankCandidates({
		context: context(),
		intent: intent(),
		dataRightsMode: "LIVE_DISPLAY_ONLY",
		candidates: [
			candidate({ provider: "bad-provider" }),
			candidate({
				providerPlaceId: "bad-actions",
				actions: {
					navigate: true,
					call: true,
					copyAddress: true,
					share: true,
					unexpected: true,
				} as PlaceCandidate["actions"],
			}),
		],
	});

	expect(results).toEqual([]);
});

describe("rankCandidates", () => {
	it("keeps provider order and hides fit scores in live-display-only mode", () => {
		const results = rankCandidates({
			context: context(),
			intent: intent(),
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			candidates: [
				candidate({
					providerPlaceId: "second",
					providerRank: 2,
					sourceRating: 5,
				}),
				candidate({
					providerPlaceId: "first",
					providerRank: 1,
					sourceRating: 2,
					name: "另一家测试面馆",
					location: { latitude: 39.994, longitude: 116.316, crs: "WGS84" },
				}),
			],
		});
		expect(results.map((result) => result.providerPlaceId)).toEqual([
			"first",
			"second",
		]);
		expect(results.every((result) => result.fitScore === null)).toBe(true);
	});

	it("ignores preference weights in live-display-only mode", () => {
		const candidates = [
			candidate({
				providerPlaceId: "provider-first",
				providerRank: 1,
				sourceRating: 1,
				estimatedTravelMinutes: 30,
			}),
			candidate({
				providerPlaceId: "provider-second",
				providerRank: 2,
				sourceRating: 5,
				estimatedTravelMinutes: 1,
				name: "高分近距离测试面馆",
				location: { latitude: 39.994, longitude: 116.316, crs: "WGS84" },
			}),
		];
		const results = rankCandidates({
			context: context({
				preferenceVector: {
					quality: 0,
					time: 0,
					budget: 0,
					mealMatch: 0,
					diversity: 0,
				},
			}),
			intent: intent(),
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			candidates,
		});

		expect(results.map((result) => result.providerPlaceId)).toEqual([
			"provider-first",
			"provider-second",
		]);
		expect(results.map((result) => result.fitScore)).toEqual([null, null]);
	});

	it("sorts by transparent suitability only when licensed", () => {
		const results = rankCandidates({
			context: context(),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			candidates: [
				candidate({ providerPlaceId: "low", sourceRating: 2, providerRank: 1 }),
				candidate({
					providerPlaceId: "high",
					sourceRating: 5,
					providerRank: 2,
					name: "高分测试面馆",
					location: { latitude: 39.994, longitude: 116.316, crs: "WGS84" },
				}),
			],
		});
		expect(results[0]?.providerPlaceId).toBe("high");
		expect(results[0]?.fitScore).toBeTypeOf("number");
	});

	it("keeps the established licensed score when preferences are omitted", () => {
		const [result] = rankCandidates({
			context: context(),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			candidates: [candidate()],
		});

		expect(result?.fitScore).toBe(93);
	});

	it("applies user preference weights to licensed transparent ranking", () => {
		const candidates = [
			candidate({
				providerPlaceId: "quality",
				providerRank: 1,
				sourceRating: 5,
				estimatedTravelMinutes: 20,
				estimatedMealMinutes: 50,
			}),
			candidate({
				providerPlaceId: "time",
				providerRank: 2,
				sourceRating: 2,
				estimatedTravelMinutes: 2,
				estimatedMealMinutes: 20,
				name: "快速测试面馆",
				location: { latitude: 39.994, longitude: 116.316, crs: "WGS84" },
			}),
		];
		const rankWith = (quality: number, time: number) =>
			rankCandidates({
				context: context({
					preferenceVector: {
						quality,
						time,
						budget: 0,
						mealMatch: 0,
						diversity: 0,
					},
				}),
				intent: intent(),
				dataRightsMode: "LICENSED_ENRICHMENT",
				candidates,
			});

		expect(rankWith(100, 0)[0]?.providerPlaceId).toBe("quality");
		expect(rankWith(0, 100)[0]?.providerPlaceId).toBe("time");
	});

	it("does not describe zero-weight licensed dimensions as ranking reasons", () => {
		const [result] = rankCandidates({
			context: context({
				budgetMaxYuan: null,
				preferenceVector: {
					quality: 0,
					time: 0,
					budget: 0,
					mealMatch: 0,
					diversity: 0,
				},
			}),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			candidates: [candidate()],
		});

		expect(result?.reasons.map((reason) => reason.code)).toEqual([
			"DISTANCE_FIT",
		]);
	});

	it("keeps descriptive provider facts in live mode when weights are zero", () => {
		const [result] = rankCandidates({
			context: context({
				budgetMaxYuan: null,
				preferenceVector: {
					quality: 0,
					time: 0,
					budget: 0,
					mealMatch: 0,
					diversity: 0,
				},
			}),
			intent: intent(),
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			candidates: [candidate()],
		});

		expect(result?.fitScore).toBeNull();
		expect(result?.reasons.map((reason) => reason.code)).toEqual([
			"DISTANCE_FIT",
			"TIME_FIT",
			"MEAL_FIT",
		]);
	});

	it("uses the diversity preference for licensed duplicate-tag selection", () => {
		const candidates = [
			candidate({ providerPlaceId: "best", providerRank: 1, sourceRating: 5 }),
			candidate({
				providerPlaceId: "same-tag",
				providerRank: 2,
				sourceRating: 4.8,
				name: "另一家测试面馆",
				location: { latitude: 39.994, longitude: 116.316, crs: "WGS84" },
			}),
			candidate({
				providerPlaceId: "different-tag",
				providerRank: 3,
				sourceRating: 4.1,
				name: "测试盖饭",
				tags: ["米饭", "快餐"],
				location: { latitude: 39.995, longitude: 116.317, crs: "WGS84" },
			}),
		];
		const rankWith = (diversity: number) =>
			rankCandidates({
				context: context({
					preferenceVector: {
						quality: 100,
						time: 0,
						budget: 0,
						mealMatch: 0,
						diversity,
					},
				}),
				intent: intent(),
				dataRightsMode: "LICENSED_ENRICHMENT",
				candidates,
			});

		expect(rankWith(100).map((result) => result.providerPlaceId)).toEqual([
			"best",
			"different-tag",
			"same-tag",
		]);
		expect(rankWith(0).map((result) => result.providerPlaceId)).toEqual([
			"best",
			"same-tag",
			"different-tag",
		]);
	});

	it("applies a validated published weight profile without changing hard filters", () => {
		const results = rankCandidates({
			context: context(),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			rules: {
				qualityWeight: 0,
				timeWeight: 95,
				budgetWeight: 0,
				intentWeight: 0,
				diversityWeight: 0,
				operationsAdjustmentMaximum: 0,
			},
			candidates: [
				candidate({
					providerPlaceId: "high-quality-slower",
					providerRank: 1,
					sourceRating: 5,
					estimatedTravelMinutes: 15,
				}),
				candidate({
					providerPlaceId: "lower-quality-faster",
					providerRank: 2,
					sourceRating: 2,
					estimatedTravelMinutes: 2,
					name: "更快的测试面馆",
					location: { latitude: 39.994, longitude: 116.316, crs: "WGS84" },
				}),
			],
		});

		expect(results[0]?.providerPlaceId).toBe("lower-quality-faster");
		expect(results[0]?.reasons.map((reason) => reason.code)).toEqual([
			"DISTANCE_FIT",
			"TIME_FIT",
		]);
	});

	it.each([
		["closed", { openStatus: "CLOSED" as const }],
		["blocked", { blocked: true }],
		["outside radius", { distanceMeters: 1_501 }],
		["over budget", { averageCostYuan: 41 }],
		["excluded cuisine", { tags: ["火锅"] }],
		["hierarchical excluded cuisine", { tags: ["重庆火锅"] }],
	])("hard-filters %s candidates", (_label, overrides) => {
		const results = rankCandidates({
			context: context({
				excludedCuisines: ["火锅"],
				preferenceVector: {
					quality: 0,
					time: 0,
					budget: 0,
					mealMatch: 0,
					diversity: 0,
				},
			}),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			candidates: [candidate(overrides)],
		});
		expect(results).toHaveLength(0);
	});

	it("accepts a valid nearby candidate at a Shanghai origin", () => {
		const results = rankCandidates({
			context: context({
				location: {
					latitude: 31.2304,
					longitude: 121.4737,
					crs: "WGS84",
				},
			}),
			intent: intent(),
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			candidates: [
				candidate({
					location: {
						latitude: 31.231,
						longitude: 121.474,
						crs: "WGS84",
					},
				}),
			],
		});
		expect(results).toHaveLength(1);
	});

	it("deduplicates provider IDs and physical places", () => {
		const base = candidate();
		const results = rankCandidates({
			context: context(),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			candidates: [
				base,
				candidate({ providerRank: 2 }),
				candidate({ providerPlaceId: "another-id", providerRank: 3 }),
			],
		});
		expect(results).toHaveLength(1);
	});

	it("drops structurally unsafe candidates and sanitizes optional fields", () => {
		const results = rankCandidates({
			context: context(),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			candidates: [
				candidate({ providerPlaceId: "bad", distanceMeters: Number.NaN }),
				candidate({
					providerPlaceId: "safe",
					imageUrl: "http://example.com/insecure.jpg",
					sourceRating: 99,
				}),
			],
		});
		expect(results).toHaveLength(1);
		expect(results[0]?.imageUrl).toBeNull();
		expect(results[0]?.sourceRating).toBeNull();
		expect(results[0]?.providerPlaceId).toBe("safe");
		expect(results[0]).not.toHaveProperty("resultToken");
	});

	it("marks missing facts and time risk without inventing values", () => {
		const [result] = rankCandidates({
			context: context({ availableMinutes: 30 }),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			candidates: [
				candidate({
					sourceRating: null,
					averageCostYuan: null,
					openStatus: "UNKNOWN",
					estimatedMealMinutes: 45,
				}),
			],
		});
		expect(result?.confidence).toBe("LOW");
		expect(result?.warnings).toEqual(
			expect.arrayContaining([
				"营业状态暂无可靠信息，请到店前确认",
				"人均消费暂无可靠信息",
				"数据源暂无评分",
				"预计往返及用餐时间可能超出你的时间预算",
			]),
		);
		expect(result?.averageCostYuan).toBeNull();
	});

	it("uses AI assistance only when the validated intent came from Qwen", () => {
		const qwen = rankCandidates({
			context: context(),
			intent: intent("QWEN"),
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			candidates: [candidate()],
		});
		const rules = rankCandidates({
			context: context(),
			intent: intent("RULE_FALLBACK"),
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			candidates: [candidate()],
		});
		expect(qwen[0]?.aiAssisted).toBe(true);
		expect(rules[0]?.aiAssisted).toBe(false);
	});

	it("penalizes a recently shown place without excluding it", () => {
		const results = rankCandidates({
			context: context(),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			recentPlaceIds: new Set(["recent"]),
			candidates: [
				candidate({ providerPlaceId: "recent", providerRank: 1 }),
				candidate({
					providerPlaceId: "fresh",
					providerRank: 2,
					name: "另一家面馆",
					location: { latitude: 39.994, longitude: 116.316, crs: "WGS84" },
				}),
			],
		});
		expect(results.map((result) => result.providerPlaceId)).toEqual([
			"fresh",
			"recent",
		]);
	});

	it("returns no more than three contract-valid results with verifiable reasons", () => {
		const results = rankCandidates({
			context: context(),
			intent: intent(),
			dataRightsMode: "LICENSED_ENRICHMENT",
			candidates: Array.from({ length: 5 }, (_, index) =>
				candidate({
					providerPlaceId: `place-${index}`,
					providerRank: index + 1,
					name: `测试餐厅${index}`,
					location: {
						latitude: 39.99 + index * 0.001,
						longitude: 116.31 + index * 0.001,
						crs: "WGS84",
					},
				}),
			),
		});
		expect(results).toHaveLength(3);
		expect(results.every((result) => result.providerPlaceId.length > 0)).toBe(
			true,
		);
		expect(
			results.every(
				(result) => result.reasons.length >= 1 && result.reasons.length <= 3,
			),
		).toBe(true);
	});
});
