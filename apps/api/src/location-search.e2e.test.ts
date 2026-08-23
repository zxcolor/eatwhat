import "reflect-metadata";
import { LocationSearchResponseSchema } from "@chi-shen-me/contracts";
import { type INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { AppModule } from "./app.module.js";
import { configureHttpRuntime } from "./common/http-runtime-security.js";
import { SafeExceptionFilter } from "./common/safe-exception.filter.js";
import { APP_CONFIG, loadAppConfig } from "./config/app-config.js";
import { DatabasePool } from "./database/database-pool.js";
import { AMAP_LOCATION_SEARCH_FETCH } from "./location-search/providers/amap-location-search.provider.js";

describe("location search HTTP flow", () => {
	let app: INestApplication;
	let baseUrl: string;

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "test",
					ALLOW_DEMO_DATA: "true",
					AMAP_ENABLED: "false",
					QWEN_ENABLED: "false",
				}),
			)
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

	it("returns up to five fictional matches without provider identifiers", async () => {
		const response = await fetch(`${baseUrl}/v1/location-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "校园" }),
		});
		const raw = await response.json();
		const body = LocationSearchResponseSchema.parse(raw);
		expect(response.status).toBe(200);
		expect(body.dataSource).toBe("DEMO");
		expect(body.dataMode).toBe("DEMO");
		expect(body.results).toHaveLength(3);
		expect(
			body.results.every((result) => result.location.crs === "WGS84"),
		).toBe(true);
		expect(JSON.stringify(raw)).not.toMatch(/providerPlaceId|providerId/i);
	});

	it.each([
		"116.3109,39.9928",
		"地点|餐厅",
		"联系 13800138000",
		"test@example.com",
	])(
		"rejects a sensitive or provider-control-shaped query: %s",
		async (query) => {
			const response = await fetch(`${baseUrl}/v1/location-search`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query }),
			});
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				code: "INVALID_REQUEST",
			});
		},
	);

	it("enforces the shared JSON Content-Type gate", async () => {
		const response = await fetch(`${baseUrl}/v1/location-search`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "{}",
		});
		expect(response.status).toBe(415);
		await expect(response.json()).resolves.toMatchObject({
			code: "UNSUPPORTED_MEDIA_TYPE",
		});
	});

	it("rate-limits location search independently from recommendations", async () => {
		let limited: Response | null = null;
		for (let index = 0; index < 35; index += 1) {
			const response = await fetch(`${baseUrl}/v1/location-search`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "校园" }),
			});
			if (response.status === 429) {
				limited = response;
				break;
			}
		}
		expect(limited?.status).toBe(429);

		const recommendation = await fetch(`${baseUrl}/v1/recommendations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				location: { latitude: 31.2304, longitude: 121.4737 },
				mealPeriod: "LUNCH",
				radiusMeters: 1_500,
			}),
		});
		expect(recommendation.status).toBe(200);
	});
});

describe("live location search privacy boundary", () => {
	let app: INestApplication | null = null;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (app !== null) await app.close();
		app = null;
	});

	it("returns live GCJ02 data while dropping the supplier POI id", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						status: "1",
						infocode: "10000",
						pois: [
							{
								id: "PRIVATE-AMAP-ID",
								name: "北京大学东门",
								address: "颐和园路 5 号",
								location: "116.3109,39.9928",
								adcode: "110108",
							},
						],
					}),
					{ status: 200 },
				),
		);
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "test",
					ALLOW_DEMO_DATA: "false",
					AMAP_ENABLED: "true",
					AMAP_WEB_SERVICE_KEY: "server-only-key",
					QWEN_ENABLED: "false",
				}),
			)
			.overrideProvider(AMAP_LOCATION_SEARCH_FETCH)
			.useValue(fetchMock)
			.compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");

		const response = await fetch(`${await app.getUrl()}/v1/location-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "北京大学" }),
		});
		const raw = await response.json();
		const body = LocationSearchResponseSchema.parse(raw);
		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			dataSource: "AMAP",
			dataMode: "LIVE",
			results: [
				expect.objectContaining({
					name: "北京大学东门",
					location: expect.objectContaining({ crs: "GCJ02" }),
				}),
			],
		});
		expect(JSON.stringify(raw)).not.toContain("PRIVATE-AMAP-ID");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("returns a safe 503 without logging the key, query or upstream URL", async () => {
		const serverKey = "private-location-key";
		const privateQuery = "敏感测试地点";
		const fetchMock = vi.fn(
			async (input: URL | RequestInfo): Promise<Response> => {
				throw new Error(`socket failure ${String(input)}`);
			},
		);
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "test",
					ALLOW_DEMO_DATA: "false",
					AMAP_ENABLED: "true",
					AMAP_WEB_SERVICE_KEY: serverKey,
					QWEN_ENABLED: "false",
				}),
			)
			.overrideProvider(AMAP_LOCATION_SEARCH_FETCH)
			.useValue(fetchMock)
			.compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		const errorLog = vi
			.spyOn(Logger.prototype, "error")
			.mockImplementation(() => undefined);
		await app.listen(0, "127.0.0.1");

		const response = await fetch(`${await app.getUrl()}/v1/location-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: privateQuery }),
		});
		const responseText = await response.text();
		const loggedText = errorLog.mock.calls.flat().map(String).join("\n");
		expect(response.status).toBe(503);
		expect(responseText).toContain("LOCATION_PROVIDER_UNAVAILABLE");
		for (const privateValue of [serverKey, privateQuery, "restapi.amap.com"]) {
			expect(responseText).not.toContain(privateValue);
			expect(loggedText).not.toContain(privateValue);
		}
		expect(loggedText).toContain('"path":"/v1/location-search"');
	});

	it("fails closed with 503 in production when no live adapter is configured", async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(
				loadAppConfig({
					NODE_ENV: "production",
					TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
					DATABASE_URL:
						"postgresql://api_runtime:runtime-pass@db.internal:5432/chi_shen_me",
					DATABASE_SSL_MODE: "verify-full",
					DATABASE_EXPECTED_TARGET: "db.internal:5432/chi_shen_me",
					DATABASE_RUNTIME_ROLE_NAME: "api_runtime",
					DATABASE_MIGRATION_ROLE_NAME: "schema_migrator",
					DATABASE_MAINTENANCE_ROLE_NAME: "retention_worker",
					DATABASE_EXPORT_WORKER_ROLE_NAME: "data_export_worker",
					ALLOW_DEMO_DATA: "false",
					AMAP_ENABLED: "false",
					QWEN_ENABLED: "false",
				}),
			)
			.overrideProvider(DatabasePool)
			.useValue({})
			.compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");

		const response = await fetch(`${await app.getUrl()}/v1/location-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "北京大学" }),
		});
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			code: "LOCATION_PROVIDER_UNAVAILABLE",
		});
	});
});
