import {
	type CuisinePreference,
	type RecommendationContext,
	type RecommendationProfile,
	RecommendationProfileSchema,
	type WeatherApplication,
	type WeatherContextRequest,
} from "@chi-shen-me/contracts";
import {
	type RecommendationProfileTerm,
	resolveRecommendationProfile,
} from "./recommendation-profile.js";

export type RecommendationQueryPlan = Readonly<{
	profile: RecommendationProfile;
	preferredTerm: RecommendationProfileTerm;
	supplementalCuisineTerms: readonly CuisinePreference[];
	queryTerms: readonly string[];
	providerCategory: "餐饮服务";
	providerCapabilityRequired: boolean;
	weatherApplication: WeatherApplication;
}>;

const NONE_WEATHER_APPLICATION = Object.freeze({
	kind: "NONE" as const,
	version: "weather-none-v1" as const,
	queryModifier: null,
});

function applyUserReportedWeather(
	weatherContext: WeatherContextRequest,
): WeatherApplication {
	if (weatherContext.kind === "NONE") return NONE_WEATHER_APPLICATION;
	switch (weatherContext.preference) {
		case "MINIMIZE_EXPOSURE":
			return {
				kind: "USER_REPORTED",
				version: "user-reported-weather-v1",
				preference: "MINIMIZE_EXPOSURE",
				queryModifier: "MINIMIZE_OUTDOOR_EXPOSURE",
			};
		case "WARMING":
			return {
				kind: "USER_REPORTED",
				version: "user-reported-weather-v1",
				preference: "WARMING",
				queryModifier: "PREFER_WARMING_OPTIONS",
			};
		case "COOLING":
			return {
				kind: "USER_REPORTED",
				version: "user-reported-weather-v1",
				preference: "COOLING",
				queryModifier: "PREFER_COOLING_OPTIONS",
			};
		default:
			return assertNeverWeatherPreference(weatherContext.preference);
	}
}

function assertNeverWeatherPreference(value: never): never {
	throw new Error(
		`Unsupported user-reported weather preference: ${String(value)}`,
	);
}

/**
 * Produces a request-scoped provider query plan only. The weather modifier is
 * explanatory query input; this module has no result re-ranking or persistence
 * surface. Profile terms always lead user cuisine terms, so a cuisine choice
 * cannot replace the breakfast or dinner profile intent.
 */
export function buildRecommendationQueryPlan(
	context: Pick<
		RecommendationContext,
		"mealPeriod" | "preferredCuisines" | "target" | "weatherContext"
	>,
): RecommendationQueryPlan {
	const definition = resolveRecommendationProfile(
		context.target,
		context.mealPeriod,
	);
	const supplementalCuisineTerms = Object.freeze([
		...new Set(context.preferredCuisines),
	]);
	const queryTerms = Object.freeze([
		definition.preferredTerm,
		...supplementalCuisineTerms,
	]);
	const profile: RecommendationProfile = RecommendationProfileSchema.parse({
		target: definition.target,
		family: definition.family,
		version: definition.version,
		providerCapabilityRequired: definition.providerCapabilityRequired,
	});

	return Object.freeze({
		profile: Object.freeze(profile),
		preferredTerm: definition.preferredTerm,
		supplementalCuisineTerms,
		queryTerms,
		providerCategory: definition.providerCategory,
		providerCapabilityRequired: definition.providerCapabilityRequired,
		weatherApplication: Object.freeze(
			applyUserReportedWeather(context.weatherContext),
		),
	});
}
