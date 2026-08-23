import { createHash } from "node:crypto";

const AMAP_WEB_SERVICE_ORIGIN = "https://restapi.amap.com";

/**
 * Official Web Service signature payload: request parameters (including key),
 * sorted by parameter name, followed directly by the per-Key private key.
 */
export function computeAmapWebServiceSignature(
	parameters: URLSearchParams,
	privateKey: string,
): string {
	if (privateKey.length === 0) {
		throw new Error("AMAP_SIGNATURE_CONFIGURATION_INVALID");
	}
	const entries = [...parameters.entries()];
	if (entries.some(([name]) => name === "sig")) {
		throw new Error("AMAP_SIGNATURE_ALREADY_PRESENT");
	}
	if (new Set(entries.map(([name]) => name)).size !== entries.length) {
		throw new Error("AMAP_SIGNATURE_DUPLICATE_PARAMETER");
	}
	const canonical = entries
		.sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join("&");
	return createHash("md5")
		.update(`${canonical}${privateKey}`, "utf8")
		.digest("hex");
}

/** Sign only the fixed official HTTPS host; the private key never enters URL. */
export function applyAmapWebServiceSignature(
	endpoint: URL,
	privateKey: string | null,
): void {
	if (privateKey === null) return;
	if (
		endpoint.origin !== AMAP_WEB_SERVICE_ORIGIN ||
		endpoint.username !== "" ||
		endpoint.password !== "" ||
		endpoint.hash !== ""
	) {
		throw new Error("AMAP_SIGNATURE_ENDPOINT_INVALID");
	}
	if (!endpoint.searchParams.has("key")) {
		throw new Error("AMAP_SIGNATURE_KEY_MISSING");
	}
	endpoint.searchParams.set(
		"sig",
		computeAmapWebServiceSignature(endpoint.searchParams, privateKey),
	);
}
