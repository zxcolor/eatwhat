import "reflect-metadata";
import { LocationCityResponseSchema } from "@chi-shen-me/contracts";
import { type INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "./app.module.js";
import { configureHttpRuntime } from "./common/http-runtime-security.js";
import { SafeExceptionFilter } from "./common/safe-exception.filter.js";
import { APP_CONFIG, loadAppConfig } from "./config/app-config.js";
import { AMAP_LOCATION_CITY_FETCH } from "./location-city/amap-location-city.provider.js";

describe("city presentation HTTP transport", () => {
	let app: INestApplication;
	let fail = false;
	const fetchMock = vi.fn<typeof fetch>(async (input) => {
		if (fail) throw new Error(`private upstream ${String(input)}`);
		return new Response(JSON.stringify({ status: "1", infocode: "10000", regeocode: {
			addressComponent: { city: "合成市", province: "合成省", district: "秘密地址" },
			formatted_address: "不得返回的完整地址",
		} }));
	});
	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG).useValue(loadAppConfig({ NODE_ENV: "test", AMAP_ENABLED: "true", AMAP_WEB_SERVICE_KEY: "synthetic-city-key", ALLOW_DEMO_DATA: "false" }))
			.overrideProvider(AMAP_LOCATION_CITY_FETCH).useValue(fetchMock).compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");
	});
	afterAll(async () => { await app.close(); });
	async function request(body: unknown, contentType = "application/json") {
		return fetch(`${await app.getUrl()}/v1/location-city`, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });
	}
	it("accepts coordinates only in JSON body and returns only the city with no-store and contract headers", async () => {
		const result = await request({ location: { latitude: 0, longitude: 0, crs: "WGS84" } });
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect(result.headers.get("X-ChiShenMe-Contract-Version")).toBe("1");
		expect(LocationCityResponseSchema.parse(await result.json())).toEqual({ city: "合成市" });
	});
	it("rejects malformed coordinates, missing CRS and extra fields before fetching", async () => {
		fetchMock.mockClear();
		for (const body of [
			{ location: { latitude: 91, longitude: 0, crs: "WGS84" } },
			{ location: { latitude: 0, longitude: 0 } },
			{ location: { latitude: 0, longitude: 0, crs: "WGS84", accuracyMeters: 5 } },
			{ location: { latitude: 0, longitude: 0, crs: "WGS84" }, radius: 1000 },
		]) expect((await request(body)).status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await request({}, "text/plain")).status).toBe(415);
	});
	it("returns a safe 503 and logs no coordinates, credentials or provider URL", async () => {
		fail = true;
		const logger = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
		try {
			const result = await request({ location: { latitude: 0, longitude: 0, crs: "WGS84" } });
			expect(result.status).toBe(503);
			const text = await result.text();
			expect(text).toContain("LOCATION_CITY_UNAVAILABLE");
			for (const privateValue of ["synthetic-city-key", "restapi.amap.com", "location=", "latitude", "longitude"]) {
				expect(text).not.toContain(privateValue);
				expect(JSON.stringify(logger.mock.calls)).not.toContain(privateValue);
			}
		} finally { fail = false; logger.mockRestore(); }
	});
	it("rate limits city resolution independently", async () => {
		let status = 200;
		for (let index = 0; index < 31 && status !== 429; index++) {
			status = (await request({ location: { latitude: 0, longitude: 0, crs: "WGS84" } })).status;
		}
		expect(status).toBe(429);
		expect((await fetch(`${await app.getUrl()}/v1/config`)).status).toBe(200);
	});
});
