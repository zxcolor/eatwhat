import type {
	Coordinate,
	CoordinateReferenceSystem,
} from "@chi-shen-me/contracts";

const EARTH_RADIUS_METERS = 6_371_000;
const GCJ_SEMI_MAJOR_AXIS = 6_378_245;
const GCJ_ECCENTRICITY_SQUARED = 0.006693421622965943;

export class CoordinateReferenceSystemMismatchError extends Error {
	constructor(
		first: CoordinateReferenceSystem,
		second: CoordinateReferenceSystem,
	) {
		super(`坐标系不一致：${first} 与 ${second}`);
		this.name = "CoordinateReferenceSystemMismatchError";
	}
}

export function coordinateReferenceSystem(
	coordinate: Coordinate,
): CoordinateReferenceSystem {
	// Runtime compatibility for callers that have not yet passed through the Zod default.
	return coordinate.crs ?? "WGS84";
}

export function isOutsideMainlandChina(
	coordinate: Pick<Coordinate, "latitude" | "longitude">,
): boolean {
	return (
		coordinate.longitude < 72.004 ||
		coordinate.longitude > 137.8347 ||
		coordinate.latitude < 0.8293 ||
		coordinate.latitude > 55.8271
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

/** Deterministic conversion used only at the WGS84 -> AMap/GCJ02 boundary. */
export function wgs84ToGcj02(coordinate: Coordinate): Coordinate {
	const sourceCrs = coordinateReferenceSystem(coordinate);
	if (sourceCrs !== "WGS84") {
		throw new CoordinateReferenceSystemMismatchError(sourceCrs, "WGS84");
	}
	if (isOutsideMainlandChina(coordinate)) {
		return { ...coordinate, crs: "GCJ02" };
	}

	const latitudeRadians = (coordinate.latitude / 180) * Math.PI;
	const sineLatitude = Math.sin(latitudeRadians);
	const magic = 1 - GCJ_ECCENTRICITY_SQUARED * sineLatitude * sineLatitude;
	const squareRootMagic = Math.sqrt(magic);
	const latitudeDelta =
		(transformLatitude(coordinate.longitude - 105, coordinate.latitude - 35) *
			180) /
		(((GCJ_SEMI_MAJOR_AXIS * (1 - GCJ_ECCENTRICITY_SQUARED)) /
			(magic * squareRootMagic)) *
			Math.PI);
	const longitudeDelta =
		(transformLongitude(coordinate.longitude - 105, coordinate.latitude - 35) *
			180) /
		((GCJ_SEMI_MAJOR_AXIS / squareRootMagic) *
			Math.cos(latitudeRadians) *
			Math.PI);

	return {
		...coordinate,
		latitude: coordinate.latitude + latitudeDelta,
		longitude: coordinate.longitude + longitudeDelta,
		crs: "GCJ02",
	};
}

/** Idempotent target conversion: an already-GCJ02 point is never offset twice. */
export function toGcj02(coordinate: Coordinate): Coordinate {
	return coordinateReferenceSystem(coordinate) === "GCJ02"
		? { ...coordinate, crs: "GCJ02" }
		: wgs84ToGcj02(coordinate);
}

export function haversineDistanceMeters(a: Coordinate, b: Coordinate): number {
	const firstCrs = coordinateReferenceSystem(a);
	const secondCrs = coordinateReferenceSystem(b);
	if (firstCrs !== secondCrs) {
		throw new CoordinateReferenceSystemMismatchError(firstCrs, secondCrs);
	}
	const radians = (degrees: number) => (degrees * Math.PI) / 180;
	const latitudeDelta = radians(b.latitude - a.latitude);
	const longitudeDelta = radians(b.longitude - a.longitude);
	const latitudeA = radians(a.latitude);
	const latitudeB = radians(b.latitude);
	const haversine =
		Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(latitudeA) *
			Math.cos(latitudeB) *
			Math.sin(longitudeDelta / 2) ** 2;
	return Math.round(
		EARTH_RADIUS_METERS *
			2 *
			Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)),
	);
}

export function estimateTravelMinutes(
	distanceMeters: number,
	mode: "WALK" | "BIKE" | "TRANSIT",
): number {
	const minutes =
		mode === "WALK"
			? distanceMeters / 80
			: mode === "BIKE"
				? distanceMeters / 240
				: distanceMeters / 300 + 6;
	return Math.max(1, Math.ceil(minutes));
}
