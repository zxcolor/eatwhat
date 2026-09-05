import {
	GroupRecommendationRequestSchema,
	RecommendationContextSchema,
	type RecommendationContext,
} from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import { type AppConfig, loadAppConfig } from "../config/app-config.js";
import type {
	AppClock,
	DataRightsPolicy,
} from "../config/data-rights-policy.js";
import type {
	PlaceCandidate,
	PlaceProvider,
} from "../recommendations/domain/place-candidate.js";
import type { RecommendationQueryPlan } from "../recommendations/domain/recommendation-query-plan.js";
import type { OperationalConfigService } from "../operational-config/operational-config.service.js";
import { type OperationalConfigSnapshot, startupOperationalConfig } from "../operational-config/operational-config.types.js";
import { IntentCoordinator } from "../recommendations/providers/intent-coordinator.js";
import { QwenIntentProvider } from "../recommendations/providers/qwen-intent.provider.js";
import { RuleIntentProvider } from "../recommendations/providers/rule-intent.provider.js";
import { RecommendationsService } from "../recommendations/recommendations.service.js";
import { GroupRecommendationsService } from "./group-recommendations.service.js";

const FIXED_NOW = Date.parse("2026-09-03T04:05:06.789Z");
const clock: AppClock = { now: () => FIXED_NOW };

const request = GroupRecommendationRequestSchema.parse({
	location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
	travelMode: "WALK",
	members: [
		{
			budgetMaxYuan: null,
			availableMinutes: 90,
			radiusMeters: 1_500,
			preferredCuisines: ["米饭", "面食"],
			excludedCuisines: ["西餐"],
		},
		{
			budgetMaxYuan: 45,
			availableMinutes: 50,
			radiusMeters: 900,
			preferredCuisines: ["面食", "米饭"],
			excludedCuisines: ["火锅"],
		},
	],
});

function config(enabled = true): AppConfig {
	return loadAppConfig({
		NODE_ENV: "test",
		GROUP_RECOMMENDATIONS_ENABLED: enabled ? "true" : "false",
	});
}

function candidate(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
	return {
		provider: "AUTHORIZED_VENDOR",
		providerPlaceId: "place-1",
		providerRank: 1,
		dataMode: "LIVE",
		actions: {
			navigate: true,
			call: true,
			copyAddress: true,
			share: true,
		},
		name: "测试面馆",
		address: "测试地址",
		sourceRating: 4.5,
		averageCostYuan: 30,
		distanceMeters: 300,
		estimatedTravelMinutes: 5,
		estimatedMealMinutes: 30,
		openStatus: "OPEN",
		tags: ["面食", "午餐"],
		imageUrl: "https://example.test/private-image.jpg",
		phone: "010-00000000",
		location: { latitude: 39.993, longitude: 116.311, crs: "WGS84" },
		sourceAttribution: "授权测试来源",
		editorialAdjustment: 0,
		blocked: false,
		...overrides,
	};
}

function provider(input?: {
	kind?: PlaceProvider["kind"];
	supported?: boolean;
	supportFailure?: Error;
	candidates?: readonly PlaceCandidate[];
	searchFailure?: Error;
}) {
	const supportsQueryPlan = vi.fn((_plan: RecommendationQueryPlan) => {
		if (input?.supportFailure !== undefined) throw input.supportFailure;
		return input?.supported ?? true;
	});
	const search = vi.fn(async (_context: RecommendationContext) => {
		if (input?.searchFailure !== undefined) throw input.searchFailure;
		return input?.candidates ?? [candidate()];
	});
	const places: PlaceProvider = {
		kind: input?.kind ?? "AUTHORIZED_VENDOR",
		dataMode: "LIVE",
		supportsQueryPlan,
		search,
	};
	return { places, supportsQueryPlan, search };
}

function policy(
	mode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT" = "LIVE_DISPLAY_ONLY",
	failure?: Error,
) {
	const effectiveMode = vi.fn(async () => {
		if (failure !== undefined) throw failure;
		return mode;
	});
	return {
		value: { effectiveMode } as unknown as DataRightsPolicy,
		effectiveMode,
	};
}

