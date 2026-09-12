import {
	CuisinePreferenceSchema,
	IntentProfileSchema,
	RecommendationContextSchema,
} from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { RecommendationRequestRegistry } from "../../common/recommendation-request.registry.js";
import { type AppConfig, loadAppConfig } from "../../config/app-config.js";
import type { DataRightsPolicy } from "../../config/data-rights-policy.js";
import { startupOperationalConfig } from "../../operational-config/operational-config.types.js";
import { constrainExplicitIntent } from "../domain/explicit-cuisine-preference.js";
import { buildRecommendationQueryPlan } from "../domain/recommendation-query-plan.js";
import { RecommendationsService } from "../recommendations.service.js";
import { DemoPlaceProvider } from "./demo-place.provider.js";
import { IntentCoordinator } from "./intent-coordinator.js";
import { QwenIntentProvider } from "./qwen-intent.provider.js";
import { qwenSafeContext } from "./qwen-intent-registry.js";
import { buildRuleIntent, RuleIntentProvider } from "./rule-intent.provider.js";

const config = () =>
	loadAppConfig({
		NODE_ENV: "test",
		QWEN_ENABLED: "true",
		QWEN_BASE_URL:
			"https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		QWEN_API_KEY: "synthetic-test-key",
		AMAP_ENABLED: "false",
	});
const context = () =>
	RecommendationContextSchema.parse({
		location: { latitude: 0, longitude: 0, crs: "WGS84" },
		locationLabel: "合成隐私标签",
		mealPeriod: "LUNCH",
		radiusMeters: 1500,
		preferredCuisines: ["米饭", "面食", "米饭"],
		excludedCuisines: ["川湘菜", "火锅", "川湘菜"],
	});
