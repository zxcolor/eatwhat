import {
	DEFAULT_RECOMMENDATION_PREFERENCE_VECTOR,
	type PlaceSearchRequest,
	type RecommendationContext,
} from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import { AmapLocationSearchProvider } from "../location-search/providers/amap-location-search.provider.js";
import { AmapPlaceKeywordSearchProvider } from "../place-search/providers/amap-place-keyword-search.provider.js";
import { buildRecommendationQueryPlan } from "../recommendations/domain/recommendation-query-plan.js";
import { AmapPlaceProvider } from "../recommendations/providers/amap-place.provider.js";
import { computeAmapWebServiceSignature } from "./amap-request-signature.js";

const origin = Object.freeze({
	latitude: 39.9928,
	longitude: 116.3109,
	crs: "GCJ02" as const,
});

const recommendationContext: RecommendationContext = Object.freeze({
	location: origin,
	mealPeriod: "LUNCH",
	target: "MEAL",
	weatherContext: Object.freeze({ kind: "NONE" }),
	decisionMode: "QUICK",
	travelMode: "WALK",
	explorationMode: "BALANCED",
	aiAssistanceEnabled: false,
	budgetMaxYuan: null,
	availableMinutes: 60,
	radiusMeters: 1_500,
	partySize: 1,
	excludedCuisines: [],
	preferredCuisines: [],
	preferenceVector: { ...DEFAULT_RECOMMENDATION_PREFERENCE_VECTOR },
});

const placeSearchRequest: PlaceSearchRequest = Object.freeze({
	location: origin,
	mealPeriod: "LUNCH",
	keyword: "牛肉面",
	radiusMeters: 1_500,
	openNow: false,
	limit: 3,
});

describe("signed AMap provider requests", () => {
	it("signs all three Web Service chains without exposing the private key", async () => {
		const privateKey = "server-signing-private-key";
		const config = loadAppConfig({
			NODE_ENV: "test",
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: "server-web-service-key",
			AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: privateKey,
		});
		const requested: URL[] = [];
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			requested.push(new URL(String(input)));
			return new Response(
				JSON.stringify({ status: "1", infocode: "10000", pois: [] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;

		await new AmapLocationSearchProvider(config, fetchMock).search("北京大学");
		await new AmapPlaceKeywordSearchProvider(config, fetchMock).search(
			placeSearchRequest,
		);
		await new AmapPlaceProvider(config, fetchMock).search(
			recommendationContext,
			buildRecommendationQueryPlan(recommendationContext),
		);

		expect(requested.map((url) => url.pathname)).toEqual([
			"/v5/place/text",
			"/v5/place/around",
			"/v5/place/around",
		]);
		for (const url of requested) {
			const signature = url.searchParams.get("sig");
			expect(signature).toMatch(/^[0-9a-f]{32}$/u);
			url.searchParams.delete("sig");
			expect(signature).toBe(
				computeAmapWebServiceSignature(url.searchParams, privateKey),
			);
			expect(url.toString()).not.toContain(privateKey);
		}
	});
});
