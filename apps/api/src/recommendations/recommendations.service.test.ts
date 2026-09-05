import {
	IntentProfileSchema,
	RecommendationContextSchema,
	type ResultToken,
} from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import { type AppConfig, loadAppConfig } from "../config/app-config.js";
import type { DataRightsPolicy } from "../config/data-rights-policy.js";
import type { OperationalConfigService } from "../operational-config/operational-config.service.js";
import { type OperationalConfigSnapshot, startupOperationalConfig } from "../operational-config/operational-config.types.js";
import type { PlaceProvider } from "./domain/place-candidate.js";
import { AmapPlaceProvider } from "./providers/amap-place.provider.js";
import { DemoPlaceProvider } from "./providers/demo-place.provider.js";
import { IntentCoordinator } from "./providers/intent-coordinator.js";
import { QwenIntentProvider } from "./providers/qwen-intent.provider.js";
import { RuleIntentProvider } from "./providers/rule-intent.provider.js";
import {
	RecommendationsService,
	recommendationNotice,
} from "./recommendations.service.js";

describe("recommendationNotice", () => {
	it("uses the generic data mode instead of a provider identity", () => {
		expect(recommendationNotice("DEMO", 1, "LIVE_DISPLAY_ONLY")).toContain(
			"虚构演示餐饮地点",
		);
		expect(recommendationNotice("LIVE", 1, "LIVE_DISPLAY_ONLY")).toContain(
			"数据授权边界实时展示",
		);
		expect(recommendationNotice("LIVE", 1, "LICENSED_ENRICHMENT")).toBeNull();
	});

	it("uses a neutral no-results explanation for every live rights mode", () => {
		for (const rightsMode of [
			"LIVE_DISPLAY_ONLY",
			"LICENSED_ENRICHMENT",
		] as const) {
			const notice = recommendationNotice("LIVE", 0, rightsMode);
			expect(notice).toContain("没有符合条件的候选");
			expect(notice).not.toContain("可靠");
		}
	});
});

