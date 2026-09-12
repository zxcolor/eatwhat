import {
	CuisinePreferenceSchema,
	type IntentProfile,
	IntentProfileSchema,
} from "@chi-shen-me/contracts";
import { describe, expect, it } from "vitest";
import {
	canonicalCuisinePreferences,
	constrainExplicitIntent,
	matchExplicitCuisines,
} from "./explicit-cuisine-preference.js";

const parsedProfile = (patch: Partial<IntentProfile> = {}) =>
	IntentProfileSchema.parse({
		cuisineWeights: { 面食: 0, 米饭: 0.7, 火锅: 1 },
		mealTypes: ["火锅", "快餐", "面食"],
		speedPreference: "RELAXED",
		diversityTarget: 0.9,
		explanationSeed: "合成模型输出",
		provider: "QWEN",
		...patch,
	});

describe("canonical explicit cuisine choices", () => {
	it("canonicalizes every enum subset, reverse order and duplicate entries", () => {
		for (let mask = 0; mask < 256; mask += 1) {
			const expected = CuisinePreferenceSchema.options.filter(
				(_, index) => (mask & (1 << index)) !== 0,
			);
			const input = Object.freeze(
				[...expected].reverse().flatMap((cuisine) => [cuisine, cuisine]),
			);
			expect(canonicalCuisinePreferences(input)).toEqual(expected);
			expect(
				canonicalCuisinePreferences(canonicalCuisinePreferences(input)),
			).toEqual(expected);
			expect(canonicalCuisinePreferences(input)).not.toBe(input);
		}
	});
	it("does not turn tag aliases or whitespace into accepted user enum values", () => {
		for (const value of [" 川湘菜 ", "川菜", "非清真", "Western"])
			expect(CuisinePreferenceSchema.safeParse(value).success).toBe(false);
	});
});

describe("positive source category evidence", () => {
	it.each(["川湘菜", "川菜", "湘菜"])(
		"supports the registered 川湘菜 alias %s",
		(tag) => {
			expect(matchExplicitCuisines([` ${tag} `], ["川湘菜"])).toEqual([
				{ cuisine: "川湘菜", tag },
			]);
		},
	);
	it("returns one stable supporting tag per canonical choice irrespective of source order", () => {
		const tags = Object.freeze(["湘菜", "面食", " 川菜 ", "川湘菜", "面食"]);
		const preferences = Object.freeze(["川湘菜", "面食", "川湘菜"] as const);
		const expected = [
			{ cuisine: "面食", tag: "面食" },
			{ cuisine: "川湘菜", tag: "川湘菜" },
		];
		expect(matchExplicitCuisines(tags, preferences)).toEqual(expected);
		expect(
			matchExplicitCuisines([...tags].reverse(), [...preferences].reverse()),
		).toEqual(expected);
		expect(tags).toEqual(["湘菜", "面食", " 川菜 ", "川湘菜", "面食"]);
	});
	it.each([
		"非清真",
		"非素食",
		"重庆火锅",
		"火锅店",
		"川湘菜系",
		"西餐/面食",
		"米饭快餐",
		"",
		"  ",
	])("does not infer a positive category from %j", (tag) => {
		expect(
			matchExplicitCuisines([tag], CuisinePreferenceSchema.options),
		).toEqual([]);
	});
	it("only reports selected categories and leaves absent evidence unmatched", () => {
		expect(
			matchExplicitCuisines(["火锅", "西餐", "素食"], ["面食", "米饭"]),
		).toEqual([]);
		expect(matchExplicitCuisines([], ["面食"])).toEqual([]);
		expect(matchExplicitCuisines(["面食"], [])).toEqual([]);
	});
});

describe("explicit intent constraints", () => {
	it.each([
		{ cuisineWeights: { 面食: 0, 米饭: 1 }, mealTypes: ["米饭", "快餐"] },
		{ cuisineWeights: { 面食: 1, 米饭: 0 }, mealTypes: ["面食", "午餐"] },
		{ cuisineWeights: { 火锅: 1 }, mealTypes: ["火锅", "正餐"] },
	])("overrides adversarial model weights and omissions: %j", (patch) => {
		const input = parsedProfile(patch);
		Object.freeze(input.mealTypes);
		Object.freeze(input.cuisineWeights);
		Object.freeze(input);
		const result = constrainExplicitIntent(
			{ preferredCuisines: ["米饭", "面食", "米饭"] },
			input,
		);
		expect(result.cuisineWeights).toEqual({ 面食: 1, 米饭: 1 });
		expect(Object.keys(result.cuisineWeights)).toEqual(["面食", "米饭"]);
		expect(result.mealTypes.slice(0, 2)).toEqual(["面食", "米饭"]);
		expect(result).toMatchObject({
			provider: input.provider,
			speedPreference: input.speedPreference,
			diversityTarget: input.diversityTarget,
			explanationSeed: input.explanationSeed,
		});
		expect(result).not.toBe(input);
	});
	it("keeps all eight explicit choices even when the original meal types are full", () => {
		const profile = parsedProfile({
			mealTypes: [
				"午餐",
				"快餐",
				"盖饭",
				"简餐",
				"正餐",
				"聚餐",
				"咖啡店",
				"甜品",
			],
		});
		const preferredCuisines = [...CuisinePreferenceSchema.options].reverse();
		const constrained = constrainExplicitIntent({ preferredCuisines }, profile);
		expect(constrained.mealTypes).toEqual(CuisinePreferenceSchema.options);
		expect(Object.values(constrained.cuisineWeights)).toEqual(Array(8).fill(1));
		expect(IntentProfileSchema.safeParse(constrained).success).toBe(true);
	});
	it("is idempotent for reordered duplicate choices and preserves unconsumed model fields", () => {
		const input = parsedProfile();
		const once = constrainExplicitIntent(
			{ preferredCuisines: ["米饭", "面食"] },
			input,
		);
		expect(
			constrainExplicitIntent(
				{ preferredCuisines: ["面食", "米饭", "面食"] },
				once,
			),
		).toEqual(once);
		expect(input.mealTypes).toEqual(["火锅", "快餐", "面食"]);
		expect(input.cuisineWeights).toEqual({ 面食: 0, 米饭: 0.7, 火锅: 1 });
	});
	it("leaves the complete legacy profile untouched when no choice was expressed", () => {
		for (const provider of ["QWEN", "RULE_FALLBACK"] as const) {
			const input = parsedProfile({ provider });
			expect(constrainExplicitIntent({ preferredCuisines: [] }, input)).toBe(
				input,
			);
		}
	});
});
