import type {
	PublicRecommendationDefaults,
	SpecialtyCapabilities,
} from "../config/feature-config";

export type MealPeriod = "BREAKFAST" | "LUNCH" | "DINNER";
export type RecommendationTarget = "MEAL" | "MILK_TEA" | "COFFEE" | "DESSERT";
export type UserReportedWeatherPreference =
	| "MINIMIZE_EXPOSURE"
	| "WARMING"
	| "COOLING";
export type WeatherContextRequest =
	| Readonly<{ kind: "NONE" }>
	| Readonly<{
			kind: "USER_REPORTED";
			preference: UserReportedWeatherPreference;
	  }>;
export type DecisionScenario = "IN_A_HURRY" | "WORKDAY_LUNCH" | "BUSINESS_TRIP";
export interface RecommendationPreferenceVector {
	readonly quality: number;
	readonly time: number;
	readonly budget: number;
	readonly mealMatch: number;
	readonly diversity: number;
}
export const DEFAULT_PREFERENCE_VECTOR: RecommendationPreferenceVector =
	Object.freeze({
		quality: 100,
		time: 100,
		budget: 100,
		mealMatch: 100,
		diversity: 100,
	});
export interface RecommendationProfile {
	readonly target: RecommendationTarget;
	readonly family:
		| "MEAL_LEGACY"
		| "MEAL_BREAKFAST"
		| "MEAL_LUNCH"
		| "MEAL_DINNER"
		| "MILK_TEA"
		| "COFFEE"
		| "DESSERT";
	readonly version: string;
	readonly providerCapabilityRequired: boolean;
}
export type WeatherApplication =
	| Readonly<{ kind: "NONE"; version: string; queryModifier: null }>
	| Readonly<{
			kind: "USER_REPORTED";
			version: string;
			preference: UserReportedWeatherPreference;
			queryModifier:
				| "MINIMIZE_OUTDOOR_EXPOSURE"
				| "PREFER_WARMING_OPTIONS"
				| "PREFER_COOLING_OPTIONS";
	  }>;
export type DecisionMode = "QUICK" | "GUIDED";
export type TravelMode = "WALK" | "BIKE" | "TRANSIT";
export type ExplorationMode = "SAFE" | "BALANCED" | "ADVENTUROUS";
export type CoordinateReferenceSystem = "WGS84" | "GCJ02";
export type DataMode = "LIVE" | "DEMO";
export type DataRightsMode = "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT";
export type OpenStatus = "OPEN" | "CLOSED" | "UNKNOWN";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";

export const CUISINE_PREFERENCES = [
	"中式快餐",
	"面食",
	"米饭",
	"火锅",
	"川湘菜",
	"清真",
	"素食",
	"西餐",
] as const;

export type CuisinePreference = (typeof CUISINE_PREFERENCES)[number];

export interface Coordinate {
	readonly latitude: number;
	readonly longitude: number;
	readonly accuracyMeters?: number;
	readonly crs: CoordinateReferenceSystem;
}

export interface LocationChoice {
	readonly label: string;
	readonly coordinate: Coordinate;
	readonly isDemonstration: boolean;
	readonly isApproximate: boolean;
}

export interface DecisionForm {
	readonly target: RecommendationTarget;
	readonly weatherContext: WeatherContextRequest;
	readonly preferenceVector: RecommendationPreferenceVector;
	readonly location: LocationChoice | null;
	readonly mealPeriod: MealPeriod;
	readonly decisionMode: DecisionMode;
	readonly travelMode: TravelMode;
	readonly explorationMode: ExplorationMode;
	readonly budgetMaxYuan: number | null;
	readonly availableMinutes: number;
	readonly radiusMeters: number;
	readonly partySize: number;
	readonly excludedCuisines: readonly CuisinePreference[];
	readonly preferredCuisines: readonly CuisinePreference[];
	readonly aiAssistancePreferred: boolean;
}

export interface RecommendationContext {
	readonly target?: RecommendationTarget;
	readonly weatherContext?: WeatherContextRequest;
	readonly preferenceVector?: RecommendationPreferenceVector;
	readonly location: Coordinate;
	readonly locationLabel?: string;
	readonly mealPeriod: MealPeriod;
	readonly decisionMode: DecisionMode;
	readonly travelMode: TravelMode;
	readonly explorationMode: ExplorationMode;
	readonly aiAssistanceEnabled: boolean;
	readonly budgetMaxYuan: number | null;
	readonly availableMinutes: number;
	readonly radiusMeters: number;
	readonly partySize: number;
	readonly excludedCuisines: readonly CuisinePreference[];
	readonly preferredCuisines: readonly CuisinePreference[];
	readonly requestTime: string;
}

export interface RecommendationActions {
	readonly navigate: boolean;
	readonly call: boolean;
	readonly copyAddress: boolean;
	readonly share: boolean;
}

export type RecommendationReasonCode =
	| "TIME_FIT"
	| "BUDGET_FIT"
	| "DISTANCE_FIT"
	| "MEAL_FIT"
	| "QUALITY_SIGNAL"
	| "DIVERSITY";

export interface RecommendationReason {
	readonly code: RecommendationReasonCode;
	readonly text: string;
}

