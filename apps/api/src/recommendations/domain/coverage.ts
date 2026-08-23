import type { Coordinate } from "@chi-shen-me/contracts";
import { coordinateReferenceSystem, wgs84ToGcj02 } from "./geo.js";

/**
 * 产品试点区的粗略多边形，不作为行政区划或真实四环道路边界使用。
 * 边界有意覆盖北四环高校密集区；客户端仍应显示“北京四环试点区（粗略）”。
 * 权威边界固定为 WGS84；GCJ02 输入会与一次性派生的 GCJ02 边界比较。
 */
export const BEIJING_FOURTH_RING_PILOT_POLYGON: readonly Coordinate[] =
	Object.freeze([
		{ longitude: 116.252, latitude: 39.858, crs: "WGS84" },
		{ longitude: 116.254, latitude: 39.925, crs: "WGS84" },
		{ longitude: 116.274, latitude: 39.995, crs: "WGS84" },
		{ longitude: 116.315, latitude: 40.018, crs: "WGS84" },
		{ longitude: 116.398, latitude: 40.021, crs: "WGS84" },
		{ longitude: 116.469, latitude: 39.997, crs: "WGS84" },
		{ longitude: 116.496, latitude: 39.95, crs: "WGS84" },
		{ longitude: 116.501, latitude: 39.878, crs: "WGS84" },
		{ longitude: 116.473, latitude: 39.842, crs: "WGS84" },
		{ longitude: 116.404, latitude: 39.82, crs: "WGS84" },
		{ longitude: 116.319, latitude: 39.821, crs: "WGS84" },
		{ longitude: 116.27, latitude: 39.835, crs: "WGS84" },
	]);

const BEIJING_FOURTH_RING_PILOT_POLYGON_GCJ02: readonly Coordinate[] =
	Object.freeze(BEIJING_FOURTH_RING_PILOT_POLYGON.map(wgs84ToGcj02));

function isOnSegment(point: Coordinate, a: Coordinate, b: Coordinate): boolean {
	const cross =
		(point.latitude - a.latitude) * (b.longitude - a.longitude) -
		(point.longitude - a.longitude) * (b.latitude - a.latitude);
	if (Math.abs(cross) > 1e-10) return false;
	return (
		point.longitude >= Math.min(a.longitude, b.longitude) &&
		point.longitude <= Math.max(a.longitude, b.longitude) &&
		point.latitude >= Math.min(a.latitude, b.latitude) &&
		point.latitude <= Math.max(a.latitude, b.latitude)
	);
}

export function isInsideBeijingFourthRingPilot(point: Coordinate): boolean {
	if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude))
		return false;
	const polygon =
		coordinateReferenceSystem(point) === "GCJ02"
			? BEIJING_FOURTH_RING_PILOT_POLYGON_GCJ02
			: BEIJING_FOURTH_RING_PILOT_POLYGON;

	let inside = false;
	for (let index = 0; index < polygon.length; index += 1) {
		const current = polygon[index];
		const previous = polygon[(index + polygon.length - 1) % polygon.length];
		if (current === undefined || previous === undefined) continue;
		if (isOnSegment(point, previous, current)) return true;

		const crossesLatitude =
			current.latitude > point.latitude !== previous.latitude > point.latitude;
		if (!crossesLatitude) continue;
		const intersectionLongitude =
			((previous.longitude - current.longitude) *
				(point.latitude - current.latitude)) /
				(previous.latitude - current.latitude) +
			current.longitude;
		if (point.longitude < intersectionLongitude) inside = !inside;
	}
	return inside;
}
