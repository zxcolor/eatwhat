const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const model = require('../lib/decision/taste-profile');
const adapter = require('../lib/decision/catalog');
const core = require('../lib/decision/core');
const actualCatalog = require('../data/virtual-catalog');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function answers(patch = {}) {
  return { likedGroups: ['hotpot'], avoidedGroups: [], budgetCents: null, maxSpicy: null, priority: 'balanced', ...patch };
}
function fact(value) {
  return value === null ? { state: 'unknown', source: 'test_unknown', version: 'test-v1' }
    : { state: 'known', value, source: 'test_virtual_fact', version: 'test-v1' };
}
function fixture(rows) {
  return { coordinateSystem: 'virtual-square-0-1000', catalogVersion: 'test-v1',
    sourceManifest: { sourceVersion: 'test-v1', sourceSha256: 'test-only' },
    restaurants: rows.map(row => ({ id: `r-${row.id}`, name: `虚拟·${row.id}`, familyId: `f-${row.id}`,
      x: row.x === undefined ? 500 : row.x, y: 500, storeCategory: fact(row.category) })),
    meals: rows.map(row => ({ id: row.id, name: `${row.id} · 虚拟原型`, restaurantId: `r-${row.id}`,
      familyId: `f-${row.id}`, source: 'reviewed_virtual_meal', version: 'test-v1', auditCodes: [],
      facts: { priceCents: fact(row.price === undefined ? 1000 : row.price),
        spicy: fact(row.spicy === undefined ? 0 : row.spicy), vegetarian: fact(true), mealRole: fact('main'),
        foodCategory: fact(null), ingredients: fact(null), actualMealRole: fact(null) } })),
  };
}
function loadCatalog(data) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/decision/catalog'), 'utf8'), {
    module,
    require(name) {
      if (name === '../../data/virtual-catalog.js') return clone(data);
      if (name === './taste-profile') return model;
      if (name === './core') return core;
      throw new Error(`Unexpected adapter dependency: ${name}`);
    },
  }, { filename: 'catalog.js' });
  return module.exports;
}
const twinData = fixture([{ id: 'a', category: '川渝火锅' }, { id: 'b', category: '米粉面馆' }]);

test('explicit taxonomy covers each actual store label once, with no invented food facts', () => {
  const actual = [...new Set(actualCatalog.restaurants.map(row => row.storeCategory.value))].sort();
  const mapped = model.GROUPS.flatMap(group => group.categories).sort();
  assert.equal(actual.length, 62);
  assert.equal(model.GROUPS.length, 12);
  assert.equal(new Set(mapped).size, mapped.length);
  assert.deepEqual(mapped, actual);
  for (const group of model.GROUPS) {
    assert.ok(Object.isFrozen(group) && Object.isFrozen(group.categories));
    assert.ok(group.id && group.label && group.description);
  }
  assert.ok(Object.isFrozen(model.GROUPS) && Object.isFrozen(model.FIELDS));
  for (const meal of actualCatalog.meals) {
    for (const key of ['foodCategory', 'ingredients', 'actualMealRole']) assert.equal(meal.facts[key].state, 'unknown');
  }
});

test('unanswered differs from explicit neutral arrays and unlimited choices', () => {
  assert.deepEqual(model.normalizeAnswers(), {});
  assert.deepEqual(model.missingFields({}), model.FIELDS);
  const neutral = answers({ likedGroups: [], avoidedGroups: [] });
  assert.deepEqual(model.missingFields(neutral), []);
  assert.equal(model.compile(neutral).taste.weight, 0);
  assert.throws(() => model.compile({ ...neutral, maxSpicy: undefined }), /辣度/);
  assert.throws(() => model.compile({ priority: 'balanced' }), /完成/);
  assert.deepEqual(clone(adapter.assessProfile({})), {
    profileComplete: false, personalizedReady: false, ready: false, status: 'incomplete',
    missingFields: model.FIELDS, signals: [], counts: {}, message: '完成偏好选择后，再为你决定。',
  });
});

