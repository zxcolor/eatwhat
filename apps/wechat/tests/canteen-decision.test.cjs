const test = require('node:test');
const assert = require('node:assert/strict');
const decision = require('../lib/canteen-decision');
const menu = require('../data/canteen-menu.json');
const policy = require('../data/canteen-policy.json');

function choose(itemId, filters = {}) {
  const candidates = decision.getCandidates(filters).candidates;
  const index = candidates.findIndex(candidate => candidate.item.id === itemId);
  assert.ok(index >= 0, `The requested real item ${itemId} must match the filters`);
  const round = decision.createRound({ random: () => (index + 0.5) / candidates.length });
  round.configure(filters);
  round.next();
  return round;
}

test('default pool contains exactly 124 real food records, with correct stall bindings', () => {
  const { candidates, weightedExcludedCount } = decision.getCandidates();
  assert.equal(candidates.length, 124);
  assert.equal(new Set(candidates.map(candidate => candidate.item.id)).size, 124);
  assert.equal(weightedExcludedCount, 0);
  const excluded = policy.items.filter(rule => !rule.defaultCandidate);
  assert.equal(excluded.filter(rule => rule.reason === 'addon').length, 17);
  assert.equal(excluded.filter(rule => rule.reason === 'drink').length, 2);
  for (const candidate of candidates) {
    assert.equal(candidate.stall.id, candidate.item.stallId);
    assert.deepEqual(candidate.item, menu.items.find(item => item.id === candidate.item.id));
    assert.ok(!excluded.some(rule => rule.itemId === candidate.item.id));
    if (candidate.item.price.kind !== 'variants') assert.deepEqual(candidate.variants, []);
  }
  for (const name of ['小米粥', '紫米粥', '煮鸡蛋', '卤蛋', '香干']) {
    assert.ok(candidates.some(candidate => candidate.item.name === name), `${name} remains eligible as a listed food`);
  }
});

test('category options preserve original names, omit excluded-only categories and match exactly', () => {
  const categories = decision.getCategories();
  assert.equal(new Set(categories).size, categories.length);
  assert.ok(categories.includes('千里香海味馄饨'));
  assert.ok(!categories.includes('豆浆'));
  for (const category of categories) {
    const candidates = decision.getCandidates({ category }).candidates;
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every(candidate => candidate.item.category === category));
  }
  for (const category of ['', '不存在的分类', '小吃 ', '加料（合并“煎饼单加”与“加料专区”的重复项）', '米线浇头（卤蛋见上表）']) {
    assert.deepEqual(decision.getCandidates({ category }).candidates, []);
  }
});

test('weight-priced foods are eligible without a budget and excluded by every strict budget', () => {
  const weighted = decision.getCandidates().candidates.filter(candidate => candidate.item.price.kind === 'weight');
  assert.deepEqual(weighted.map(candidate => candidate.item.name), ['麻辣香锅', '麻辣烫', '麻辣拌']);
  for (const budgetMaxFen of [0, 1400, 100000]) {
    const filtered = decision.getCandidates({ budgetMaxFen });
    assert.equal(filtered.weightedExcludedCount, 3);
    assert.ok(filtered.candidates.every(candidate => candidate.item.price.kind !== 'weight'));
  }
  assert.equal(decision.getCandidates({ budgetMaxFen: 100000 }).candidates.length, 121);
  assert.equal(decision.getCandidates({ budgetMaxFen: 1400, category: '主食' }).weightedExcludedCount, 0);
  const onlyWeight = decision.getCandidates({ budgetMaxFen: 1400, category: '餐品与称重价格' });
  assert.equal(onlyWeight.weightedExcludedCount, 3);
  assert.deepEqual(onlyWeight.candidates, []);
});

test('fixed prices meet the exact integer-fen upper bound', () => {
  for (const { item } of decision.getCandidates().candidates.filter(candidate => candidate.item.price.kind === 'fixed')) {
    assert.ok(decision.getCandidates({ budgetMaxFen: item.price.amountFen }).candidates.some(candidate => candidate.item.id === item.id));
    assert.ok(!decision.getCandidates({ budgetMaxFen: item.price.amountFen - 1 }).candidates.some(candidate => candidate.item.id === item.id));
  }
});

