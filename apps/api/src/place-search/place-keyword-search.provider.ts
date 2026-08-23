import type {
	DataMode,
	DataSourceCode,
	PlaceSearchCoordinate,
	PlaceSearchRequest,
	RecommendationActions,
} from "@chi-shen-me/contracts";

export interface PlaceKeywordSearchCandidate {
	readonly provider: DataSourceCode;
	readonly providerPlaceId: string;
	readonly providerRank: number;
	readonly name: string;
	readonly address: string | null;
	readonly location: PlaceSearchCoordinate;
	readonly distanceMeters: number;
	readonly sourceLabel: string;
	readonly sourceRating: number | null;
	readonly averageCostYuan: number | null;
	readonly openStatus: "OPEN" | "CLOSED" | "UNKNOWN";
	readonly tags: readonly string[];
	readonly dataMode: DataMode;
	readonly actions: Readonly<RecommendationActions>;
}

export interface PlaceKeywordSearchProvider {
	readonly dataSource: DataSourceCode;
	readonly dataMode: DataMode;
	search(
		request: PlaceSearchRequest,
	): Promise<readonly PlaceKeywordSearchCandidate[]>;
}

export const PLACE_KEYWORD_SEARCH_PROVIDER = Symbol(
	"PLACE_KEYWORD_SEARCH_PROVIDER",
);

export type PlaceKeywordSearchFailureReason =
	| "DISABLED"
	| "TIMEOUT"
	| "UPSTREAM_HTTP"
	| "UPSTREAM_REJECTED"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_RESPONSE"
	| "NETWORK_ERROR";

export class PlaceKeywordSearchProviderUnavailableError extends Error {
	constructor(
		readonly reason: PlaceKeywordSearchFailureReason = "NETWORK_ERROR",
	) {
		super("餐厅关键词搜索服务暂时不可用");
		this.name = "PlaceKeywordSearchProviderUnavailableError";
	}
}