export interface RecommendationResult {
	readonly provider: string;
	readonly resultToken: string;
	readonly dataMode: DataMode;
	readonly actions: RecommendationActions;
	readonly name: string;
	readonly address: string;
	readonly rank: number;
	readonly fitScore: number | null;
	readonly sourceRating: number | null;
	readonly averageCostYuan: number | null;
	readonly distanceMeters: number;
	readonly estimatedTravelMinutes: number;
	readonly estimatedMealMinutes: number;
	readonly openStatus: OpenStatus;
	readonly tags: readonly string[];
	readonly imageUrl: string | null;
	readonly phone: string | null;
	readonly location: Coordinate;
	readonly reasons: readonly RecommendationReason[];
	readonly warnings: readonly string[];
	readonly confidence: Confidence;
	readonly aiAssisted: boolean;
	readonly sourceAttribution: string;
}

export interface RecommendationResponse {
	readonly profile?: RecommendationProfile;
	readonly weatherApplication?: WeatherApplication;
	readonly rulesConfigVersion?: number | null;
	readonly requestId: string;
	readonly generatedAt: string;
	readonly coverage: "NATIONWIDE";
	readonly dataRightsMode: DataRightsMode;
	readonly ruleVersion: string;
	readonly promptVersion: string;
	readonly modelVersion: string;
	readonly aiFallbackUsed: boolean;
	readonly results: readonly RecommendationResult[];
	readonly notice: string | null;
}

export interface LocationSearchPlace {
	readonly name: string;
	readonly address: string | null;
	readonly location: Coordinate;
	readonly sourceLabel: string;
	readonly providerRank: number;
}

export interface LocationSearchResponse {
	readonly requestId: string;
	readonly dataSource: string;
	readonly dataMode: DataMode;
	readonly results: readonly LocationSearchPlace[];
}

export type RecommendationEventType =
	| "IMPRESSION"
	| "DETAIL"
	| "FAVORITE"
	| "NAVIGATION"
	| "CALL"
	| "REROLL";

export interface RecommendationEvent {
	readonly requestId: string;
	readonly resultToken: string;
	readonly type: RecommendationEventType;
	readonly occurredAt: string;
}

export type ConfigurationState =
	| "UNCONFIRMED"
	| "TRUSTED_COMPATIBLE"
	| "UNAVAILABLE_RULES_ONLY"
	| "INCOMPATIBLE";

export interface DecisionAccessPolicy {
	readonly recommendationDefaults?: PublicRecommendationDefaults | null;
	readonly specialtyCapabilities?: SpecialtyCapabilities;
	readonly dataRightsMode?: DataRightsMode;
	readonly generation: number;
	readonly state: ConfigurationState;
	readonly recommendationsEnabled: boolean;
	readonly locationSearchEnabled: boolean;
	readonly aiEnabled: boolean;
}

export type LocationFailureKind =
	| "PRIVACY_REQUIRED"
	| "PERMISSION_DENIED"
	| "PERMISSION_PERMANENTLY_DENIED"
	| "UNAVAILABLE"
	| "CANCELLED";

export type LocationState =
	| { readonly status: "IDLE" }
	| { readonly status: "LOCATING" }
	| { readonly status: "READY"; readonly choice: LocationChoice }
	| {
			readonly status: "FAILED";
			readonly kind: LocationFailureKind;
			readonly message: string;
	  };

export type LocationSearchState =
	| { readonly status: "IDLE" }
	| { readonly status: "LOADING" }
	| { readonly status: "READY"; readonly response: LocationSearchResponse }
	| { readonly status: "EMPTY"; readonly response: LocationSearchResponse }
	| { readonly status: "FAILED"; readonly message: string };

export type RecommendationLoadState =
	| { readonly status: "IDLE" }
	| { readonly status: "LOADING" }
	| {
			readonly status: "READY";
			readonly response: RecommendationResponse;
			readonly context: RecommendationContext;
			readonly configurationGeneration: number;
			readonly trustedCompatibleConfiguration: boolean;
	  }
	| { readonly status: "FAILED"; readonly message: string };

export interface DecisionState {
	readonly activeScenario: DecisionScenario | null;
	readonly form: DecisionForm;
	readonly formError: string | null;
	readonly locationState: LocationState;
	readonly locationSearchQuery: string;
	readonly locationSearchState: LocationSearchState;
	readonly recommendation: RecommendationLoadState;
	readonly accessPolicy: DecisionAccessPolicy;
}

export const BUILT_IN_QUICK_LOCATIONS: readonly LocationChoice[] =
	Object.freeze([
		location("北京电子科技学院", 39.83639, 116.27362, 100),
		location("北京大学东门", 39.9928, 116.3109, 80),
		location("清华大学东门", 40.003, 116.3269, 80),
		location("中国人民大学东门", 39.97, 116.3212, 80),
		location("北京师范大学东门", 39.9614, 116.372, 80),
		location("国贸地铁站", 39.9091, 116.4612, 100),
	]);

function location(
	label: string,
	latitude: number,
	longitude: number,
	accuracyMeters: number,
): LocationChoice {
	return Object.freeze({
		label,
		coordinate: Object.freeze({
			latitude,
			longitude,
			accuracyMeters,
			crs: "WGS84",
		}),
		isDemonstration: true,
		isApproximate: false,
	});
}