const rawIntent = () => ({
	cuisineWeights: { 火锅: 1, 面食: 0, 米饭: 0.2 },
	mealTypes: ["火锅", "快餐"],
	speedPreference: "RELAXED",
	diversityTarget: 0.99,
	explanationSeed: "合成回包方向",
});
function qwenResponse(content: unknown): Response {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content: JSON.stringify(content) } }],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("Qwen explicit preference input and response boundaries", () => {
	it("normalizes both choice sets into identical privacy-minimal payloads", async () => {
		const payloads: unknown[] = [];
		const fetchMock = vi.fn(
			async (_url: URL | RequestInfo, init?: RequestInit) => {
				const payload = JSON.parse(String(init?.body));
				payloads.push(payload);
				return qwenResponse(rawIntent());
			},
		);
		const provider = new QwenIntentProvider(
			config(),
			fetchMock as typeof fetch,
		);
		const original = context();
		const before = structuredClone(original);
		const first = await provider.resolve(original);
		const second = await provider.resolve({
			...original,
			preferredCuisines: ["面食", "米饭"],
			excludedCuisines: ["火锅", "川湘菜"],
		});
		expect(payloads[0]).toEqual(payloads[1]);
		expect(qwenSafeContext(original)).toMatchObject({
			preferredCuisines: ["面食", "米饭"],
			excludedCuisines: ["火锅", "川湘菜"],
		});
		const serialized = JSON.stringify(payloads);
		for (const forbidden of [
			"location",
			"latitude",
			"longitude",
			"合成隐私标签",
			"account",
			"device",
			"partySize",
		])
			expect(serialized).not.toContain(forbidden);
		expect(first).toEqual(second);
		expect(first.cuisineWeights).toEqual({ 面食: 1, 米饭: 1 });
		expect(first.mealTypes.slice(0, 2)).toEqual(["面食", "米饭"]);
		expect(original).toEqual(before);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ cuisineWeights: { 面食: 0, 米饭: 1 }, mealTypes: ["米饭"] },
		{ cuisineWeights: { 面食: 1, 米饭: 0 }, mealTypes: ["面食"] },
		{ cuisineWeights: { 火锅: 1 }, mealTypes: ["火锅", "快餐"] },
		{ cuisineWeights: {}, mealTypes: ["正餐"] },
	])(
		"constrains a real parsed success response even when called directly: %j",
		async (patch) => {
			const raw = { ...rawIntent(), ...patch };
			const fetchMock = vi.fn(async () => qwenResponse(raw));
			const profile = await new QwenIntentProvider(
				config(),
				fetchMock as typeof fetch,
			).resolve(context());
			expect(profile.cuisineWeights).toEqual({ 面食: 1, 米饭: 1 });
			expect(profile.mealTypes.slice(0, 2)).toEqual(["面食", "米饭"]);
			expect(profile).toMatchObject({
				speedPreference: raw.speedPreference,
				diversityTarget: raw.diversityTarget,
				explanationSeed: raw.explanationSeed,
				provider: "QWEN",
			});
			expect(constrainExplicitIntent(context(), profile)).toEqual(profile);
			expect(fetchMock).toHaveBeenCalledOnce();
		},
	);
	it("preserves the complete parsed Qwen result for an empty preference set", async () => {
		const raw = rawIntent();
		const fetchMock = vi.fn(async () => qwenResponse(raw));
		const result = await new QwenIntentProvider(
			config(),
			fetchMock as typeof fetch,
		).resolve({ ...context(), preferredCuisines: [] });
		expect(result).toEqual({ ...raw, provider: "QWEN" });
	});
	it("never truncates any of eight explicit choices behind model hints", async () => {
		const raw = {
			...rawIntent(),
			mealTypes: [
				"午餐",
				"快餐",
				"盖饭",
				"简餐",
				"正餐",
				"聚餐",
				"咖啡店",
				"甜品",
			],
		};
		const fetchMock = vi.fn(async () => qwenResponse(raw));
		const result = await new QwenIntentProvider(
			config(),
			fetchMock as typeof fetch,
		).resolve({
			...context(),
			preferredCuisines: [...CuisinePreferenceSchema.options].reverse(),
		});
		expect(result.mealTypes).toEqual(CuisinePreferenceSchema.options);
		expect(Object.values(result.cuisineWeights)).toEqual(Array(8).fill(1));
	});
	it.each([
		{ aiAssistanceEnabled: false },
		{ mealPeriod: "BREAKFAST" },
		{ mealPeriod: "DINNER" },
		{ target: "COFFEE" },
		{ weatherContext: { kind: "USER_REPORTED", preference: "WARMING" } },
	])(
		"keeps direct Qwen calls at zero I/O for a disabled path: %j",
		async (patch) => {
			const fetchMock = vi.fn();
			const provider = new QwenIntentProvider(
				config(),
				fetchMock as typeof fetch,
			);
			await expect(
				provider.resolve(
					RecommendationContextSchema.parse({ ...context(), ...patch }),
				),
			).rejects.toThrow("AI 意图服务暂时不可用");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ cuisineWeights: { 面食: 2 } },
		{ mealTypes: Array(9).fill("面食") },
		{ speedPreference: "UNKNOWN" },
		{ explanationSeed: "" },
	])(
		"does not repair invalid model structure into a successful response: %j",
		async (patch) => {
			const fetchMock = vi.fn(async () =>
				qwenResponse({ ...rawIntent(), ...patch }),
			);
			const appConfig = config();
			const result = await new IntentCoordinator(
				appConfig,
				new QwenIntentProvider(appConfig, fetchMock as typeof fetch),
				new RuleIntentProvider(),
			).resolve({ ...context(), preferredCuisines: [] });
			expect(result.profile.cuisineWeights).toEqual({});
			expect(result.profile.provider).toBe("RULE_FALLBACK");
			expect(result.fallbackUsed).toBe(true);
			expect(result.modelVersion).toBe(appConfig.versions.ruleFallbackModel);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);
	it("does not erase an explicitly chosen category merely because it is also excluded", async () => {
		const input = {
			...context(),
			preferredCuisines: ["面食", "火锅"] as const,
			excludedCuisines: ["火锅"] as const,
		};
		const parsed = RecommendationContextSchema.parse(input);
		const fetchMock = vi.fn(async () => qwenResponse(rawIntent()));
		const result = await new QwenIntentProvider(
			config(),
			fetchMock as typeof fetch,
		).resolve(parsed);
		expect(result.cuisineWeights).toEqual({ 面食: 1, 火锅: 1 });
		expect(qwenSafeContext(parsed).excludedCuisines).toEqual(["火锅"]);
	});
});

