import { randomUUID } from "node:crypto";
import {
	DataSourceCodeSchema,
	DEFAULT_RECOMMENDATION_PREFERENCE_VECTOR,
	type GroupRecommendationRequest,
	type GroupRecommendationResponse,
	GroupRecommendationResponseSchema,
	RecommendationContextSchema,
} from "@chi-shen-me/contracts";
import {
	Inject,
	Injectable,
	ServiceUnavailableException,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import {
	APP_CLOCK,
	type AppClock,
	DataRightsPolicy,
} from "../config/data-rights-policy.js";
import {
	PLACE_PROVIDER,
	type PlaceCandidate,
	type PlaceProvider,
} from "../recommendations/domain/place-candidate.js";
import { rankCandidates } from "../recommendations/domain/recommendation-engine.js";
import { buildRecommendationQueryPlan } from "../recommendations/domain/recommendation-query-plan.js";
import { buildRuleIntent } from "../recommendations/providers/rule-intent.provider.js";
import { aggregateGroupConstraints } from "./group-constraint-aggregator.js";

const GROUP_UNAVAILABLE_RESPONSE = Object.freeze({
	code: "GROUP_RECOMMENDATIONS_UNAVAILABLE",
	message: "群组推荐服务暂时不可用，请稍后重试",
});

export function groupRecommendationNotice(
	dataMode: PlaceProvider["dataMode"],
	resultCount: number,
	dataRightsMode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT",
): string | null {
	if (dataMode === "DEMO") {
		return "当前使用虚构演示餐饮地点，仅用于验证同设备群组流程，不可用于真实就餐决策";
	}
	if (resultCount === 0) {
		return "当前共同条件下没有符合条件的候选，请返回重新录入成员约束";
	}
	if (dataRightsMode === "LIVE_DISPLAY_ONLY") {
		return "当前按数据授权边界实时展示共同约束筛选结果，不保存外部餐饮地点数据且不显示自有适合度";
	}
	return null;
}

function failUnavailable(): never {
	throw new ServiceUnavailableException(GROUP_UNAVAILABLE_RESPONSE);
}

function uniqueValidCandidateProviders(
	candidates: readonly PlaceCandidate[],
): readonly string[] | null {
	const providers = candidates.map((candidate) => candidate.provider);
	if (
		providers.some(
			(provider) => !DataSourceCodeSchema.safeParse(provider).success,
		)
	) {
		return null;
	}
	return [...new Set(providers)];
}

@Injectable()
export class GroupRecommendationsService {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(APP_CLOCK) private readonly clock: AppClock,
		@Inject(PLACE_PROVIDER) private readonly places: PlaceProvider,
		private readonly dataRightsPolicy: DataRightsPolicy,
	) {}

	async recommend(
		request: GroupRecommendationRequest,
	): Promise<GroupRecommendationResponse> {
		// The endpoint repeats the public capability gate. A stale or forged client
		// can never turn a hidden candidate feature into provider/model I/O.
		if (
			!this.config.features.groupRecommendationsEnabled ||
			this.places.kind === "UNAVAILABLE"
		) {
			return failUnavailable();
		}

		const aggregation = aggregateGroupConstraints(request.members);
		const generatedAt = new Date(this.clock.now()).toISOString();
		const context = RecommendationContextSchema.parse({
			location: request.location,
			mealPeriod: "LUNCH",
			target: "MEAL",
			weatherContext: { kind: "NONE" },
			decisionMode: "GUIDED",
			travelMode: request.travelMode,
			explorationMode: "BALANCED",
			aiAssistanceEnabled: false,
			budgetMaxYuan: aggregation.effectiveBudgetMaxYuan,
			availableMinutes: aggregation.effectiveAvailableMinutes,
			radiusMeters: aggregation.effectiveRadiusMeters,
			partySize: aggregation.memberCount,
			excludedCuisines: aggregation.excludedCuisines,
			preferredCuisines: aggregation.preferredCuisines,
			preferenceVector: { ...DEFAULT_RECOMMENDATION_PREFERENCE_VECTOR },
			// No client timestamp exists in the group contract. Opening-hours checks
			// use the same trusted instant emitted on this response.
			requestTime: generatedAt,
		});
		const queryPlan = buildRecommendationQueryPlan(context);
		let supported = false;
		try {
			supported = this.places.supportsQueryPlan(queryPlan);
		} catch {
			supported = false;
		}
		if (!supported) return failUnavailable();

		// Deliberately bypass IntentCoordinator: the group path has no Qwen branch,
		// fallback marker or model metadata. This pure rule profile is request-local.
		const intent = buildRuleIntent(context, queryPlan);
		let candidates: readonly PlaceCandidate[];
		try {
			candidates = await this.places.search(context, queryPlan);
		} catch {
			return failUnavailable();
		}

		const candidateProviders = uniqueValidCandidateProviders(candidates);
		let dataRightsMode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT" =
			"LIVE_DISPLAY_ONLY";
		if (candidateProviders !== null) {
			const providers =
				candidateProviders.length > 0 ? candidateProviders : [this.places.kind];
			try {
				const decisions = await Promise.all(
					providers.map((provider) =>
						this.dataRightsPolicy.effectiveMode(provider),
					),
				);
				if (
					decisions.length > 0 &&
					decisions.every((decision) => decision === "LICENSED_ENRICHMENT")
				) {
					dataRightsMode = "LICENSED_ENRICHMENT";
				}
			} catch {
				// Database, authorization or policy failures reduce disclosure/ranking;
				// they must never make the group request fail open.
				dataRightsMode = "LIVE_DISPLAY_ONLY";
			}
		}

		const results = rankCandidates({
			context,
			intent,
			candidates,
			dataRightsMode,
		});

		return GroupRecommendationResponseSchema.parse({
			requestId: randomUUID(),
			generatedAt,
			coverage: "NATIONWIDE",
			dataRightsMode,
			ruleVersion: this.config.versions.rule,
			aggregation,
			results: results.map((result) => ({
				provider: result.provider,
				dataMode: result.dataMode,
				name: result.name,
				address: result.address,
				rank: result.rank,
				fitScore: result.fitScore,
				sourceRating: result.sourceRating,
				averageCostYuan: result.averageCostYuan,
				distanceMeters: result.distanceMeters,
				estimatedTravelMinutes: result.estimatedTravelMinutes,
				estimatedMealMinutes: result.estimatedMealMinutes,
				openStatus: result.openStatus,
				tags: [...result.tags],
				reasons: result.reasons.map((reason) => ({ ...reason })),
				warnings: [...result.warnings],
				confidence: result.confidence,
				sourceAttribution: result.sourceAttribution,
			})),
			notice: groupRecommendationNotice(
				this.places.dataMode,
				results.length,
				dataRightsMode,
			),
		});
	}
}
