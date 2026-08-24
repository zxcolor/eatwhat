import { describe, expect, it, vi } from "vitest";
import { type AppConfig, loadAppConfig } from "../../config/app-config.js";
import { getAmapFailureDiagnostic } from "../../providers/amap-response-status.js";
import {
	AMAP_LOCATION_SEARCH_RESPONSE_MAX_BYTES,
	AmapLocationSearchProvider,
} from "./amap-location-search.provider.js";
import { DemoLocationSearchProvider } from "./demo-location-search.provider.js";

function liveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	const base = loadAppConfig({
		NODE_ENV: "test",
		AMAP_ENABLED: "true",
		AMAP_WEB_SERVICE_KEY: "test-location-key",
	});
	return { ...base, ...overrides };
}

describe("location search providers", () => {
	it("searches only clearly marked fictional demo locations", async () => {
		const provider = new DemoLocationSearchProvider();
		const results = await provider.search("校园");
		expect(results).toHaveLength(3);
		expect(results.every((result) => result.name.startsWith("演示·"))).toBe(
			true,
		);
		expect(results.every((result) => result.sourceLabel.includes("虚构"))).toBe(
			true,
		);
		expect(results.every((result) => result.location.crs === "WGS84")).toBe(
			true,
		);
		expect(results.every((result) => !("aliases" in result))).toBe(true);
	});

	it("accepts a pinyin alias without changing the public result", async () => {
		const provider = new DemoLocationSearchProvider();
		const results = await provider.search("zhongguancun");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			name: "演示·中关村测试点",
			sourceLabel: "虚构地点数据，仅供开发测试",
		});
		expect(results[0]).not.toHaveProperty("aliases");
	});

	it("does not call the live supplier while its adapter is disabled", async () => {
		const fetchMock = vi.fn();
		const provider = new AmapLocationSearchProvider(
			loadAppConfig({ NODE_ENV: "test", AMAP_ENABLED: "false" }),
			fetchMock as typeof fetch,
		);
		await expect(provider.search("北京大学")).rejects.toMatchObject({
			reason: "DISABLED",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses the nationwide HTTPS text endpoint, never caches, and filters malformed POIs", async () => {
		const fetchMock = vi.fn(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("https://restapi.amap.com");
				expect(url.pathname).toBe("/v5/place/text");
				expect(url.searchParams.get("key")).toBe("test-location-key");
				expect(url.searchParams.get("keywords")).toBe("北京大学");
				expect(url.searchParams.has("region")).toBe(false);
				expect(url.searchParams.has("city_limit")).toBe(false);
				expect(url.searchParams.get("page_size")).toBe("5");
				expect(url.searchParams.get("page_num")).toBe("1");
				expect(url.searchParams.get("output")).toBe("json");
				expect(init).toMatchObject({
					method: "GET",
					cache: "no-store",
					redirect: "error",
					referrerPolicy: "no-referrer",
				});
				return new Response(
					JSON.stringify({
						status: "1",
						infocode: "10000",
						pois: [
							{
								id: "B000-PRIVATE-ID",
								name: "北京大学东门",
								address: "颐和园路 5 号",
								location: "116.3109,39.9928",
								adcode: "110108",
							},
							{
								id: "SHANGHAI-PRIVATE-ID",
								name: "上海测试地点",
								address: "上海市测试路 1 号",
								location: "121.47,31.23",
								adcode: "310101",
							},
							{ name: "无坐标地点", adcode: "110108" },
							null,
						],
					}),
					{ status: 200 },
				);
			},
		);
		const provider = new AmapLocationSearchProvider(
			liveConfig(),
			fetchMock as typeof fetch,
		);

		const first = await provider.search("北京大学");
		const second = await provider.search("北京大学");

		expect(first).toEqual([
			{
				name: "北京大学东门",
				address: "颐和园路 5 号",
				location: { latitude: 39.9928, longitude: 116.3109, crs: "GCJ02" },
				sourceLabel: "高德地图实时地点数据",
				providerRank: 1,
			},
			{
				name: "上海测试地点",
				address: "上海市测试路 1 号",
				location: { latitude: 31.23, longitude: 121.47, crs: "GCJ02" },
				sourceLabel: "高德地图实时地点数据",
				providerRank: 2,
			},
		]);
		expect(second).toEqual(first);
		expect(JSON.stringify(first)).not.toMatch(
			/B000-PRIVATE-ID|SHANGHAI-PRIVATE-ID/u,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		{
			response: new Response("upstream unavailable", { status: 503 }),
			reason: "UPSTREAM_HTTP",
		},
		{
			response: new Response(
				JSON.stringify({ status: "0", infocode: "10001" }),
				{
					status: 200,
				},
			),
			reason: "UPSTREAM_REJECTED",
		},
		{
			response: new Response("{", { status: 200 }),
			reason: "INVALID_RESPONSE",
		},
		{
			response: new Response(
				JSON.stringify({ status: "1", infocode: "10000", pois: {} }),
				{
					status: 200,
				},
			),
			reason: "INVALID_RESPONSE",
		},
	])("maps an upstream failure to $reason", async ({ response, reason }) => {
		const provider = new AmapLocationSearchProvider(
			liveConfig(),
			vi.fn(async () => response) as typeof fetch,
		);
		await expect(provider.search("北京大学")).rejects.toMatchObject({ reason });
	});

	it("attaches only a safe AMap rejection classification", async () => {
		const privateInfo = "private upstream message with user query";
		const provider = new AmapLocationSearchProvider(
			liveConfig(),
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "0",
							infocode: "10004",
							info: privateInfo,
						}),
					),
			) as typeof fetch,
		);

		const error = await provider.search("北京大学").catch((caught) => caught);
		expect(error).toMatchObject({ reason: "UPSTREAM_REJECTED" });
		expect(getAmapFailureDiagnostic(error)).toEqual({
			classification: "QUOTA_OR_RATE_LIMIT",
			safeInfocode: "10004",
		});
		expect(JSON.stringify(error)).not.toContain(privateInfo);
	});

	it("rejects an oversized declared response before parsing", async () => {
		const response = new Response(JSON.stringify({ status: "1", pois: [] }), {
			status: 200,
			headers: {
				"content-length": String(AMAP_LOCATION_SEARCH_RESPONSE_MAX_BYTES + 1),
			},
		});
		const provider = new AmapLocationSearchProvider(
			liveConfig(),
			vi.fn(async () => response) as typeof fetch,
		);
		await expect(provider.search("北京大学")).rejects.toMatchObject({
			reason: "RESPONSE_TOO_LARGE",
		});
	});

	it("discards low-level error details that contain the key and user query", async () => {
		const provider = new AmapLocationSearchProvider(
			liveConfig(),
			vi.fn(async (input: URL | RequestInfo) => {
				throw new Error(`socket failure ${String(input)}`);
			}) as typeof fetch,
		);
		const error = await provider
			.search("隐私地点关键词")
			.catch((caught) => caught);
		expect(error).toMatchObject({ reason: "NETWORK_ERROR" });
		expect(String(error)).not.toContain("test-location-key");
		expect(String(error)).not.toContain("隐私地点关键词");
		expect(String(error)).not.toContain("restapi.amap.com");
	});

	it("aborts a slow live lookup at the configured timeout", async () => {
		const base = liveConfig();
		const config: AppConfig = {
			...base,
			amap: { ...base.amap, timeoutMs: 10 },
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
		const provider = new AmapLocationSearchProvider(
			config,
			fetchMock as typeof fetch,
		);
		await expect(provider.search("北京大学")).rejects.toMatchObject({
			reason: "TIMEOUT",
		});
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});
});
