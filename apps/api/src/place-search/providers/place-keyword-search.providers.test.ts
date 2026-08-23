import type { PlaceSearchRequest } from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { type AppConfig, loadAppConfig } from "../../config/app-config.js";
import { getAmapFailureDiagnostic } from "../../providers/amap-response-status.js";
import {
	AMAP_PLACE_SEARCH_RESPONSE_MAX_BYTES,
	AmapPlaceKeywordSearchProvider,
} from "./amap-place-keyword-search.provider.js";
import { DemoPlaceKeywordSearchProvider } from "./demo-place-keyword-search.provider.js";
import { UnavailablePlaceKeywordSearchProvider } from "./unavailable-place-keyword-search.provider.js";

const request: PlaceSearchRequest = {
	location: { latitude: 39.9928, longitude: 116.3109, crs: "GCJ02" },
	mealPeriod: "LUNCH",
	keyword: "牛肉面",
	radiusMeters: 1_500,
	openNow: false,
	limit: 10,
};

function liveConfig(): AppConfig {
	return loadAppConfig({
		NODE_ENV: "test",
		AMAP_ENABLED: "true",
		AMAP_WEB_SERVICE_KEY: "private-test-key",
	});
}

function validResponse(): Response {
	return new Response(
		JSON.stringify({
			status: "1",
			infocode: "10000",
			pois: [
				{
					id: "B000-PRIVATE-POI-ID",
					name: "测试牛肉面",
					address: "测试路 1 号",
					location: "116.3110,39.9929",
					distance: "800",
					adcode: "110108",
					type: "餐饮服务;中餐厅",
					business: {
						rating: "4.6",
						cost: "28",
						tag: "牛肉面|快餐",
						opentime_today: "全天",
					},
				},
				{
					id: "OUTSIDE-BEIJING",
					name: "外地餐厅",
					location: "121.47,31.23",
					adcode: "310101",
				},
				{ id: "MISSING-LOCATION", name: "缺失坐标", adcode: "110108" },
				null,
			],
		}),
		{ status: 200 },
	);
}

