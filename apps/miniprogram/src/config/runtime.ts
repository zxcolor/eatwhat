const DEFAULT_API_BASE_URL = "https://api.unfinished-era.com/";

export interface RuntimeConfig {
	readonly apiBaseUrl: string;
	readonly appVersion: string;
}

export function normalizeApiBaseUrl(value: string): string {
	const normalized = value.trim().replace(/\/+$/u, "");
	// A deployment extension must never redirect credentials or location to an
	// arbitrary host. Staging requires a separately reviewed build and domain.
	if (normalized !== DEFAULT_API_BASE_URL.replace(/\/$/u, "")) {
		throw new Error("API_BASE_URL_INVALID");
	}
	return normalized;
}

export function resolveRuntimeConfig(
	runtime: Pick<WxRuntime, "getExtConfigSync">,
): RuntimeConfig {
	const extension = runtime.getExtConfigSync?.();
	const candidate =
		extension !== undefined && typeof extension.apiBaseUrl === "string"
			? extension.apiBaseUrl
			: DEFAULT_API_BASE_URL;
	return Object.freeze({
		apiBaseUrl: normalizeApiBaseUrl(candidate),
		appVersion: "0.1.0",
	});
}
