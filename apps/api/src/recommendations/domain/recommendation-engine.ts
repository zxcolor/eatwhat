import {
	type Confidence,
	type Coordinate,
	type DataMode,
	DataModeSchema,
	type DataRightsMode,
	type DataSourceCode,
	DataSourceCodeSchema,
	type IntentProfile,
	type RecommendationActions,
	RecommendationActionsSchema,
	type RecommendationContext,
	type RecommendationReason,
} from "@chi-shen-me/contracts";
import {
	DEFAULT_RECOMMENDATION_RULES,
	type RecommendationRules,
} from "../../operational-config/operational-config.types.js";
import type { PlaceCandidate } from "./place-candidate.js";

export interface RankCandidatesInput {
	readonly context: RecommendationContext;
	readonly intent: IntentProfile;
	readonly candidates: readonly PlaceCandidate[];
	readonly dataRightsMode: DataRightsMode;
	readonly recentPlaceIds?: ReadonlySet<string>;
	readonly rules?: RecommendationRules;
}

/**
 * Internal ranked domain result. The stable provider reference deliberately
 * exists only here; the public contract replaces it with a request-scoped
 * result token in RecommendationsService.
 */
export interface RankedPlaceResult {
	readonly provider: DataSourceCode;
	readonly providerPlaceId: string;
	readonly dataMode: DataMode;
	readonly actions: RecommendationActions;
	readonly name: string;
	readonly address: string;
	readonly rank: number;
	readonly fitScore: number | null;
	readonly sourceRating: number | null;
	readonly averageCostYuan: number | null;
	readonly distanceMeters: number;
	readonly estimatedTravelMinutes: number;
	readonly estimatedMealMinutes: number;
	readonly openStatus: "OPEN" | "CLOSED" | "UNKNOWN";
	readonly tags: readonly string[];
	readonly imageUrl: string | null;
	readonly phone: string | null;
	readonly location: Coordinate;
	readonly reasons: readonly RecommendationReason[];
	readonly warnings: readonly string[];
	readonly confidence: Confidence;
	readonly aiAssisted: boolean;
	readonly sourceAttribution: string;
}

interface ScoredCandidate {
	readonly candidate: PlaceCandidate;
	readonly fitScore: number;
	readonly confidence: "LOW" | "MEDIUM" | "HIGH";
	readonly warnings: readonly string[];
	readonly reasons: readonly RecommendationReason[];
}

const normalize = (value: string) => value.trim().toLocaleLowerCase("zh-CN");
const clamp = (value: number, minimum: number, maximum: number) =>
	Math.min(maximum, Math.max(minimum, value));

function safeNullableNumber(
	value: number | null,
	minimum: number,
	maximum: number,
): number | null {
	return value !== null &&
		Number.isFinite(value) &&
		value >= minimum &&
		value <= maximum
		? value
		: null;
}