test('normalization rejects malformed or contradictory declarations without modifying inputs', () => {
  for (const invalid of [null, [], new Date(), new Map(), 'answer', { extra: true }, { likedGroups: null }, { likedGroups: Array(1) }, { avoidedGroups: 'hotpot' },
    { likedGroups: ['hotpot', 'hotpot'] }, { likedGroups: ['unknown'] }, { budgetCents: 0 }, { budgetCents: '2000' },
    { maxSpicy: 2 }, { maxSpicy: NaN }, { priority: 'random' },
    { likedGroups: ['hotpot'], avoidedGroups: ['hotpot'] },
    { avoidedGroups: model.GROUPS.map(group => group.id) }, { likedGroups: [], priority: 'taste' }]) {
    assert.throws(() => model.normalizeAnswers(invalid), error => error.code === 'INVALID_TASTE_PROFILE');
  }
  const input = answers({ likedGroups: ['noodles', 'hotpot'], avoidedGroups: ['drinks'] });
  const before = clone(input);
  const normalized = model.normalizeAnswers(input);
  assert.deepEqual(normalized.likedGroups, ['hotpot', 'noodles']);
  normalized.likedGroups.push('dessert');
  assert.deepEqual(input, before);
  const compiled = model.compile(input);
  compiled.taste.likedGroups.push('dessert');
  assert.deepEqual(input, before);
});

test('compiled priorities use declared fixed weights and actual target terms', () => {
  const expected = { balanced: [4, 2, 2, 1], taste: [6, 1, 1, 1], price: [2, 6, 1, 1], distance: [2, 1, 6, 1] };
  for (const [priority, [taste, price, distance, main]] of Object.entries(expected)) {
    const options = model.compile(answers({ priority, budgetCents: 3000, maxSpicy: 1 }));
    assert.deepEqual(options, { budgetCents: 3000, maxSpicy: 1, weights: { price, distance, main },
      taste: { version: 1, likedGroups: ['hotpot'], avoidedGroups: [], weight: taste } });
    for (const target of ['PACKAGE', 'RESTAURANT']) {
      const problem = loadCatalog(twinData).buildProblem({ ...options, target });
      core.validate(problem);
      const weights = Object.fromEntries(problem.request.explicit_preferences.terms.map(term => [term.id, term.weight]));
      assert.deepEqual(weights, { price, distance, ...(target === 'PACKAGE' ? { main } : {}), store_type_preference: taste });
    }
  }
});

test('different stated favorite types change equal-price and equal-distance choices in both targets', () => {
  const local = loadCatalog(twinData);
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    for (const [liked, expected] of [['hotpot', 'a'], ['noodles', 'b']]) {
      const problem = local.buildProblem({ ...model.compile(answers({ likedGroups: [liked] })), target });
      const result = core.decide(clone(problem), core.createSession(1));
      const prefix = target === 'RESTAURANT' ? 'r-' : '';
      assert.equal(result.selectedId, prefix + expected);
      const winner = core.utility(problem.candidates.find(row => row.id === prefix + expected), problem.request.explicit_preferences);
      const other = core.utility(problem.candidates.find(row => row.id !== prefix + expected), problem.request.explicit_preferences);
      assert.equal(winner.value.cmp(other.value), 1);
    }
  }
});

test('taste uses a fixed denominator and explicit neutral fallback while unknown stays unknown', () => {
  const local = loadCatalog(fixture([{ id: 'liked', category: '川渝火锅' }, { id: 'neutral', category: '米粉面馆' },
    { id: 'unknown', category: null }, { id: 'unmapped', category: '名称像火锅但未映射的店铺' }]));
  const problem = local.buildProblem(model.compile(answers()));
  for (const row of problem.candidates) {
    const score = core.utility(row, problem.request.explicit_preferences);
    assert.deepEqual(score.weightSum.toPair(), ['9', '1']);
    assert.deepEqual(score.value.toPair(), row.id === 'liked' ? ['43', '45'] : ['11', '15']);
    if (['unknown', 'unmapped'].includes(row.id)) {
      assert.equal(row.facts.storeTypeGroup.state, 'unknown');
      assert.equal(row.facts.storeTypeAffinity.state, 'unknown');
      assert.equal(Object.hasOwn(row.facts.storeTypeAffinity, 'value'), false);
      assert.equal(score.terms.find(term => term.id === 'store_type_preference').state, 'unknown');
    }
  }
});