test('all five variants retain one dish slot and expose only budget-eligible real specifications', () => {
  const expected = {
    福建扁食: [800, 1300], 紫菜虾米馄饨: [800, 1300], 虾三鲜馄饨: [1000, 1400],
    荠菜馄饨: [900, 1300], 虾仁馄饨: [1100, 1500],
  };
  const variants = decision.getCandidates().candidates.filter(candidate => candidate.item.price.kind === 'variants');
  assert.equal(variants.length, 5);
  for (const candidate of variants) {
    const [small, large] = expected[candidate.item.name];
    assert.deepEqual(candidate.variants.map(variant => variant.amountFen), [small, large]);
    assert.deepEqual(candidate.variants.map(variant => variant.name), ['小份', '大份']);
    for (const [budgetMaxFen, prices] of [[small - 1, []], [small, [small]], [large - 1, [small]], [large, [small, large]]]) {
      const matches = decision.getCandidates({ budgetMaxFen }).candidates.filter(entry => entry.item.id === candidate.item.id);
      assert.equal(matches.length, prices.length === 0 ? 0 : 1);
      if (matches.length) assert.deepEqual(matches[0].variants.map(variant => variant.amountFen), prices);
    }
  }
});

test('invalid budgets and category types are rejected rather than silently widening filters', () => {
  for (const budgetMaxFen of [-1, 0.5, '1000', '', NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, false]) {
    assert.throws(() => decision.getCandidates({ budgetMaxFen }), { code: 'CANTEEN_INVALID_FILTER' });
  }
  for (const filters of [null, false, [], '预算', { category: 1 }, { category: {} }, { category: [] }]) {
    assert.throws(() => decision.getCandidates(filters), { code: 'CANTEEN_INVALID_FILTER' });
  }
  assert.deepEqual(decision.getCandidates({ budgetMaxFen: 0 }).candidates, []);
});

test('new round is idle and unrestricted, with no automatic initial selection', () => {
  const state = decision.createRound().snapshot();
  assert.deepEqual(state.filters, { budgetMaxFen: null, category: null });
  assert.equal(state.totalCount, 124);
  assert.equal(state.remainingCount, 124);
  assert.equal(state.seenCount, 0);
  assert.equal(state.status, 'idle');
  assert.equal(state.current, null);
  assert.equal(state.selectedVariantId, null);
});

test('each real dish has one equal-width random bucket irrespective of stall and variant count', () => {
  const candidates = decision.getCandidates().candidates;
  candidates.forEach((candidate, index) => {
    const round = decision.createRound({ random: () => (index + 0.5) / candidates.length });
    assert.equal(round.next().current.item.id, candidate.item.id);
  });
  const category = '千里香海味馄饨';
  const fourDishes = decision.getCandidates({ category }).candidates;
  assert.equal(fourDishes.length, 4);
  for (const [randomValue, index] of [[0, 0], [0.25 - Number.EPSILON, 0], [0.25, 1], [0.5, 2], [0.75, 3], [1 - Number.EPSILON, 3]]) {
    const round = decision.createRound({ random: () => randomValue });
    round.configure({ category });
    assert.equal(round.next().current.item.id, fourDishes[index].item.id);
  }
});

test('invalid random providers fail atomically and never select outside the candidate pool', () => {
  assert.throws(() => decision.createRound({ random: 1 }), { code: 'CANTEEN_INVALID_RANDOM' });
  for (const value of [-1, 1, 1.1, Infinity, NaN, '0', null]) {
    const round = decision.createRound({ random: () => value });
    const before = round.snapshot();
    assert.throws(() => round.next(), { code: 'CANTEEN_INVALID_RANDOM' });
    assert.deepEqual(round.snapshot(), before);
  }
});

test('a round visits all 124 dish IDs once, then requires explicit restart', () => {
  let randomCalls = 0;
  const round = decision.createRound({ random: () => { randomCalls += 1; return 0; } });
  const seen = new Set();
  let last;
  for (let i = 0; i < 124; i += 1) {
    last = round.next();
    assert.ok(!seen.has(last.current.item.id));
    seen.add(last.current.item.id);
    assert.equal(last.seenCount, i + 1);
    assert.equal(last.remainingCount, 123 - i);
  }
  const exhausted = round.next();
  assert.equal(exhausted.status, 'exhausted');
  assert.deepEqual(exhausted.current, last.current);
  assert.deepEqual(round.next(), exhausted);
  assert.equal(randomCalls, 124);
  const restarted = round.restart();
  assert.equal(restarted.status, 'idle');
  assert.equal(restarted.current, null);
  assert.equal(restarted.seenCount, 0);
  assert.equal(restarted.remainingCount, 124);
  assert.equal(round.next().current.item.id, [...seen][0]);
});

