import "reflect-metadata";
import { RecommendationResponseSchema } from "@chi-shen-me/contracts";
import { type INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "./app.module.js";
import { SafeExceptionFilter } from "./common/safe-exception.filter.js";
import { APP_CONFIG, loadAppConfig } from "./config/app-config.js";
import { RecommendationEventsService } from "./events/recommendation-events.service.js";
import { AMAP_FETCH } from "./recommendations/providers/amap-place.provider.js";

const AMAP_E2E_TIMEOUT_MS = 15_000;

describe("AMap LIVE_DISPLAY_ONLY failure boundary", () => {
	let app: INestApplication | null = null;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (app !== null) await app.close();
		app = null;
	});

	it(
		"returns live AMap results without fit scores or retained external POI references",
		async () => {
			const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
				const url = new URL(String(input));
				expect(url.searchParams.has("region")).toBe(false);
				expect(url.searchParams.has("city_limit")).toBe(false);
				return new Response(
					JSON.stringify({
						status: "1",
						info: "OK",
						infocode: "10000",
						count: "1",
						pois: [
							{
								id: "B000A83VY0",
								name: "高德实时测试餐厅",
								address: "测试路 1 号",
								location: "121.478500,31.228600",
								distance: "180",
								type: "餐饮服务;中餐厅",
								business: {
									rating: "4.5",
									cost: "25",
									tag: "面食",
									opentime_today: "全天",
								},
								photos: [{ url: "https://example.com/amap-live.jpg" }],
							},
						],
					}),
					{ status: 200 },
				);
			});
			const module = await Test.createTestingModule({ imports: [AppModule] })
				.overrideProvider(APP_CONFIG)
				.useValue(
					loadAppConfig({
						NODE_ENV: "test",
						DATA_RIGHTS_MODE: "LIVE_DISPLAY_ONLY",
						ALLOW_DEMO_DATA: "false",
						AMAP_ENABLED: "true",
						AMAP_WEB_SERVICE_KEY: "amap-test-placeholder",
						QWEN_ENABLED: "false",
					}),
				)
				.overrideProvider(AMAP_FETCH)
				.useValue(fetchMock)
				.compile();

			app = module.createNestApplication();
			app.useGlobalFilters(new SafeExceptionFilter());
			await app.listen(0, "127.0.0.1");
			const baseUrl = await app.getUrl();
			const recommendationResponse = await fetch(
				`${baseUrl}/v1/recommendations`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						location: { latitude: 31.2304, longitude: 121.4737, crs: "WGS84" },
						mealPeriod: "LUNCH",
						radiusMeters: 1_500,
						aiAssistanceEnabled: false,
					}),
				},
			);
			const recommendationRaw = await recommendationResponse.json();
			expect(JSON.stringify(recommendationRaw)).not.toContain(
				"providerPlaceId",
			);
			const recommendation =
				RecommendationResponseSchema.parse(recommendationRaw);

			expect(recommendationResponse.status).toBe(200);
			expect(recommendation.coverage).toBe("NATIONWIDE");
			expect(recommendation.dataRightsMode).toBe("LIVE_DISPLAY_ONLY");
			expect(recommendation.results).toHaveLength(1);
			expect(recommendation.results[0]).toMatchObject({
				provider: "AMAP",
				resultToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
				dataMode: "LIVE",
				actions: {
					navigate: false,
					call: false,
					copyAddress: false,
					share: false,
				},
				fitScore: null,
				imageUrl: null,
				sourceAttribution: "高德地图实时数据",
				location: expect.objectContaining({ crs: "GCJ02" }),
			});
			expect(recommendation.notice).toContain("不保存外部餐饮地点数据");

			const eventResponse = await fetch(`${baseUrl}/v1/recommendation-events`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: recommendation.requestId,
					resultToken: recommendation.results[0]?.resultToken,
					type: "DETAIL",
					occurredAt: new Date().toISOString(),
				}),
			});
			expect(eventResponse.status).toBe(202);
			expect(
				JSON.stringify(app.get(RecommendationEventsService).snapshot().at(-1)),
			).not.toContain("providerPlaceId");
		},
		AMAP_E2E_TIMEOUT_MS,
	);

	it(
		"returns a safe upstream error without logging the key, URL or precise coordinates",
		async () => {
			const serverSideKey = "amap-server-side-secret";
			const latitude = "39.992812";
			const longitude = "116.310912";
			const fetchMock = vi.fn(
				async (input: URL | RequestInfo): Promise<Response> => {
					// Simulate a low-level client whose error embeds the complete sensitive URL.
					throw new Error(`socket failure while fetching ${String(input)}`);
				},
			);
			const module = await Test.createTestingModule({ imports: [AppModule] })
				.overrideProvider(APP_CONFIG)
				.useValue(
					loadAppConfig({
						NODE_ENV: "test",
						DATA_RIGHTS_MODE: "LIVE_DISPLAY_ONLY",
						ALLOW_DEMO_DATA: "false",
						AMAP_ENABLED: "true",
						AMAP_WEB_SERVICE_KEY: serverSideKey,
						QWEN_ENABLED: "false",
					}),
				)
				.overrideProvider(AMAP_FETCH)
				.useValue(fetchMock)
				.compile();

			app = module.createNestApplication();
			app.useGlobalFilters(new SafeExceptionFilter());
			const errorLog = vi
				.spyOn(Logger.prototype, "error")
				.mockImplementation(() => undefined);
			await app.listen(0, "127.0.0.1");
			const baseUrl = await app.getUrl();

			const response = await fetch(`${baseUrl}/v1/recommendations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					location: {
						latitude: Number(latitude),
						longitude: Number(longitude),
						crs: "WGS84",
					},
					mealPeriod: "LUNCH",
					radiusMeters: 1_500,
					aiAssistanceEnabled: false,
				}),
			});
			const responseText = await response.text();
			const loggedText = errorLog.mock.calls.flat().map(String).join("\n");

			expect(response.status).toBe(503);
			expect(responseText).toContain("PLACE_PROVIDER_UNAVAILABLE");
			expect(fetchMock).toHaveBeenCalledOnce();
			for (const privateValue of [
				serverSideKey,
				latitude,
				longitude,
				"restapi.amap.com",
			]) {
				expect(responseText).not.toContain(privateValue);
				expect(loggedText).not.toContain(privateValue);
			}
			expect(loggedText).toContain('"event":"request_failed"');
			expect(loggedText).toContain('"path":"/v1/recommendations"');
		},
		AMAP_E2E_TIMEOUT_MS,
	);
});