test('excluded store types are hard constraints that price advantage cannot offset', () => {
  const local = loadCatalog(fixture([{ id: 'cheap', category: '川渝火锅', price: 1 },
    { id: 'allowed', category: '米粉面馆', price: 10000 }, { id: 'unknown', category: null, price: 0 }]));
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    const problem = local.buildProblem({ ...model.compile(answers({ likedGroups: [], avoidedGroups: ['hotpot'], priority: 'price' })), target });
    const result = core.decide(clone(problem), core.createSession(0));
    const prefix = target === 'RESTAURANT' ? 'r-' : '';
    assert.equal(result.selectedId, `${prefix}allowed`);
    assert.deepEqual(result.rejected, [`${prefix}cheap`]);
    assert.deepEqual(result.unknown, [`${prefix}unknown`]);
  }
});

test('spicy limit remains a hard condition with unknown unresolved, and restaurant witness stays the same meal', () => {
  const data = fixture([{ id: 'cheap', category: '川渝火锅', price: 100, spicy: 3 },
    { id: 'mild', category: '川渝火锅', price: 2000, spicy: 1 },
    { id: 'unknown', category: '米粉面馆', spicy: null }]);
  data.meals[1].restaurantId = data.meals[0].restaurantId;
  data.meals[1].familyId = data.meals[0].familyId;
  data.restaurants.splice(1, 1);
  const local = loadCatalog(data);
  const problem = local.buildProblem({ ...model.compile(answers({ maxSpicy: 1, budgetCents: 3000 })), target: 'RESTAURANT' });
  const result = core.decide(clone(problem), core.createSession(0));
  assert.equal(result.selectedId, 'r-cheap');
  assert.deepEqual(result.unknown, ['r-unknown']);
  const selected = local.getDisplay(result.selectedId, 'RESTAURANT', problem);
  assert.equal(selected.witnessMealId, 'mild');
  assert.equal(selected.priceCents, 2000);
  assert.equal(selected.spicy, 1);
});

test('normal taste models are canonicalized and malformed models cannot weaken exclusions', () => {
  const taste = model.compile(answers({ likedGroups: ['noodles', 'hotpot'] })).taste;
  assert.deepEqual(model.normalizeTaste(taste).likedGroups, ['hotpot', 'noodles']);
  assert.equal(model.normalizeTaste(null), null);
  for (const invalid of [undefined, {}, [], { ...taste, version: 2 }, { ...taste, extra: true },
    { ...taste, weight: -1 }, { ...taste, weight: NaN }, { ...taste, weight: Infinity }, { ...taste, weight: '4' },
    { ...taste, weight: 0 }, { ...taste, likedGroups: [] }, { ...taste, avoidedGroups: ['hotpot'] },
    { ...taste, avoidedGroups: ['missing'] }]) {
    assert.throws(() => model.normalizeTaste(invalid), error => error.code === 'INVALID_TASTE_PROFILE');
    assert.throws(() => adapter.buildProblem({ taste: invalid }));
  }
});

test('no-profile problem preserves original fields, terms and behavior', () => {
  const local = loadCatalog(twinData);
  const oldDefault = local.buildProblem({});
  assert.deepEqual(clone(oldDefault), clone(local.buildProblem({ taste: null })));
  assert.deepEqual(Object.keys(oldDefault.candidates[0].facts), ['priceCents', 'distanceUnits', 'vegetarian', 'spicy', 'mealRole']);
  assert.deepEqual(Array.from(oldDefault.request.explicit_preferences.terms, term => term.id), ['price', 'distance', 'main']);
  assert.equal(core.decide(clone(oldDefault), core.createSession(0)).selectedId, 'a');
});

