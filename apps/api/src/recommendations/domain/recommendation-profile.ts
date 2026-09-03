import type {
	MealPeriod,
	RecommendationProfile,
	RecommendationTarget,
} from "@chi-shen-me/contracts";

export const RECOMMENDATION_PROVIDER_CATEGORY = "餐饮服务" as const;

export const RECOMMENDATION_PROFILE_TERM_ALLOWLIST = [
	"早餐",
	"午餐",
	"晚餐",
	"奶茶店",
	"咖啡店",
	"甜品店",
] as const;

export type RecommendationProfileTerm =
	(typeof RECOMMENDATION_PROFILE_TERM_ALLOWLIST)[number];

type ActiveRecommendationProfile = Exclude<
	RecommendationProfile,
	{ family: "MEAL_LEGACY" }
>;

export type RecommendationProfileDefinition = ActiveRecommendationProfile & {
	readonly preferredTerm: RecommendationProfileTerm;
	readonly providerCategory: typeof RECOMMENDATION_PROVIDER_CATEGORY;
};

const profile = (
	value: RecommendationProfileDefinition,
): RecommendationProfileDefinition => Object.freeze(value);

const MEAL_PROFILES: Readonly<
	Record<MealPeriod, RecommendationProfileDefinition>
> = Object.freeze({
	BREAKFAST: profile({
		target: "MEAL",
		family: "MEAL_BREAKFAST",
		version: "meal-breakfast-v1",
		providerCapabilityRequired: false,
		preferredTerm: "早餐",
		providerCategory: RECOMMENDATION_PROVIDER_CATEGORY,
	}),
	LUNCH: profile({
		target: "MEAL",
		family: "MEAL_LUNCH",
		version: "meal-lunch-v1",
		providerCapabilityRequired: false,
		preferredTerm: "午餐",
		providerCategory: RECOMMENDATION_PROVIDER_CATEGORY,
	}),
	DINNER: profile({
		target: "MEAL",
		family: "MEAL_DINNER",
		version: "meal-dinner-v1",
		providerCapabilityRequired: false,
		preferredTerm: "晚餐",
		providerCategory: RECOMMENDATION_PROVIDER_CATEGORY,
	}),
});

const VERTICAL_PROFILES: Readonly<
	Record<Exclude<RecommendationTarget, "MEAL">, RecommendationProfileDefinition>
> = Object.freeze({
	MILK_TEA: profile({
		target: "MILK_TEA",
		family: "MILK_TEA",
		version: "milk-tea-v1",
		providerCapabilityRequired: true,
		preferredTerm: "奶茶店",
		providerCategory: RECOMMENDATION_PROVIDER_CATEGORY,
	}),
	COFFEE: profile({
		target: "COFFEE",
		family: "COFFEE",
		version: "coffee-v1",
		providerCapabilityRequired: true,
		preferredTerm: "咖啡店",
		providerCategory: RECOMMENDATION_PROVIDER_CATEGORY,
	}),
	DESSERT: profile({
		target: "DESSERT",
		family: "DESSERT",
		version: "dessert-v1",
		providerCapabilityRequired: true,
		preferredTerm: "甜品店",
		providerCategory: RECOMMENDATION_PROVIDER_CATEGORY,
	}),
});

/**
 * Resolves only an internal query profile. Every adapter must still explicitly
 * accept the resulting plan. Synthetic DEMO fixtures may accept these v1
 * profiles; a live adapter must reject them until an independently authorized
 * provider taxonomy/capability is wired.
 */
export function resolveRecommendationProfile(
	target: RecommendationTarget,
	mealPeriod: MealPeriod,
): RecommendationProfileDefinition {
	return target === "MEAL"
		? MEAL_PROFILES[mealPeriod]
		: VERTICAL_PROFILES[target];
}
