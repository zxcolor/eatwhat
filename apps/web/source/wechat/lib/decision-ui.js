const SCENARIOS = {
  IN_A_HURRY: { decisionMode: 'QUICK', travelMode: 'WALK', explorationMode: 'SAFE', budgetMaxYuan: 25, availableMinutes: 30, radiusMeters: 1000 },
  WORKDAY_LUNCH: { mealPeriod: 'LUNCH', decisionMode: 'QUICK', travelMode: 'WALK', explorationMode: 'BALANCED', budgetMaxYuan: 25, availableMinutes: 45, radiusMeters: 1500 },
  BUSINESS_TRIP: { decisionMode: 'GUIDED', travelMode: 'WALK', explorationMode: 'BALANCED', budgetMaxYuan: 40, availableMinutes: 60, radiusMeters: 1500 },
};
function scenario(filters, key) { return { ...filters, ...(SCENARIOS[key] || {}) }; }
function normalize(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ''); }
function visible(result, budget, filter) {
  return (!filter.openNowOnly || result.openStatus === 'OPEN') &&
    (!filter.knownPriceOnly || (Number.isFinite(result.averageCostYuan) && result.averageCostYuan >= 0 && (budget === null || result.averageCostYuan <= budget))) &&
    (!normalize(filter.query) || result.tags.some(tag => normalize(tag).includes(normalize(filter.query))));
}
module.exports = { scenario, visible };