function safeUrl(value: string | null): string | null {
	if (value === null || value.length > 2_048) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

function sanitizeCandidate(candidate: PlaceCandidate): PlaceCandidate | null {
	const provider = DataSourceCodeSchema.safeParse(candidate.provider);
	const dataMode = DataModeSchema.safeParse(candidate.dataMode);
	const actions = RecommendationActionsSchema.safeParse(candidate.actions);
	const validCoordinates =
		Number.isFinite(candidate.location.latitude) &&
		Number.isFinite(candidate.location.longitude) &&
		candidate.location.latitude >= -90 &&
		candidate.location.latitude <= 90 &&
		candidate.location.longitude >= -180 &&
		candidate.location.longitude <= 180 &&
		(candidate.location.crs === "WGS84" || candidate.location.crs === "GCJ02");
	if (
		!provider.success ||
		!dataMode.success ||
		!actions.success ||
		candidate.providerPlaceId.trim().length === 0 ||
		candidate.providerPlaceId.length > 120 ||
		candidate.name.trim().length === 0 ||
		!validCoordinates ||
		!Number.isFinite(candidate.distanceMeters) ||
		candidate.distanceMeters < 0 ||
		!Number.isFinite(candidate.estimatedTravelMinutes) ||
		candidate.estimatedTravelMinutes < 0 ||
		!Number.isFinite(candidate.estimatedMealMinutes) ||
		candidate.estimatedMealMinutes <= 0
	) {
		return null;
	}

	return {
		...candidate,
		provider: provider.data,
		dataMode: dataMode.data,
		actions: { ...actions.data },
		providerPlaceId: candidate.providerPlaceId.trim(),
		name: candidate.name.trim().slice(0, 120),
		address: candidate.address.trim().slice(0, 300),
		sourceRating: safeNullableNumber(candidate.sourceRating, 0, 5),
		averageCostYuan: safeNullableNumber(candidate.averageCostYuan, 0, 20_000),
		distanceMeters: Math.round(candidate.distanceMeters),
		estimatedTravelMinutes: Math.round(candidate.estimatedTravelMinutes),
		estimatedMealMinutes: Math.round(candidate.estimatedMealMinutes),
		tags: candidate.tags
			.filter((tag) => typeof tag === "string" && tag.trim().length > 0)
			.slice(0, 20)
			.map((tag) => tag.trim().slice(0, 40)),
		imageUrl: safeUrl(candidate.imageUrl),
		phone: candidate.phone?.trim().slice(0, 80) || null,
		sourceAttribution:
			candidate.sourceAttribution.trim().slice(0, 100) || "数据来源未知",
		editorialAdjustment: clamp(
			Number.isFinite(candidate.editorialAdjustment)
				? candidate.editorialAdjustment
				: 0,
			-5,
			5,
		),
	};
}

function isCuisineExcluded(
	candidate: PlaceCandidate,
	context: RecommendationContext,
): boolean {
	// A grouped user choice also excludes its provider child-category tags.
	const exclusions = new Set(
		context.excludedCuisines
			.flatMap((cuisine) =>
				cuisine === "川湘菜" ? ["川湘菜", "川菜", "湘菜"] : [cuisine],
			)
			.map(normalize),
	);
	if (exclusions.size === 0) return false;
	return candidate.tags.some((tag) => {
		const normalizedTag = normalize(tag);
		return [...exclusions].some(
			(exclusion) =>
				normalizedTag === exclusion || normalizedTag.includes(exclusion),
		);
	});
}

function hardFilter(input: RankCandidatesInput): PlaceCandidate[] {
	const seenProviderIds = new Set<string>();
	const seenPlaces = new Set<string>();
	const accepted: PlaceCandidate[] = [];

	for (const rawCandidate of input.candidates) {
		const candidate = sanitizeCandidate(rawCandidate);
		if (
			candidate === null ||
			candidate.blocked ||
			candidate.openStatus === "CLOSED"
		)
			continue;
		if (candidate.distanceMeters > input.context.radiusMeters) continue;
		if (
			input.context.budgetMaxYuan !== null &&
			candidate.averageCostYuan !== null &&
			candidate.averageCostYuan > input.context.budgetMaxYuan
		) {
			continue;
		}
		if (isCuisineExcluded(candidate, input.context)) continue;

		const providerKey = `${candidate.provider}:${candidate.providerPlaceId}`;
		const physicalKey = `${normalize(candidate.name)}:${candidate.location.crs}:${candidate.location.latitude.toFixed(4)}:${candidate.location.longitude.toFixed(4)}`;
		if (seenProviderIds.has(providerKey) || seenPlaces.has(physicalKey))
			continue;
		seenProviderIds.add(providerKey);
		seenPlaces.add(physicalKey);
		accepted.push(candidate);
	}
	return accepted;
}

function qualityScore(candidate: PlaceCandidate): number {
	return candidate.sourceRating === null
		? 10
		: (candidate.sourceRating / 5) * 25;
}

function timeScore(
	candidate: PlaceCandidate,
	context: RecommendationContext,
): number {
	const totalMinutes =
		candidate.estimatedTravelMinutes * 2 + candidate.estimatedMealMinutes;
	const ratio = totalMinutes / context.availableMinutes;
	if (ratio <= 0.75) return 25;
	if (ratio <= 1) return 25 - ((ratio - 0.75) / 0.25) * 5;
	return clamp(20 - (ratio - 1) * 25, 0, 20);
}

function budgetScore(
	candidate: PlaceCandidate,
	context: RecommendationContext,
): number {
	if (context.budgetMaxYuan === null) return 20;
	if (candidate.averageCostYuan === null) return 8;
	const ratio = candidate.averageCostYuan / context.budgetMaxYuan;
	return clamp(20 - Math.max(0, ratio - 0.65) * 8, 14, 20);
}

function mealMatchScore(
	candidate: PlaceCandidate,
	intent: IntentProfile,
): number {
	const normalizedTags = new Set(candidate.tags.map(normalize));
	const mealTypeMatch = intent.mealTypes.some((mealType) =>
		normalizedTags.has(normalize(mealType)),
	);
	let strongestCuisineWeight = 0;
	for (const [cuisine, weight] of Object.entries(intent.cuisineWeights)) {
		if (normalizedTags.has(normalize(cuisine)))
			strongestCuisineWeight = Math.max(weight, strongestCuisineWeight);
	}
	return clamp(4 + (mealTypeMatch ? 6 : 0) + strongestCuisineWeight * 5, 0, 15);
}

function applyPreference(score: number, preference: number): number {
	return score * (preference / 100);
}

function candidateConfidence(
	candidate: PlaceCandidate,
): "LOW" | "MEDIUM" | "HIGH" {
	const knownFacts = [
		candidate.sourceRating !== null,
		candidate.averageCostYuan !== null,
		candidate.openStatus !== "UNKNOWN",
		candidate.tags.length > 0,
		candidate.address.length > 0,
	].filter(Boolean).length;
	return knownFacts >= 5 ? "HIGH" : knownFacts >= 3 ? "MEDIUM" : "LOW";
}

function candidateWarnings(
	candidate: PlaceCandidate,
	context: RecommendationContext,
): string[] {
	const warnings: string[] = [];
	if (candidate.openStatus === "UNKNOWN")
		warnings.push("营业状态暂无可靠信息，请到店前确认");
	if (candidate.averageCostYuan === null) warnings.push("人均消费暂无可靠信息");
	if (candidate.sourceRating === null) warnings.push("数据源暂无评分");
	if (
		candidate.estimatedTravelMinutes * 2 + candidate.estimatedMealMinutes >
		context.availableMinutes
	) {
		warnings.push("预计往返及用餐时间可能超出你的时间预算");
	}
	return warnings;
}

function travelModeText(mode: RecommendationContext["travelMode"]): string {
	if (mode === "BIKE") return "骑行";
	if (mode === "TRANSIT") return "公共交通";
	return "步行";
}

function candidateReasons(
	candidate: PlaceCandidate,
	context: RecommendationContext,
	intent: IntentProfile,
	dataRightsMode: DataRightsMode,
	rules: RecommendationRules = DEFAULT_RECOMMENDATION_RULES,
): RecommendationReason[] {
	const describesProviderResult = dataRightsMode === "LIVE_DISPLAY_ONLY";
	const reasons: RecommendationReason[] = [
		{
			code: "DISTANCE_FIT",
			text: `距离约 ${candidate.distanceMeters} 米，${travelModeText(context.travelMode)}约 ${candidate.estimatedTravelMinutes} 分钟`,
		},
	];
	if (
		context.budgetMaxYuan !== null &&
		candidate.averageCostYuan !== null &&
		candidate.averageCostYuan <= context.budgetMaxYuan &&
		(describesProviderResult ||
			(context.preferenceVector.budget > 0 && rules.budgetWeight > 0))
	) {
		reasons.push({
			code: "BUDGET_FIT",
			text: `人均约 ${Math.round(candidate.averageCostYuan)} 元，在 ${context.budgetMaxYuan} 元预算内`,
		});
	}
	const totalMinutes =
		candidate.estimatedTravelMinutes * 2 + candidate.estimatedMealMinutes;
	if (
		totalMinutes <= context.availableMinutes &&
		(describesProviderResult ||
			(context.preferenceVector.time > 0 && rules.timeWeight > 0))
	) {
		reasons.push({
			code: "TIME_FIT",
			text: `预计往返加用餐约 ${totalMinutes} 分钟，符合 ${context.availableMinutes} 分钟时间预算`,
		});
	}
	const intentMatch = intent.mealTypes.find((type) =>
		candidate.tags.some((tag) => normalize(tag) === normalize(type)),
	);
	if (
		intentMatch !== undefined &&
		reasons.length < 3 &&
		(describesProviderResult ||
			(context.preferenceVector.mealMatch > 0 && rules.intentWeight > 0))
	) {
		reasons.push({
			code: "MEAL_FIT",
			text: `餐厅标签包含“${intentMatch}”，符合本次用餐方向`,
		});
	}
	if (
		candidate.sourceRating !== null &&
		reasons.length < 3 &&
		(describesProviderResult ||
			(context.preferenceVector.quality > 0 && rules.qualityWeight > 0))
	) {
		reasons.push({
			code: "QUALITY_SIGNAL",
			text: `数据源评分 ${candidate.sourceRating.toFixed(1)} 分，仅作为质量参考`,
		});
	}
	return reasons.slice(0, 3);
}

function scoreCandidate(
	candidate: PlaceCandidate,
	input: RankCandidatesInput,
): ScoredCandidate {
	const rules = input.rules ?? DEFAULT_RECOMMENDATION_RULES;
	const isRecent =
		input.recentPlaceIds?.has(candidate.providerPlaceId) ?? false;
	const diversity = ((isRecent ? 2 : 10) / 10) * rules.diversityWeight;
	const preferences = input.context.preferenceVector;
	const rawScore =
		applyPreference(
			(qualityScore(candidate) / 25) * rules.qualityWeight,
			preferences.quality,
		) +
		applyPreference(
			(timeScore(candidate, input.context) / 25) * rules.timeWeight,
			preferences.time,
		) +
		applyPreference(
			(budgetScore(candidate, input.context) / 20) * rules.budgetWeight,
			preferences.budget,
		) +
		applyPreference(
			(mealMatchScore(candidate, input.intent) / 15) * rules.intentWeight,
			preferences.mealMatch,
		) +
		applyPreference(diversity, preferences.diversity) +
		clamp(
			candidate.editorialAdjustment,
			-rules.operationsAdjustmentMaximum,
			rules.operationsAdjustmentMaximum,
		);
	return {
		candidate,
		fitScore: Math.round(clamp(rawScore, 0, 100)),
		confidence: candidateConfidence(candidate),
		warnings: candidateWarnings(candidate, input.context),
		reasons: candidateReasons(
			candidate,
			input.context,
			input.intent,
			input.dataRightsMode,
			rules,
		),
	};
}

function primaryTag(candidate: PlaceCandidate): string {
	return normalize(candidate.tags[0] ?? candidate.name);
}

function selectLicensedResults(
	scored: readonly ScoredCandidate[],
	context: RecommendationContext,
	rules: RecommendationRules,
): ScoredCandidate[] {
	const remaining = [...scored];
	const selected: ScoredCandidate[] = [];
	const usedTags = new Set<string>();
	const baseDuplicateTagPenalty =
		context.explorationMode === "SAFE"
			? 2
			: context.explorationMode === "BALANCED"
				? 7
				: 12;
	const duplicateTagPenalty = applyPreference(
		baseDuplicateTagPenalty *
			(rules.diversityWeight / DEFAULT_RECOMMENDATION_RULES.diversityWeight),
		context.preferenceVector.diversity,
	);

	while (remaining.length > 0 && selected.length < 3) {
		remaining.sort((a, b) => {
			const adjustedA =
				a.fitScore -
				(usedTags.has(primaryTag(a.candidate)) ? duplicateTagPenalty : 0);
			const adjustedB =
				b.fitScore -
				(usedTags.has(primaryTag(b.candidate)) ? duplicateTagPenalty : 0);
			return (
				adjustedB - adjustedA ||
				a.candidate.providerRank - b.candidate.providerRank
			);
		});
		const next = remaining.shift();
		if (next === undefined) break;
		selected.push(next);
		usedTags.add(primaryTag(next.candidate));
	}
	return selected;
}

export function rankCandidates(
	input: RankCandidatesInput,
): RankedPlaceResult[] {
	const filtered = hardFilter(input);
	const selected =
		input.dataRightsMode === "LICENSED_ENRICHMENT"
			? selectLicensedResults(
					filtered.map((candidate) => scoreCandidate(candidate, input)),
					input.context,
					input.rules ?? DEFAULT_RECOMMENDATION_RULES,
				)
			: filtered
					.sort((a, b) => a.providerRank - b.providerRank)
					.slice(0, 3)
					.map((candidate) => ({
						candidate,
						// Deliberately do not compute the weighted suitability score before
						// written enrichment rights are active.
						fitScore: 0,
						confidence: candidateConfidence(candidate),
						warnings: candidateWarnings(candidate, input.context),
						reasons: candidateReasons(
							candidate,
							input.context,
							input.intent,
							input.dataRightsMode,
						),
					}));

	return selected.map(
		({ candidate, fitScore, confidence, warnings, reasons }, index) => ({
			provider: candidate.provider,
			providerPlaceId: candidate.providerPlaceId,
			dataMode: candidate.dataMode,
			actions: { ...candidate.actions },
			name: candidate.name,
			address: candidate.address,
			rank: index + 1,
			fitScore:
				input.dataRightsMode === "LICENSED_ENRICHMENT" ? fitScore : null,
			sourceRating: candidate.sourceRating,
			averageCostYuan: candidate.averageCostYuan,
			distanceMeters: candidate.distanceMeters,
			estimatedTravelMinutes: candidate.estimatedTravelMinutes,
			estimatedMealMinutes: candidate.estimatedMealMinutes,
			openStatus: candidate.openStatus,
			tags: [...candidate.tags],
			imageUrl: candidate.imageUrl,
			phone: candidate.phone,
			location: candidate.location,
			reasons: [...reasons],
			warnings: [...warnings],
			confidence,
			aiAssisted: input.intent.provider === "QWEN",
			sourceAttribution: candidate.sourceAttribution,
		}),
	);
}
