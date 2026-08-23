import {
	IntentProfileSchema,
	RecommendationContextSchema,
	type ResultToken,
} from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import type { AppConfig } from "../config/app-config.js";
import type { DataRightsPolicy } from "../config/data-rights-policy.js";
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
