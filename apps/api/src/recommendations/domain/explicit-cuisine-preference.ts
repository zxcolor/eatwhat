import {
	type CuisinePreference,
	CuisinePreferenceSchema,
	type IntentProfile,
	type RecommendationContext,
} from "@chi-shen-me/contracts";

/** Public schemas validate values first. Choices express a set, not a ballot.
 * Tag normalization must never broaden the accepted user enum values. */
export function canonicalCuisinePreferences(
	values: readonly CuisinePreference[],
): CuisinePreference[] {
	const selected = new Set(values);
	return CuisinePreferenceSchema.options.filter((cuisine) =>
		selected.has(cuisine),
	);
}

/** Positive matches require an explicitly registered source category. The
 * broader exclusion matcher must not certify labels such as 非清真 or 非素食. */
export function matchExplicitCuisines(
	tags: readonly string[],
	preferences: readonly CuisinePreference[],
): { cuisine: CuisinePreference; tag: string }[] {
	const normalizedTags = [
		...new Set(tags.map((tag) => tag.trim().toLowerCase())),
	].sort();
	return canonicalCuisinePreferences(preferences).flatMap((cuisine) => {
		const acceptedTags =
			cuisine === "川湘菜" ? ["川湘菜", "川菜", "湘菜"] : [cuisine];
		const tag = normalizedTags.find((candidate) =>
			acceptedTags.includes(candidate),
		);
		return tag === undefined ? [] : [{ cuisine, tag }];
	});
}

/** Constrain parsed model/rule output at every public provider/coordinator exit.
 * With explicit choices, model-added weights cannot outrank, omit or reweight
 * those choices. All eight selected enums fit before optional inferred terms.
 * Unselected meal-type hints remain only for compatibility; explicit scoring
 * and explanations independently consume the request and source evidence. */
export function constrainExplicitIntent(
	context: Pick<RecommendationContext, "preferredCuisines">,
	profile: IntentProfile,
): IntentProfile {
	const preferred = canonicalCuisinePreferences(context.preferredCuisines);
	if (preferred.length === 0) return profile;
	return {
		...profile,
		cuisineWeights: Object.fromEntries(
			preferred.map((cuisine) => [cuisine, 1]),
		),
		mealTypes: [...new Set([...preferred, ...profile.mealTypes])].slice(0, 8),
	};
}
