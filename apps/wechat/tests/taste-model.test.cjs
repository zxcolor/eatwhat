const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const model = require('../lib/decision/taste-profile');
const adapter = require('../lib/decision/catalog');
const core = require('../lib/decision/core');
const actualCatalog = require('../data/virtual-catalog');
const { legacyOptions } = require('./fixtures/legacy-taste.cjs');

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

test('slider defaults do not count as answers and both explicit values are required', () => {

  assert.deepEqual(model.normalizeAnswers(), {});
  assert.deepEqual(model.missingFields({}), ['spicyLevel', 'flavorIntensity']);
  assert.deepEqual(model.missingFields({spicyLevel: 0}), ['flavorIntensity']);
  assert.deepEqual(model.missingFields({spicyLevel: 0, flavorIntensity: 50}), []);
  assert.throws(() => model.compile({spicyLevel: 0}), /完成/);
  const pending = adapter.assessProfile({});
  assert.equal(pending.ready, false); assert.equal(pending.profileComplete, false);
  assert.deepEqual(pending.missingFields, model.FIELDS);
  assert.equal(model.compile({spicyLevel: 0, flavorIntensity: 50}).taste, null);

});

test('slider normalization rejects coercion, invalid ranges and legacy fields without mutating input', () => {

  for (const invalid of [null, [], new Date(), new Map(), 'answer', {extra:true}, {likedGroups:[]},
    {budgetCents:2000}, {priority:'taste'}, {spicyLevel:null}, {spicyLevel:undefined}, {spicyLevel:-1},
    {spicyLevel:7}, {spicyLevel:0.5}, {spicyLevel:NaN}, {spicyLevel:Infinity}, {spicyLevel:'2'},
    {flavorIntensity:-1}, {flavorIntensity:101}, {flavorIntensity:0.5}, {flavorIntensity:false}, {flavorIntensity:'50'}]) {
    assert.throws(() => model.normalizeAnswers(invalid), {code:'INVALID_TASTE_PROFILE'});
  }
  const input={spicyLevel:6,flavorIntensity:100}, before=clone(input);
  const normalized=model.normalizeAnswers(input); normalized.spicyLevel=0;
  const compiled=model.compile(input); compiled.weights.price=99;
  assert.deepEqual(input,before);

});

test('explicit legacy adapter inputs retain their fixed weights and actual target terms', () => {

  const expected={balanced:[4,2,2,1],taste:[6,1,1,1],price:[2,6,1,1],distance:[2,1,6,1]};
  for(const [priority,[taste,price,distance,main]] of Object.entries(expected)) {
    const options=legacyOptions(answers({priority,budgetCents:3000,maxSpicy:1}));
    for(const target of ['PACKAGE','RESTAURANT']) {
      const problem=loadCatalog(twinData).buildProblem({...options,target}); core.validate(problem);
      assert.deepEqual(Object.fromEntries(problem.request.explicit_preferences.terms.map(term=>[term.id,term.weight])),
        {price,distance,...(target==='PACKAGE'?{main}:{}),store_type_preference:taste});
    }
  }

});

