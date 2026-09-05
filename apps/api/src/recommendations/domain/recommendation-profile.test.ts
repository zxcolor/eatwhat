import { describe, expect, it } from "vitest";
import {
	RECOMMENDATION_PROFILE_TERM_ALLOWLIST,
	resolveRecommendationProfile,
} from "./recommendation-profile.js";

describe("recommendation profile registry", () => {
	it("maps each meal period and vertical target to a deterministic profile", () => {
		const resolved = [
			resolveRecommendationProfile("MEAL", "BREAKFAST"),
			resolveRecommendationProfile("MEAL", "LUNCH"),
			resolveRecommendationProfile("MEAL", "DINNER"),
			resolveRecommendationProfile("MILK_TEA", "LUNCH"),
			resolveRecommendationProfile("COFFEE", "BREAKFAST"),
			resolveRecommendationProfile("DESSERT", "DINNER"),
		];

		expect(resolved).toMatchInlineSnapshot(`
			[
			  {
			    "family": "MEAL_BREAKFAST",
			    "preferredTerm": "早餐",
			    "providerCapabilityRequired": false,
			    "providerCategory": "餐饮服务",
			    "target": "MEAL",
			    "version": "meal-breakfast-v1",
			  },
			  {
			    "family": "MEAL_LUNCH",
			    "preferredTerm": "午餐",
			    "providerCapabilityRequired": false,
			    "providerCategory": "餐饮服务",
			    "target": "MEAL",
			    "version": "meal-lunch-v1",
			  },
			  {
			    "family": "MEAL_DINNER",
			    "preferredTerm": "晚餐",
			    "providerCapabilityRequired": false,
			    "providerCategory": "餐饮服务",
			    "target": "MEAL",
			    "version": "meal-dinner-v1",
			  },
			  {
			    "family": "MILK_TEA",
			    "preferredTerm": "奶茶店",
			    "providerCapabilityRequired": true,
			    "providerCategory": "餐饮服务",
			    "target": "MILK_TEA",
			    "version": "milk-tea-v1",
			  },
			  {
			    "family": "COFFEE",
			    "preferredTerm": "咖啡店",
			    "providerCapabilityRequired": true,
			    "providerCategory": "餐饮服务",
			    "target": "COFFEE",
			    "version": "coffee-v1",
			  },
			  {
			    "family": "DESSERT",
			    "preferredTerm": "甜品店",
			    "providerCapabilityRequired": true,
			    "providerCategory": "餐饮服务",
			    "target": "DESSERT",
			    "version": "dessert-v1",
			  },
			]
		`);
		expect(
			resolved.every((entry) =>
				RECOMMENDATION_PROFILE_TERM_ALLOWLIST.includes(entry.preferredTerm),
			),
		).toBe(true);
	});
});
