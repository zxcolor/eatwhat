import { describe, expect, it } from "vitest";
import {
	CoordinateReferenceSystemMismatchError,
	haversineDistanceMeters,
	haversineDistanceMetersUnrounded,
	isOutsideMainlandChina,
	toGcj02,
	wgs84ToGcj02,
} from "./geo.js";

describe("WGS84 to GCJ02 conversion", () => {
	it("matches a Beijing control point deterministically", () => {
		const converted = wgs84ToGcj02({
			latitude: 39.908823,
			longitude: 116.39747,
			accuracyMeters: 12,
			crs: "WGS84",
		});

		expect(converted.latitude).toBeCloseTo(39.9102265, 6);
		expect(converted.longitude).toBeCloseTo(116.4037136, 6);
		expect(converted.accuracyMeters).toBe(12);
		expect(converted.crs).toBe("GCJ02");
	});

	it("does not numerically offset points outside mainland China", () => {
		const london = {
			latitude: 51.5074,
			longitude: -0.1278,
			crs: "WGS84" as const,
		};
		expect(isOutsideMainlandChina(london)).toBe(true);
		expect(wgs84ToGcj02(london)).toEqual({ ...london, crs: "GCJ02" });
	});

	it("does not transform an explicitly GCJ02 point twice", () => {
		const gcj02 = {
			latitude: 39.9102265,
			longitude: 116.4037136,
			crs: "GCJ02" as const,
		};
		expect(toGcj02(gcj02)).toEqual(gcj02);
		expect(() => wgs84ToGcj02(gcj02)).toThrow(
			CoordinateReferenceSystemMismatchError,
		);
	});

	it("rejects distance calculations that mix coordinate systems", () => {
		for (const distance of [
			haversineDistanceMeters,
			haversineDistanceMetersUnrounded,
		])
			expect(() =>
				distance(
					{ latitude: 39.9, longitude: 116.4, crs: "WGS84" },
					{ latitude: 39.9, longitude: 116.4, crs: "GCJ02" },
				),
			).toThrow(CoordinateReferenceSystemMismatchError);
	});

	it("retains sub-metre boundary evidence while preserving the rounded display helper", () => {
		const origin = { latitude: 0, longitude: 0, crs: "WGS84" as const };
		const outside = {
			latitude: (1500.4 / 6371000) * (180 / Math.PI),
			longitude: 0,
			crs: "WGS84" as const,
		};
		expect(haversineDistanceMetersUnrounded(origin, outside)).toBeCloseTo(
			1500.4,
			8,
		);
		expect(haversineDistanceMetersUnrounded(origin, outside)).toBeGreaterThan(
			1500,
		);
		expect(haversineDistanceMeters(origin, outside)).toBe(1500);
	});
});
