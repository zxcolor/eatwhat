import type {
	PlaceSearchRequest,
	RecommendationEvent,
} from "@chi-shen-me/contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecommendationRequestRegistry } from "../common/recommendation-request.registry.js";
import type {
	PlaceKeywordSearchCandidate,
	PlaceKeywordSearchProvider,
} from "./place-keyword-search.provider.js";
import { PlaceSearchService } from "./place-search.service.js";

const request: PlaceSearchRequest = {
	location: { latitude: 39.9928, longitude: 116.3109, crs: "WGS84" },
	mealPeriod: "LUNCH",
	keyword: "午餐",
	radiusMeters: 1_500,
	maxAverageCostYuan: 30,
	openNow: true,
	limit: 10,
};

function candidate(
	providerRank: number,
	overrides: Partial<PlaceKeywordSearchCandidate> = {},
): PlaceKeywordSearchCandidate {
	return {
		provider: "AMAP",
		providerPlaceId: `private-poi-${providerRank}`,
		providerRank,
		name: `餐厅 ${providerRank}`,
		address: null,
		location: { latitude: 39.99, longitude: 116.31, crs: "GCJ02" },
		distanceMeters: 600,
		sourceLabel: "实时餐厅数据",
		sourceRating: null,
		averageCostYuan: null,
		openStatus: "UNKNOWN",
		tags: ["午餐"],
		dataMode: "LIVE",
		actions: {
			navigate: false,
			call: false,
			copyAddress: false,
			share: false,
		},
		...overrides,
	};
}

const registries: RecommendationRequestRegistry[] = [];

afterEach(() => {
	for (const registry of registries.splice(0)) registry.onModuleDestroy();
});

describe("PlaceSearchService", () => {
	it("applies only hard filters, keeps UNKNOWN, and preserves provider rank", async () => {
		const provider = {
			dataSource: "AMAP",
			dataMode: "LIVE",
			search: vi.fn().mockResolvedValue([
				candidate(1, { averageCostYuan: 20, openStatus: "CLOSED" }),
				candidate(2, { averageCostYuan: null, openStatus: "UNKNOWN" }),
				candidate(3, { averageCostYuan: 20, distanceMeters: 1_501 }),
				candidate(4, { averageCostYuan: 20, openStatus: "OPEN" }),
				candidate(5, { averageCostYuan: 31, openStatus: "OPEN" }),
				candidate(6, {
					providerPlaceId: "private-poi-4",
					name: "重复餐厅不得覆盖首项",
					averageCostYuan: 20,
					openStatus: "OPEN",
				}),
				candidate(7, {
					location: { latitude: 31.2304, longitude: 121.4737, crs: "GCJ02" },
					averageCostYuan: 20,
					openStatus: "OPEN",
				}),
			]),
		} as unknown as PlaceKeywordSearchProvider;
		const registry = new RecommendationRequestRegistry();
		registries.push(registry);
		const service = new PlaceSearchService(provider, registry);

		const response = await service.search(request);

		expect(response.results.map((result) => result.rank)).toEqual([2, 4]);
		expect(response.results).toHaveLength(2);
		expect(response).toMatchObject({
			coverage: "BEIJING_FOURTH_RING",
			notice: null,
		});
		expect(response.results[1]?.name).toBe("餐厅 4");
		expect(JSON.stringify(response)).not.toMatch(
			/provider|private-poi|fitScore|reasons|aiAssisted/u,
		);
		expect(provider.search).toHaveBeenCalledWith(request);

		const first = response.results[0];
		if (first === undefined) throw new Error("expected search result");
		expect(
			registry.resolveForPersistence(
				response.requestId,
				first.resultToken,
				"FAVORITE",
			),
		).toMatchObject({ providerPlaceId: "private-poi-2" });
		const fakeEvent: RecommendationEvent = {
			requestId: response.requestId,
			resultToken: first.resultToken,
			type: "DETAIL",
			occurredAt: new Date().toISOString(),
		};
		expect(registry.validateAndConsume(fakeEvent)).toBeNull();
		expect(registry.resolveHistoryEvent(fakeEvent)).toBeNull();
	});

	it("returns OUTSIDE_PILOT without calling a provider or issuing tokens", async () => {
		const provider = {
			dataSource: "AMAP",
			dataMode: "LIVE",
			search: vi.fn(),
		} as unknown as PlaceKeywordSearchProvider;
		const registry = new RecommendationRequestRegistry();
		registries.push(registry);
		const service = new PlaceSearchService(provider, registry);

		await expect(
			service.search({
				...request,
				location: {
					latitude: 31.2304,
					longitude: 121.4737,
					crs: "WGS84",
				},
			}),
		).resolves.toMatchObject({
			coverage: "OUTSIDE_PILOT",
			results: [],
			notice: expect.stringContaining("不在北京四环试点区"),
		});
		expect(provider.search).not.toHaveBeenCalled();
		expect(registry.diagnostics().activeRequestCount).toBe(0);
	});

	it("maps every provider error to one safe service error", async () => {
		const provider = {
			dataSource: "AMAP",
			dataMode: "LIVE",
			search: vi.fn(async () => {
				throw new Error(
					"private-test-key 牛肉面 116.3109 https://restapi.amap.com",
				);
			}),
		} as unknown as PlaceKeywordSearchProvider;
		const registry = new RecommendationRequestRegistry();
		registries.push(registry);
		const service = new PlaceSearchService(provider, registry);

		const error = await service.search(request).catch((caught) => caught);
		expect(error).toBeInstanceOf(ServiceUnavailableException);
		expect(error).toMatchObject({
			response: {
				code: "PLACE_SEARCH_PROVIDER_UNAVAILABLE",
				message: "餐厅搜索服务暂时不可用，请稍后重试",
			},
		});
		expect(JSON.stringify(error)).not.toMatch(
			/private-test-key|牛肉面|116\.3109|restapi\.amap\.com/u,
		);
	});
});
