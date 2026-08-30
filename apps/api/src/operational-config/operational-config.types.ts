import {
	RegisteredIntentPromptVersionSchema,
	RegisteredQwenModelVersionSchema,
} from "@chi-shen-me/contracts";
import { z } from "zod";
import type { AppConfig } from "../config/app-config.js";

export const OPERATIONAL_CONFIG_KEYS = [
	"features.ai-assistance",
	"recommendations.rules",
	"recommendations.prompt",
	"coverage.default",
	"clients.minimum-version",
] as const;

export type OperationalConfigKey = (typeof OPERATIONAL_CONFIG_KEYS)[number];

const SemanticVersionSchema = z
	.string()
	.regex(
		/^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/u,
	);

const RuleWeightSchema = z.number().min(0).max(95).multipleOf(0.0001);

export const AiAssistanceFlagSchema = z
	.object({
		enabled: z.boolean(),
	})
	.strict();

export const RecommendationRulesSchema = z
	.object({
		qualityWeight: RuleWeightSchema,
		timeWeight: RuleWeightSchema,
		budgetWeight: RuleWeightSchema,
		intentWeight: RuleWeightSchema,
		diversityWeight: RuleWeightSchema,
		operationsAdjustmentMaximum: z.number().min(0).max(5).multipleOf(0.0001),
	})
	.strict()
	.superRefine((value, context) => {
		const total =
			value.qualityWeight +
			value.timeWeight +
			value.budgetWeight +
			value.intentWeight +
			value.diversityWeight;
		if (Math.abs(total - 95) > 0.0001) {
			context.addIssue({
				code: "custom",
				message: "推荐基础权重总和必须为 95",
			});
		}
	});

export type RecommendationRules = z.infer<typeof RecommendationRulesSchema>;

export const PromptSettingsSchema = z
	.object({
		enabled: z.boolean(),
		promptVersion: RegisteredIntentPromptVersionSchema,
		modelVersion: RegisteredQwenModelVersionSchema,
		timeoutMs: z.number().int().min(500).max(2_500),
	})
	.strict();

export type PromptSettings = z.infer<typeof PromptSettingsSchema>;

export const CoverageSettingsSchema = z
	.object({
		defaultRadiusMeters: z.number().int().min(200).max(10_000),
		maximumRadiusMeters: z.number().int().min(200).max(10_000),
		areaCode: z.literal("NATIONWIDE"),
	})
	.strict()
	.refine(
		(value) => value.defaultRadiusMeters <= value.maximumRadiusMeters,
		"默认半径不能大于最大半径",
	);

export type CoverageSettings = z.infer<typeof CoverageSettingsSchema>;

export const MinimumAppVersionsSchema = z
	.object({
		android: SemanticVersionSchema,
		ios: SemanticVersionSchema.optional(),
		miniprogram: SemanticVersionSchema.optional(),
	})
	.strict();

export type MinimumAppVersions = z.infer<typeof MinimumAppVersionsSchema>;

export const DEFAULT_RECOMMENDATION_RULES: RecommendationRules = Object.freeze({
	qualityWeight: 25,
	timeWeight: 25,
	budgetWeight: 20,
	intentWeight: 15,
	diversityWeight: 10,
	operationsAdjustmentMaximum: 5,
});

export interface OperationalConfigSnapshot {
	readonly source:
		| "STARTUP_DEFAULT"
		| "DATABASE"
		| "STALE_CACHE"
		| "SAFE_FALLBACK";
	readonly aiAssistanceEnabled: boolean;
	readonly recommendationRules: RecommendationRules;
	readonly prompt: PromptSettings;
	readonly coverage: CoverageSettings;
	readonly minimumAppVersions: MinimumAppVersions;
	readonly versions: Readonly<Record<OperationalConfigKey, number | null>>;
}

export function startupOperationalConfig(
	config: AppConfig,
	source: OperationalConfigSnapshot["source"] = "STARTUP_DEFAULT",
): OperationalConfigSnapshot {
	return Object.freeze({
		source,
		aiAssistanceEnabled: true,
		recommendationRules: DEFAULT_RECOMMENDATION_RULES,
		prompt: Object.freeze({
			enabled: true,
			promptVersion: config.versions.prompt,
			modelVersion: config.qwen.model,
			timeoutMs: config.qwen.timeoutMs,
		}),
		coverage: Object.freeze({
			defaultRadiusMeters: 1_500,
			maximumRadiusMeters: 10_000,
			areaCode: "NATIONWIDE",
		}),
		minimumAppVersions: Object.freeze({
			android: config.features.minimumSupportedVersion,
		}),
		versions: Object.freeze({
			"features.ai-assistance": null,
			"recommendations.rules": null,
			"recommendations.prompt": null,
			"coverage.default": null,
			"clients.minimum-version": null,
		}),
	});
}
