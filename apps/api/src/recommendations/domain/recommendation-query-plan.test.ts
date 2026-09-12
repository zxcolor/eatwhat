import {
	CuisinePreferenceSchema,
	RecommendationContextSchema,
} from "@chi-shen-me/contracts";
import { describe, expect, it } from "vitest";
import { buildRecommendationQueryPlan } from "./recommendation-query-plan.js";

const context = (
	overrides: Partial<
		Parameters<typeof RecommendationContextSchema.parse>[0]
	> = {},
) =>
	RecommendationContextSchema.parse({
		location: { latitude: 39.9928, longitude: 116.3109 },
		mealPeriod: "LUNCH",
		radiusMeters: 1_500,
		...overrides,
	});

describe("recommendation query plan", () => {
	it.each(["MEAL", "MILK_TEA", "COFFEE", "DESSERT"] as const)(
		"canonicalizes supplemental cuisine sets without displacing the %s profile",
		(target) => {
			const original = context({
				target,
				preferredCuisines: ["川湘菜", "火锅", "面食", "米饭", "面食"],
			});
			const before = structuredClone(original);
			const a = buildRecommendationQueryPlan(original);
			const b = buildRecommendationQueryPlan(
				context({
					target,
					preferredCuisines: ["米饭", "面食", "火锅", "川湘菜"],
				}),
			);
			expect(a).toEqual(b);
			expect(a.supplementalCuisineTerms).toEqual([
				"面食",
				"米饭",
				"火锅",
				"川湘菜",
			]);
			expect(a.queryTerms[0]).toBe(a.preferredTerm);
			expect(a.queryTerms.slice(1)).toEqual(a.supplementalCuisineTerms);
			expect(original).toEqual(before);
			expect(Object.isFrozen(a.queryTerms)).toBe(true);
		},
	);
	it("retains all eight choices after the leading profile query term", () => {
		const plan = buildRecommendationQueryPlan(
			context({
				mealPeriod: "BREAKFAST",
				preferredCuisines: [...CuisinePreferenceSchema.options].reverse(),
			}),
		);
		expect(plan.queryTerms).toEqual([
			"早餐",
			...CuisinePreferenceSchema.options,
		]);
	});
	it("keeps breakfast and dinner profile terms ahead of user cuisines", () => {
		const breakfast = buildRecommendationQueryPlan(
			context({
				mealPeriod: "BREAKFAST",
				preferredCuisines: ["火锅", "川湘菜"],
			}),
		);
		const dinner = buildRecommendationQueryPlan(
			context({
				mealPeriod: "DINNER",
				preferredCuisines: ["面食"],
			}),
		);

		expect(breakfast.queryTerms).toEqual(["早餐", "火锅", "川湘菜"]);
		expect(dinner.queryTerms).toEqual(["晚餐", "面食"]);
		expect(breakfast.preferredTerm).toBe("早餐");
		expect(dinner.preferredTerm).toBe("晚餐");
	});

	it("marks vertical plans as capability-gated without provider taxonomy", () => {
		const plan = buildRecommendationQueryPlan(
			context({ target: "COFFEE", mealPeriod: "BREAKFAST" }),
		);

		expect(plan).toMatchInlineSnapshot(`
			{
			  "preferredTerm": "咖啡店",
			  "profile": {
			    "family": "COFFEE",
			    "providerCapabilityRequired": true,
			    "target": "COFFEE",
			    "version": "coffee-v1",
			  },
			  "providerCapabilityRequired": true,
			  "providerCategory": "餐饮服务",
			  "queryTerms": [
			    "咖啡店",
			  ],
			  "supplementalCuisineTerms": [],
			  "weatherApplication": {
			    "kind": "NONE",
			    "queryModifier": null,
			    "version": "weather-none-v1",
			  },
			}
		`);
		expect(plan).not.toHaveProperty("providerTaxonomy");
		expect(plan).not.toHaveProperty("rankResults");
		expect(plan).not.toHaveProperty("persist");
	});

	it.each([
		["MINIMIZE_EXPOSURE", "MINIMIZE_OUTDOOR_EXPOSURE"],
		["WARMING", "PREFER_WARMING_OPTIONS"],
		["COOLING", "PREFER_COOLING_OPTIONS"],
	] as const)(
		"maps %s only to its request-scoped query modifier",
		(preference, queryModifier) => {
			const plan = buildRecommendationQueryPlan(
				context({
					weatherContext: { kind: "USER_REPORTED", preference },
				}),
			);
			expect(plan.weatherApplication).toEqual({
				kind: "USER_REPORTED",
				version: "user-reported-weather-v1",
				preference,
				queryModifier,
			});
		},
	);
});
