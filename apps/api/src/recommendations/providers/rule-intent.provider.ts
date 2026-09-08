import {
	CuisinePreferenceSchema,
	type IntentProfile,
	IntentProfileSchema,
	type RecommendationContext,
} from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import {
	buildRecommendationQueryPlan,
	type RecommendationQueryPlan,
} from "../domain/recommendation-query-plan.js";

export interface IntentProvider {
	resolve(
		context: RecommendationContext,
		plan?: RecommendationQueryPlan,
	): Promise<IntentProfile>;
}

export function buildRuleIntent(
	context: RecommendationContext,
	plan: RecommendationQueryPlan = buildRecommendationQueryPlan(context),
): IntentProfile {
	// The client submits a set of choices, not an ordered preference ballot.
	// Canonical order also keeps capped meal types and their explanations stable.
	const preferredCuisines = CuisinePreferenceSchema.options.filter((cuisine) =>
		context.preferredCuisines.includes(cuisine),
	);
	const legacyMealTypes =
		context.mealPeriod === "BREAKFAST"
			? ["早餐", "包子", "粥", "面食", "快餐"]
			: context.mealPeriod === "DINNER"
				? context.partySize >= 3
					? ["晚餐", "正餐", "聚餐", "家常菜", "火锅"]
					: ["晚餐", "正餐", "家常菜", "面食"]
				: context.availableMinutes <= 45
					? ["午餐", "快餐", "盖饭", "面食", "简餐"]
					: ["午餐", "家常菜", "盖饭", "面食", "正餐"];
	const mealTypes =
		plan.profile.target === "MEAL"
			? legacyMealTypes
			: [plan.preferredTerm, ...preferredCuisines];
	const cuisineWeights = Object.fromEntries(
		preferredCuisines.map((cuisine) => [cuisine, 1]),
	);
	return IntentProfileSchema.parse({
		cuisineWeights,
		mealTypes: [
			...new Set(
				plan.profile.target === "MEAL"
					? [...preferredCuisines, ...mealTypes]
					: mealTypes,
			),
		].slice(0, 8),
		speedPreference:
			context.availableMinutes <= 45
				? "FAST"
				: context.availableMinutes >= 90
					? "RELAXED"
					: "NORMAL",
		diversityTarget:
			context.explorationMode === "SAFE"
				? 0.2
				: context.explorationMode === "ADVENTUROUS"
					? 0.9
					: 0.55,
		explanationSeed:
			plan.profile.target === "MEAL" && plan.weatherApplication.kind === "NONE"
				? "根据餐段、预算、时间和用户主动选择生成，不使用位置或账号信息"
				: "根据版本化目标和用户主动选择生成，不使用位置、账号或外部天气信息",
		provider: "RULE_FALLBACK",
	});
}

@Injectable()
export class RuleIntentProvider implements IntentProvider {
	async resolve(
		context: RecommendationContext,
		plan?: RecommendationQueryPlan,
	): Promise<IntentProfile> {
		return buildRuleIntent(context, plan);
	}
}
