const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { SOURCE_SHA256, SOURCE_VERSION, OUTPUT_PATH, RUNTIME_PATH, canonical, sha256,
  projectCatalog, validateCatalog, serialize, serializeRuntime, validateArtifacts, buildFromSource } = require('../scripts/build-virtual-catalog.cjs');

const bytes = fs.readFileSync(OUTPUT_PATH, 'utf8');
const catalog = JSON.parse(bytes);
const clone = value => JSON.parse(JSON.stringify(value));
const factValue = item => item.state === 'known' ? item.value : null;

// A public-only source-shaped fixture: no research directory or private truth is needed in CI.
function sourceFixture() {
  const restaurants = catalog.restaurants.map(row => ({ id: row.id, name: row.name,
    family_id: row.familyId, x: row.x, y: row.y, category: row.storeCategory.value,
    is_virtual: true, coordinate_system: catalog.coordinateSystem,
    provenance: { generated_fields: ['name', 'x', 'y'] } }));
  const restaurantById = new Map(restaurants.map(row => [row.id, row]));
  const meals = catalog.meals.map(row => ({ id: row.id, name: row.name,
    restaurant_id: row.restaurantId, family_id: row.familyId,
    category: restaurantById.get(row.restaurantId).category,
    store_category: restaurantById.get(row.restaurantId).category,
    is_virtual: true, price_status: row.priceBasis, price_yuan: factValue(row.facts.priceCents) === null ? null : factValue(row.facts.priceCents) / 100,
    spicy: factValue(row.facts.spicy), vegetarian: factValue(row.facts.vegetarian),
    meal_role: factValue(row.facts.mealRole), food_category: null, ingredients: null, actual_meal_role: null,
    audit: { schema_version: 'round9-catalog-audit-v1', collection_eligible: true,
      display_name: row.name, flags: row.auditCodes.map(code => ({ code })),
      attribute_basis: { spicy: row.facts.spicy.source, vegetarian: row.facts.vegetarian.source,
        meal_role: row.facts.mealRole.source }, price_reference: { unit: 'unknown' } } }));
  const template = meals.find(row => row.family_id === 'family-S076');
  for (const excluded of catalog.sourceManifest.excludedMeals) {
    const row = clone(template);
    row.id = excluded.id;
    row.meal_role = null;
    row.audit.attribute_basis.meal_role = 'unknown_due_multi_use';
    row.audit.collection_eligible = false;
    row.audit.flags = [{ code: 'multi_use_not_single_meal' }];
    row.audit.price_reference.unit = 'whole_multi_use_pass';
    meals.push(row);
  }
  return { schema_version: 'round9-reviewed-catalog-v1', catalog_version: SOURCE_VERSION,
    audit_schema_version: 'round9-catalog-audit-v1',
    scope: { all_entities_virtual: true, real_world_execution_authorized: false }, restaurants, meals };
}

function resign(value) {
  value.sourceManifest.payloadSha256 = sha256(canonical({ restaurants: value.restaurants, meals: value.meals }));
  return value;
}

test('committed catalog binds reviewed R9A-v2 and deterministic exporter bytes', () => {
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(serialize(catalog), bytes);
  assert.equal(catalog.sourceManifest.sourceSha256, SOURCE_SHA256);
  assert.equal(catalog.sourceManifest.exporterSha256,
    sha256(fs.readFileSync(require.resolve('../scripts/build-virtual-catalog.cjs'))));
  assert.equal(catalog.restaurants.length, 363);
  assert.equal(catalog.meals.length, 1092);
  assert.equal(new Set(catalog.restaurants.map(row => row.familyId)).size, 121);
  assert.deepEqual(catalog.sourceManifest.counts.roles, { main: 912, snack: 128, drink: 44, unknown: 8 });
  assert.deepEqual(catalog.sourceManifest.counts.unknown, { priceCents: 0, spicy: 380,
    vegetarian: 485, mealRole: 8, foodCategory: 1092, ingredients: 1092, actualMealRole: 1092 });
});