test('change dish can select another food at the same stall', () => {
  const round = decision.createRound({ random: () => 0 });
  round.configure({ category: '主食' });
  const first = round.next().current;
  const second = round.next().current;
  assert.equal(first.stall.name, '民族风味');
  assert.equal(second.stall.id, first.stall.id);
  assert.notEqual(second.item.id, first.item.id);
});

test('changing a variant does not consume another dish, and next always changes the dish ID', () => {
  const round = decision.createRound({ random: () => 0 });
  round.configure({ category: '千里香海味馄饨' });
  const first = round.next();
  assert.equal(first.selectedVariantId, null);
  const small = round.selectVariant('small');
  const large = round.selectVariant('large');
  assert.equal(small.current.item.id, large.current.item.id);
  assert.equal(large.seenCount, 1);
  assert.equal(large.remainingCount, 3);
  const second = round.next();
  assert.notEqual(second.current.item.id, first.current.item.id);
  assert.equal(second.selectedVariantId, null);
  assert.equal(second.seenCount, 2);
});

test('a single candidate displays normally, is still confirmable after exhaustion, and does not loop', () => {
  const round = decision.createRound({ random: () => 0 });
  round.configure({ category: '福建小吃', budgetMaxFen: 100 });
  const selected = round.next();
  assert.equal(selected.status, 'ready');
  assert.equal(selected.totalCount, 1);
  assert.equal(selected.current.item.name, '香干');
  assert.equal(selected.remainingCount, 0);
  assert.equal(round.next().status, 'exhausted');
  assert.equal(round.confirmation().amountFen, 100);
  assert.equal(round.snapshot().seenCount, 1);
});

test('zero matches and unknown categories remain empty without automatic fallback', () => {
  const round = decision.createRound({ random: () => assert.fail('Empty rounds must not draw') });
  for (const filters of [{ budgetMaxFen: 0 }, { category: '不存在的分类' }, { category: '餐品与称重价格', budgetMaxFen: 1400 }]) {
    assert.equal(round.configure(filters).status, 'empty');
    const next = round.next();
    assert.equal(next.status, 'empty');
    assert.equal(next.totalCount, 0);
    assert.equal(next.current, null);
    assert.throws(() => round.confirmation(), { code: 'CANTEEN_NO_SELECTION' });
    assert.equal(round.restart().status, 'empty');
  }
});

test('new conditions immediately clear old results and variant choices, including back-to-back actions', () => {
  const round = decision.createRound({ random: () => 0 });
  round.configure({ category: '千里香海味馄饨' });
  round.next();
  round.selectVariant('large');
  const state = round.configure({ budgetMaxFen: 100 });
  assert.equal(state.current, null);
  assert.equal(state.selectedVariantId, null);
  assert.equal(state.seenCount, 0);
  assert.throws(() => round.confirmation(), { code: 'CANTEEN_NO_SELECTION' });
  assert.throws(() => round.selectVariant('large'), { code: 'CANTEEN_INVALID_VARIANT' });
  const ids = new Set();
  for (let i = 0; i < state.totalCount; i += 1) {
    const next = round.next();
    assert.ok(next.current.item.price.amountFen <= 100);
    assert.ok(!ids.has(next.current.item.id));
    ids.add(next.current.item.id);
  }
  assert.equal(round.next().status, 'exhausted');
  const unrestricted = round.configure({});
  assert.equal(unrestricted.totalCount, 124);
  assert.equal(unrestricted.current, null);
});

test('an invalid reconfiguration preserves the previous valid round exactly', () => {
  const round = decision.createRound({ random: () => 0 });
  round.configure({ budgetMaxFen: 800, category: '主食' });
  round.next();
  const before = round.snapshot();
  assert.throws(() => round.configure({ budgetMaxFen: -100 }), { code: 'CANTEEN_INVALID_FILTER' });
  assert.deepEqual(round.snapshot(), before);
});

