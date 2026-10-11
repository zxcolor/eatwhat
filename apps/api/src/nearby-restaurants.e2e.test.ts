import "reflect-metadata";
import { NearbyRestaurantResponseSchema } from "@chi-shen-me/contracts";
import { type INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "./app.module.js";
import { APP_CONFIG, loadAppConfig } from "./config/app-config.js";
import { configureHttpRuntime } from "./common/http-runtime-security.js";
import { SafeExceptionFilter } from "./common/safe-exception.filter.js";
import { AMAP_FETCH } from "./recommendations/providers/amap-place.provider.js";

describe("authorized nearby collection HTTP flow", () => {
	let app: INestApplication;
	const calls: URL[] = [];
	let fail = false;
	const origin = { latitude: 0, longitude: 0, crs: "WGS84" };
	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG).useValue(loadAppConfig({
				NODE_ENV: "test", ALLOW_DEMO_DATA: "false", AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "synthetic-nearby-key", QWEN_ENABLED: "false",
			})).overrideProvider(AMAP_FETCH).useValue(async (input: URL | RequestInfo) => {
				const url = new URL(String(input)); calls.push(url);
				if (fail) throw new Error(`private upstream ${url}`);
				const page = Number(url.searchParams.get("page_num"));
				return new Response(JSON.stringify({ status: "1", infocode: "10000", pois:
					Array.from({ length: 25 }, (_, i) => ({ id: `synthetic-${page}-${i}`, name: `测试门店${i}`,
						address: "合成测试地址", location: i === 24 ? "1,0" : "0.001,0", type: "餐饮服务",
						business: { rating: "4", cost: "20", tel: "测试电话", opentime_today: "全天" },
					})),
				}));
			}).compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");
	});
	afterAll(async () => { await app.close(); });
	async function request(body: unknown) {
		return fetch(`${await app.getUrl()}/v1/restaurants/nearby`, { method: "POST",
			headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	}
	it("makes one upstream call per page, accepts only two pages and filters beyond 3.5km", async () => {
		calls.length = 0;
		const config = await (await fetch(`${await app.getUrl()}/v1/config`)).json();
		expect(config.nearbyRestaurantCollectionEnabled).toBe(true);
		expect(config.dataRightsMode).toBe("LIVE_DISPLAY_ONLY");
		const first = NearbyRestaurantResponseSchema.parse(await (await request({ location: origin, page: 1 })).json());
		const second = NearbyRestaurantResponseSchema.parse(await (await request({ location: origin, page: 2 })).json());
		expect(first.restaurants).toHaveLength(24);
		expect(first.nextPage).toBe(2);
		expect(second.nextPage).toBeNull();
		expect(second.truncated).toBe(true);
		expect(calls).toHaveLength(2);
		for (const [i, call] of calls.entries()) {
			expect(call.origin).toBe("https://restapi.amap.com");
			expect(call.searchParams.get("radius")).toBe("3500");
			expect(call.searchParams.get("page_size")).toBe("25");
			expect(call.searchParams.get("page_num")).toBe(String(i + 1));
			expect(call.searchParams.get("types")).toBe("050000");
			expect(call.searchParams.has("keywords")).toBe(false);
		}
	});
	it("rejects page three, custom radius and malformed coordinates without calling AMap", async () => {
		calls.length = 0;
		for (const body of [{ location: origin, page: 3 }, { location: origin, page: 1, radiusMeters: 5000 },
			{ location: { ...origin, latitude: 91 }, page: 1 }]) {
			expect((await request(body)).status).toBe(400);
		}
		expect(calls).toHaveLength(0);
	});
	it("returns only a safe error when AMap fails, with no fallback demo data", async () => {
		fail = true;
		const logger = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
		try {
			const response = await request({ location: origin, page: 1 });
			expect(response.status).toBe(503);
			expect(await response.text()).not.toMatch(/synthetic-nearby-key|restapi.amap|location=/);
			expect(JSON.stringify(logger.mock.calls)).not.toMatch(/synthetic-nearby-key|restapi.amap|location=/);
		} finally { fail = false; logger.mockRestore(); }
	});
	it("rejects missing or non-JSON content types before calling AMap", async () => {
		calls.length = 0;
		for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
			const headers = contentType === undefined ? {} : { "content-type": contentType };
			const response = await fetch(`${await app.getUrl()}/v1/restaurants/nearby`, {
				method: "POST", headers,
				...(contentType === undefined ? {} : { body: JSON.stringify({ location: origin, page: 1 }) }),
			});
			expect(response.status).toBe(415);
		}
		expect(calls).toHaveLength(0);
	});
});
