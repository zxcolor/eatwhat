import type {
	IntentProfile,
	RecommendationContext,
} from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { OperationalConfigSnapshot } from "../../operational-config/operational-config.types.js";
import {
	buildRecommendationQueryPlan,
	type RecommendationQueryPlan,
} from "../domain/recommendation-query-plan.js";
import { QwenIntentProvider } from "./qwen-intent.provider.js";
import { RuleIntentProvider } from "./rule-intent.provider.js";

export interface ResolvedIntent {
	readonly profile: IntentProfile;
	readonly fallbackUsed: boolean;
	readonly modelVersion: string;
}

@Injectable()
export class IntentCoordinator {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly qwen: QwenIntentProvider,
		private readonly rules: RuleIntentProvider,
	) {}

	async resolve(
		context: RecommendationContext,
		plan: RecommendationQueryPlan = buildRecommendationQueryPlan(context),
		operational?: OperationalConfigSnapshot,
	): Promise<ResolvedIntent> {
		const prompt = operational?.prompt;
		const rulesRequired =
			plan.profile.family !== "MEAL_LUNCH" ||
			plan.weatherApplication.kind === "USER_REPORTED";
		const operationallyEnabled =
			(operational?.aiAssistanceEnabled ?? true) && (prompt?.enabled ?? true);
		if (
			rulesRequired ||
			!context.aiAssistanceEnabled ||
			!this.config.qwen.enabled ||
			!operationallyEnabled
		) {
			return {
				profile: await this.rules.resolve(context, plan),
				fallbackUsed: false,
				modelVersion: this.config.versions.ruleFallbackModel,
			};
		}
		try {
			return {
				profile: await this.qwen.resolve(context, plan, prompt),
				fallbackUsed: false,
				modelVersion: prompt?.modelVersion ?? this.config.qwen.model,
			};
		} catch {
			return {
				profile: await this.rules.resolve(context, plan),
				fallbackUsed: true,
				modelVersion: this.config.versions.ruleFallbackModel,
			};
		}
	}
}