test('export is independent of source order and does not mutate source objects', () => {
  const source = sourceFixture();
  const before = canonical(source);
  assert.equal(serialize(projectCatalog(source)), bytes);
  assert.equal(canonical(source), before);
  source.restaurants.reverse();
  source.meals.reverse();
  assert.equal(serialize(projectCatalog(source)), bytes);
});

test('runtime JS exports exactly the audited JSON without a JSON module loader', () => {
  const runtime = fs.readFileSync(RUNTIME_PATH, 'utf8');
  assert.equal(runtime, serializeRuntime(catalog));
  assert.equal(validateArtifacts(catalog, Buffer.from(bytes), Buffer.from(runtime)), catalog);
  const module = { exports: {} };
  vm.runInNewContext(runtime, { module }, { filename: RUNTIME_PATH });
  assert.deepEqual(clone(module.exports), catalog);
});

test('artifact validation rejects a one-byte drift in either JSON or runtime JS', () => {
  const jsonBytes = fs.readFileSync(OUTPUT_PATH);
  const runtimeBytes = fs.readFileSync(RUNTIME_PATH);
  const changedJson = Buffer.from(jsonBytes);
  const changedRuntime = Buffer.from(runtimeBytes);
  changedJson[changedJson.length - 1] = 32;
  changedRuntime[changedRuntime.length - 1] = 32;
  assert.deepEqual(JSON.parse(changedJson.toString('utf8')), catalog);
  assert.throws(() => validateArtifacts(catalog, changedJson, runtimeBytes), /JSON export differs/);
  assert.throws(() => validateArtifacts(catalog, jsonBytes, changedRuntime), /runtime JS differs/);
});

test('specific reviewed display names, virtual scene cents and source versions survive projection', () => {
  const first = catalog.meals.find(row => row.id === 'vm-S001-P01-0');
  assert.equal(first.name, '【独享时光】小圆锅单人餐 · 虚拟原型');
  assert.deepEqual(first.facts.priceCents, { state: 'known', value: 7900,
    source: 'virtual_final_scene_price', version: SOURCE_VERSION });
  assert.equal(first.priceBasis, 'virtual_final_scene_price');
  assert.equal(first.facts.spicy.state, 'unknown');
  assert.ok(catalog.meals.some(row => row.name.endsWith('模拟变体 1')));
  assert.ok(catalog.meals.some(row => row.name.endsWith('（素食待确认）')));
});

test('four whole multi-use passes are excluded without dividing their prices', () => {
  assert.deepEqual(catalog.sourceManifest.excludedMeals, [0, 1, 2, 3].map(index => ({
    id: `vm-S076-P03-${index}`, reason: 'multi_use_offer' })));
  for (const row of catalog.meals) assert.ok(!row.id.startsWith('vm-S076-P03-'));
  const source = sourceFixture();
  source.meals.find(row => !row.audit.collection_eligible).audit.collection_eligible = true;
  assert.throws(() => projectCatalog(source), /eligibility contradicts/);
});

test('known false and zero remain known rather than missing', () => {
  const falseFact = catalog.meals.find(row => row.facts.vegetarian.value === false).facts.vegetarian;
  const zeroFact = catalog.meals.find(row => row.facts.spicy.value === 0).facts.spicy;
  assert.equal(falseFact.state, 'known');
  assert.equal(zeroFact.state, 'known');
  for (const row of catalog.meals) {
    for (const item of Object.values(row.facts)) {
      if (item.state === 'unknown') assert.equal(Object.hasOwn(item, 'value'), false);
    }
  }
});

test('R9A vegetarian title conflicts remain unknown and retain their audit identity', () => {
  const conflicts = catalog.meals.filter(row => row.auditCodes.includes('synthetic_vegetarian_title_conflict'));
  assert.equal(conflicts.length, 88);
  for (const row of conflicts) {
    assert.equal(row.facts.vegetarian.state, 'unknown');
    assert.equal(row.facts.vegetarian.source, 'unknown_due_title_conflict');
  }
  const source = sourceFixture();
  const row = source.meals.find(meal => meal.audit.flags.some(flag => flag.code === 'synthetic_vegetarian_title_conflict'));
  row.vegetarian = true;
  row.audit.attribute_basis.vegetarian = 'synthetic';
  assert.throws(() => projectCatalog(source), /conflict must remain unknown/);
});