describe("coordinator public exits", () => {
	it.each(["LIVE_DISPLAY_ONLY", "LICENSED_ENRICHMENT"] as const)(
		"skips unused AI for explicit choices and reports the public execution state in %s",
		async (dataRightsMode) => {
			const appConfig = { ...config(), dataRightsMode };
			const fetchMock = vi.fn(() => {
				throw new Error("Unused model must not run");
			});
			const places = new DemoPlaceProvider();
			const search = vi.spyOn(places, "search");
			const registry = new RecommendationRequestRegistry();
			const rights = {
				effectiveMode: async () => dataRightsMode,
			} as DataRightsPolicy;
			const service = new RecommendationsService(
				appConfig,
				places,
				new IntentCoordinator(
					appConfig,
					new QwenIntentProvider(appConfig, fetchMock as typeof fetch),
					new RuleIntentProvider(),
				),
				registry,
				rights,
			);
			try {
				const response = await service.recommend(context());
				expect(response.results.length).toBeGreaterThan(0);
				expect(response.aiFallbackUsed).toBe(false);
				expect(response.modelVersion).toBe(
					appConfig.versions.ruleFallbackModel,
				);
				expect(
					response.results.every((result) => result.aiAssisted === false),
				).toBe(true);
				expect(fetchMock).not.toHaveBeenCalled();
				expect(search).toHaveBeenCalledWith(
					expect.objectContaining({
						preferredCuisines: context().preferredCuisines,
					}),
					expect.objectContaining({ queryTerms: ["午餐", "面食", "米饭"] }),
				);
			} finally {
				registry.onModuleDestroy();
			}
		},
	);

	it.each(["SUCCESS", "FAILURE"] as const)(
		"keeps meaningful LIVE explanation assistance and distinguishes %s from a policy skip",
		async (outcome) => {
			const appConfig = config();
			const fetchMock = vi.fn(async () =>
				outcome === "SUCCESS"
					? qwenResponse({
							...rawIntent(),
							cuisineWeights: { 面食: 1 },
							mealTypes: ["面食"],
						})
					: new Response("synthetic unavailable", { status: 502 }),
			);
			const registry = new RecommendationRequestRegistry();
			const rights = {
				effectiveMode: async () => "LIVE_DISPLAY_ONLY" as const,
			} as DataRightsPolicy;
			const service = new RecommendationsService(
				appConfig,
				new DemoPlaceProvider(),
				new IntentCoordinator(
					appConfig,
					new QwenIntentProvider(appConfig, fetchMock as typeof fetch),
					new RuleIntentProvider(),
				),
				registry,
				rights,
			);
			try {
				const response = await service.recommend({
					...context(),
					preferredCuisines: [],
					availableMinutes: 15,
				});
				expect(response.results.length).toBeGreaterThan(0);
				expect(response.aiFallbackUsed).toBe(outcome === "FAILURE");
				expect(
					response.results.every(
						(result) => result.aiAssisted === (outcome === "SUCCESS"),
					),
				).toBe(true);
				expect(
					response.results.every((result) => result.fitScore === null),
				).toBe(true);
				expect(fetchMock).toHaveBeenCalledTimes(outcome === "SUCCESS" ? 1 : 2);
				if (outcome === "SUCCESS")
					expect(response.results[0]?.reasons).toContainEqual({
						code: "MEAL_FIT",
						text: "餐厅标签包含“面食”，符合本次用餐方向",
					});
			} finally {
				registry.onModuleDestroy();
			}
		},
	);

	it("uses a single-person dinner direction without a group-size branch", () => {
		const request = RecommendationContextSchema.parse({
			...context(),
			mealPeriod: "DINNER",
			preferredCuisines: [],
		});
		expect(buildRuleIntent(request).mealTypes).toEqual([
			"晚餐",
			"正餐",
			"家常菜",
			"面食",
		]);
		expect(qwenSafeContext(request)).not.toHaveProperty("partySize");
	});
	it.each([
		"QWEN_SUCCESS",
		"QWEN_FAILURE",
		"OPT_OUT",
		"CONFIG_DISABLED",
		"OPERATOR_DISABLED",
		"PROMPT_DISABLED",
		"RULES_REQUIRED",
	] as const)(
		"keeps execution and fallback metadata correct without explicit choices on %s",
		async (path) => {
			const enabled = config();
			const appConfig: AppConfig =
				path === "CONFIG_DISABLED"
					? { ...enabled, qwen: { ...enabled.qwen, enabled: false } }
					: enabled;
			const request = {
				...context(),
				preferredCuisines: [],
				aiAssistanceEnabled: path !== "OPT_OUT",
				mealPeriod:
					path === "RULES_REQUIRED" ? ("DINNER" as const) : ("LUNCH" as const),
			};
			const qwen = new QwenIntentProvider(appConfig, vi.fn() as typeof fetch);
			const rules = new RuleIntentProvider();
			const adversarial = IntentProfileSchema.parse({
				...rawIntent(),
				provider: path === "QWEN_SUCCESS" ? "QWEN" : "RULE_FALLBACK",
			});
			const qwenSpy = vi.spyOn(qwen, "resolve");
			if (path === "QWEN_FAILURE")
				qwenSpy.mockRejectedValue(new Error("Synthetic failure"));
			else qwenSpy.mockResolvedValue(adversarial);
			const rulesSpy = vi
				.spyOn(rules, "resolve")
				.mockResolvedValue(adversarial);
			const operational = startupOperationalConfig(appConfig, "DATABASE");
			const result = await new IntentCoordinator(
				appConfig,
				qwen,
				rules,
			).resolve(request, undefined, {
				...operational,
				aiAssistanceEnabled: path !== "OPERATOR_DISABLED",
				prompt: { ...operational.prompt, enabled: path !== "PROMPT_DISABLED" },
			});
			expect(result.profile.cuisineWeights).toEqual(adversarial.cuisineWeights);
			expect(result.profile.mealTypes).toEqual(adversarial.mealTypes);
			expect(result.profile).toMatchObject({
				speedPreference: "RELAXED",
				diversityTarget: 0.99,
				explanationSeed: "合成回包方向",
			});
			expect(constrainExplicitIntent(request, result.profile)).toEqual(
				result.profile,
			);
			expect(result.fallbackUsed).toBe(path === "QWEN_FAILURE");
			const qwenUsed = path === "QWEN_SUCCESS" || path === "QWEN_FAILURE";
			expect(qwenSpy).toHaveBeenCalledTimes(qwenUsed ? 1 : 0);
			expect(rulesSpy).toHaveBeenCalledTimes(path === "QWEN_SUCCESS" ? 0 : 1);
			expect(result.modelVersion).toBe(
				path === "QWEN_SUCCESS"
					? operational.prompt.modelVersion
					: appConfig.versions.ruleFallbackModel,
			);
		},
	);
	it.each(["MEAL", "COFFEE", "MILK_TEA", "DESSERT"] as const)(
		"keeps all eight choices and a leading %s query profile in deterministic rules",
		(target) => {
			const request = RecommendationContextSchema.parse({
				...context(),
				target,
				preferredCuisines: [...CuisinePreferenceSchema.options].reverse(),
			});
			const plan = buildRecommendationQueryPlan(request);
			const profile = buildRuleIntent(request, plan);
			expect(profile.mealTypes).toEqual(CuisinePreferenceSchema.options);
			expect(profile.cuisineWeights).toEqual(
				Object.fromEntries(
					CuisinePreferenceSchema.options.map((cuisine) => [cuisine, 1]),
				),
			);
			expect(plan.queryTerms[0]).toBe(plan.preferredTerm);
			expect(profile.provider).toBe("RULE_FALLBACK");
		},
	);
});