function responseOf(error: unknown): unknown {
	return (error as Readonly<{ getResponse(): unknown }>).getResponse();
}

function operational(snapshot: OperationalConfigSnapshot): OperationalConfigService {
	return { current: vi.fn(async () => snapshot) } as unknown as OperationalConfigService;
}

describe("GroupRecommendationsService capability boundary", () => {
	it.each(["STALE_CACHE", "SAFE_FALLBACK"] as const)(
		"rejects %s before capability, provider, rights, model or token-registry work",
		async (source) => {
			const base = config(true);
			const initial = startupOperationalConfig(base);
			const places = provider();
			const rights = policy();
			const model = vi.spyOn(QwenIntentProvider.prototype, "resolve");
			const registryIssue = vi.spyOn(RecommendationRequestRegistry.prototype, "issue");
			try {
				const service = new GroupRecommendationsService(base, clock, places.places, rights.value, operational({
					...initial, source,
					lastSuccessfulReadAt: source === "STALE_CACHE" ? "2026-09-06T01:00:00.000Z" : null,
				}));
				await expect(service.recommend(request)).rejects.toMatchObject({
					status: 503, response: { code: "GROUP_RECOMMENDATIONS_UNAVAILABLE" },
				});
				expect(places.supportsQueryPlan).not.toHaveBeenCalled();
				expect(places.search).not.toHaveBeenCalled();
				expect(rights.effectiveMode).not.toHaveBeenCalled();
				expect(model).not.toHaveBeenCalled();
				expect(registryIssue).not.toHaveBeenCalled();
			} finally {
				model.mockRestore();
				registryIssue.mockRestore();
			}
		},
	);

	it("applies the operations ceiling to the recomputed common radius, not each member's upper bound", async () => {
		const base = config(true);
		const snapshot = startupOperationalConfig(base);
		const active = operational({ ...snapshot, coverage: { areaCode: "NATIONWIDE", defaultRadiusMeters: 500, maximumRadiusMeters: 1000 } });
		const places = provider();
		const rights = policy();
		const service = new GroupRecommendationsService(base, clock, places.places, rights.value, active);
		const accepted = await service.recommend(request);
		expect(request.members[0]?.radiusMeters).toBe(1500);
		expect(accepted.aggregation.effectiveRadiusMeters).toBe(900);
		expect(places.search).toHaveBeenCalledWith(expect.objectContaining({ radiusMeters: 900 }), expect.any(Object));
		places.supportsQueryPlan.mockClear();
		places.search.mockClear();
		rights.effectiveMode.mockClear();
		await expect(service.recommend(GroupRecommendationRequestSchema.parse({
			...request, members: request.members.map((member) => ({ ...member, radiusMeters: 1200 })),
		}))).rejects.toMatchObject({ status: 400, response: { code: "RADIUS_EXCEEDS_ACTIVE_COVERAGE" } });
		expect(places.supportsQueryPlan).not.toHaveBeenCalled();
		expect(places.search).not.toHaveBeenCalled();
		expect(rights.effectiveMode).not.toHaveBeenCalled();
	});

	it("fails a disabled switch closed before capability, provider or rights I/O", async () => {
		const places = provider();
		const rights = policy();
		const service = new GroupRecommendationsService(
			config(false),
			clock,
			places.places,
			rights.value,
		);

		const error = await service.recommend(request).catch((caught) => caught);
		expect(responseOf(error)).toEqual({
			code: "GROUP_RECOMMENDATIONS_UNAVAILABLE",
			message: "群组推荐服务暂时不可用，请稍后重试",
		});
		expect(places.supportsQueryPlan).not.toHaveBeenCalled();
		expect(places.search).not.toHaveBeenCalled();
		expect(rights.effectiveMode).not.toHaveBeenCalled();
	});

	it("fails an unavailable adapter closed without invoking it", async () => {
		const places = provider({ kind: "UNAVAILABLE" });
		const rights = policy();
		const service = new GroupRecommendationsService(
			config(true),
			clock,
			places.places,
			rights.value,
		);

		await expect(service.recommend(request)).rejects.toMatchObject({
			status: 503,
		});
		expect(places.supportsQueryPlan).not.toHaveBeenCalled();
		expect(places.search).not.toHaveBeenCalled();
		expect(rights.effectiveMode).not.toHaveBeenCalled();
	});

	it.each([
		["unsupported", { supported: false }],
		["capability probe throws", { supportFailure: new Error("private probe") }],
	] as const)(
		"fails %s closed before provider search and rights I/O",
		async (_label, providerInput) => {
			const places = provider(providerInput);
			const rights = policy();
			const service = new GroupRecommendationsService(
				config(true),
				clock,
				places.places,
				rights.value,
			);

			const error = await service.recommend(request).catch((caught) => caught);
			expect(responseOf(error)).toEqual({
				code: "GROUP_RECOMMENDATIONS_UNAVAILABLE",
				message: "群组推荐服务暂时不可用，请稍后重试",
			});
			expect(places.supportsQueryPlan).toHaveBeenCalledOnce();
			expect(places.search).not.toHaveBeenCalled();
			expect(rights.effectiveMode).not.toHaveBeenCalled();
		},
	);

	it("maps provider failures to the same sanitized 503", async () => {
		const privateFailure = "private upstream URL and credential";
		const places = provider({ searchFailure: new Error(privateFailure) });
		const rights = policy();
		const service = new GroupRecommendationsService(
			config(true),
			clock,
			places.places,
			rights.value,
		);

		const error = await service.recommend(request).catch((caught) => caught);
		expect(JSON.stringify(responseOf(error))).not.toContain(privateFailure);
		expect(responseOf(error)).toMatchObject({
			code: "GROUP_RECOMMENDATIONS_UNAVAILABLE",
		});
		expect(rights.effectiveMode).not.toHaveBeenCalled();
	});
});

