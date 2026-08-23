import {
	type DataSourceCode,
	DataSourceCodeSchema,
} from "@chi-shen-me/contracts";

/**
 * Capabilities are explicit registration metadata. Selection must never infer
 * what an adapter can do from its provider code.
 */
export const ProviderCapability = Object.freeze({
	PLACE_RECOMMENDATION: "PLACE_RECOMMENDATION",
	PLACE_KEYWORD_SEARCH: "PLACE_KEYWORD_SEARCH",
	LOCATION_TEXT_SEARCH: "LOCATION_TEXT_SEARCH",
} as const);

export type ProviderCapability =
	(typeof ProviderCapability)[keyof typeof ProviderCapability];

export interface ProviderCatalogEntry {
	readonly code: DataSourceCode;
	readonly capabilities: readonly ProviderCapability[];
}

// This catalog lists only adapters that actually exist in this build. It is
// also the allow-list used while parsing priority configuration, so a typo or
// a not-yet-implemented supplier prevents startup instead of silently falling
// back to a different data source.
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = Object.freeze([
	Object.freeze({
		code: DataSourceCodeSchema.parse("AMAP"),
		capabilities: Object.freeze([
			ProviderCapability.PLACE_RECOMMENDATION,
			ProviderCapability.PLACE_KEYWORD_SEARCH,
			ProviderCapability.LOCATION_TEXT_SEARCH,
		]),
	}),
	Object.freeze({
		code: DataSourceCodeSchema.parse("DEMO"),
		capabilities: Object.freeze([
			ProviderCapability.PLACE_RECOMMENDATION,
			ProviderCapability.PLACE_KEYWORD_SEARCH,
			ProviderCapability.LOCATION_TEXT_SEARCH,
		]),
	}),
]);

export const REGISTERED_PROVIDER_CODES: readonly DataSourceCode[] =
	Object.freeze(PROVIDER_CATALOG.map(({ code }) => code));

export function getProviderCatalogEntry(
	code: DataSourceCode,
): ProviderCatalogEntry {
	const entry = PROVIDER_CATALOG.find((candidate) => candidate.code === code);
	if (entry === undefined) {
		throw new Error("供应商未在当前构建中注册");
	}
	return entry;
}

export function assertCatalogCapability(
	code: DataSourceCode,
	capability: ProviderCapability,
): void {
	if (!getProviderCatalogEntry(code).capabilities.includes(capability)) {
		throw new Error("供应商目录未声明适配器所需能力");
	}
}
