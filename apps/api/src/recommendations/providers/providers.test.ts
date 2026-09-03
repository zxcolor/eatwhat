import { RecommendationContextSchema } from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { type AppConfig, loadAppConfig } from "../../config/app-config.js";
import { getAmapFailureDiagnostic } from "../../providers/amap-response-status.js";
import { toGcj02 } from "../domain/geo.js";
import {
	buildRecommendationQueryPlan,
	type RecommendationQueryPlan,
} from "../domain/recommendation-query-plan.js";
import {
	AMAP_RESPONSE_MAX_BYTES,
	AmapPlaceProvider,
	interpretAmapOpenStatus,
	PlaceProviderUnavailableError,
} from "./amap-place.provider.js";
import { DemoPlaceProvider } from "./demo-place.provider.js";
import { IntentCoordinator } from "./intent-coordinator.js";
import { QwenIntentProvider } from "./qwen-intent.provider.js";
import { buildRuleIntent, RuleIntentProvider } from "./rule-intent.provider.js";
import { UnavailablePlaceProvider } from "./unavailable-place.provider.js";

const recommendationContext = RecommendationContextSchema.parse({
	location: {
		latitude: 39.9928,
		longitude: 116.3109,
		accuracyMeters: 15,
		crs: "WGS84",
	},
	locationLabel: "测试大学",
	mealPeriod: "LUNCH",
	radiusMeters: 1_500,
	budgetMaxYuan: 30,
	availableMinutes: 45,
	preferredCuisines: ["面食"],
});

function queryPlan(
	context = recommendationContext,
	queryTerms?: readonly string[],
): RecommendationQueryPlan {
	const plan = buildRecommendationQueryPlan(context);
	return queryTerms === undefined
		? plan
		: Object.freeze({ ...plan, queryTerms: Object.freeze([...queryTerms]) });
}

function enabledConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	const base = loadAppConfig({
		NODE_ENV: "test",
		QWEN_ENABLED: "true",
		QWEN_BASE_URL:
			"https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		QWEN_API_KEY: "test-key",
		AMAP_ENABLED: "false",
	});
	return { ...base, ...overrides };
}

