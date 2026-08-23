import { describe, expect, it } from "vitest";
import {
	BEIJING_FOURTH_RING_PILOT_POLYGON,
	isInsideBeijingFourthRingPilot,
} from "./coverage.js";
import { toGcj02 } from "./geo.js";

describe("Beijing fourth-ring pilot coverage", () => {
	it("includes central Beijing and the north-fourth-ring university pilot", () => {
		expect(
			isInsideBeijingFourthRingPilot({
				latitude: 39.9087,
				longitude: 116.3975,
				crs: "WGS84",
			}),
		).toBe(true);
		const university = {
			latitude: 39.9928,
			longitude: 116.3109,
			crs: "WGS84" as const,
		};
		expect(isInsideBeijingFourthRingPilot(university)).toBe(true);
		expect(isInsideBeijingFourthRingPilot(toGcj02(university))).toBe(true);
	});

	it("excludes locations clearly outside the pilot", () => {
		expect(
			isInsideBeijingFourthRingPilot({
				latitude: 40.19,
				longitude: 116.41,
				crs: "WGS84",
			}),
		).toBe(false);
		expect(
			isInsideBeijingFourthRingPilot({
				latitude: 31.23,
				longitude: 121.47,
				crs: "WGS84",
			}),
		).toBe(false);
	});

	it("treats a polygon boundary point as inside", () => {
		const boundaryPoint = BEIJING_FOURTH_RING_PILOT_POLYGON[0];
		expect(boundaryPoint).toBeDefined();
		if (boundaryPoint === undefined) throw new Error("试点区多边形不能为空");
		expect(isInsideBeijingFourthRingPilot(boundaryPoint)).toBe(true);
	});
});
