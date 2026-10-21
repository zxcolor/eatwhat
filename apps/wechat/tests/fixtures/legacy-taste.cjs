// Explicit inputs for the still-supported legacy catalog adapter. These are
// synthetic test declarations, never migrated answers for the new sliders.
function legacyOptions(input) {
	const weights = {
		balanced: [4, 2, 2],
		taste: [6, 1, 1],
		price: [2, 6, 1],
		distance: [2, 1, 6],
	};
	const [taste, price, distance] = weights[input.priority];
	return {
		budgetCents: input.budgetCents,
		maxSpicy: input.maxSpicy,
		weights: { price, distance, main: 1 },
		taste: {
			version: 1,
			likedGroups: [...input.likedGroups].sort(),
			avoidedGroups: [...input.avoidedGroups].sort(),
			weight: input.likedGroups.length ? taste : 0,
		},
	};
}
module.exports = { legacyOptions };
