import type { Coordinate } from "./types";

export interface Gcj02Coordinate {
	readonly latitude: number;
	readonly longitude: number;
}

/** Transient, on-device WGS84 to GCJ02 alignment for wx.openLocation. */
export function toGcj02(coordinate: Coordinate): Gcj02Coordinate | null {
	const { latitude, longitude } = coordinate;
	if (
		!Number.isFinite(latitude) ||
		latitude < -90 ||
		latitude > 90 ||
		!Number.isFinite(longitude) ||
		longitude < -180 ||
		longitude > 180
	)
		return null;
	if (coordinate.crs === "GCJ02" || outsideMainlandChina(latitude, longitude)) {
		return Object.freeze({ latitude, longitude });
	}

	const latitudeRadians = (latitude / 180) * Math.PI;
	const sineLatitude = Math.sin(latitudeRadians);
	const magic = 1 - GCJ_ECCENTRICITY_SQUARED * sineLatitude * sineLatitude;
	const squareRootMagic = Math.sqrt(magic);
	const latitudeDelta =
		(transformLatitude(longitude - 105, latitude - 35) * 180) /
		(((GCJ_SEMI_MAJOR_AXIS * (1 - GCJ_ECCENTRICITY_SQUARED)) /
			(magic * squareRootMagic)) *
			Math.PI);
	const longitudeDelta =
		(transformLongitude(longitude - 105, latitude - 35) * 180) /
		((GCJ_SEMI_MAJOR_AXIS / squareRootMagic) *
			Math.cos(latitudeRadians) *
			Math.PI);
	const converted = {
		latitude: latitude + latitudeDelta,
		longitude: longitude + longitudeDelta,
	};
	return Number.isFinite(converted.latitude) &&
		Number.isFinite(converted.longitude)
		? Object.freeze(converted)
		: null;
}

function outsideMainlandChina(latitude: number, longitude: number): boolean {
	return (
		longitude < 72.004 ||
		longitude > 137.8347 ||
		latitude < 0.8293 ||
		latitude > 55.8271
	);
}

function transformLatitude(
	longitudeOffset: number,
	latitudeOffset: number,
): number {
	let value =
		-100 +
		2 * longitudeOffset +
		3 * latitudeOffset +
		0.2 * latitudeOffset * latitudeOffset +
		0.1 * longitudeOffset * latitudeOffset +
		0.2 * Math.sqrt(Math.abs(longitudeOffset));
	value +=
		((20 * Math.sin(6 * longitudeOffset * Math.PI) +
			20 * Math.sin(2 * longitudeOffset * Math.PI)) *
			2) /
		3;
	value +=
		((20 * Math.sin(latitudeOffset * Math.PI) +
			40 * Math.sin((latitudeOffset / 3) * Math.PI)) *
			2) /
		3;
	value +=
		((160 * Math.sin((latitudeOffset / 12) * Math.PI) +
			320 * Math.sin((latitudeOffset * Math.PI) / 30)) *
			2) /
		3;
	return value;
}

function transformLongitude(
	longitudeOffset: number,
	latitudeOffset: number,
): number {
	let value =
		300 +
		longitudeOffset +
		2 * latitudeOffset +
		0.1 * longitudeOffset * longitudeOffset +
		0.1 * longitudeOffset * latitudeOffset +
		0.1 * Math.sqrt(Math.abs(longitudeOffset));
	value +=
		((20 * Math.sin(6 * longitudeOffset * Math.PI) +
			20 * Math.sin(2 * longitudeOffset * Math.PI)) *
			2) /
		3;
	value +=
		((20 * Math.sin(longitudeOffset * Math.PI) +
			40 * Math.sin((longitudeOffset / 3) * Math.PI)) *
			2) /
		3;
	value +=
		((150 * Math.sin((longitudeOffset / 12) * Math.PI) +
			300 * Math.sin((longitudeOffset / 30) * Math.PI)) *
			2) /
		3;
	return value;
}

const GCJ_SEMI_MAJOR_AXIS = 6_378_245;
const GCJ_ECCENTRICITY_SQUARED = 0.006693421622965943;
