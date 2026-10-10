export type VersionStatus =
	| Readonly<{ kind: "COMPATIBLE"; minimumVersion: string }>
	| Readonly<{ kind: "UPDATE_REQUIRED"; minimumVersion: string }>
	| Readonly<{ kind: "CONFIGURATION_UNAVAILABLE" }>;

const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function compareNumericSegment(left: string, right: string): number {
	const normalizedLeft = left.replace(/^0+/u, "") || "0";
	const normalizedRight = right.replace(/^0+/u, "") || "0";
	return (
		normalizedLeft.length - normalizedRight.length ||
		normalizedLeft.localeCompare(normalizedRight)
	);
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".");
	const rightParts = right.split(".");
	for (let index = 0; index < 3; index += 1) {
		const comparison = compareNumericSegment(
			leftParts[index] ?? "0",
			rightParts[index] ?? "0",
		);
		if (comparison !== 0) return comparison;
	}
	return 0;
}

export function evaluateVersion(
	currentVersion: string,
	minimumVersion: unknown,
): VersionStatus {
	if (
		!STRICT_VERSION.test(currentVersion) ||
		typeof minimumVersion !== "string" ||
		!STRICT_VERSION.test(minimumVersion)
	) {
		return Object.freeze({ kind: "CONFIGURATION_UNAVAILABLE" });
	}
	return compareVersions(currentVersion, minimumVersion) < 0
		? Object.freeze({ kind: "UPDATE_REQUIRED", minimumVersion })
		: Object.freeze({ kind: "COMPATIBLE", minimumVersion });
}