test('source basis cannot contradict an unknown or known virtual attribute', () => {
  const source = sourceFixture();
  const row = source.meals.find(meal => meal.spicy === null && meal.audit.collection_eligible);
  row.audit.attribute_basis.spicy = 'synthetic';
  assert.throws(() => projectCatalog(source), /Contradictory spicy/);
});

test('virtual role, store category and title cannot become verified food composition', () => {
  for (const field of ['food_category', 'ingredients', 'actual_meal_role']) {
    const source = sourceFixture();
    source.meals[0][field] = 'invented';
    assert.throws(() => projectCatalog(source), /must not become/);
  }
  assert.equal(catalog.scope.storeCategoryIsFoodCategory, false);
  assert.equal(catalog.scope.actualCompositionKnown, false);
});

test('source projection drops truth, feedback, models, geographic and original store provenance', () => {
  const source = sourceFixture();
  source.truth = { hiddenUtilities: [1, 0] };
  source.model = { weights: [999] };
  source.feedback = [{ label: 'left' }];
  source.restaurants[0].provenance.source_name = 'DO_NOT_EXPORT_ORIGINAL_STORE';
  source.restaurants[0].address = 'DO_NOT_EXPORT_ADDRESS';
  source.restaurants[0].latitude = 12.34;
  source.meals[0].split = 'test';
  assert.equal(serialize(projectCatalog(source)), bytes);
  const prohibited = new Set(['truth', 'hidden', 'hiddenUtilities', 'weights', 'model', 'feedback',
    'source_name', 'sourceName', 'address', 'latitude', 'longitude', 'lat', 'lng', 'split', 'utilities']);
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!prohibited.has(key), `Private/unrelated field: ${key}`);
      inspect(child);
    }
  }
  inspect(catalog);
});

test('input prices must be finite nonnegative whole cents', () => {
  for (const price of [NaN, Infinity, -1, 0.001, '19.99', true]) {
    const source = sourceFixture();
    source.meals[0].price_yuan = price;
    assert.throws(() => projectCatalog(source), /price|cents/);
  }
});

test('restaurant coordinates retain virtual units and cannot be nonfinite or geographic', () => {
  for (const coordinate of [-1, 1001, NaN, Infinity, '500']) {
    const source = sourceFixture();
    source.restaurants[0].x = coordinate;
    assert.throws(() => projectCatalog(source));
  }
  const source = sourceFixture();
  source.restaurants[0].coordinate_system = 'GCJ-02';
  assert.throws(() => projectCatalog(source));
  assert.equal(catalog.units.distance, 'virtual_unit');
});

test('duplicate identities and cross-family restaurant references are rejected', () => {
  const duplicate = sourceFixture();
  duplicate.meals[1].id = duplicate.meals[0].id;
  assert.throws(() => projectCatalog(duplicate), /Duplicate meal/);
  const source = sourceFixture();
  source.meals[0].restaurant_id = 'vr-S002-0';
  assert.throws(() => projectCatalog(source), /family mismatch/);
});

test('output validation rejects semantic mutations even if payload hash is recomputed', () => {
  for (const mutate of [
    value => { value.meals[0].facts.foodCategory = { state: 'known', value: 'invented', source: 'invented', version: SOURCE_VERSION }; },
    value => { value.meals[0].facts.spicy = { state: 'unknown', value: 0, source: 'unknown', version: SOURCE_VERSION }; },
    value => { value.meals[0].familyId = 'family-S999'; },
    value => { value.restaurants[0].storeCategory.source = 'verified_food_category'; },
    value => { value.meals[0].truth = 1; },
    value => { value.sourceManifest.hidden = true; },
    value => { value.units.distance = 'm'; },
    value => { value.meals[0].priceBasis = 'current_payable_price'; },
  ]) {
    const changed = clone(catalog);
    mutate(changed);
    assert.throws(() => validateCatalog(resign(changed)));
  }
});

