import type { Coordinate, DataSourceCode } from "@chi-shen-me/contracts";

export const LOCATION_SEARCH_PROVIDER = Symbol("LOCATION_SEARCH_PROVIDER");

export interface LocationSearchCandidate {
	readonly name: string;
	readonly address: string | null;
	readonly location: Coordinate;
	readonly sourceLabel: string;
	readonly providerRank: number;
}

/**
 * Provider-neutral boundary. A new licensed supplier must implement only this
 * adapter and must never expose its private identifier through the public DTO.
 */
export interface LocationSearchProvider {
	readonly dataSource: DataSourceCode;
	readonly dataMode: "LIVE" | "DEMO";
	search(query: string): Promise<readonly LocationSearchCandidate[]>;
}

export type LocationSearchFailureReason =
	| "DISABLED"
	| "TIMEOUT"
	| "UPSTREAM_HTTP"
	| "UPSTREAM_REJECTED"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_RESPONSE"
	| "NETWORK_ERROR";

export class LocationSearchProviderUnavailableError extends Error {
	constructor(readonly reason: LocationSearchFailureReason = "NETWORK_ERROR") {
		super("地点数据服务暂时不可用");
		this.name = "LocationSearchProviderUnavailableError";
	}
}
