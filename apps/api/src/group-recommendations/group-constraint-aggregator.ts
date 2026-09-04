import {
	type CuisinePreference,
	CuisinePreferenceSchema,
	type GroupConstraintAggregation,
	GroupConstraintAggregationSchema,
	type GroupMemberConstraints,
} from "@chi-shen-me/contracts";

const CUISINE_ORDER: readonly CuisinePreference[] =
	CuisinePreferenceSchema.options;

/**
 * Recomputes the only supported anonymous-group policy from member inputs.
 * The output is deliberately canonical, so member order and each member's
 * array order cannot change the provider request or the echoed summary.
 */
export function aggregateGroupConstraints(
	members: readonly GroupMemberConstraints[],
): Readonly<GroupConstraintAggregation> {
	if (members.length < 2 || members.length > 8) {
		throw new RangeError("GROUP_MEMBER_COUNT_OUT_OF_RANGE");
	}

	const finiteBudgets = members.flatMap((member) =>
		member.budgetMaxYuan === null ? [] : [member.budgetMaxYuan],
	);
	const excludedSet = new Set(
		members.flatMap((member) => member.excludedCuisines),
	);
	const nonEmptyPreferenceSets = members
		.map((member) => new Set(member.preferredCuisines))
		.filter((preferences) => preferences.size > 0);
	const sharedPreferenceSet =
		nonEmptyPreferenceSets.length === 0
			? new Set<CuisinePreference>()
			: new Set(
					CUISINE_ORDER.filter((cuisine) =>
						nonEmptyPreferenceSets.every((preferences) =>
							preferences.has(cuisine),
						),
					),
				);

	const aggregation = GroupConstraintAggregationSchema.parse({
		version: "group-constraints-v1",
		memberCount: members.length,
		effectiveBudgetMaxYuan:
			finiteBudgets.length === 0 ? null : Math.min(...finiteBudgets),
		effectiveAvailableMinutes: Math.min(
			...members.map((member) => member.availableMinutes),
		),
		effectiveRadiusMeters: Math.min(
			...members.map((member) => member.radiusMeters),
		),
		preferredCuisines: CUISINE_ORDER.filter(
			(cuisine) =>
				sharedPreferenceSet.has(cuisine) && !excludedSet.has(cuisine),
		),
		excludedCuisines: CUISINE_ORDER.filter((cuisine) =>
			excludedSet.has(cuisine),
		),
	});
	Object.freeze(aggregation.preferredCuisines);
	Object.freeze(aggregation.excludedCuisines);
	return Object.freeze(aggregation);
}
