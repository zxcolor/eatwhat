import "reflect-metadata";
import {
	CONTRACT_VERSION_HEADER,
	CURRENT_CONTRACT_VERSION,
	FeatureConfigSchema,
	RecommendationResponseSchema,
} from "@chi-shen-me/contracts";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "./app.module.js";
import { configureHttpRuntime } from "./common/http-runtime-security.js";
import { RecommendationRequestRegistry } from "./common/recommendation-request.registry.js";
import { SafeExceptionFilter } from "./common/safe-exception.filter.js";
import { APP_CONFIG, loadAppConfig } from "./config/app-config.js";
import {
	APP_CLOCK,
	type AppClock,
	DataRightsPolicy,
} from "./config/data-rights-policy.js";
import { RecommendationEventsService } from "./events/recommendation-events.service.js";
import { OperationalConfigService } from "./operational-config/operational-config.service.js";
import { startupOperationalConfig } from "./operational-config/operational-config.types.js";

describe("public HTTP API", () => {
	let app: INestApplication;
	let baseUrl: string;
	const appConfig = loadAppConfig({
		NODE_ENV: "test",
		DATA_RIGHTS_MODE: "LIVE_DISPLAY_ONLY",
		AMAP_ENABLED: "false",
		QWEN_ENABLED: "false",
	});
	const operationalConfig = Object.freeze({
		...startupOperationalConfig(appConfig),
		coverage: Object.freeze({
			areaCode: "NATIONWIDE",
			defaultRadiusMeters: 1_500,
			maximumRadiusMeters: 2_000,
		}),
	});

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(appConfig)
			.overrideProvider(OperationalConfigService)
			.useValue({ current: async () => operationalConfig })
			.compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app.close();
	});

	it("GET /health exposes only liveness metadata", async () => {
		const response = await fetch(`${baseUrl}/health`);
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(200);
		expect(body.status).toBe("ok");
		expect(body.timestamp).toBeTypeOf("string");
	});

	it("GET /health/ready confirms local dependencies without calling an upstream", async () => {
		const response = await fetch(`${baseUrl}/health/ready`);
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(200);
		expect(body.status).toBe("ready");
		expect(body.timestamp).toBeTypeOf("string");
		expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
			CURRENT_CONTRACT_VERSION,
		);
	});

	it("sets defensive headers without exposing the server framework", async () => {
		const response = await fetch(`${baseUrl}/health`);
		expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
			CURRENT_CONTRACT_VERSION,
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.has("x-powered-by")).toBe(false);
	});

	it("does not reflect a client-supplied contract version", async () => {
		const untrustedVersion = "unsupported-version-secret";
		const response = await fetch(`${baseUrl}/health`, {
			headers: { [CONTRACT_VERSION_HEADER]: untrustedVersion },
		});
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
			CURRENT_CONTRACT_VERSION,
		);
		expect(body).not.toContain(untrustedVersion);
	});

	it("does not apply the JSON Content-Type gate to GET requests", async () => {
		const response = await fetch(`${baseUrl}/health`, {
			headers: { "content-type": "text/plain" },
		});
		expect(response.status).toBe(200);
	});

	it.each([
		"/v1/location-search",
		"/v1/place-search",
		"/v1/recommendations",
		"/v1/group-recommendations",
		"/v1/recommendation-events",
		"/v1/support-feedback",
	])("rejects unsupported Content-Type on POST %s", async (path) => {
		const response = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: {
				"content-type": "text/plain",
				"x-request-id": "39.9000,116.4000",
				[CONTRACT_VERSION_HEADER]: "private/unsupported",
			},
			body: "{}",
		});
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(415);
		expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
			CURRENT_CONTRACT_VERSION,
		);
		expect(body).toMatchObject({
			code: "UNSUPPORTED_MEDIA_TYPE",
			message: "Content-Type 必须为 application/json",
		});
		expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/i);
		expect(body).not.toHaveProperty("stack");
		expect(JSON.stringify(body)).not.toContain("private/unsupported");
	});

	it("rejects a missing Content-Type on JSON POST endpoints", async () => {
		const response = await fetch(`${baseUrl}/v1/recommendations`, {
			method: "POST",
			body: new Uint8Array([0x7b, 0x7d]),
		});
		expect(response.status).toBe(415);
		await expect(response.json()).resolves.toMatchObject({
			code: "UNSUPPORTED_MEDIA_TYPE",
		});
	});

	it.each([
		"/v1/location-search",
		"/v1/place-search",
		"/v1/recommendations",
		"/v1/group-recommendations",
		"/v1/recommendation-events",
		"/v1/support-feedback",
	])(
		"returns a safe 400 ProblemDetails response for malformed JSON on POST %s",
		async (path) => {
			const response = await fetch(`${baseUrl}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[CONTRACT_VERSION_HEADER]: "not-a-version/private-input",
				},
				body: '{"location":',
			});
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(400);
			expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
				CURRENT_CONTRACT_VERSION,
			);
			expect(body).toMatchObject({
				code: "INVALID_JSON",
				message: "请求体不是有效的 JSON",
			});
			expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/i);
			expect(body).not.toHaveProperty("stack");
			expect(JSON.stringify(body)).not.toContain("not-a-version/private-input");
		},
	);

	it.each([
		"/v1/location-search",
		"/v1/place-search",
		"/v1/recommendations",
		"/v1/group-recommendations",
		"/v1/recommendation-events",
		"/v1/support-feedback",
	])(
		"returns an explicit 413 for a JSON body over 100 KiB on POST %s",
		async (path) => {
			const response = await fetch(`${baseUrl}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ padding: "x".repeat(100 * 1_024) }),
			});
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(413);
			expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
				CURRENT_CONTRACT_VERSION,
			);
			expect(body).toMatchObject({
				code: "PAYLOAD_TOO_LARGE",
				message: "请求体不能超过 100 KiB",
			});
			expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/i);
			expect(body).not.toHaveProperty("stack");
		},
	);

	it("POST /v1/support-feedback fails closed while its secure store is disabled", async () => {
		const response = await fetch(`${baseUrl}/v1/support-feedback`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				submissionId: "0192f014-7d64-4b59-8fc1-513465daae10",
				category: "PRODUCT",
				message: "推荐页的重新尝试按钮暂时无法使用。",
			}),
		});
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			code: "SUPPORT_FEEDBACK_UNAVAILABLE",
			message: "反馈服务暂时不可用，请稍后重试",
		});
		expect(body).not.toHaveProperty("stack");
		expect(JSON.stringify(body)).not.toContain("重新尝试按钮");
	});

	it("GET /v1/config returns the shared contract", async () => {
		const response = await fetch(`${baseUrl}/v1/config`);
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(FeatureConfigSchema.safeParse(body).success).toBe(true);
		expect(body).toMatchObject({
			coverageName: "全国范围",
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			aiEnabled: false,
			favoritesEnabled: false,
			supportFeedbackEnabled: false,
			serviceCapabilities: {
				recommendationsEnabled: true,
				groupRecommendationsEnabled: false,
				locationSearchEnabled: true,
				placeSearchEnabled: true,
			},
			recommendationDefaults: {
				areaCode: "NATIONWIDE",
				defaultRadiusMeters: 1_500,
				maximumRadiusMeters: 2_000,
			},
		});
	});

	it("POST /v1/group-recommendations fails closed while its explicit switch is disabled", async () => {
		const registry = app.get(RecommendationRequestRegistry);
		const before = registry.diagnostics();
		const response = await fetch(`${baseUrl}/v1/group-recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				location: { latitude: 39.9928, longitude: 116.3109 },
				travelMode: "WALK",
				members: [
					{
						budgetMaxYuan: null,
						availableMinutes: 60,
						radiusMeters: 1_500,
						preferredCuisines: [],
						excludedCuisines: [],
					},
					{
						budgetMaxYuan: 50,
						availableMinutes: 45,
						radiusMeters: 1_000,
						preferredCuisines: ["面食"],
						excludedCuisines: [],
					},
				],
			}),
		});

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			code: "GROUP_RECOMMENDATIONS_UNAVAILABLE",
			message: "群组推荐服务暂时不可用，请稍后重试",
		});
		expect(registry.diagnostics()).toEqual(before);
	});

	it("POST /v1/recommendations returns a demo Top 3 without fit scores", async () => {
		const response = await fetch(`${baseUrl}/v1/recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				location: {
					latitude: 39.9928,
					longitude: 116.3109,
					accuracyMeters: 80,
					crs: "WGS84",
				},
				mealPeriod: "LUNCH",
				radiusMeters: 1_500,
			}),
		});
		const body = await response.json();
		const parsed = RecommendationResponseSchema.safeParse(body);
		expect(response.status).toBe(200);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.results).toHaveLength(3);
		// Provider-security changes must never alter the deterministic DEMO baseline.
		expect(parsed.data.results.map((result) => result.name)).toEqual([
			"演示·校园面馆",
			"演示·家常盖饭",
			"演示·北方饺子铺",
		]);
		expect(
			parsed.data.results.every((result) => result.fitScore === null),
		).toBe(true);
		expect(
			parsed.data.results.every((result) => result.provider === "DEMO"),
		).toBe(true);
		expect(
			parsed.data.results.every((result) => result.dataMode === "DEMO"),
		).toBe(true);
		expect(
			parsed.data.results.every(
				(result) =>
					result.actions.navigate &&
					result.actions.call &&
					result.actions.copyAddress &&
					!result.actions.share,
			),
		).toBe(true);
		expect(
			parsed.data.results.every((result) => result.location.crs === "WGS84"),
		).toBe(true);
	});

	it("returns the same nationwide demo baseline for a Shanghai origin", async () => {
		const response = await fetch(`${baseUrl}/v1/recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				location: { latitude: 31.2304, longitude: 121.4737 },
				mealPeriod: "DINNER",
				radiusMeters: 1_500,
			}),
		});
		const body = RecommendationResponseSchema.parse(await response.json());
		expect(body.coverage).toBe("NATIONWIDE");
		expect(body.results.map((result) => result.name)).toEqual([
			"演示·校园面馆",
			"演示·家常盖饭",
			"演示·北方饺子铺",
		]);
	});

	it("rejects an invalid recommendation body", async () => {
		const response = await fetch(`${baseUrl}/v1/recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				location: { latitude: 200, longitude: 116.31 },
				mealPeriod: "MIDNIGHT",
				radiusMeters: 100,
			}),
		});
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(400);
		expect(body.code).toBe("INVALID_REQUEST");
	});

	it("rejects a recommendation radius above the active operational limit", async () => {
		const response = await fetch(`${baseUrl}/v1/recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				location: { latitude: 39.9928, longitude: 116.3109 },
				mealPeriod: "LUNCH",
				radiusMeters: 2_001,
			}),
		});
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(400);
		expect(body).toMatchObject({
			code: "RADIUS_EXCEEDS_ACTIVE_COVERAGE",
			message: "搜索半径超过当前运营配置允许的范围",
		});
		expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/i);
		expect(body).not.toHaveProperty("stack");
	});

	it("POST /v1/recommendation-events accepts the strict coordinate-free contract", async () => {
		const recommendationResponse = await fetch(
			`${baseUrl}/v1/recommendations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					location: { latitude: 39.9928, longitude: 116.3109 },
					mealPeriod: "LUNCH",
					radiusMeters: 1_500,
				}),
			},
		);
		const recommendationRaw = await recommendationResponse.json();
		expect(JSON.stringify(recommendationRaw)).not.toContain("providerPlaceId");
		const recommendation =
			RecommendationResponseSchema.parse(recommendationRaw);
		const issuedResult = recommendation.results[0];
		expect(issuedResult).toBeDefined();
		if (issuedResult === undefined) return;

		const response = await fetch(`${baseUrl}/v1/recommendation-events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: recommendation.requestId,
				resultToken: issuedResult.resultToken,
				type: "DETAIL",
				occurredAt: new Date().toISOString(),
			}),
		});
		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({ accepted: true });
		expect(
			JSON.stringify(app.get(RecommendationEventsService).snapshot().at(-1)),
		).not.toContain("providerPlaceId");

		const duplicate = await fetch(`${baseUrl}/v1/recommendation-events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: recommendation.requestId,
				resultToken: issuedResult.resultToken,
				type: "DETAIL",
				occurredAt: new Date().toISOString(),
			}),
		});
		expect(duplicate.status).toBe(400);
		await expect(duplicate.json()).resolves.toMatchObject({
			code: "INVALID_EVENT_SESSION",
		});
	});

	it("rejects forged recommendation events", async () => {
		const event = {
			requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
			resultToken: "A".repeat(43),
			type: "DETAIL",
			occurredAt: new Date().toISOString(),
		} as const;
		const forged = await fetch(`${baseUrl}/v1/recommendation-events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(event),
		});
		expect(forged.status).toBe(400);
		await expect(forged.json()).resolves.toMatchObject({
			code: "INVALID_EVENT_SESSION",
		});
	});

	it("strictly rejects legacy provider references at the public event boundary", async () => {
		const response = await fetch(`${baseUrl}/v1/recommendation-events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
				resultToken: "A".repeat(43),
				provider: "AUTHORIZED_VENDOR",
				providerPlaceId: "invalid-1",
				type: "DETAIL",
				occurredAt: new Date().toISOString(),
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			code: "INVALID_REQUEST",
		});
	});

	it("strictly rejects coordinates in recommendation events", async () => {
		const response = await fetch(`${baseUrl}/v1/recommendation-events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "2af305ae-82a1-4f87-86b7-1c97c4a8683f",
				resultToken: "A".repeat(43),
				type: "DETAIL",
				occurredAt: new Date().toISOString(),
				latitude: 39.9,
				longitude: 116.3,
			}),
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.code).toBe("INVALID_REQUEST");
	});

	it("does not reflect an unsafe request id into error responses", async () => {
		const response = await fetch(`${baseUrl}/v1/recommendations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-request-id": "39.9000,116.4000",
			},
			body: "{}",
		});
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(400);
		expect(body.requestId).not.toBe("39.9000,116.4000");
		expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/i);
	});

	it("rate-limits anonymous recommendation bursts", async () => {
		let limitedResponse: Response | null = null;
		for (let index = 0; index < 35; index += 1) {
			const response = await fetch(`${baseUrl}/v1/recommendations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					location: { latitude: 31.2304, longitude: 121.4737 },
					mealPeriod: "LUNCH",
					radiusMeters: 1_500,
				}),
			});
			if (response.status === 429) {
				limitedResponse = response;
				break;
			}
		}
		expect(limitedResponse?.status).toBe(429);
		if (limitedResponse === null) throw new Error("rate limit was not reached");
		expect(limitedResponse.headers.get(CONTRACT_VERSION_HEADER)).toBe(
			CURRENT_CONTRACT_VERSION,
		);
		await expect(limitedResponse.json()).resolves.toMatchObject({
			code: "RATE_LIMITED",
		});
	});
});

describe("runtime data-rights expiration", () => {
	let app: INestApplication;
	let baseUrl: string;
	let nowMs = Date.parse("2099-12-31T15:59:58.000Z");
	const clock: AppClock = { now: () => nowMs };
	const expiresAtMs = Date.parse("2099-12-31T15:59:59.000Z");
	const dataRightsPolicy = {
		effectiveMode: async (provider: string) =>
			provider === "DEMO" && nowMs < expiresAtMs
				? ("LICENSED_ENRICHMENT" as const)
				: ("LIVE_DISPLAY_ONLY" as const),
		canPersistPlaceReference: async (provider: string) =>
			provider === "DEMO" && nowMs < expiresAtMs,
	};

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "test",
					DATA_RIGHTS_MODE: "LICENSED_ENRICHMENT",
					DATA_RIGHTS_AUTHORIZATION_ID: "11111111-1111-4111-8111-111111111111",
					DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT: "2099-12-31T15:59:59.000Z",
					FAVORITES_ENABLED: "true",
					AMAP_ENABLED: "false",
					QWEN_ENABLED: "false",
				}),
			)
			.overrideProvider(APP_CLOCK)
			.useValue(clock)
			.overrideProvider(DataRightsPolicy)
			.useValue(dataRightsPolicy)
			.compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app.close();
	});

	it("downgrades config, ranking and event retention without a restart", async () => {
		const recommendationBody = JSON.stringify({
			location: { latitude: 39.9928, longitude: 116.3109 },
			mealPeriod: "LUNCH",
			radiusMeters: 1_500,
			aiAssistanceEnabled: false,
		});

		const licensedConfig = await fetch(`${baseUrl}/v1/config`).then(
			(response) => response.json(),
		);
		expect(licensedConfig).toMatchObject({
			dataRightsMode: "LICENSED_ENRICHMENT",
			favoritesEnabled: false,
		});

		const licensedRecommendation = RecommendationResponseSchema.parse(
			await fetch(`${baseUrl}/v1/recommendations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: recommendationBody,
			}).then((response) => response.json()),
		);
		expect(licensedRecommendation.results[0]?.fitScore).not.toBeNull();
		const licensedResult = licensedRecommendation.results[0];
		expect(licensedResult).toBeDefined();
		if (licensedResult === undefined) return;
		const licensedEventResponse = await fetch(
			`${baseUrl}/v1/recommendation-events`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: licensedRecommendation.requestId,
					resultToken: licensedResult.resultToken,
					type: "DETAIL",
					occurredAt: new Date().toISOString(),
				}),
			},
		);
		expect(licensedEventResponse.status).toBe(202);
		expect(
			app.get(RecommendationEventsService).snapshot().at(-1),
		).toMatchObject({
			provider: "DEMO",
		});
		expect(
			JSON.stringify(app.get(RecommendationEventsService).snapshot().at(-1)),
		).not.toContain("providerPlaceId");

		nowMs = Date.parse("2099-12-31T15:59:59.000Z");

		const liveConfig = await fetch(`${baseUrl}/v1/config`).then((response) =>
			response.json(),
		);
		expect(liveConfig).toMatchObject({
			dataRightsMode: "LIVE_DISPLAY_ONLY",
			favoritesEnabled: false,
		});

		const liveRecommendation = RecommendationResponseSchema.parse(
			await fetch(`${baseUrl}/v1/recommendations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: recommendationBody,
			}).then((response) => response.json()),
		);
		const liveResult = liveRecommendation.results[0];
		expect(liveRecommendation.dataRightsMode).toBe("LIVE_DISPLAY_ONLY");
		expect(liveResult?.fitScore).toBeNull();
		expect(liveResult).toBeDefined();
		if (liveResult === undefined) return;

		const eventResponse = await fetch(`${baseUrl}/v1/recommendation-events`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: liveRecommendation.requestId,
				resultToken: liveResult.resultToken,
				type: "DETAIL",
				occurredAt: new Date().toISOString(),
			}),
		});
		expect(eventResponse.status).toBe(202);
		expect(
			JSON.stringify(app.get(RecommendationEventsService).snapshot().at(-1)),
		).not.toContain("providerPlaceId");
	});
});
