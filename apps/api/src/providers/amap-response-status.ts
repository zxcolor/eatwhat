export type AmapFailureClassification =
	| "CONFIGURATION_OR_PERMISSION"
	| "QUOTA_OR_RATE_LIMIT"
	| "REQUEST_REJECTED"
	| "UPSTREAM_TRANSIENT"
	| "UNKNOWN_REJECTION"
	| "MALFORMED_RESPONSE";

export type AmapResponseStatus =
	| Readonly<{
			classification: "SUCCESS";
			safeInfocode: "10000";
	  }>
	| AmapFailureDiagnostic;

export interface AmapFailureDiagnostic {
	readonly classification: AmapFailureClassification;
	/**
	 * Only an explicitly allowlisted official code, 3XXXX, or UNKNOWN is ever
	 * returned. The caller must never substitute the raw upstream value here.
	 */
	readonly safeInfocode: string;
}

const CONFIGURATION_OR_PERMISSION_CODES = new Set([
	"10001",
	"10002",
	"10005",
	"10006",
	"10007",
	"10008",
	"10009",
	"10011",
	"10012",
	"10013",
	"10026",
	"10041",
	"40002",
]);

const QUOTA_OR_RATE_LIMIT_CODES = new Set([
	"10003",
	"10004",
	"10010",
	"10014",
	"10015",
	"10019",
	"10020",
	"10021",
	"10029",
	"10044",
	"10045",
	"40000",
	"40001",
	"40003",
]);

const REQUEST_REJECTED_CODES = new Set([
	"20000",
	"20001",
	"20002",
	"20011",
	"20012",
	"20800",
	"20801",
	"20802",
	"20803",
]);

const UPSTREAM_TRANSIENT_CODES = new Set(["10016", "10017", "20003"]);

const AMAP_FAILURE_DIAGNOSTIC = Symbol("AMAP_FAILURE_DIAGNOSTIC");

type ErrorWithAmapFailureDiagnostic = Error & {
	readonly [AMAP_FAILURE_DIAGNOSTIC]?: AmapFailureDiagnostic;
};

function exactUpstreamString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 16 ? trimmed : null;
}

function failure(
	classification: AmapFailureClassification,
	safeInfocode: string,
): AmapFailureDiagnostic {
	return Object.freeze({ classification, safeInfocode });
}

/**
 * Classifies only the low-cardinality status fields documented by AMap. The
 * upstream `info` string and response body are intentionally not accepted, so
 * they cannot accidentally cross this diagnostic boundary.
 */
export function classifyAmapResponseStatus(
	statusValue: unknown,
	infocodeValue: unknown,
): AmapResponseStatus {
	const status = exactUpstreamString(statusValue);
	const infocode = exactUpstreamString(infocodeValue);

	if (status === "1" && infocode === "10000") {
		return Object.freeze({ classification: "SUCCESS", safeInfocode: "10000" });
	}
	if (status !== "0" || infocode === null || infocode === "10000") {
		return failure("MALFORMED_RESPONSE", "UNKNOWN");
	}
	if (CONFIGURATION_OR_PERMISSION_CODES.has(infocode)) {
		return failure("CONFIGURATION_OR_PERMISSION", infocode);
	}
	if (QUOTA_OR_RATE_LIMIT_CODES.has(infocode)) {
		return failure("QUOTA_OR_RATE_LIMIT", infocode);
	}
	if (REQUEST_REJECTED_CODES.has(infocode)) {
		return failure("REQUEST_REJECTED", infocode);
	}
	if (UPSTREAM_TRANSIENT_CODES.has(infocode)) {
		return failure("UPSTREAM_TRANSIENT", infocode);
	}
	// The official table groups 300** engine response failures. Preserve the
	// class without echoing a not-individually-allowlisted upstream value.
	if (/^3\d{4}$/u.test(infocode)) {
		return failure("UPSTREAM_TRANSIENT", "3XXXX");
	}
	return failure("UNKNOWN_REJECTION", "UNKNOWN");
}

/** Attach safe AMap diagnostics without making them enumerable or serializable. */
export function attachAmapFailureDiagnostic<TError extends Error>(
	error: TError,
	diagnostic: AmapFailureDiagnostic,
): TError {
	Object.defineProperty(error, AMAP_FAILURE_DIAGNOSTIC, {
		configurable: false,
		enumerable: false,
		value: diagnostic,
		writable: false,
	});
	return error;
}

export function getAmapFailureDiagnostic(
	error: unknown,
): AmapFailureDiagnostic | null {
	if (!(error instanceof Error)) return null;
	return (
		(error as ErrorWithAmapFailureDiagnostic)[AMAP_FAILURE_DIAGNOSTIC] ?? null
	);
}
