import type {
	IntentProfile,
	RecommendationContext,
} from "@chi-shen-me/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { OperationalConfigSnapshot } from "../../operational-config/operational-config.types.js";
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
		operational?: OperationalConfigSnapshot,
	): Promise<ResolvedIntent> {
		const prompt = operational?.prompt;
		const operationallyEnabled =
			(operational?.aiAssistanceEnabled ?? true) && (prompt?.enabled ?? true);
		if (
			!context.aiAssistanceEnabled ||
			!this.config.qwen.enabled ||
			!operationallyEnabled
		) {
			return {
				profile: await this.rules.resolve(context),
				fallbackUsed: false,
				modelVersion: this.config.versions.ruleFallbackModel,
			};
		}
		try {
			return {
				profile: await this.qwen.resolve(context, prompt),
				fallbackUsed: false,
				modelVersion: prompt?.modelVersion ?? this.config.qwen.model,
			};
		} catch {
			return {
				profile: await this.rules.resolve(context),
				fallbackUsed: true,
				modelVersion: this.config.versions.ruleFallbackModel,
			};
		}
	}
}
