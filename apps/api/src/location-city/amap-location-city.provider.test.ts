import type { PlaceSearchCoordinate } from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import { computeAmapWebServiceSignature } from "../providers/amap-request-signature.js";
import { toGcj02 } from "../recommendations/domain/geo.js";
import { AMAP_LOCATION_CITY_RESPONSE_MAX_BYTES, AmapLocationCityProvider } from "./amap-location-city.provider.js";

const origin: PlaceSearchCoordinate = { latitude: 35, longitude: 105, crs: "WGS84" };
const config = loadAppConfig({ NODE_ENV: "test", AMAP_ENABLED: "true", AMAP_WEB_SERVICE_KEY: "synthetic-city-key", AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: "synthetic-city-signature", ALLOW_DEMO_DATA: "false" });
const body = (addressComponent: unknown) => ({ status: "1", infocode: "10000", regeocode: { addressComponent } });
const response = (value: unknown) => new Response(JSON.stringify(value));
const provider = (fetchImpl: typeof fetch) => new AmapLocationCityProvider(config, fetchImpl);

describe("city-only AMap reverse geocoder", () => {
	it("converts WGS84 once, signs only the official HTTPS URL and requests no nearby POIs", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(body({ city: "合成市", province: "合成省" })));
		expect(await provider(fetchMock).city(origin)).toBe("合成市");
		const [input, init] = fetchMock.mock.calls[0];
		const url = new URL(String(input));
		const transformed = toGcj02(origin);
		expect(url.origin + url.pathname).toBe("https://restapi.amap.com/v3/geocode/regeo");
		expect(url.searchParams.get("location")).toBe(`${transformed.longitude.toFixed(6)},${transformed.latitude.toFixed(6)}`);
		expect(url.searchParams.get("extensions")).toBe("base");
		expect(url.searchParams.get("radius")).toBe("0");
		expect(init).toMatchObject({ cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
		const sig = url.searchParams.get("sig"); url.searchParams.delete("sig");
		expect(sig).toBe(computeAmapWebServiceSignature(url.searchParams, "synthetic-city-signature"));
		const gcjFetch = vi.fn<typeof fetch>().mockResolvedValue(response(body({ city: "合成市" })));
		await provider(gcjFetch).city({ ...origin, crs: "GCJ02" });
		expect(new URL(String(gcjFetch.mock.calls[0][0])).searchParams.get("location")).toBe("105.000000,35.000000");
	});
	it.each(["北京市", "上海市", "天津市", "重庆市"])("uses province for municipality %s when city is empty", async (province) => {
		expect(await provider(vi.fn<typeof fetch>().mockResolvedValue(response(body({ city: [], province })))).city(origin)).toBe(province);
	});
	it("returns unknown for empty city instead of inventing a city from province or district", async () => {
		expect(await provider(vi.fn<typeof fetch>().mockResolvedValue(response(body({ city: [], province: "合成省", district: "合成县" })))).city(origin)).toBeNull();
	});
	it.each([
		{ status: "0", infocode: "10001", info: "private upstream text" },
		{ status: "1", infocode: "10000", regeocode: [] },
		{ status: "1", infocode: "unknown", regeocode: { addressComponent: { city: "合成市" } } },
	])("rejects upstream errors and malformed structure without echoing the body", async (value) => {
		await expect(provider(vi.fn<typeof fetch>().mockResolvedValue(response(value))).city(origin)).rejects.toThrow("LOCATION_CITY_PROVIDER_UNAVAILABLE");
	});
	it("enforces both declared and streamed response size", async () => {
		for (const responseValue of [
			new Response("{}", { headers: { "content-length": String(AMAP_LOCATION_CITY_RESPONSE_MAX_BYTES + 1) } }),
			new Response("x".repeat(AMAP_LOCATION_CITY_RESPONSE_MAX_BYTES + 1)),
		]) {
			await expect(provider(vi.fn<typeof fetch>().mockResolvedValue(responseValue)).city(origin)).rejects.toThrow("LOCATION_CITY_PROVIDER_UNAVAILABLE");
		}
	});
	it("times out a stalled response body", async () => {
		const stalled = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
		const instance = new AmapLocationCityProvider({ ...config, amap: { ...config.amap, timeoutMs: 10 } }, vi.fn<typeof fetch>().mockResolvedValue(stalled));
		await expect(instance.city(origin)).rejects.toThrow("LOCATION_CITY_PROVIDER_UNAVAILABLE");
	});
	it("does not call AMap when disabled", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		const instance = new AmapLocationCityProvider(loadAppConfig({ NODE_ENV: "test", AMAP_ENABLED: "false" }), fetchMock);
		await expect(instance.city(origin)).rejects.toThrow("LOCATION_CITY_PROVIDER_UNAVAILABLE");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
