import {
	IntentProfileSchema,
	RecommendationContextSchema,
	type ResultToken,
} from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import type { AppConfig } from "../config/app-config.js";
import type { DataRightsPolicy } from "../config/data-rights-policy.js";
import type { OperationalConfigService } from "../operational-config/operational-config.service.js";
import type { OperationalConfigSnapshot } from "../operational-config/operational-config.types.js";
import type { PlaceProvider } from "./domain/place-candidate.js";
import type { IntentCoordinator } from "./providers/intent-coordinator.js";
import {
	RecommendationsService,
	recommendationNotice,
} from "./recommendations.service.js";

describe("recommendationNotice", () => {
	it("uses the generic data mode instead of a provider identity", () => {
		expect(recommendationNotice("DEMO", 1, "LIVE_DISPLAY_ONLY")).toContain(
			"虚构演示餐厅",
		);
		expect(recommendationNotice("LIVE", 1, "LIVE_DISPLAY_ONLY")).toContain(
			"数据授权边界实时展示",
		);
		expect(recommendationNotice("LIVE", 1, "LICENSED_ENRICHMENT")).toBeNull();
	});

	it("keeps the no-results explanation for every live provider", () => {
		expect(recommendationNotice("LIVE", 0, "LICENSED_ENRICHMENT")).toContain(
			"没有可靠结果",
		);
	});
});

describe("RecommendationsService token transaction", () => {
	it("rejects a radius above the active operations ceiling before provider calls", async () => {
		const places = {
			kind: "AUTHORIZED_VENDOR",
			dataMode: "LIVE",
			search: vi.fn(),
		} as unknown as PlaceProvider;
		const intents = { resolve: vi.fn() } as unknown as IntentCoordinator;
		const operationalSnapshot = {
			source: "DATABASE",
			aiAssistanceEnabled: false,
			recommendationRules: {
				qualityWeight: 25,
				timeWeight: 25,
				budgetWeight: 20,
				intentWeight: 15,
				diversityWeight: 10,
				operationsAdjustmentMaximum: 5,
			},
			prompt: {
				enabled: false,
				promptVersion: "prompt-v1",
				modelVersion: "model-v1",
				timeoutMs: 1_500,
			},
			coverage: {
				defaultRadiusMeters: 1_000,
				maximumRadiusMeters: 2_000,
				areaCode: "NATIONWIDE",
			},
			minimumAppVersions: { android: "1.0.0" },
			versions: {
				"features.ai-assistance": 1,
				"recommendations.rules": 1,
				"recommendations.prompt": 1,
				"coverage.default": 1,
				"clients.minimum-version": 1,
			},
		} satisfies OperationalConfigSnapshot;
		const operational = {
			current: vi.fn(async () => operationalSnapshot),
		} as unknown as OperationalConfigService;
		const service = new RecommendationsService(
			{} as AppConfig,
			places,
			intents,
			new RecommendationRequestRegistry(),
			{} as DataRightsPolicy,
			operational,
		);

		await expect(
			service.recommend(
				RecommendationContextSchema.parse({
					location: { latitude: 39.9928, longitude: 116.3109 },
					mealPeriod: "LUNCH",
					radiusMeters: 2_500,
				}),
			),
		).rejects.toMatchObject({
			response: { code: "RADIUS_EXCEEDS_ACTIVE_COVERAGE" },
		});
		expect(places.search).not.toHaveBeenCalled();
		expect(intents.resolve).not.toHaveBeenCalled();
	});

	it("revokes an issued mapping when the public response fails validation", async () => {
		const registry = new RecommendationRequestRegistry();
		const originalIssue = registry.issue.bind(registry);
		vi.spyOn(registry, "issue").mockImplementation((requestId, references) => {
			originalIssue(requestId, references);
			return ["invalid-token" as ResultToken];
		});
		const config = {
			versions: {
				rule: "test-rule",
				prompt: "test-prompt",
				ruleFallbackModel: "rule-fallback-v1",
			},
		} as AppConfig;
		const places: PlaceProvider = {
			kind: "AUTHORIZED_VENDOR",
			dataMode: "LIVE",
			search: async () => [
				{
					provider: "AUTHORIZED_VENDOR",
					providerPlaceId: "stable-provider-id",
					providerRank: 1,
					dataMode: "LIVE",
					actions: {
						navigate: false,
						call: false,
						copyAddress: false,
						share: false,
					},
					name: "测试餐厅",
					address: "测试地址",
					sourceRating: null,
					averageCostYuan: null,
					distanceMeters: 100,
					estimatedTravelMinutes: 2,
					estimatedMealMinutes: 30,
					openStatus: "OPEN",
					tags: ["面食"],
					imageUrl: null,
					phone: null,
					location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
					sourceAttribution: "已授权测试数据源",
					editorialAdjustment: 0,
					blocked: false,
				},
			],
		};
		const intents = {
			resolve: async () => ({
				profile: IntentProfileSchema.parse({
					cuisineWeights: { 面食: 1 },
					mealTypes: ["午餐", "面食"],
					speedPreference: "FAST",
					diversityTarget: 0.5,
					explanationSeed: "测试",
					provider: "RULE_FALLBACK",
				}),
				fallbackUsed: false,
				modelVersion: "rule-fallback-v1",
			}),
		} as unknown as IntentCoordinator;
		const policy = {
			effectiveMode: async () => "LIVE_DISPLAY_ONLY" as const,
		} as DataRightsPolicy;
		const service = new RecommendationsService(
			config,
			places,
			intents,
			registry,
			policy,
		);

		await expect(
			service.recommend(
				RecommendationContextSchema.parse({
					location: { latitude: 39.9928, longitude: 116.3109 },
					mealPeriod: "LUNCH",
					radiusMeters: 1_500,
				}),
			),
		).rejects.toBeDefined();
		expect(registry.diagnostics().activeRequestCount).toBe(0);
		registry.onModuleDestroy();
	});
});
