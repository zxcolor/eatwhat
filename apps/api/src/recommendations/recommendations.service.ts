import { randomUUID } from "node:crypto";
import {
	type DataMode,
	type DataRightsMode,
	type DataSourceCode,
	type RecommendationContext,
	type RecommendationResponse,
	RecommendationResponseSchema,
	type RecommendationResult,
	type ResultToken,
} from "@chi-shen-me/contracts";
import {
	BadRequestException,
	Inject,
	Injectable,
	Optional,
	ServiceUnavailableException,
} from "@nestjs/common";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { DataRightsPolicy } from "../config/data-rights-policy.js";
import { OperationalConfigService } from "../operational-config/operational-config.service.js";
import {
	isOperationalConfigAvailable,
	startupOperationalConfig,
} from "../operational-config/operational-config.types.js";
import {
	PLACE_PROVIDER,
	type PlaceCandidate,
	type PlaceProvider,
} from "./domain/place-candidate.js";
import {
	type RankedPlaceResult,
	rankCandidates,
} from "./domain/recommendation-engine.js";
import { buildRecommendationQueryPlan } from "./domain/recommendation-query-plan.js";
import { IntentCoordinator } from "./providers/intent-coordinator.js";

function toPublicResult(
	result: RankedPlaceResult,
	resultToken: ResultToken,
): RecommendationResult {
	return {
		provider: result.provider,
		resultToken,
		dataMode: result.dataMode,
		actions: { ...result.actions },
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
		imageUrl: result.imageUrl,
		phone: result.phone,
		location: { ...result.location },
		reasons: result.reasons.map((reason) => ({ ...reason })),
		warnings: [...result.warnings],
		confidence: result.confidence,
		aiAssisted: result.aiAssisted,
		sourceAttribution: result.sourceAttribution,
	};
}

export function recommendationNotice(
	dataMode: DataMode,
	resultCount: number,
	dataRightsMode: DataRightsMode,
): string | null {
	if (dataMode === "DEMO") {
		return "当前使用虚构演示餐饮地点，仅用于验证产品流程，不可用于真实就餐决策";
	}
	if (resultCount === 0) {
		return "当前条件下没有符合条件的候选，请调整预算、距离或排除条件";
	}
	if (dataRightsMode === "LIVE_DISPLAY_ONLY") {
		return "当前按数据授权边界实时展示，不保存外部餐饮地点数据且不显示自有适合度";
	}
	return null;
}

@Injectable()
export class RecommendationsService {
	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		@Inject(PLACE_PROVIDER) private readonly places: PlaceProvider,
		private readonly intents: IntentCoordinator,
		private readonly requestRegistry: RecommendationRequestRegistry,
		private readonly dataRightsPolicy: DataRightsPolicy,
		@Optional()
		private readonly operationalConfig?: OperationalConfigService,
	) {}

	async recommend(
		context: RecommendationContext,
	): Promise<RecommendationResponse> {
		const requestId = randomUUID();
		const generatedAt = new Date().toISOString();
		const operational =
			(await this.operationalConfig?.current()) ??
			startupOperationalConfig(this.config);
		if (!isOperationalConfigAvailable(operational)) {
			throw new ServiceUnavailableException({
				code: "OPERATIONAL_CONFIG_UNAVAILABLE",
				message: "推荐配置暂时不可用，请稍后重试",
			});
		}
		if (context.radiusMeters > operational.coverage.maximumRadiusMeters) {
			throw new BadRequestException({
				code: "RADIUS_EXCEEDS_ACTIVE_COVERAGE",
				message: "搜索半径超过当前运营配置允许的范围",
			});
		}
		// Client clocks are untrusted. Business-hours evaluation must use server
		// time so a forged requestTime cannot turn a closed place into an open one.
		const trustedContext = { ...context, requestTime: generatedAt };
		const queryPlan = buildRecommendationQueryPlan(trustedContext);
		let queryPlanSupported = false;
		try {
			queryPlanSupported = this.places.supportsQueryPlan(queryPlan);
		} catch {
			queryPlanSupported = false;
		}
		if (!queryPlanSupported) {
			throw new ServiceUnavailableException({
				code: "PLACE_PROVIDER_UNAVAILABLE",
				message: "餐厅数据服务暂时不可用，请稍后重试",
			});
		}

		const resolvedIntent = await this.intents.resolve(
			trustedContext,
			queryPlan,
			operational,
		);
		let candidates: readonly PlaceCandidate[];
		try {
			// 模型只在此调用之前获得脱敏用餐条件；POI 从不传入千问。
			candidates = await this.places.search(trustedContext, queryPlan);
		} catch {
			throw new ServiceUnavailableException({
				code: "PLACE_PROVIDER_UNAVAILABLE",
				message: "餐厅数据服务暂时不可用，请稍后重试",
			});
		}
		// Resolve after all asynchronous provider calls so an authorization that
		// expires while the request is in flight cannot enable licensed ranking.
		const candidateProviders = [
			...new Set<DataSourceCode>(
				candidates.map((candidate) => candidate.provider),
			),
		];
		const providersToAuthorize =
			candidateProviders.length > 0 ? candidateProviders : [this.places.kind];
		const providerModes = await Promise.all(
			providersToAuthorize.map((provider) =>
				this.dataRightsPolicy.effectiveMode(provider),
			),
		);
		// The public response currently has one rights mode. A future aggregate
		// provider therefore receives licensed ranking only when every included
		// source is independently authorized for all required capabilities.
		const effectiveDataRightsMode: DataRightsMode = providerModes.every(
			(mode) => mode === "LICENSED_ENRICHMENT",
		)
			? "LICENSED_ENRICHMENT"
			: "LIVE_DISPLAY_ONLY";
		const results = rankCandidates({
			context: trustedContext,
			intent: resolvedIntent.profile,
			candidates,
			dataRightsMode: effectiveDataRightsMode,
			rules: operational.recommendationRules,
		});

		const notice = recommendationNotice(
			this.places.dataMode,
			results.length,
			effectiveDataRightsMode,
		);
		const resultTokens = this.requestRegistry.issue(
			requestId,
			results,
			context.mealPeriod,
		);
		const publicResults = results.map((result, index) => {
			const resultToken = resultTokens[index];
			if (resultToken === undefined) {
				throw new Error("RESULT_TOKEN_ISSUANCE_FAILED");
			}
			return toPublicResult(result, resultToken);
		});

		try {
			return RecommendationResponseSchema.parse({
				requestId,
				generatedAt,
				coverage: "NATIONWIDE",
				dataRightsMode: effectiveDataRightsMode,
				ruleVersion: this.config.versions.rule,
				rulesConfigVersion: operational.versions["recommendations.rules"],
				promptVersion: operational.prompt.promptVersion,
				modelVersion: resolvedIntent.modelVersion,
				aiFallbackUsed: resolvedIntent.fallbackUsed,
				profile: queryPlan.profile,
				weatherApplication: queryPlan.weatherApplication,
				results: publicResults,
				notice,
			});
		} catch (error) {
			// Token issuance and response validation form a fail-closed transaction:
			// a response that cannot cross the public schema leaves no live mapping.
			this.requestRegistry.revoke(requestId);
			throw error;
		}
	}
}
