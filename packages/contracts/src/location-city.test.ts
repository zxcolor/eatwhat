import { describe, expect, it } from "vitest";
import { LocationCityRequestSchema, LocationCityResponseSchema } from "./index.js";

describe("city-only lookup contract", () => {
	it("requires explicit CRS and bounded coordinates without extra personal data", () => {
		expect(LocationCityRequestSchema.parse({ location: { latitude: 0, longitude: 0, crs: "WGS84" } })).toEqual({ location: { latitude: 0, longitude: 0, crs: "WGS84" } });
		for (const value of [
			{ location: { latitude: 0, longitude: 0 } },
			{ location: { latitude: 91, longitude: 0, crs: "WGS84" } },
			{ location: { latitude: 0, longitude: 181, crs: "GCJ02" } },
			{ location: { latitude: 0, longitude: 0, crs: "WGS84", accuracyMeters: 5 } },
			{ location: { latitude: 0, longitude: 0, crs: "WGS84" }, label: "private address" },
		]) expect(LocationCityRequestSchema.safeParse(value).success).toBe(false);
	});
	it("allows unknown city but no blank name, excessive value or address fields", () => {
		expect(LocationCityResponseSchema.parse({ city: null })).toEqual({ city: null });
		expect(LocationCityResponseSchema.parse({ city: " 北京市 " })).toEqual({ city: "北京市" });
		for (const value of [{ city: " " }, { city: "x".repeat(81) }, { city: "北京市", address: "private address" }]) {
			expect(LocationCityResponseSchema.safeParse(value).success).toBe(false);
		}
	});
});