describe("RecommendationsService token transaction", () => {
	it.each(["STALE_CACHE", "SAFE_FALLBACK"] as const)(
		"rejects %s before capability, model, provider, rights or token-registry operations",
		async (source) => {
			const base = loadAppConfig({ NODE_ENV: "test" });
			const initial = startupOperationalConfig(base);
			const operational = {
				current: vi.fn(async () => ({
					...initial, source,
					lastSuccessfulReadAt: source === "STALE_CACHE" ? "2026-09-06T01:00:00.000Z" : null,
					// Execution must honor availability even if old diagnostic values were enabled.
					aiAssistanceEnabled: true,
				})),
			} as unknown as OperationalConfigService;
			const places = { kind: "AUTHORIZED_VENDOR", dataMode: "LIVE", supportsQueryPlan: vi.fn(), search: vi.fn() } as unknown as PlaceProvider;
			const intents = { resolve: vi.fn() } as unknown as IntentCoordinator;
			const rights = { effectiveMode: vi.fn() } as unknown as DataRightsPolicy;
			const registry = new RecommendationRequestRegistry();
			const issue = vi.spyOn(registry, "issue");
			const revoke = vi.spyOn(registry, "revoke");
			const service = new RecommendationsService(base, places, intents, registry, rights, operational);
			await expect(service.recommend(RecommendationContextSchema.parse({
				location: { latitude: 39.9928, longitude: 116.3109 }, mealPeriod: "LUNCH", radiusMeters: 1500,
			}))).rejects.toMatchObject({ status: 503, response: { code: "OPERATIONAL_CONFIG_UNAVAILABLE" } });
			expect(places.supportsQueryPlan).not.toHaveBeenCalled();
			expect(places.search).not.toHaveBeenCalled();
			expect(intents.resolve).not.toHaveBeenCalled();
			expect(rights.effectiveMode).not.toHaveBeenCalled();
			expect(issue).not.toHaveBeenCalled();
			expect(revoke).not.toHaveBeenCalled();
			expect(registry.diagnostics().activeRequestCount).toBe(0);
			registry.onModuleDestroy();
		},
	);

	it("rejects a radius above the active operations ceiling before provider calls", async () => {
		const places = {
			kind: "AUTHORIZED_VENDOR",
			dataMode: "LIVE",
			search: vi.fn(),
		} as unknown as PlaceProvider;
		const intents = { resolve: vi.fn() } as unknown as IntentCoordinator;
		const operationalSnapshot = {
			source: "DATABASE",
			lastSuccessfulReadAt: "2026-09-06T01:00:00.000Z",
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
				promptVersion: "intent-prompt-v1",
				modelVersion: "qwen3.7-flash-2026-07-15",
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
		const revoke = vi.spyOn(registry, "revoke");
		const originalIssue = registry.issue.bind(registry);
		vi.spyOn(registry, "issue").mockImplementation((requestId, references) => {
			originalIssue(requestId, references);
			return ["invalid-token" as ResultToken];
		});
		const config = {
			...loadAppConfig({ NODE_ENV: "test" }),
			versions: {
				rule: "test-rule",
				prompt: "test-prompt",
				ruleFallbackModel: "rule-fallback-v1",
			},
		} as AppConfig;
		const places: PlaceProvider = {
			kind: "AUTHORIZED_VENDOR",
			dataMode: "LIVE",
			supportsQueryPlan: () => true,
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
		expect(registry.issue).toHaveBeenCalledOnce();
		expect(revoke).toHaveBeenCalledWith(expect.any(String));
		expect(registry.diagnostics().activeRequestCount).toBe(0);
		registry.onModuleDestroy();
	});
});

describe("RecommendationsService query-plan coordination", () => {
	it("fails an unsupported plan closed before intent or provider search", async () => {
		const registry = new RecommendationRequestRegistry();
		const supportsQueryPlan = vi.fn(() => false);
		const search = vi.fn();
		const places = {
			kind: "AMAP",
			dataMode: "LIVE",
			supportsQueryPlan,
			search,
		} satisfies PlaceProvider;
		const resolve = vi.fn();
		const intents = { resolve } as unknown as IntentCoordinator;
		const effectiveMode = vi.fn();
		const policy = { effectiveMode } as unknown as DataRightsPolicy;
		const config = {
			...loadAppConfig({ NODE_ENV: "test" }),
			versions: {
				rule: "test-rule",
				prompt: "test-prompt",
				ruleFallbackModel: "rule-fallback-v1",
			},
		} as AppConfig;
		const service = new RecommendationsService(
			config,
			places,
			intents,
			registry,
			policy,
		);
		const context = RecommendationContextSchema.parse({
			location: { latitude: 39.9928, longitude: 116.3109 },
			locationLabel: "不应进入错误响应的测试地点",
			mealPeriod: "LUNCH",
			target: "COFFEE",
			radiusMeters: 1_500,
		});

		const error = await service.recommend(context).catch((caught) => caught);
		const response = (
			error as Readonly<{ getResponse: () => unknown }>
		).getResponse();

		expect(response).toEqual({
			code: "PLACE_PROVIDER_UNAVAILABLE",
			message: "餐厅数据服务暂时不可用，请稍后重试",
		});
		expect(JSON.stringify(response)).not.toMatch(
			/39\.9928|116\.3109|测试地点|COFFEE/u,
		);
		expect(supportsQueryPlan).toHaveBeenCalledOnce();
		expect(supportsQueryPlan).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: expect.objectContaining({ target: "COFFEE" }),
			}),
		);
		expect(resolve).not.toHaveBeenCalled();
		expect(search).not.toHaveBeenCalled();
		expect(effectiveMode).not.toHaveBeenCalled();
		registry.onModuleDestroy();
	});

	it.each([
		{
			name: "specialty",
			request: { target: "COFFEE" as const },
		},
		{
			name: "user weather",
			request: {
				weatherContext: {
					kind: "USER_REPORTED" as const,
					preference: "COOLING" as const,
				},
			},
		},
	] as const)(
		"blocks a real AMap $name plan before intent and network I/O",
		async ({ request }) => {
			const registry = new RecommendationRequestRegistry();
			const config = loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			});
			const fetchMock = vi.fn();
			const places = new AmapPlaceProvider(config, fetchMock as typeof fetch);
			const search = vi.spyOn(places, "search");
			const resolve = vi.fn();
			const policy = { effectiveMode: vi.fn() } as unknown as DataRightsPolicy;
			const service = new RecommendationsService(
				config,
				places,
				{ resolve } as unknown as IntentCoordinator,
				registry,
				policy,
			);
			const context = RecommendationContextSchema.parse({
				location: { latitude: 39.9928, longitude: 116.3109 },
				mealPeriod: "LUNCH",
				radiusMeters: 1_500,
				...request,
			});

			const error = await service.recommend(context).catch((caught) => caught);
			expect(
				(error as Readonly<{ getResponse: () => unknown }>).getResponse(),
			).toEqual({
				code: "PLACE_PROVIDER_UNAVAILABLE",
				message: "餐厅数据服务暂时不可用，请稍后重试",
			});
			expect(resolve).not.toHaveBeenCalled();
			expect(search).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			registry.onModuleDestroy();
		},
	);

	it("echoes the demo profile and applied user weather while preserving LIVE ordering", async () => {
		const registry = new RecommendationRequestRegistry();
		const config = loadAppConfig({
			NODE_ENV: "test",
			QWEN_ENABLED: "true",
			QWEN_BASE_URL:
				"https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
			QWEN_API_KEY: "test-key",
		});
		const qwenFetch = vi.fn();
		const intents = new IntentCoordinator(
			config,
			new QwenIntentProvider(config, qwenFetch as typeof fetch),
			new RuleIntentProvider(),
		);
		const policy = {
			effectiveMode: vi.fn(async () => "LIVE_DISPLAY_ONLY" as const),
		} as unknown as DataRightsPolicy;
		const service = new RecommendationsService(
			config,
			new DemoPlaceProvider(),
			intents,
			registry,
			policy,
		);

		const response = await service.recommend(
			RecommendationContextSchema.parse({
				location: { latitude: 39.9928, longitude: 116.3109 },
				mealPeriod: "LUNCH",
				target: "COFFEE",
				weatherContext: { kind: "USER_REPORTED", preference: "WARMING" },
				radiusMeters: 1_500,
			}),
		);

		expect(response.profile).toEqual({
			target: "COFFEE",
			family: "COFFEE",
			version: "coffee-v1",
			providerCapabilityRequired: true,
		});
		expect(response.weatherApplication).toEqual({
			kind: "USER_REPORTED",
			version: "user-reported-weather-v1",
			preference: "WARMING",
			queryModifier: "PREFER_WARMING_OPTIONS",
		});
		expect(response.results.map((result) => result.name)).toEqual([
			"演示·九点钟咖啡馆",
			"演示·纸上森林咖啡",
			"演示·信号灯咖啡站",
		]);
		expect(response.results.map((result) => result.rank)).toEqual([1, 2, 3]);
		expect(response.results.every((result) => result.fitScore === null)).toBe(
			true,
		);
		expect(
			response.results.every((result) =>
				result.tags.includes("演示查询条件·用户自报偏暖已应用"),
			),
		).toBe(true);
		expect(qwenFetch).not.toHaveBeenCalled();
		registry.onModuleDestroy();
	});
});
