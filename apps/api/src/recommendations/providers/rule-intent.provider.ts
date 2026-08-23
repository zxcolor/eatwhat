import {
	type IntentProfile,
	IntentProfileSchema,
	type RecommendationContext,
} from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";

export interface IntentProvider {
	resolve(context: RecommendationContext): Promise<IntentProfile>;
}

export function buildRuleIntent(context: RecommendationContext): IntentProfile {
	const mealTypes =
		context.mealPeriod === "BREAKFAST"
			? ["早餐", "包子", "粥", "面食", "快餐"]
			: context.mealPeriod === "DINNER"
				? context.partySize >= 3
					? ["晚餐", "正餐", "聚餐", "家常菜", "火锅"]
					: ["晚餐", "正餐", "家常菜", "面食"]
				: context.availableMinutes <= 45
					? ["午餐", "快餐", "盖饭", "面食", "简餐"]
					: ["午餐", "家常菜", "盖饭", "面食", "正餐"];
	const cuisineWeights = Object.fromEntries(
		context.preferredCuisines.map((cuisine, index) => [
			cuisine,
			Math.max(0.45, 1 - index * 0.08),
		]),
	);
	return IntentProfileSchema.parse({
		cuisineWeights,
		mealTypes: [...new Set([...context.preferredCuisines, ...mealTypes])].slice(
			0,
			8,
		),
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
			"根据餐段、预算、时间和用户主动选择生成，不使用位置或账号信息",
		provider: "RULE_FALLBACK",
	});
}

@Injectable()
export class RuleIntentProvider implements IntentProvider {
	async resolve(context: RecommendationContext): Promise<IntentProfile> {
		return buildRuleIntent(context);
	}
}