test('complete neutral preferences can be ready through explicitly selected price and distance weights', () => {
  const result = loadCatalog(fixture([{ id: 'a', category: '川渝火锅' },
    { id: 'b', category: '米粉面馆', price: 2000, x: 600 }])).assessProfile(answers({ likedGroups: [] }));
  assert.equal(result.profileComplete, true);
  assert.equal(result.ready, true);
  assert.equal(result.personalizedReady, true);
  assert.equal(result.status, 'ready');
  assert.match(result.message, /价格与距离/);
  assert.deepEqual(clone(result.signals), [{ id: 'price', label: '价格偏好能区分当前选择' },
    { id: 'distance', label: '距离偏好能区分当前选择' }]);
  assert.deepEqual(clone(result.counts), { PACKAGE: { total: 2, feasible: 2, unknown: 0, rejected: 0 },
    RESTAURANT: { total: 2, feasible: 2, unknown: 0, rejected: 0 } });
});

test('complete answers with no effective distinction stay gated, including generic main-role differences', () => {
  const data = clone(twinData);
  data.meals[1].facts.mealRole = fact('snack');
  const result = loadCatalog(data).assessProfile(answers({ likedGroups: [] }));
  assert.equal(result.profileComplete, true);
  assert.equal(result.personalizedReady, false);
  assert.equal(result.ready, false);
  assert.equal(result.status, 'needs_preference');
  assert.deepEqual(Array.from(result.missingFields), []);
  assert.match(result.message, /还不能区分/);
  assert.deepEqual(clone(result.signals), []);
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    assert.equal(result.counts[target].feasible, 2);
    assert.deepEqual(clone(result.targetReadiness[target]), {
      scoreDiscriminates: false, constrainedSingleton: false, supportedSignals: [],
    });
  }
});

test('one feasible result qualifies only when explicit known hard conditions rejected other candidates', () => {
  const local = loadCatalog(fixture([{ id: 'cheap', category: '川渝火锅', price: 1000 },
    { id: 'costly', category: '米粉面馆', price: 3000 }]));
  const result = local.assessProfile(answers({ likedGroups: [], budgetCents: 2000 }));
  assert.equal(result.ready, true);
  assert.match(result.message, /唯一可行选择/);
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    assert.equal(result.counts[target].feasible, 1);
    assert.equal(result.counts[target].rejected, 1);
    assert.deepEqual(clone(result.targetReadiness[target]), {
      scoreDiscriminates: false, constrainedSingleton: true, supportedSignals: ['budgetCents'],
    });
  }
  const solitary = loadCatalog(fixture([{ id: 'only', category: '川渝火锅' }])).assessProfile(answers({ likedGroups: [] }));
  assert.equal(solitary.ready, false);
  assert.equal(solitary.status, 'needs_preference');
});

test('hard type exclusions can produce a supported singleton without inventing ranking variation', () => {
  const result = loadCatalog(twinData).assessProfile(answers({ likedGroups: [], avoidedGroups: ['hotpot'] }));
  assert.equal(result.ready, true);
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    assert.equal(result.targetReadiness[target].scoreDiscriminates, false);
    assert.equal(result.targetReadiness[target].constrainedSingleton, true);
    assert.deepEqual(Array.from(result.targetReadiness[target].supportedSignals), ['avoidedGroups']);
  }
});

test('unavailable favorite types are not reported as supported taste personalization', () => {
  const result = loadCatalog(fixture([{ id: 'a', category: '川渝火锅' },
    { id: 'b', category: '米粉面馆', price: 2000 }])).assessProfile(answers({ likedGroups: ['grill'] }));
  assert.equal(result.ready, true);
  assert.deepEqual(clone(result.signals), [{ id: 'price', label: '价格偏好能区分当前选择' }]);
  assert.match(result.message, /价格/);
  assert.doesNotMatch(result.message, /喜欢/);
  for (const value of Object.values(result.targetReadiness)) assert.equal(value.supportedSignals.includes('likedGroups'), false);
});