describe("place keyword search providers", () => {
	it("does not mislabel the fail-closed fallback as demo data", async () => {
		const provider = new UnavailablePlaceKeywordSearchProvider();
		expect(provider.dataSource).toBe("UNAVAILABLE");
		expect(provider.dataMode).toBe("LIVE");
		await expect(provider.search()).rejects.toMatchObject({
			reason: "DISABLED",
		});
	});

	it("returns only clearly marked fictional demo matches", async () => {
		const provider = new DemoPlaceKeywordSearchProvider();
		const results = await provider.search(request);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			provider: "DEMO",
			name: "演示·校园牛肉面",
			dataMode: "DEMO",
			openStatus: "OPEN",
			actions: {
				navigate: true,
				call: false,
				copyAddress: true,
				share: false,
			},
		});
		expect(results[0]?.sourceLabel).toContain("虚构");
	});

	it("uses official HTTPS around search per request and tolerates malformed elements", async () => {
		const fetchMock = vi.fn(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("https://restapi.amap.com");
				expect(url.pathname).toBe("/v5/place/around");
				expect(url.searchParams.get("key")).toBe("private-test-key");
				expect(url.searchParams.get("keywords")).toBe("牛肉面");
				expect(url.searchParams.get("location")).toBe("116.310900,39.992800");
				expect(url.searchParams.get("radius")).toBe("1500");
				expect(url.searchParams.get("types")).toBe("050000");
				expect(url.searchParams.get("region")).toBe("北京市");
				expect(url.searchParams.get("city_limit")).toBe("true");
				expect(url.searchParams.get("sortrule")).toBe("distance");
				expect(url.searchParams.get("show_fields")).toBe("business");
				expect(url.searchParams.has("photos")).toBe(false);
				expect(init).toMatchObject({
					method: "GET",
					cache: "no-store",
					redirect: "error",
					referrerPolicy: "no-referrer",
				});
				return validResponse();
			},
		);
		const provider = new AmapPlaceKeywordSearchProvider(
			liveConfig(),
			fetchMock as typeof fetch,
		);

		const first = await provider.search(request);
		const second = await provider.search(request);

		expect(first).toEqual([
			{
				provider: "AMAP",
				providerPlaceId: "B000-PRIVATE-POI-ID",
				providerRank: 1,
				name: "测试牛肉面",
				address: "测试路 1 号",
				location: { latitude: 39.9929, longitude: 116.311, crs: "GCJ02" },
				distanceMeters: 800,
				sourceLabel: "高德地图实时餐厅数据",
				sourceRating: 4.6,
				averageCostYuan: 28,
				openStatus: "OPEN",
				tags: ["牛肉面", "快餐", "餐饮服务", "中餐厅"],
				dataMode: "LIVE",
				actions: {
					navigate: false,
					call: false,
					copyAddress: false,
					share: false,
				},
			},
		]);
		expect(second).toEqual(first);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("converts WGS84 only at the AMap adapter boundary", async () => {
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			const location = new URL(String(input)).searchParams.get("location");
			expect(location).not.toBe("116.310900,39.992800");
			return new Response(
				JSON.stringify({ status: "1", infocode: "10000", pois: [] }),
			);
		});
		const provider = new AmapPlaceKeywordSearchProvider(
			liveConfig(),
			fetchMock as typeof fetch,
		);
		await provider.search({
			...request,
			location: { ...request.location, crs: "WGS84" },
		});
	});

	it("does not call AMap while the integration is disabled", async () => {
		const fetchMock = vi.fn();
		const provider = new AmapPlaceKeywordSearchProvider(
			loadAppConfig({ NODE_ENV: "test", AMAP_ENABLED: "false" }),
			fetchMock as typeof fetch,
		);
		await expect(provider.search(request)).rejects.toMatchObject({
			reason: "DISABLED",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		{
			response: new Response("unavailable", { status: 503 }),
			reason: "UPSTREAM_HTTP",
		},
		{
			response: new Response(
				JSON.stringify({ status: "0", infocode: "10001" }),
			),
			reason: "UPSTREAM_REJECTED",
		},
		{ response: new Response("{"), reason: "INVALID_RESPONSE" },
		{
			response: new Response(
				JSON.stringify({ status: "1", infocode: "10000", pois: {} }),
			),
			reason: "INVALID_RESPONSE",
		},
	] as const)(
		"maps supplier failures to $reason",
		async ({ response, reason }) => {
			const provider = new AmapPlaceKeywordSearchProvider(
				liveConfig(),
				vi.fn(async () => response) as typeof fetch,
			);
			await expect(provider.search(request)).rejects.toMatchObject({ reason });
		},
	);

	it("attaches only a safe AMap request rejection classification", async () => {
		const privateInfo = "private upstream message with exact coordinates";
		const provider = new AmapPlaceKeywordSearchProvider(
			liveConfig(),
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "0",
							infocode: "20012",
							info: privateInfo,
						}),
					),
			) as typeof fetch,
		);

		const error = await provider.search(request).catch((caught) => caught);
		expect(error).toMatchObject({ reason: "UPSTREAM_REJECTED" });
		expect(getAmapFailureDiagnostic(error)).toEqual({
			classification: "REQUEST_REJECTED",
			safeInfocode: "20012",
		});
		expect(JSON.stringify(error)).not.toContain(privateInfo);
	});

	it("rejects an oversized response before parsing", async () => {
		const response = new Response("{}", {
			headers: {
				"content-length": String(AMAP_PLACE_SEARCH_RESPONSE_MAX_BYTES + 1),
			},
		});
		const provider = new AmapPlaceKeywordSearchProvider(
			liveConfig(),
			vi.fn(async () => response) as typeof fetch,
		);
		await expect(provider.search(request)).rejects.toMatchObject({
			reason: "RESPONSE_TOO_LARGE",
		});
	});

	it("aborts slow requests and never exposes URL, key, coordinates or keyword", async () => {
		const base = liveConfig();
		const config: AppConfig = {
			...base,
			amap: { ...base.amap, timeoutMs: 10 },
		};
		const fetchMock = vi.fn(
			async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error(`private ${String(input)}`)),
						{ once: true },
					);
				}),
		);
		const provider = new AmapPlaceKeywordSearchProvider(
			config,
			fetchMock as typeof fetch,
		);
		const error = await provider.search(request).catch((caught) => caught);
		expect(error).toMatchObject({ reason: "TIMEOUT" });
		const text = String(error);
		expect(text).not.toContain("private-test-key");
		expect(text).not.toContain("牛肉面");
		expect(text).not.toContain("116.3109");
		expect(text).not.toContain("restapi.amap.com");
	});
});
