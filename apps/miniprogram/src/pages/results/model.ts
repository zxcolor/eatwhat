import type {
	RecommendationContext,
	RecommendationResponse,
	RecommendationResult,
} from "../../features/decision/index";

export interface ResultsFilter {
	readonly openNowOnly: boolean;
	readonly knownPriceWithinBudgetOnly: boolean;
	readonly cuisineTagQuery: string;
}

export interface ResultCard {
	readonly resultIndex: number;
	readonly rank: number;
	readonly name: string;
	readonly address: string;
	readonly distanceText: string;
	readonly travelText: string;
	readonly costText: string;
	readonly ratingText: string;
	readonly openText: string;
	readonly tags: readonly string[];
	readonly reasons: readonly string[];
	readonly warnings: readonly string[];
	readonly confidenceText: string;
	readonly sourceAttribution: string;
	readonly aiAssisted: boolean;
	readonly dataModeLabel: string;
	readonly evidence: readonly string[];
}

export function projectResultCards(
	response: RecommendationResponse,
	context: RecommendationContext,
	filter: ResultsFilter,
): readonly ResultCard[] {
	const cuisineQuery = normalizeTag(filter.cuisineTagQuery);
	return response.results
		.slice(0, 3)
		.map((result, resultIndex) => ({ result, resultIndex }))
		.filter(({ result }) => matches(result, context, filter, cuisineQuery))
		.map(({ result, resultIndex }) => toCard(result, resultIndex, context));
}

export function resultCountSummary(
	visibleCount: number,
	totalCount: number,
	filter: ResultsFilter,
	liveDisplayOnly = false,
): string {
	const active =
		filter.openNowOnly ||
		filter.knownPriceWithinBudgetOnly ||
		filter.cuisineTagQuery.trim().length > 0;
	return active
		? `本地筛选显示 ${visibleCount} / ${Math.min(totalCount, 3)} 条`
		: `本次共 ${Math.min(totalCount, 3)} ${liveDisplayOnly ? "个候选" : "条推荐"}`;
}

function matches(
	result: RecommendationResult,
	context: RecommendationContext,
	filter: ResultsFilter,
	cuisineQuery: string,
): boolean {
	if (filter.openNowOnly && result.openStatus !== "OPEN") return false;
	if (filter.knownPriceWithinBudgetOnly) {
		if (result.averageCostYuan === null) return false;
		if (
			context.budgetMaxYuan !== null &&
			result.averageCostYuan > context.budgetMaxYuan
		)
			return false;
	}
	return (
		cuisineQuery.length === 0 ||
		result.tags.some((tag) => normalizeTag(tag).includes(cuisineQuery))
	);
}

function toCard(
	result: RecommendationResult,
	resultIndex: number,
	context: RecommendationContext,
): ResultCard {
	return Object.freeze({
		resultIndex,
		rank: result.rank,
		name: result.name,
		address: result.address.trim().length === 0 ? "地址待确认" : result.address,
		distanceText: formatDistance(result.distanceMeters),
		travelText: `约 ${Math.round(result.estimatedTravelMinutes)} 分钟到达`,
		costText:
			result.averageCostYuan === null
				? "人均未知"
				: `人均约 ¥${Math.round(result.averageCostYuan)}`,
		ratingText:
			result.sourceRating === null
				? "评分未知"
				: `来源评分 ${result.sourceRating.toFixed(1)}`,
		openText:
			result.openStatus === "OPEN"
				? "营业中"
				: result.openStatus === "CLOSED"
					? "已打烊"
					: "营业状态待确认",
		tags: Object.freeze(result.tags.slice(0, 6)),
		reasons: Object.freeze(result.reasons.map((reason) => reason.text)),
		warnings: Object.freeze([...result.warnings]),
		confidenceText:
			result.confidence === "HIGH"
				? "高置信"
				: result.confidence === "MEDIUM"
					? "中等置信"
					: "低置信",
		sourceAttribution: result.sourceAttribution,
		aiAssisted: result.aiAssisted,
		dataModeLabel:
			result.dataMode === "DEMO" ? "演示数据 · 虚构地点" : "实时来源",
		evidence: evidenceSummary(result, context),
	});
}

export function evidenceSummary(
	result: RecommendationResult,
	context: RecommendationContext,
): readonly string[] {
	const evidence = [`符合 · 距离在 ${context.radiusMeters} 米以内`];
	if (context.budgetMaxYuan !== null)
		evidence.push(
			result.averageCostYuan === null
				? "待确认 · 商户人均价格未知"
				: `符合 · 已知人均不超过 ${context.budgetMaxYuan} 元`,
		);
	evidence.push(
		result.openStatus === "OPEN"
			? "符合 · 来源显示营业中"
			: "待确认 · 营业状态未知",
	);
	const totalMinutes =
		result.estimatedTravelMinutes + result.estimatedMealMinutes;
	evidence.push(
		totalMinutes > context.availableMinutes
			? `时间偏紧 · 预计共 ${Math.round(totalMinutes)} 分钟，请再确认`
			: `时间参考 · 预计共 ${Math.round(totalMinutes)} 分钟`,
	);
	if (context.excludedCuisines.length > 0 && result.tags.length === 0)
		evidence.push("待确认 · 缺少菜系标签，请核对排除项");
	return Object.freeze(evidence);
}

function formatDistance(meters: number): string {
	return meters >= 1_000
		? `${(meters / 1_000).toFixed(1)} km`
		: `${Math.round(meters)} m`;
}

function normalizeTag(value: string): string {
	return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");
}