test('hash, count and exporter identity mismatches cannot pass integrity checks', () => {
  for (const mutate of [
    value => { value.meals[0].name += ' changed'; },
    value => { value.sourceManifest.counts.meals--; },
    value => { value.sourceManifest.exporterSha256 = '0'.repeat(64); },
    value => { value.sourceManifest.sourceSha256 = '0'.repeat(64); },
  ]) {
    const changed = clone(catalog);
    mutate(changed);
    assert.throws(() => validateCatalog(changed));
  }
  assert.throws(() => buildFromSource(__filename), /pinned R9A/);
});

function virtualFact(value) {
  return value === null ? { state: 'unknown', source: 'unknown', version: SOURCE_VERSION }
    : { state: 'known', value, source: 'synthetic', version: SOURCE_VERSION };
}

function mealFixture(id, price, vegetarian, spicy = 0, restaurantId = 'vr-S001-0') {
  return { id, restaurantId, familyId: 'family-S001', name: `${id} · 虚拟原型`,
    priceBasis: 'virtual_final_scene_price', source: 'reviewed_virtual_meal', version: SOURCE_VERSION, auditCodes: [],
    facts: { priceCents: virtualFact(price), vegetarian: virtualFact(vegetarian), spicy: virtualFact(spicy),
      mealRole: virtualFact('main'), foodCategory: virtualFact(null), ingredients: virtualFact(null), actualMealRole: virtualFact(null) } };
}

function smallCatalog(meals) {
  return { coordinateSystem: 'virtual-square-0-1000', catalogVersion: 'synthetic-fixture-v1',
    sourceManifest: { sourceVersion: SOURCE_VERSION, sourceSha256: 'fixture' }, meals,
    restaurants: [{ id: 'vr-S001-0', familyId: 'family-S001', name: '虚拟·测试店', x: 503, y: 504,
      storeCategory: virtualFact('模拟餐食'), source: 'synthetic_virtual_restaurant', version: SOURCE_VERSION }] };
}

function loadAdapter(data) {
  const module = { exports: {} };
  const source = fs.readFileSync(require.resolve('../lib/decision/catalog.js'), 'utf8');
  vm.runInNewContext(source, { module, require(name) {
    assert.equal(name, '../../data/virtual-catalog.js');
    return clone(data);
  } }, { filename: 'catalog.js' });
  return module.exports;
}

test('PACKAGE adapter exposes all 1092 meals as independent candidates across the complete map', () => {
  const adapter = loadAdapter(catalog);
  const problem = adapter.buildProblem({ target: 'PACKAGE', budgetCents: 100, maxDistanceUnits: 1 });
  assert.equal(problem.candidates.length, 1092);
  assert.deepEqual(Array.from(problem.candidates, row => row.id), catalog.meals.map(row => row.id));
  assert.equal(Object.keys(problem.displayById).length, 1092);
  assert.equal(problem.dataset.source, SOURCE_SHA256);
  assert.equal(problem.context.mode, 'VIRTUAL');
  assert.deepEqual(clone(problem.request.conditions), [
    { id: 'budget', attribute: 'priceCents', op: 'lte', value: 100 },
    { id: 'distance', attribute: 'distanceUnits', op: 'lte', value: 1 },
  ]);
});

test('adapter derives Euclidean distance in virtual units and preserves unknown rather than inferring composition', () => {
  const adapter = loadAdapter(smallCatalog([mealFixture('one', 1250, null, null)]));
  const problem = adapter.buildProblem({ origin: { x: 500, y: 500 } });
  const candidate = problem.candidates[0];
  assert.equal(candidate.facts.distanceUnits.value, 5);
  assert.equal(candidate.facts.distanceUnits.source, 'synthetic_euclidean_distance');
  assert.equal(candidate.facts.priceCents.value, 1250);
  assert.equal(candidate.facts.vegetarian.state, 'unknown');
  const display = adapter.getDisplay('one', 'PACKAGE', problem);
  assert.equal(display.foodCategory, null);
  assert.equal(display.ingredients, null);
  assert.ok(display.unknownFields.includes('spicy'));
  assert.equal(display.coordinateSystem, 'virtual-square-0-1000');
});