test('different stated favorite types change equal-price and equal-distance choices in both targets', () => {
  const local = loadCatalog(twinData);
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    for (const [liked, expected] of [['hotpot', 'a'], ['noodles', 'b']]) {
      const problem = local.buildProblem({ ...legacyOptions(answers({ likedGroups: [liked] })), target });
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
  const problem = local.buildProblem(legacyOptions(answers()));
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
    const problem = local.buildProblem({ ...legacyOptions(answers({ likedGroups: [], avoidedGroups: ['hotpot'], priority: 'price' })), target });
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
  const problem = local.buildProblem({ ...legacyOptions(answers({ maxSpicy: 1, budgetCents: 3000 })), target: 'RESTAURANT' });
  const result = core.decide(clone(problem), core.createSession(0));
  assert.equal(result.selectedId, 'r-cheap');
  assert.deepEqual(result.unknown, ['r-unknown']);
  const selected = local.getDisplay(result.selectedId, 'RESTAURANT', problem);
  assert.equal(selected.witnessMealId, 'mild');
  assert.equal(selected.priceCents, 2000);
  assert.equal(selected.spicy, 1);
});

test('normal taste models are canonicalized and malformed models cannot weaken exclusions', () => {
  const taste = legacyOptions(answers({ likedGroups: ['noodles', 'hotpot'] })).taste;
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

test('complete sliders permit confirmation without claiming personalized price or distance weights', () => {

  const result=loadCatalog(twinData).assessProfile({spicyLevel:2,flavorIntensity:50});
  assert.equal(result.ready,true); assert.equal(result.profileComplete,true); assert.equal(result.personalizedReady,false);
  const compiled=model.compile({spicyLevel:2,flavorIntensity:50});
  assert.deepEqual(compiled.weights,{price:1,distance:1,main:1}); assert.equal(compiled.taste,null);
  assert.equal(compiled.budgetCents,null); assert.equal(compiled.maxSpicy,null);

});

test('flat catalog scores cannot prevent confirmation of the two explicitly dragged sliders', () => {

  const data=clone(twinData);data.meals[1].facts.mealRole=fact('snack');
  const result=loadCatalog(data).assessProfile({spicyLevel:0,flavorIntensity:0});
  assert.equal(result.ready,true);assert.equal(result.personalizedReady,false);assert.deepEqual(Array.from(result.missingFields),[]);

});

test('only the non-spicy endpoint maps to the legacy hard spice scale', () => {

  for(let spicyLevel=0;spicyLevel<=6;spicyLevel++) {
    const compiled=model.compile({spicyLevel,flavorIntensity:50});
    assert.equal(compiled.maxSpicy,spicyLevel===0?0:null);
    assert.equal(compiled.budgetCents,null); assert.equal(compiled.taste,null);
  }

});

test('the retained legacy category adapter still enforces exclusions independently of slider readiness', () => {

  const local=loadCatalog(twinData);
  const problem=local.buildProblem(legacyOptions(answers({likedGroups:[],avoidedGroups:['hotpot']})));
  const result=core.decide(clone(problem),core.createSession(0));
  assert.equal(result.selectedId,'b'); assert.deepEqual(result.rejected,['a']);
  assert.equal(local.assessProfile({spicyLevel:2,flavorIntensity:50}).personalizedReady,false);

});

test('legacy category, budget and priority answers cannot impersonate the slider profile', () => {

  for(const legacy of [answers(),answers({likedGroups:['grill']}),{spicyLevel:2,flavorIntensity:50,budgetCents:1000}])
    assert.throws(()=>adapter.assessProfile(legacy),{code:'INVALID_TASTE_PROFILE'});

});

test('flavor intensity is retained as a declaration without fabricated menu attributes', () => {

  const low=model.compile({spicyLevel:2,flavorIntensity:0});
  const high=model.compile({spicyLevel:2,flavorIntensity:100});
  assert.deepEqual(low,high);
  const local=loadCatalog(twinData); const problem=local.buildProblem(low);
  assert.ok(problem.candidates.every(row=>!Object.hasOwn(row.facts,'flavorIntensity')));
  assert.equal(local.assessProfile({spicyLevel:2,flavorIntensity:100}).personalizedReady,false);

});

test('complete declarations and unknown food information remain distinct states', () => {

  const local=loadCatalog(fixture([{id:'only',category:'川渝火锅',price:null,spicy:null}]));
  assert.equal(local.assessProfile({spicyLevel:0}).ready,false);
  const declaration=local.assessProfile({spicyLevel:0,flavorIntensity:50});
  assert.equal(declaration.ready,true); assert.equal(declaration.personalizedReady,false);
  const problem=local.buildProblem(model.compile({spicyLevel:0,flavorIntensity:50}));
  const selected=core.decide(clone(problem),core.createSession(0));
  assert.equal(selected.selectedId,null); assert.ok(selected.unknown.includes('only'));

});

test('real virtual catalog classification still matches independent non-spicy facts after slider confirmation', () => {

  const input={spicyLevel:0,flavorIntensity:37};
  assert.equal(adapter.assessProfile(input).ready,true);
  const expected={feasible:[],unknown:[],rejected:[]};
  for(const meal of actualCatalog.meals){const kind=meal.facts.spicy.state==='unknown'?'unknown':meal.facts.spicy.value>0?'rejected':'feasible';expected[kind].push(meal.id);}
  const problem=adapter.buildProblem(model.compile(input));
  const result=core.decide(clone(problem),core.createSession(0));
  for(const key of Object.keys(expected))assert.deepEqual([...result[key]].sort(),expected[key].sort());
  assert.equal(problem.candidates.length,1092);
  assert.deepEqual(actualCatalog.sourceManifest.counts.unknown,{priceCents:0,spicy:380,vegetarian:485,mealRole:8,foodCategory:1092,ingredients:1092,actualMealRole:1092});

});
