import { randomUUID } from "node:crypto";
import {
	type PlaceSearchRequest,
	type PlaceSearchResponse,
	PlaceSearchResponseSchema,
	type PlaceSearchResult,
	type ResultToken,
} from "@chi-shen-me/contracts";
import {
	Inject,
	Injectable,
	ServiceUnavailableException,
} from "@nestjs/common";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import { isInsideBeijingFourthRingPilot } from "../recommendations/domain/coverage.js";
import {
	PLACE_KEYWORD_SEARCH_PROVIDER,
	type PlaceKeywordSearchCandidate,
	type PlaceKeywordSearchProvider,
} from "./place-keyword-search.provider.js";

function publicResult(
	candidate: PlaceKeywordSearchCandidate,
	resultToken: ResultToken,
): PlaceSearchResult {
	return {
		resultToken,
		rank: candidate.providerRank,
		name: candidate.name,
		address: candidate.address,
		location: { ...candidate.location },
		distanceMeters: candidate.distanceMeters,
		sourceLabel: candidate.sourceLabel,
		sourceRating: candidate.sourceRating,
		averageCostYuan: candidate.averageCostYuan,
		openStatus: candidate.openStatus,
		tags: [...candidate.tags],
		dataMode: candidate.dataMode,
		actions: { ...candidate.actions },
	};
}

function satisfiesHardFilters(
	candidate: PlaceKeywordSearchCandidate,
	request: PlaceSearchRequest,
): boolean {
	if (!isInsideBeijingFourthRingPilot(candidate.location)) return false;
	if (candidate.distanceMeters > request.radiusMeters) return false;
	if (
		request.maxAverageCostYuan !== undefined &&
		candidate.averageCostYuan !== null &&
		candidate.averageCostYuan > request.maxAverageCostYuan
	) {
		return false;
	}
	// UNKNOWN is retained: absence of reliable hours is not evidence of closure.
	if (request.openNow && candidate.openStatus === "CLOSED") return false;
	return true;
}

function stableUniqueCandidates(
	candidates: readonly PlaceKeywordSearchCandidate[],
): readonly PlaceKeywordSearchCandidate[] {
	const identifiersByProvider = new Map<string, Set<string>>();
	return candidates.filter((candidate) => {
		let identifiers = identifiersByProvider.get(candidate.provider);
		if (identifiers === undefined) {
			identifiers = new Set<string>();
			identifiersByProvider.set(candidate.provider, identifiers);
		}
		if (identifiers.has(candidate.providerPlaceId)) return false;
		identifiers.add(candidate.providerPlaceId);
		return true;
	});
}

@Injectable()
export class PlaceSearchService {
	constructor(
		@Inject(PLACE_KEYWORD_SEARCH_PROVIDER)
		private readonly provider: PlaceKeywordSearchProvider,
		private readonly requestRegistry: RecommendationRequestRegistry,
	) {}

	async search(request: PlaceSearchRequest): Promise<PlaceSearchResponse> {
		const requestId = randomUUID();
		if (!isInsideBeijingFourthRingPilot(request.location)) {
			return PlaceSearchResponseSchema.parse({
				requestId,
				coverage: "OUTSIDE_PILOT",
				results: [],
				notice: "当前位置不在北京四环试点区，请手动选择试点区内地点",
			});
		}
		let candidates: readonly PlaceKeywordSearchCandidate[];
		try {
			// This is a per-request live lookup. The provider query, exact origin and
			// supplier identifiers are never cached or retained by this service.
			candidates = await this.provider.search(request);
		} catch {
			throw new ServiceUnavailableException({
				code: "PLACE_SEARCH_PROVIDER_UNAVAILABLE",
				message: "餐厅搜索服务暂时不可用，请稍后重试",
			});
		}

		// Array.filter and slice are stable. No quality or proprietary ranking is
		// introduced: providerRank remains the upstream rank, including gaps caused
		// by explicit hard filters.
		const retained = stableUniqueCandidates(candidates)
			.filter((candidate) => satisfiesHardFilters(candidate, request))
			.slice(0, request.limit);
		const resultTokens = this.requestRegistry.issueSearch(
			requestId,
			retained,
			request.mealPeriod,
		);
		try {
			return PlaceSearchResponseSchema.parse({
				requestId,
				coverage: "BEIJING_FOURTH_RING",
				results: retained.map((candidate, index) => {
					const resultToken = resultTokens[index];
					if (resultToken === undefined) {
						throw new Error("SEARCH_RESULT_TOKEN_ISSUANCE_FAILED");
					}
					return publicResult(candidate, resultToken);
				}),
				notice: null,
			});
		} catch (error) {
			this.requestRegistry.revoke(requestId);
			throw error;
		}
	}
}