test('fixed scoring anchors do not shift with budget, candidate range or main-course preference', () => {
  const adapter = loadAdapter(smallCatalog([mealFixture('one', 1250, true)]));
  const first = adapter.buildProblem({ budgetCents: 1500, weights: { price: 3, distance: 2, main: 1 } });
  const second = adapter.buildProblem({ budgetCents: 10000, preferMain: false });
  assert.deepEqual(clone(first.request.explicit_preferences.terms[0].knots), [[0, 1], [5000, 0]]);
  assert.deepEqual(clone(first.request.explicit_preferences.terms[1].knots), [[0, 1], [1500, 0]]);
  assert.deepEqual(clone(second.request.explicit_preferences.terms[0].knots), [[0, 1], [5000, 0]]);
  assert.equal(first.request.explicit_preferences.terms[0].weight, 3);
  assert.equal(first.request.explicit_preferences.terms[2].attribute, 'mealRole');
  assert.ok(first.request.conditions.every(row => row.attribute !== 'mealRole'));
  assert.equal(second.request.explicit_preferences.terms.length, 2);
  assert.equal(adapter.buildProblem({ target: 'RESTAURANT', preferMain: true }).request.explicit_preferences.terms.length, 2);
});

test('restaurant hard constraints cannot splice cheap nonvegetarian and expensive vegetarian meals', () => {
  const adapter = loadAdapter(smallCatalog([
    mealFixture('cheap', 1000, false), mealFixture('vegetarian', 3000, true),
  ]));
  const problem = adapter.buildProblem({ target: 'RESTAURANT', budgetCents: 2000, vegetarianOnly: true });
  const candidate = problem.candidates[0];
  assert.equal(candidate.facts.singleMealEligible.state, 'known');
  assert.equal(candidate.facts.singleMealEligible.value, false);
  assert.equal(candidate.metadata.witnessMealId, null);
  assert.equal(candidate.metadata.unresolvedMealCount, 0);
  assert.equal(candidate.facts.priceCents.state, 'unknown');
  assert.equal(candidate.facts.vegetarian.state, 'unknown');
  assert.ok(problem.request.conditions.some(row => row.attribute === 'singleMealEligible' && row.value === true));
});

test('partially known packages cannot splice into a confirmed restaurant witness', () => {
  const adapter = loadAdapter(smallCatalog([
    mealFixture('known-price', 1000, null), mealFixture('known-vegetarian', null, true),
  ]));
  const problem = adapter.buildProblem({ target: 'RESTAURANT', budgetCents: 2000, vegetarianOnly: true });
  const candidate = problem.candidates[0];
  assert.equal(candidate.facts.singleMealEligible.state, 'unknown');
  assert.equal(candidate.metadata.unresolvedMealCount, 2);
  for (const key of ['priceCents', 'vegetarian', 'spicy', 'mealRole']) assert.equal(candidate.facts[key].state, 'unknown');
  assert.equal(problem.displayById[candidate.id].witnessMealId, null);
});

test('restaurant picks the cheapest single witness that passes all currently enabled constraints', () => {
  const adapter = loadAdapter(smallCatalog([
    mealFixture('cheap-nonvegetarian', 1000, false), mealFixture('spicy-vegetarian', 2000, true, 3),
    mealFixture('valid-b', 3000, true, 1), mealFixture('valid-a', 2500, true, 1),
  ]));
  const problem = adapter.buildProblem({ target: 'RESTAURANT', budgetCents: 3500, vegetarianOnly: true, maxSpicy: 1 });
  const candidate = problem.candidates[0];
  assert.equal(candidate.facts.singleMealEligible.value, true);
  assert.equal(candidate.facts.priceCents.value, 2500);
  assert.equal(candidate.facts.vegetarian.value, true);
  assert.equal(candidate.facts.spicy.value, 1);
  assert.equal(candidate.metadata.witnessMealId, 'valid-a');
  assert.equal(candidate.metadata.eligibleMealCount, 2);
  const display = adapter.getDisplay(candidate.id, 'RESTAURANT', problem);
  assert.equal(display.mealId, 'valid-a');
  assert.equal(display.mealName, 'valid-a · 虚拟原型');
  assert.equal(display.priceLabel, '本次条件下最低已知虚拟套餐价');
});

