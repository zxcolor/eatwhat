const test = require('node:test');
const assert = require('node:assert/strict');
const { scenario, visible } = require('../lib/decision-ui');
test('Android scenarios preserve explicit location, target, weather and excluded cuisines', () => {
  const original = { location: { latitude: 0, longitude: 0 }, target: 'COFFEE', weatherContext: { kind: 'NONE' }, excludedCuisines: ['面食'], mealPeriod: 'DINNER' };
  const hurry = scenario(original, 'IN_A_HURRY');
  assert.equal(hurry.availableMinutes, 30); assert.equal(hurry.radiusMeters, 1000);
  assert.equal(hurry.location, original.location); assert.equal(hurry.excludedCuisines, original.excludedCuisines); assert.equal(hurry.target, 'COFFEE'); assert.equal(hurry.mealPeriod, 'DINNER');
  assert.equal(scenario(original, 'WORKDAY_LUNCH').mealPeriod, 'LUNCH');
  assert.equal(scenario(original, 'BUSINESS_TRIP').decisionMode, 'GUIDED');
});
test('local filters preserve order and distinguish unknown prices and opening states', () => {
  const results = [
    { rank: 1, averageCostYuan: null, openStatus: 'UNKNOWN', tags: ['面食'] },
    { rank: 2, averageCostYuan: 20, openStatus: 'OPEN', tags: [' 川 菜 '] },
    { rank: 3, averageCostYuan: 40, openStatus: 'OPEN', tags: ['川菜'] },
  ];
  assert.deepEqual(results.filter(item => visible(item, 25, {})).map(item => item.rank), [1, 2, 3]);
  assert.deepEqual(results.filter(item => visible(item, 25, { openNowOnly: true, knownPriceOnly: true, query: '川菜' })).map(item => item.rank), [2]);
  assert.deepEqual(results.filter(item => visible(item, null, { knownPriceOnly: true })).map(item => item.rank), [2, 3]);
  assert.equal(results[0].openStatus, 'UNKNOWN');
});