describe("intent providers", () => {
	it("builds deterministic meal intent without AI", () => {
		const profile = buildRuleIntent(recommendationContext);
		expect(profile.provider).toBe("RULE_FALLBACK");
		expect(profile.speedPreference).toBe("FAST");
		expect(profile.mealTypes).toContain("面食");
	});

	it("sends only privacy-minimal context to the Beijing Qwen workspace", async () => {
		const fetchMock = vi.fn(
			async (_url: URL | RequestInfo, init?: RequestInit) => {
				const serialized = String(init?.body);
				expect(serialized).not.toContain("39.9928");
				expect(serialized).not.toContain("116.3109");
				expect(serialized).not.toContain("测试大学");
				expect(serialized).not.toContain("location");
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										cuisineWeights: { 面食: 1 },
										mealTypes: ["面食", "快餐"],
										speedPreference: "FAST",
										diversityTarget: 0.5,
										explanationSeed: "适合快速午餐",
									}),
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		);
		const provider = new QwenIntentProvider(
			enabledConfig(),
			fetchMock as typeof fetch,
		);
		const profile = await provider.resolve(recommendationContext);
		expect(profile.provider).toBe("QWEN");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("falls back to rules after a Qwen failure", async () => {
		const fetchMock = vi.fn(
			async () => new Response("bad gateway", { status: 502 }),
		);
		const config = enabledConfig();
		const qwen = new QwenIntentProvider(config, fetchMock as typeof fetch);
		const coordinator = new IntentCoordinator(
			config,
			qwen,
			new RuleIntentProvider(),
		);
		const result = await coordinator.resolve(recommendationContext);
		expect(result.profile.provider).toBe("RULE_FALLBACK");
		expect(result.fallbackUsed).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("honors a user AI opt-out without calling Qwen", async () => {
		const fetchMock = vi.fn();
		const config = enabledConfig();
		const qwen = new QwenIntentProvider(config, fetchMock as typeof fetch);
		const coordinator = new IntentCoordinator(
			config,
			qwen,
			new RuleIntentProvider(),
		);
		const result = await coordinator.resolve({
			...recommendationContext,
			aiAssistanceEnabled: false,
		});
		expect(result.profile.provider).toBe("RULE_FALLBACK");
		expect(result.fallbackUsed).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "breakfast profile",
			context: RecommendationContextSchema.parse({
				...recommendationContext,
				mealPeriod: "BREAKFAST",
			}),
			expectedFirstTerm: "面食",
		},
		{
			name: "dinner profile",
			context: RecommendationContextSchema.parse({
				...recommendationContext,
				mealPeriod: "DINNER",
			}),
			expectedFirstTerm: "面食",
		},
		{
			name: "specialty target",
			context: RecommendationContextSchema.parse({
				...recommendationContext,
				target: "COFFEE",
			}),
			expectedFirstTerm: "咖啡店",
		},
		{
			name: "user-reported weather",
			context: RecommendationContextSchema.parse({
				...recommendationContext,
				weatherContext: { kind: "USER_REPORTED", preference: "WARMING" },
			}),
			expectedFirstTerm: "面食",
		},
	] as const)("forces deterministic rules for $name", async (entry) => {
		const fetchMock = vi.fn();
		const config = enabledConfig();
		const coordinator = new IntentCoordinator(
			config,
			new QwenIntentProvider(config, fetchMock as typeof fetch),
			new RuleIntentProvider(),
		);
		const plan = buildRecommendationQueryPlan(entry.context);

		const result = await coordinator.resolve(entry.context, plan);

		expect(result.profile.provider).toBe("RULE_FALLBACK");
		expect(result.profile.mealTypes[0]).toBe(entry.expectedFirstTerm);
		expect(result.fallbackUsed).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("place providers", () => {
	it("returns only clearly marked fictional demo restaurants", async () => {
		const results = await new DemoPlaceProvider().search(
			recommendationContext,
			queryPlan(),
		);
		expect(results.length).toBeGreaterThanOrEqual(3);
		expect(results.every((result) => result.name.startsWith("演示·"))).toBe(
			true,
		);
		expect(
			results.every((result) => result.sourceAttribution.includes("虚构")),
		).toBe(true);
		expect(results.every((result) => result.location.crs === "WGS84")).toBe(
			true,
		);
		expect(
			results.every(
				(result) =>
					result.dataMode === "DEMO" &&
					result.actions.navigate &&
					result.actions.call &&
					result.actions.copyAddress &&
					!result.actions.share,
			),
		).toBe(true);
	});

	it("preserves the input CRS when creating demo offsets", async () => {
		const gcjContext = {
			...recommendationContext,
			location: toGcj02(recommendationContext.location),
		};
		const results = await new DemoPlaceProvider().search(
			gcjContext,
			queryPlan(gcjContext),
		);
		expect(results.every((result) => result.location.crs === "GCJ02")).toBe(
			true,
		);
	});

	it("supports all six current v1 demo profiles with bounded user weather", () => {
		const provider = new DemoPlaceProvider();
		const profiles = [
			{ target: "MEAL" as const, mealPeriod: "BREAKFAST" as const },
			{ target: "MEAL" as const, mealPeriod: "LUNCH" as const },
			{ target: "MEAL" as const, mealPeriod: "DINNER" as const },
			{ target: "MILK_TEA" as const, mealPeriod: "LUNCH" as const },
			{ target: "COFFEE" as const, mealPeriod: "LUNCH" as const },
			{ target: "DESSERT" as const, mealPeriod: "LUNCH" as const },
		];

		for (const profile of profiles) {
			for (const weatherContext of [
				{ kind: "NONE" as const },
				{ kind: "USER_REPORTED" as const, preference: "WARMING" as const },
			]) {
				const context = RecommendationContextSchema.parse({
					...recommendationContext,
					...profile,
					weatherContext,
				});
				expect(
					provider.supportsQueryPlan(buildRecommendationQueryPlan(context)),
				).toBe(true);
			}
		}
	});

	it.each([
		["MILK_TEA", "奶茶店"],
		["COFFEE", "咖啡店"],
		["DESSERT", "甜品店"],
	] as const)(
		"returns a distinct fictional %s fixture in stable provider order",
		async (target, expectedTag) => {
			const context = RecommendationContextSchema.parse({
				...recommendationContext,
				target,
			});
			const plan = buildRecommendationQueryPlan(context);
			const provider = new DemoPlaceProvider();

			expect(provider.supportsQueryPlan(plan)).toBe(true);
			const first = await provider.search(context, plan);
			const second = await provider.search(context, plan);

			expect(first).toHaveLength(4);
			expect(first.map((candidate) => candidate.providerRank)).toEqual([
				1, 2, 3, 4,
			]);
			expect(first.map((candidate) => candidate.providerPlaceId)).toEqual(
				second.map((candidate) => candidate.providerPlaceId),
			);
			expect(
				first.every(
					(candidate) =>
						candidate.name.startsWith("演示·") &&
						candidate.tags.includes(expectedTag),
				),
			).toBe(true);
		},
	);

	it("applies user-reported weather only as an explicit demo query modifier", async () => {
		const context = RecommendationContextSchema.parse({
			...recommendationContext,
			target: "COFFEE",
			weatherContext: { kind: "USER_REPORTED", preference: "WARMING" },
		});
		const plan = buildRecommendationQueryPlan(context);
		const provider = new DemoPlaceProvider();
		const results = await provider.search(context, plan);

		expect(results.map((candidate) => candidate.providerRank)).toEqual([
			2, 3, 4,
		]);
		expect(
			results.every((candidate) =>
				candidate.tags.includes("演示查询条件·用户自报偏暖已应用"),
			),
		).toBe(true);
		expect(
			results.flatMap((candidate) => candidate.tags).join(" "),
		).not.toMatch(/真实天气|实时天气|气温/u);
	});

	it("fails specialty and user-reported plans closed before live provider I/O", async () => {
		const config = loadAppConfig({
			NODE_ENV: "test",
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: "test-key",
		});
		const fetchMock = vi.fn();
		const amap = new AmapPlaceProvider(config, fetchMock as typeof fetch);
		const unavailable = new UnavailablePlaceProvider();
		const specialty = buildRecommendationQueryPlan(
			RecommendationContextSchema.parse({
				...recommendationContext,
				target: "COFFEE",
			}),
		);
		const weather = buildRecommendationQueryPlan(
			RecommendationContextSchema.parse({
				...recommendationContext,
				weatherContext: { kind: "USER_REPORTED", preference: "COOLING" },
			}),
		);
		const capabilityRequiredMeal = Object.freeze({
			...queryPlan(),
			providerCapabilityRequired: true,
		}) satisfies RecommendationQueryPlan;

		expect(amap.supportsQueryPlan(queryPlan())).toBe(true);
		expect(unavailable.supportsQueryPlan(queryPlan())).toBe(true);
		for (const plan of [specialty, weather, capabilityRequiredMeal]) {
			expect(amap.supportsQueryPlan(plan)).toBe(false);
			expect(unavailable.supportsQueryPlan(plan)).toBe(false);
			await expect(
				amap.search(recommendationContext, plan),
			).rejects.toMatchObject({ reason: "UNSUPPORTED_QUERY_PLAN" });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not call AMap when it is disabled", async () => {
		const fetchMock = vi.fn();
		const provider = new AmapPlaceProvider(
			loadAppConfig({ NODE_ENV: "test", AMAP_ENABLED: "false" }),
			fetchMock as typeof fetch,
		);
		await expect(
			provider.search(recommendationContext, queryPlan()),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps the breakfast profile keyword ahead of user cuisine for AMap", async () => {
		const breakfastContext = RecommendationContextSchema.parse({
			...recommendationContext,
			mealPeriod: "BREAKFAST",
			preferredCuisines: ["火锅"],
		});
		const breakfastPlan = buildRecommendationQueryPlan(breakfastContext);
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			expect(new URL(String(input)).searchParams.get("keywords")).toBe("早餐");
			return new Response(
				JSON.stringify({ status: "1", infocode: "10000", pois: [] }),
				{ status: 200 },
			);
		});
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);

		expect(breakfastPlan.queryTerms).toEqual(["早餐", "火锅"]);
		await provider.search(breakfastContext, breakfastPlan);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("uses the official HTTPS around query, maps a live-shaped response and never caches", async () => {
		const fetchMock = vi.fn(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("https://restapi.amap.com");
				expect(url.pathname).toBe("/v5/place/around");
				expect(url.searchParams.get("key")).toBe("test-key");
				const expectedOrigin = toGcj02(recommendationContext.location);
				expect(url.searchParams.get("location")).toBe(
					`${expectedOrigin.longitude.toFixed(6)},${expectedOrigin.latitude.toFixed(6)}`,
				);
				expect(url.searchParams.get("radius")).toBe("1500");
				expect(url.searchParams.get("types")).toBe("050000");
				expect(url.searchParams.get("sortrule")).toBe("distance");
				expect(url.searchParams.has("region")).toBe(false);
				expect(url.searchParams.has("city_limit")).toBe(false);
				expect(url.searchParams.get("page_size")).toBe("25");
				expect(url.searchParams.get("page_num")).toBe("1");
				expect(url.searchParams.get("show_fields")).toBe("business");
				expect(url.searchParams.get("output")).toBe("json");
				const keyword = url.searchParams.get("keywords");
				expect(keyword).toBe("面食");
				expect(keyword).not.toContain("|");
				expect(Array.from(keyword ?? "").length).toBeLessThanOrEqual(80);
				expect(init).toMatchObject({
					method: "GET",
					cache: "no-store",
					redirect: "error",
					referrerPolicy: "no-referrer",
				});
				return new Response(
					JSON.stringify({
						status: "1",
						info: "OK",
						infocode: "10000",
						count: "2",
						pois: [
							{
								id: "amap-1",
								name: "测试餐厅",
								address: "测试路 1 号",
								location: "116.315,39.993",
								distance: "420",
								type: "餐饮服务;中餐厅",
								business: {
									rating: "4.6",
									cost: "28",
									tag: "面食",
									opentime_today: "全天",
								},
								photos: [{ url: "https://example.com/a.jpg" }],
							},
							{ id: "broken", name: "无坐标" },
						],
					}),
					{ status: 200 },
				);
			},
		);
		const config = loadAppConfig({
			NODE_ENV: "test",
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: "test-key",
		});
		const provider = new AmapPlaceProvider(config, fetchMock as typeof fetch);
		const first = await provider.search(
			recommendationContext,
			queryPlan(recommendationContext, ["面食", "午餐", "面食"]),
		);
		const second = await provider.search(
			recommendationContext,
			queryPlan(recommendationContext, ["面食", "午餐", "面食"]),
		);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({
			provider: "AMAP",
			providerPlaceId: "amap-1",
			dataMode: "LIVE",
			actions: {
				navigate: false,
				call: false,
				copyAddress: false,
				share: false,
			},
			sourceRating: 4.6,
			averageCostYuan: 28,
			openStatus: "OPEN",
			imageUrl: null,
			location: expect.objectContaining({ crs: "GCJ02" }),
		});
		expect(second).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not offset an already-GCJ02 request origin a second time", async () => {
		const gcjContext = {
			...recommendationContext,
			location: toGcj02(recommendationContext.location),
		};
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			expect(new URL(String(input)).searchParams.get("location")).toBe(
				`${gcjContext.location.longitude.toFixed(6)},${gcjContext.location.latitude.toFixed(6)}`,
			);
			return new Response(
				JSON.stringify({ status: "1", infocode: "10000", pois: [] }),
				{ status: 200 },
			);
		});
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);

		await provider.search(gcjContext, queryPlan(gcjContext));
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("drops unsafe keywords and treats blank numeric fields as unknown", async () => {
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			const url = new URL(String(input));
			expect(url.searchParams.get("keywords")).toBe("面食");
			expect(url.toString()).not.toContain("13800138000");
			return new Response(
				JSON.stringify({
					status: "1",
					infocode: "10000",
					pois: [
						{
							id: "amap-blank-fields",
							name: "字段缺失餐厅",
							address: "测试地址",
							location: "116.3209,39.9928",
							distance: "",
							type: "餐饮服务;中餐厅",
							business: { rating: "", cost: "", opentime_today: "全天" },
						},
					],
				}),
				{ status: 200 },
			);
		});
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);
		const [candidate] = await provider.search(
			recommendationContext,
			queryPlan(recommendationContext, ["手机号13800138000", "面食"]),
		);
		expect(candidate?.sourceRating).toBeNull();
		expect(candidate?.averageCostYuan).toBeNull();
		expect(candidate?.distanceMeters).toBeGreaterThan(100);
	});

	it("normalizes absent and malformed optional business, biz_ext, cost and distance fields", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						status: "1",
						infocode: "10000",
						pois: [
							{
								id: "malformed-optionals",
								name: "缺失字段餐厅",
								address: [],
								location: "116.314000,39.993000",
								distance: { value: "300" },
								type: "餐饮服务;中餐厅",
								business: [],
								biz_ext: ["not-an-object"],
								photos: [{ url: "http://insecure.example.com/photo.jpg" }],
							},
							{
								id: "legacy-optionals",
								name: "兼容字段餐厅",
								location: "116.315000,39.993000",
								distance: "not-a-number",
								business: { rating: "not-a-number", cost: "" },
								biz_ext: { rating: "4.1", cost: "22" },
								photos: { url: "https://example.com/single.jpg" },
							},
							{
								id: "bad-location",
								name: "错误坐标",
								location: "116.315,39.993,unexpected",
							},
						],
					}),
					{ status: 200 },
				),
		);
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);

		const results = await provider.search(recommendationContext, queryPlan());

		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({
			providerPlaceId: "malformed-optionals",
			address: "",
			sourceRating: null,
			averageCostYuan: null,
			imageUrl: null,
			phone: null,
			openStatus: "UNKNOWN",
		});
		expect(results[0]?.distanceMeters).toBeGreaterThan(100);
		expect(results[1]).toMatchObject({
			providerPlaceId: "legacy-optionals",
			sourceRating: 4.1,
			averageCostYuan: 22,
			imageUrl: null,
		});
	});

	it("skips non-object POI elements while preserving valid peers and upstream rank", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						status: "1",
						infocode: "10000",
						pois: [
							null,
							42,
							"not-a-poi",
							{
								id: "valid-peer",
								name: "有效餐厅",
								location: "116.314000,39.993000",
								business: { cost: "20" },
								photos: [{ url: "https://untrusted.example/poi.jpg" }],
							},
						],
					}),
					{ status: 200 },
				),
		);
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);

		const results = await provider.search(recommendationContext, queryPlan());

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			providerPlaceId: "valid-peer",
			providerRank: 4,
			averageCostYuan: 20,
			imageUrl: null,
		});
	});

	it("rejects an oversized declared response before parsing its body", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ status: "1", infocode: "10000", pois: [] }),
					{
						status: 200,
						headers: { "content-length": String(AMAP_RESPONSE_MAX_BYTES + 1) },
					},
				),
		);
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);

		await expect(
			provider.search(recommendationContext, queryPlan()),
		).rejects.toMatchObject({
			reason: "RESPONSE_TOO_LARGE",
		});
	});

	it("rejects an oversized chunked response even without Content-Length", async () => {
		const firstChunk = new Uint8Array(Math.floor(AMAP_RESPONSE_MAX_BYTES / 2));
		const secondChunk = new Uint8Array(
			AMAP_RESPONSE_MAX_BYTES - firstChunk.byteLength + 1,
		);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(firstChunk);
				controller.enqueue(secondChunk);
				controller.close();
			},
		});
		const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);

		await expect(
			provider.search(recommendationContext, queryPlan()),
		).rejects.toMatchObject({
			reason: "RESPONSE_TOO_LARGE",
		});
	});

	it.each([
		{
			status: "0",
			infocode: "10001",
			reason: "UPSTREAM_REJECTED",
			classification: "CONFIGURATION_OR_PERMISSION",
			safeInfocode: "10001",
		},
		{
			status: "1",
			infocode: "10001",
			reason: "INVALID_RESPONSE",
			classification: "MALFORMED_RESPONSE",
			safeInfocode: "UNKNOWN",
		},
		{
			status: "1",
			infocode: undefined,
			reason: "INVALID_RESPONSE",
			classification: "MALFORMED_RESPONSE",
			safeInfocode: "UNKNOWN",
		},
	] as const)(
		"classifies an unsuccessful official status pair: %o",
		async ({ reason, classification, safeInfocode, ...upstreamStatus }) => {
			const fetchMock = vi.fn(
				async () =>
					new Response(JSON.stringify({ ...upstreamStatus, pois: [] }), {
						status: 200,
					}),
			);
			const provider = new AmapPlaceProvider(
				loadAppConfig({
					NODE_ENV: "test",
					AMAP_ENABLED: "true",
					AMAP_WEB_SERVICE_KEY: "test-key",
				}),
				fetchMock as typeof fetch,
			);

			const error = await provider
				.search(recommendationContext, queryPlan())
				.catch((caught) => caught);
			expect(error).toMatchObject({
				name: "PlaceProviderUnavailableError",
				reason,
				message: "餐厅数据服务暂时不可用",
			});
			expect(getAmapFailureDiagnostic(error)).toEqual({
				classification,
				safeInfocode,
			});
			expect(JSON.stringify(error)).not.toContain(safeInfocode);
		},
	);

	it.each([
		{
			name: "non-2xx HTTP response",
			response: new Response("unavailable", { status: 503 }),
			reason: "UPSTREAM_HTTP",
		},
		{
			name: "malformed JSON",
			response: new Response("{", { status: 200 }),
			reason: "INVALID_RESPONSE",
		},
		{
			name: "successful status with malformed POI collection",
			response: new Response(
				JSON.stringify({ status: "1", infocode: "10000", pois: {} }),
				{ status: 200 },
			),
			reason: "INVALID_RESPONSE",
		},
	])("maps $name to a safe failure category", async ({ response, reason }) => {
		const fetchMock = vi.fn(async () => response);
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);

		await expect(
			provider.search(recommendationContext, queryPlan()),
		).rejects.toMatchObject({
			reason,
		});
	});

	it("aborts a slow request at the configured timeout", async () => {
		const baseConfig = loadAppConfig({
			NODE_ENV: "test",
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: "test-key",
		});
		const config: AppConfig = {
			...baseConfig,
			amap: { ...baseConfig.amap, timeoutMs: 10 },
		};
		const fetchMock = vi.fn(
			async (
				_input: URL | RequestInfo,
				init?: RequestInit,
			): Promise<Response> =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					);
				}),
		);
		const provider = new AmapPlaceProvider(config, fetchMock as typeof fetch);

		await expect(
			provider.search(recommendationContext, queryPlan()),
		).rejects.toMatchObject({
			reason: "TIMEOUT",
		});
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it("also enforces the timeout while streaming the response body", async () => {
		const baseConfig = loadAppConfig({
			NODE_ENV: "test",
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: "test-key",
		});
		const config: AppConfig = {
			...baseConfig,
			amap: { ...baseConfig.amap, timeoutMs: 10 },
		};
		const body = new ReadableStream<Uint8Array>({
			start() {
				// Intentionally leave the stream open until the provider cancels it.
			},
		});
		const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
		const provider = new AmapPlaceProvider(config, fetchMock as typeof fetch);

		await expect(
			provider.search(recommendationContext, queryPlan()),
		).rejects.toMatchObject({
			reason: "TIMEOUT",
		});
	});

	it("cancels the response reader after an unexpected body read failure", async () => {
		const cancel = vi.fn(async () => undefined);
		const response = {
			ok: true,
			headers: new Headers(),
			body: {
				getReader: () => ({
					read: async () => {
						throw new Error("private upstream stream failure");
					},
					cancel,
				}),
			},
		} as unknown as Response;
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			vi.fn(async () => response) as typeof fetch,
		);

		await expect(
			provider.search(recommendationContext, queryPlan()),
		).rejects.toMatchObject({ reason: "INVALID_RESPONSE" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("discards network error details that could contain the request URL", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error(
				"request failed: https://restapi.amap.com/v5/place/around?key=secret&location=116.3109,39.9928",
			);
		});
		const provider = new AmapPlaceProvider(
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
			}),
			fetchMock as typeof fetch,
		);

		const error = await provider
			.search(recommendationContext, queryPlan())
			.catch((caught) => caught);
		expect(error).toBeInstanceOf(PlaceProviderUnavailableError);
		expect(error).toMatchObject({ reason: "NETWORK_ERROR" });
		expect(String(error)).not.toContain("secret");
		expect(String(error)).not.toContain("116.3109");
		expect(String(error)).not.toContain("39.9928");
	});

	it("interprets known, closed and malformed schedules conservatively", () => {
		expect(interpretAmapOpenStatus("全天", "2026-08-20T04:00:00.000Z")).toBe(
			"OPEN",
		);
		expect(interpretAmapOpenStatus("休息", "2026-08-20T04:00:00.000Z")).toBe(
			"CLOSED",
		);
		expect(
			interpretAmapOpenStatus("无可靠数据", "2026-08-20T04:00:00.000Z"),
		).toBe("UNKNOWN");
		expect(
			interpretAmapOpenStatus("09:00-14:00", "2026-08-20T04:00:00.000Z"),
		).toBe("OPEN");
		expect(
			interpretAmapOpenStatus(
				"09:00-10:00 11:00-14:00",
				"2026-08-20T04:00:00.000Z",
			),
		).toBe("OPEN");
		expect(
			interpretAmapOpenStatus(
				"09:00-10:00 17:00-21:00",
				"2026-08-20T07:00:00.000Z",
			),
		).toBe("CLOSED");
		expect(
			interpretAmapOpenStatus(
				"09:00-11:00；12:00-13:00，18:00-22:00",
				"2026-08-20T10:30:00.000Z",
			),
		).toBe("OPEN");
		expect(
			interpretAmapOpenStatus("22:00-02:00", "2026-08-20T16:30:00.000Z"),
		).toBe("OPEN");
		expect(
			interpretAmapOpenStatus("09:00-24:00", "2026-08-20T15:59:00.000Z"),
		).toBe("OPEN");
		expect(
			interpretAmapOpenStatus("24:30-02:00", "2026-08-20T04:00:00.000Z"),
		).toBe("UNKNOWN");
		expect(interpretAmapOpenStatus("", "2026-08-20T04:00:00.000Z")).toBe(
			"UNKNOWN",
		);
		expect(interpretAmapOpenStatus([], "2026-08-20T04:00:00.000Z")).toBe(
			"UNKNOWN",
		);
	});
});
