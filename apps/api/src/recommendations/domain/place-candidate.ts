import type {
	Coordinate,
	DataMode,
	DataSourceCode,
	RecommendationActions,
	RecommendationContext,
} from "@chi-shen-me/contracts";

export interface PlaceCandidate {
	readonly provider: DataSourceCode;
	readonly providerPlaceId: string;
	readonly providerRank: number;
	readonly dataMode: DataMode;
	readonly actions: Readonly<RecommendationActions>;
	readonly name: string;
	readonly address: string;
	readonly sourceRating: number | null;
	readonly averageCostYuan: number | null;
	readonly distanceMeters: number;
	readonly estimatedTravelMinutes: number;
	readonly estimatedMealMinutes: number;
	readonly openStatus: "OPEN" | "CLOSED" | "UNKNOWN";
	readonly tags: readonly string[];
	readonly imageUrl: string | null;
	readonly phone: string | null;
	readonly location: Coordinate;
	readonly sourceAttribution: string;
	readonly editorialAdjustment: number;
	readonly blocked: boolean;
}

export interface PlaceProvider {
	readonly kind: DataSourceCode;
	readonly dataMode: DataMode;
	search(
		context: RecommendationContext,
		mealTypes: readonly string[],
	): Promise<readonly PlaceCandidate[]>;
}

export const PLACE_PROVIDER = Symbol("PLACE_PROVIDER");