test('readiness compares exact combined utilities, including cancellation and flat price anchors', () => {
  const cancelled = loadCatalog(fixture([{ id: 'a', category: '川渝火锅', price: 1000, x: 800 },
    { id: 'b', category: '米粉面馆', price: 2000, x: 500 }])).assessProfile(answers({ likedGroups: [] }));
  assert.equal(cancelled.ready, false);
  assert.equal(cancelled.status, 'needs_preference');
  for (const value of Object.values(cancelled.targetReadiness)) {
    assert.equal(value.scoreDiscriminates, false);
    assert.deepEqual(Array.from(value.supportedSignals), ['price', 'distance']);
  }
  const saturated = loadCatalog(fixture([{ id: 'a', category: '川渝火锅', price: 6000 },
    { id: 'b', category: '米粉面馆', price: 7000 }])).assessProfile(answers({ likedGroups: [] }));
  assert.equal(saturated.ready, false);
  assert.deepEqual(clone(saturated.signals), []);
  const tiny = loadCatalog(fixture([{ id: 'a', category: '川渝火锅', x: 500 },
    { id: 'b', category: '米粉面馆', x: 500 + 2 ** -40 }])).assessProfile(answers({ likedGroups: [] }));
  assert.equal(tiny.ready, true);
  for (const value of Object.values(tiny.targetReadiness)) assert.equal(value.scoreDiscriminates, true);
});

test('assessment distinguishes unanswered, complete but infeasible, and complete but unknown data', () => {
  const complete = answers({ budgetCents: 2000 });
  for (const [price, status, field] of [[3000, 'no_feasible_candidates', 'rejected'], [null, 'needs_information', 'unknown']]) {
    const result = loadCatalog(fixture([{ id: 'only', category: '川渝火锅', price }])).assessProfile(complete);
    assert.equal(result.profileComplete, true);
    assert.equal(result.personalizedReady, false);
    assert.equal(result.ready, false);
    assert.equal(result.status, status);
    assert.deepEqual(Array.from(result.missingFields), []);
    assert.equal(result.counts.PACKAGE[field], 1);
    assert.equal(result.counts.RESTAURANT[field], 1);
    assert.match(result.message, /偏好已齐全/);
  }
});

test('full real virtual catalog readiness counts match independent raw-fact classification', () => {
  const input = answers({ likedGroups: ['noodles'], avoidedGroups: ['hotpot'], budgetCents: 3000, maxSpicy: 1, priority: 'price' });
  const result = adapter.assessProfile(input);
  const restaurants = new Map(actualCatalog.restaurants.map(row => [row.id, row]));
  const avoidedLabels = new Set(model.GROUPS.find(group => group.id === 'hotpot').categories);
  const expected = { total: 1092, feasible: 0, unknown: 0, rejected: 0 };
  const feasibleRestaurants = new Set();
  for (const meal of actualCatalog.meals) {
    const category = restaurants.get(meal.restaurantId).storeCategory.value;
    const rejected = avoidedLabels.has(category) || meal.facts.priceCents.value > 3000
      || (meal.facts.spicy.state === 'known' && meal.facts.spicy.value > 1);
    const kind = rejected ? 'rejected' : meal.facts.spicy.state === 'unknown' ? 'unknown' : 'feasible';
    expected[kind]++;
    if (kind === 'feasible') feasibleRestaurants.add(meal.restaurantId);
  }
  assert.deepEqual(result.counts.PACKAGE, expected);
  assert.equal(result.counts.RESTAURANT.total, 363);
  assert.equal(result.counts.RESTAURANT.feasible, feasibleRestaurants.size);
  assert.equal(result.ready, true);
  assert.ok(expected.feasible > 0 && expected.unknown > 0 && expected.rejected > 0);
  const problem = adapter.buildProblem(model.compile(input));
  assert.equal(problem.candidates.length, 1092);
  assert.ok(problem.candidates.every(row => row.facts.storeTypeGroup.state === 'known'));
  assert.deepEqual(actualCatalog.sourceManifest.counts.unknown, { priceCents: 0, spicy: 380,
    vegetarian: 485, mealRole: 8, foodCategory: 1092, ingredients: 1092, actualMealRole: 1092 });
});