describe("GroupRecommendationsService bounded execution", () => {
	it("shares runtime weights with single recommendations while keeping code identity and LIVE order separate", async () => {
		const base = config(true);
		const initial = startupOperationalConfig(base);
		const candidates = [
			candidate({
				providerPlaceId: "fast-low-rating", providerRank: 1, name: "快速候选", sourceRating: 1,
				distanceMeters: 200, estimatedTravelMinutes: 2, estimatedMealMinutes: 15,
			}),
			candidate({
				providerPlaceId: "slower-high-rating", providerRank: 2, name: "高评分候选", sourceRating: 5,
				distanceMeters: 600, estimatedTravelMinutes: 8, estimatedMealMinutes: 30,
				location: { latitude: 39.994, longitude: 116.312, crs: "WGS84" },
			}),
		];
		const weights = [
			{ revision: 4, qualityWeight: 95, timeWeight: 0, expected: ["高评分候选", "快速候选"] },
			{ revision: 5, qualityWeight: 0, timeWeight: 95, expected: ["快速候选", "高评分候选"] },
		];
		for (const mode of ["LICENSED_ENRICHMENT", "LIVE_DISPLAY_ONLY"] as const) {
			for (const weight of weights) {
				const snapshot: OperationalConfigSnapshot = {
					...initial, source: "DATABASE", lastSuccessfulReadAt: "2026-09-06T01:00:00.000Z",
					recommendationRules: {
						qualityWeight: weight.qualityWeight, timeWeight: weight.timeWeight,
						budgetWeight: 0, intentWeight: 0, diversityWeight: 0, operationsAdjustmentMaximum: 0,
					},
					versions: { ...initial.versions, "recommendations.rules": weight.revision },
				};
				const places = provider({ candidates });
				const rights = policy(mode);
				const group = await new GroupRecommendationsService(base, clock, places.places, rights.value, operational(snapshot)).recommend(request);
				const registry = new RecommendationRequestRegistry();
				const qwenFetch = vi.fn();
				try {
					const intents = new IntentCoordinator(base, new QwenIntentProvider(base, qwenFetch as typeof fetch), new RuleIntentProvider());
					const single = await new RecommendationsService(base, places.places, intents, registry, rights.value, operational(snapshot)).recommend(RecommendationContextSchema.parse({
						location: request.location, travelMode: request.travelMode, mealPeriod: "LUNCH",
						budgetMaxYuan: group.aggregation.effectiveBudgetMaxYuan,
						availableMinutes: group.aggregation.effectiveAvailableMinutes,
						radiusMeters: group.aggregation.effectiveRadiusMeters,
						partySize: group.aggregation.memberCount,
						preferredCuisines: group.aggregation.preferredCuisines,
						excludedCuisines: group.aggregation.excludedCuisines,
						aiAssistanceEnabled: false,
					}));
					const expectedOrder = mode === "LICENSED_ENRICHMENT" ? weight.expected : ["快速候选", "高评分候选"];
					expect(group.results.map((result) => result.name)).toEqual(expectedOrder);
					expect(single.results.map((result) => result.name)).toEqual(expectedOrder);
					expect(group.results.map((result) => result.fitScore)).toEqual(single.results.map((result) => result.fitScore));
					if (mode === "LIVE_DISPLAY_ONLY") expect(group.results.map((result) => result.fitScore)).toEqual([null, null]);
					else expect(group.results.every((result) => result.fitScore !== null)).toBe(true);
					expect(group.ruleVersion).toBe(base.versions.rule);
					expect(single.ruleVersion).toBe(base.versions.rule);
					expect(group.rulesConfigVersion).toBe(weight.revision);
					expect(single.rulesConfigVersion).toBe(weight.revision);
					expect(qwenFetch).not.toHaveBeenCalled();
				} finally {
					registry.onModuleDestroy();
				}
			}
		}
	});

	it("recomputes constraints and fixes every internal recommendation dimension using server time", async () => {
		const places = provider();
		const rights = policy();
		const service = new GroupRecommendationsService(
			config(true),
			clock,
			places.places,
			rights.value,
		);

		const response = await service.recommend(request);
		expect(response.generatedAt).toBe("2026-09-03T04:05:06.789Z");
		expect(response.aggregation).toEqual({
			version: "group-constraints-v1",
			memberCount: 2,
			effectiveBudgetMaxYuan: 45,
			effectiveAvailableMinutes: 50,
			effectiveRadiusMeters: 900,
			preferredCuisines: ["面食", "米饭"],
			excludedCuisines: ["火锅", "西餐"],
		});
		expect(places.supportsQueryPlan).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: expect.objectContaining({
					target: "MEAL",
					family: "MEAL_LUNCH",
					version: "meal-lunch-v1",
				}),
				weatherApplication: {
					kind: "NONE",
					version: "weather-none-v1",
					queryModifier: null,
				},
			}),
		);
		expect(places.search).toHaveBeenCalledWith(
			expect.objectContaining({
				mealPeriod: "LUNCH",
				target: "MEAL",
				weatherContext: { kind: "NONE" },
				decisionMode: "GUIDED",
				travelMode: "WALK",
				explorationMode: "BALANCED",
				aiAssistanceEnabled: false,
				budgetMaxYuan: 45,
				availableMinutes: 50,
				radiusMeters: 900,
				partySize: 2,
				excludedCuisines: ["火锅", "西餐"],
				preferredCuisines: ["面食", "米饭"],
				preferenceVector: {
					quality: 100,
					time: 100,
					budget: 100,
					mealMatch: 100,
					diversity: 100,
				},
				requestTime: "2026-09-03T04:05:06.789Z",
			}),
			expect.any(Object),
		);
	});

	it("does not issue a registry entry or expose action, location, token, media, phone or AI fields", async () => {
		const registry = new RecommendationRequestRegistry();
		const before = registry.diagnostics();
		const places = provider();
		const rights = policy();
		const response = await new GroupRecommendationsService(
			config(true),
			clock,
			places.places,
			rights.value,
		).recommend(request);

		expect(registry.diagnostics()).toEqual(before);
		const [result] = response.results;
		expect(result).toBeDefined();
		expect(Object.keys(result ?? {}).sort()).toEqual(
			[
				"address",
				"averageCostYuan",
				"confidence",
				"dataMode",
				"distanceMeters",
				"estimatedMealMinutes",
				"estimatedTravelMinutes",
				"fitScore",
				"name",
				"openStatus",
				"provider",
				"rank",
				"reasons",
				"sourceAttribution",
				"sourceRating",
				"tags",
				"warnings",
			].sort(),
		);
		const serialized = JSON.stringify(response);
		expect(serialized).not.toMatch(
			/resultToken|providerPlaceId|actions|location|phone|imageUrl|aiAssisted|promptVersion|modelVersion|aiFallbackUsed/u,
		);
		registry.onModuleDestroy();
	});

	it("preserves provider order with null fit scores whenever any included provider is live-display-only", async () => {
		const candidates = [
			candidate({
				provider: "AUTHORIZED_VENDOR",
				providerPlaceId: "provider-second",
				providerRank: 2,
				sourceRating: 5,
			}),
			candidate({
				provider: "SECOND_VENDOR",
				providerPlaceId: "provider-first",
				providerRank: 1,
				sourceRating: 1,
				name: "低分但上游第一的测试餐厅",
				location: { latitude: 39.994, longitude: 116.312, crs: "WGS84" },
			}),
		];
		const places = provider({ candidates });
		const effectiveMode = vi.fn(async (providerCode: string) =>
			providerCode === "AUTHORIZED_VENDOR"
				? ("LICENSED_ENRICHMENT" as const)
				: ("LIVE_DISPLAY_ONLY" as const),
		);
		const response = await new GroupRecommendationsService(
			config(true),
			clock,
			places.places,
			{ effectiveMode } as unknown as DataRightsPolicy,
		).recommend(request);

		expect(effectiveMode).toHaveBeenCalledTimes(2);
		expect(response.dataRightsMode).toBe("LIVE_DISPLAY_ONLY");
		expect(response.results.map((result) => result.name)).toEqual([
			"低分但上游第一的测试餐厅",
			"测试面馆",
		]);
		expect(response.results.map((result) => result.fitScore)).toEqual([
			null,
			null,
		]);
	});

	it("uses existing transparent ranking only when every included provider is licensed", async () => {
		const places = provider({
			candidates: [
				candidate({
					providerPlaceId: "low",
					providerRank: 1,
					sourceRating: 1,
				}),
				candidate({
					providerPlaceId: "high",
					providerRank: 2,
					sourceRating: 5,
					name: "高分授权测试餐厅",
					location: { latitude: 39.994, longitude: 116.312, crs: "WGS84" },
				}),
			],
		});
		const rights = policy("LICENSED_ENRICHMENT");
		const response = await new GroupRecommendationsService(
			config(true),
			clock,
			places.places,
			rights.value,
		).recommend(request);

		expect(response.dataRightsMode).toBe("LICENSED_ENRICHMENT");
		expect(response.results[0]?.name).toBe("高分授权测试餐厅");
		expect(response.results.every((result) => result.fitScore !== null)).toBe(
			true,
		);
	});

	it("downgrades rights-policy failures to provider order and null scores", async () => {
		const places = provider({
			candidates: [
				candidate({ providerPlaceId: "first", providerRank: 1 }),
				candidate({
					providerPlaceId: "second",
					providerRank: 2,
					name: "另一家测试餐厅",
					location: { latitude: 39.994, longitude: 116.312, crs: "WGS84" },
				}),
			],
		});
		const rights = policy(
			"LICENSED_ENRICHMENT",
			new Error("private database failure"),
		);
		const response = await new GroupRecommendationsService(
			config(true),
			clock,
			places.places,
			rights.value,
		).recommend(request);

		expect(response.dataRightsMode).toBe("LIVE_DISPLAY_ONLY");
		expect(response.results.map((result) => result.fitScore)).toEqual([
			null,
			null,
		]);
		expect(JSON.stringify(response)).not.toContain("private database failure");
	});
});
