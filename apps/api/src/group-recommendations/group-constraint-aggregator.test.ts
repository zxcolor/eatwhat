import type {
	CuisinePreference,
	GroupMemberConstraints,
} from "@chi-shen-me/contracts";
import { describe, expect, it } from "vitest";
import { aggregateGroupConstraints } from "./group-constraint-aggregator.js";

function member(
	overrides: Partial<GroupMemberConstraints> = {},
): GroupMemberConstraints {
	return {
		budgetMaxYuan: null,
		availableMinutes: 60,
		radiusMeters: 1_500,
		preferredCuisines: [],
		excludedCuisines: [],
		...overrides,
	};
}

describe("aggregateGroupConstraints", () => {
	it("takes the tightest numeric limits and preserves unlimited budget only when every budget is null", () => {
		expect(
			aggregateGroupConstraints([
				member({
					budgetMaxYuan: null,
					availableMinutes: 90,
					radiusMeters: 2_000,
				}),
				member({ budgetMaxYuan: 60, availableMinutes: 45, radiusMeters: 800 }),
				member({
					budgetMaxYuan: 35,
					availableMinutes: 70,
					radiusMeters: 1_200,
				}),
			]),
		).toMatchObject({
			version: "group-constraints-v1",
			memberCount: 3,
			effectiveBudgetMaxYuan: 35,
			effectiveAvailableMinutes: 45,
			effectiveRadiusMeters: 800,
		});
		expect(
			aggregateGroupConstraints([member(), member()]).effectiveBudgetMaxYuan,
		).toBeNull();
	});

	it("unions exclusions, intersects only non-empty preferences, gives exclusions priority and emits contract order", () => {
		const result = aggregateGroupConstraints([
			member({
				preferredCuisines: ["素食", "火锅", "面食", "米饭"],
				excludedCuisines: ["西餐"],
			}),
			member({ preferredCuisines: [] }),
			member({
				preferredCuisines: ["米饭", "面食", "火锅"],
				excludedCuisines: ["火锅", "清真"],
			}),
		]);

		expect(result.preferredCuisines).toEqual(["面食", "米饭"]);
		expect(result.excludedCuisines).toEqual(["火锅", "清真", "西餐"]);
	});

	it("returns no shared preferences when every member preference set is empty", () => {
		expect(
			aggregateGroupConstraints([
				member({ excludedCuisines: ["米饭"] }),
				member({ excludedCuisines: ["面食"] }),
			]),
		).toMatchObject({
			preferredCuisines: [],
			excludedCuisines: ["面食", "米饭"],
		});
	});

	it("is invariant to every member permutation", () => {
		const members = [
			member({
				budgetMaxYuan: 80,
				preferredCuisines: ["中式快餐", "面食", "米饭"],
			}),
			member({
				budgetMaxYuan: null,
				availableMinutes: 40,
				preferredCuisines: ["米饭", "面食"],
			}),
			member({
				budgetMaxYuan: 45,
				radiusMeters: 700,
				preferredCuisines: ["面食", "米饭"],
				excludedCuisines: ["米饭"],
			}),
		] as const;
		const permutations = [
			[members[0], members[1], members[2]],
			[members[0], members[2], members[1]],
			[members[1], members[0], members[2]],
			[members[1], members[2], members[0]],
			[members[2], members[0], members[1]],
			[members[2], members[1], members[0]],
		];
		const canonical = aggregateGroupConstraints(members);
		for (const permutation of permutations) {
			expect(aggregateGroupConstraints(permutation)).toEqual(canonical);
		}
	});

	it.each([1, 9])("rejects %i members defensively", (count) => {
		expect(() =>
			aggregateGroupConstraints(Array.from({ length: count }, () => member())),
		).toThrow("GROUP_MEMBER_COUNT_OUT_OF_RANGE");
	});

	it("orders every cuisine independently from member array order", () => {
		const allReverse = [
			"西餐",
			"素食",
			"清真",
			"川湘菜",
			"火锅",
			"米饭",
			"面食",
			"中式快餐",
		] satisfies CuisinePreference[];
		const result = aggregateGroupConstraints([
			member({ preferredCuisines: allReverse }),
			member({ preferredCuisines: allReverse }),
		]);
		expect(result.preferredCuisines).toEqual([
			"中式快餐",
			"面食",
			"米饭",
			"火锅",
			"川湘菜",
			"清真",
			"素食",
			"西餐",
		]);
	});
});