test('unconstrained vegetarian availability is existential and distinct from the cheapest witness attribute', () => {
  const adapter = loadAdapter(smallCatalog([mealFixture('cheap', 1000, false), mealFixture('veg', 3000, true)]));
  const problem = adapter.buildProblem({ target: 'RESTAURANT' });
  const candidate = problem.candidates[0];
  assert.equal(candidate.facts.priceCents.value, 1000);
  assert.equal(candidate.facts.vegetarian.value, true);
  const display = problem.displayById[candidate.id];
  assert.equal(display.vegetarianBasis, 'exists_known_vegetarian_eligible_virtual_meal');
  assert.equal(display.witnessVegetarian, false);
});

test('a known violation dominates missing facts; empty restaurants are explicitly infeasible', () => {
  const adapter = loadAdapter(smallCatalog([mealFixture('over-budget', 3000, null)]));
  const candidate = adapter.buildProblem({ target: 'RESTAURANT', budgetCents: 2000, vegetarianOnly: true }).candidates[0];
  assert.equal(candidate.facts.singleMealEligible.value, false);
  assert.equal(candidate.metadata.unresolvedMealCount, 0);
  const empty = loadAdapter(smallCatalog([])).buildProblem({ target: 'RESTAURANT' }).candidates[0];
  assert.equal(empty.facts.singleMealEligible.value, false);
});

test('zero-valued price, distance and spice thresholds remain enabled', () => {
  const adapter = loadAdapter(smallCatalog([mealFixture('free', 0, true, 0)]));
  const problem = adapter.buildProblem({ target: 'RESTAURANT', origin: { x: 503, y: 504 },
    budgetCents: 0, maxDistanceUnits: 0, maxSpicy: 0, vegetarianOnly: true });
  assert.equal(problem.request.conditions.length, 5);
  assert.equal(problem.candidates[0].facts.singleMealEligible.value, true);
  assert.equal(problem.candidates[0].facts.priceCents.value, 0);
});

test('display snapshots are request-specific and returned copies cannot mutate adapter state', () => {
  const adapter = loadAdapter(smallCatalog([mealFixture('cheap', 1000, false), mealFixture('veg', 3000, true)]));
  const options = { target: 'RESTAURANT', origin: { x: 500, y: 500 }, weights: { price: 2 } };
  const before = clone(options);
  const first = adapter.buildProblem(options);
  const second = adapter.buildProblem({ target: 'RESTAURANT', vegetarianOnly: true });
  assert.equal(first.displayById['vr-S001-0'].mealId, 'cheap');
  assert.equal(second.displayById['vr-S001-0'].mealId, 'veg');
  const copy = adapter.getDisplay('vr-S001-0', 'RESTAURANT', first);
  copy.name = 'modified';
  assert.notEqual(adapter.getDisplay('vr-S001-0', 'RESTAURANT', first).name, 'modified');
  first.candidates[0].facts.priceCents.value = 999;
  assert.equal(adapter.buildProblem(options).candidates[0].facts.priceCents.value, 1000);
  assert.deepEqual(options, before);
  assert.equal(adapter.getDisplay('missing', 'RESTAURANT', first), null);
  assert.equal(adapter.getDisplay('vr-S001-0', 'PACKAGE', first), null);
});

test('adapter rejects malformed options instead of silently weakening constraints', () => {
  const adapter = loadAdapter(smallCatalog([mealFixture('one', 1000, true)]));
  for (const options of [null, [], { target: 'LIVE' }, { latitude: 1 }, { origin: { x: 1 } },
    { origin: { x: -1, y: 0 } }, { origin: { x: NaN, y: 0 } },
    { budgetCents: 1.5 }, { budgetCents: true }, { budgetCents: -1 },
    { maxDistanceUnits: Infinity }, { maxSpicy: 6 }, { vegetarianOnly: 1 },
    { preferMain: 'yes' }, { weights: null }, { weights: { price: -1 } },
    { weights: { distance: NaN } }, { weights: { secretScore: 1 } }]) {
    assert.throws(() => adapter.buildProblem(options), /Invalid virtual decision options/);
  }
});