test('confirmation keeps same-name foods attached to their own stall, price and original unit', () => {
  const foods = menu.items.filter(item => item.name === '番茄鸡排饭');
  assert.equal(foods.length, 2);
  const records = foods.map(item => choose(item.id).confirmation());
  const shandong = records.find(record => record.stallId === 'shandong-jianbing');
  const hanshi = records.find(record => record.stallId === 'hanshi-banfan');
  assert.equal(shandong.amountFen, 1300);
  assert.equal(shandong.unit, null);
  assert.equal(shandong.priceText, '13元');
  assert.equal(hanshi.amountFen, 1400);
  assert.equal(hanshi.unit, '份');
  assert.equal(hanshi.priceText, '14元/份');
  assert.notEqual(shandong.itemId, hanshi.itemId);
  assert.equal(shandong.variantId, null);
  assert.equal(shandong.variantName, null);
  assert.equal(shandong.menuVersion, 'canteen-menu-v1');
  assert.deepEqual(Object.keys(shandong).sort(), ['menuVersion', 'itemId', 'stallId', 'variantId', 'variantName', 'priceKind', 'amountFen', 'unit', 'priceText'].sort());
});

test('confirming any variant requires an explicit eligible choice and records that exact price', () => {
  for (const item of menu.items.filter(entry => entry.price.kind === 'variants')) {
    const round = choose(item.id);
    assert.throws(() => round.confirmation(), { code: 'CANTEEN_INVALID_VARIANT' });
    for (const variant of item.price.variants) {
      round.selectVariant(variant.id);
      assert.deepEqual(round.confirmation(), {
        menuVersion: 'canteen-menu-v1', itemId: item.id, stallId: item.stallId,
        variantId: variant.id, variantName: variant.name, priceKind: 'variants',
        amountFen: variant.amountFen, unit: variant.unit, priceText: variant.originalPriceText,
      });
    }
    const limited = choose(item.id, { budgetMaxFen: item.price.variants[0].amountFen });
    assert.equal(limited.snapshot().selectedVariantId, null, 'Even one eligible variant is an explicit user choice');
    assert.throws(() => limited.selectVariant('large'), { code: 'CANTEEN_INVALID_VARIANT' });
    assert.throws(() => limited.selectVariant(null), { code: 'CANTEEN_INVALID_VARIANT' });
    assert.throws(() => limited.selectVariant('foreign-variant'), { code: 'CANTEEN_INVALID_VARIANT' });
    assert.throws(() => limited.confirmation(), { code: 'CANTEEN_INVALID_VARIANT' });
    limited.selectVariant('small');
    assert.equal(limited.confirmation().amountFen, item.price.variants[0].amountFen);
  }
});

test('weight confirmations preserve actual pricing rules without inventing a paid total', () => {
  for (const item of menu.items.filter(entry => entry.price.kind === 'weight')) {
    const round = choose(item.id);
    assert.deepEqual(round.confirmation(), {
      menuVersion: 'canteen-menu-v1', itemId: item.id, stallId: item.stallId,
      variantId: null, variantName: null, priceKind: 'weight', amountFen: null, unit: null,
      priceText: '素菜1.2元/50g；荤菜2.8元/50g，均价14',
    });
    assert.throws(() => round.selectVariant('small'), { code: 'CANTEEN_INVALID_VARIANT' });
    round.configure({ budgetMaxFen: 1400 });
    assert.throws(() => round.confirmation(), { code: 'CANTEEN_NO_SELECTION' });
  }
});

test('external snapshots cannot alter the true price, filters, available variants or internal round', () => {
  const item = menu.items.find(entry => entry.name === '福建扁食');
  const round = choose(item.id, { budgetMaxFen: 800 });
  const state = round.selectVariant('small');
  state.filters.budgetMaxFen = 100000;
  state.current.item.price.variants[0].amountFen = 0;
  state.current.variants.push({ id: 'large', name: '大份', amountFen: 0 });
  state.current.stall.id = 'forged';
  assert.equal(round.snapshot().filters.budgetMaxFen, 800);
  assert.equal(round.confirmation().amountFen, 800);
  assert.equal(round.confirmation().stallId, item.stallId);
  assert.throws(() => round.selectVariant('large'), { code: 'CANTEEN_INVALID_VARIANT' });
  const candidateList = decision.getCandidates();
  candidateList.candidates[0].item.price.amountFen = 0;
  assert.equal(decision.getCandidates().candidates[0].item.price.amountFen, 600);
  const categories = decision.getCategories();
  categories.push('forged');
  assert.ok(!decision.getCategories().includes('forged'));
});
