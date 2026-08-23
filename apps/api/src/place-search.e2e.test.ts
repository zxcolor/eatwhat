import "reflect-metadata";
import {
	CONTRACT_VERSION_HEADER,
	CURRENT_CONTRACT_VERSION,
	PlaceSearchResponseSchema,
} from "@chi-shen-me/contracts";
import { type INestApplication, Logger } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
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
import { AMAP_PLACE_KEYWORD_SEARCH_FETCH } from "./place-search/providers/amap-place-keyword-search.provider.js";

const searchBody = {
	location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
	mealPeriod: "LUNCH",
	keyword: "牛肉面",
	radiusMeters: 1_500,
	maxAverageCostYuan: 30,
	openNow: true,
	limit: 10,
};

async function startApp(module: TestingModule): Promise<INestApplication> {
	const app = module.createNestApplication({ bodyParser: false });
	app.useGlobalFilters(new SafeExceptionFilter());
	configureHttpRuntime(app, app.get(APP_CONFIG));
	await app.listen(0, "127.0.0.1");
	return app;
}

describe("place keyword search HTTP flow", () => {
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
		app = await startApp(module);
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app.close();
	});

	it("returns fictional matches with opaque tokens and no provider fields", async () => {
		const response = await fetch(`${baseUrl}/v1/place-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(searchBody),
		});
		const raw = await response.json();
		const body = PlaceSearchResponseSchema.parse(raw);

		expect(response.status).toBe(200);
		expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
			CURRENT_CONTRACT_VERSION,
		);
		expect(body.results).toHaveLength(1);
		expect(body.results[0]).toMatchObject({
			name: "演示·校园牛肉面",
			dataMode: "DEMO",
			rank: 1,
		});
		expect(body.results[0]?.resultToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(JSON.stringify(raw)).not.toMatch(
			/providerPlaceId|providerId|dataSource|fitScore|reasons|aiAssisted/u,
		);
	});

	it.each([
		"116.3109,39.9928",
		"牛肉面|火锅",
		"联系 13800138000",
		"test@example.com",
	])("rejects unsafe keyword input: %s", async (keyword) => {
		const response = await fetch(`${baseUrl}/v1/place-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...searchBody, keyword }),
		});
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			code: "INVALID_REQUEST",
		});
	});

	it("requires explicit CRS and bounds the search radius", async () => {
		for (const body of [
			{
				...searchBody,
				location: { latitude: 39.99, longitude: 116.31 },
			},
			{ ...searchBody, radiusMeters: 5_001 },
		]) {
			const response = await fetch(`${baseUrl}/v1/place-search`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}
	});

	it("enforces a separate 30/minute IP limit", async () => {
		let limited: Response | null = null;
		for (let index = 0; index < 35; index += 1) {
			const response = await fetch(`${baseUrl}/v1/place-search`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(searchBody),
			});
			if (response.status === 429) {
				limited = response;
				break;
			}
		}
		expect(limited?.status).toBe(429);
	});
});

describe("live place keyword search privacy boundary", () => {
	let app: INestApplication | null = null;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (app !== null) await app.close();
		app = null;
	});

	it("returns provider-neutral live data while dropping the supplier POI id", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						status: "1",
						infocode: "10000",
						pois: [
							{
								id: "PRIVATE-AMAP-PLACE-ID",
								name: "测试牛肉面",
								address: "测试路 1 号",
								location: "116.3170,39.9980",
								distance: "900",
								adcode: "110108",
								business: {
									rating: "4.5",
									cost: "25",
									opentime_today: "全天",
								},
							},
						],
					}),
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
			.overrideProvider(AMAP_PLACE_KEYWORD_SEARCH_FETCH)
			.useValue(fetchMock)
			.compile();
		app = await startApp(module);

		const response = await fetch(`${await app.getUrl()}/v1/place-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(searchBody),
		});
		const raw = await response.json();
		const body = PlaceSearchResponseSchema.parse(raw);
		expect(response.status).toBe(200);
		expect(body.results[0]).toMatchObject({
			name: "测试牛肉面",
			dataMode: "LIVE",
			actions: {
				navigate: false,
				call: false,
				copyAddress: false,
				share: false,
			},
		});
		expect(JSON.stringify(raw)).not.toMatch(
			/PRIVATE-AMAP-PLACE-ID|provider|server-only-key/u,
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("returns and logs only a safe 503 when the supplier fails", async () => {
		const serverKey = "private-place-search-key";
		const privateKeyword = "敏感牛肉面关键词";
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			throw new Error(`private upstream body ${String(input)}`);
		});
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
			.overrideProvider(AMAP_PLACE_KEYWORD_SEARCH_FETCH)
			.useValue(fetchMock)
			.compile();
		app = await startApp(module);
		const errorLog = vi
			.spyOn(Logger.prototype, "error")
			.mockImplementation(() => undefined);

		const response = await fetch(`${await app.getUrl()}/v1/place-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...searchBody, keyword: privateKeyword }),
		});
		const responseText = await response.text();
		const loggedText = errorLog.mock.calls.flat().map(String).join("\n");
		expect(response.status).toBe(503);
		expect(responseText).toContain("PLACE_SEARCH_PROVIDER_UNAVAILABLE");
		for (const privateValue of [
			serverKey,
			privateKeyword,
			"116.3109",
			"restapi.amap.com",
			"private upstream body",
		]) {
			expect(responseText).not.toContain(privateValue);
			expect(loggedText).not.toContain(privateValue);
		}
		expect(loggedText).toContain('"path":"/v1/place-search"');
	});

	it("fails closed in production when no formal provider is configured", async () => {
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
		app = await startApp(module);

		const response = await fetch(`${await app.getUrl()}/v1/place-search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(searchBody),
		});
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			code: "PLACE_SEARCH_PROVIDER_UNAVAILABLE",
		});
	});
});
