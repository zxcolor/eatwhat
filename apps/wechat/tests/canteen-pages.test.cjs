const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const tap = (page, extra = {}) => ({ currentTarget: { dataset: { revision: page.data.revision, ...extra } } });
const input = value => ({ detail: { value } });

// Only the native host, clock and RNG are controlled. The page, menu, policy,
// decision engine and record factory execute their real repository modules.
function harness(options = {}) {
  const calls = [];
  const forbidden = [];
  const storage = new Map();
  const storageFailures = new Set();
  const timers = new Map();
  const modules = new Map();
  let definition;
  let timerId = 0;
  let randomValue = 0;
  let randomCalls = 0;
  let now = 2000000000000;
  function forbid(name) {
    forbidden.push(name);
    throw new Error(`Forbidden canteen capability: ${name}`);
  }
  function storageGuard(operation, key) {
    if (storageFailures.has(`${operation}:${key}`)) throw new Error('Private native storage failure');
  }
  const platform = new Proxy({
    hideShareMenu(value) { calls.push({ name: 'hideShareMenu', value }); },
    navigateTo(value) { calls.push({ name: 'navigateTo', value }); },
    navigateBack(value) { calls.push({ name: 'navigateBack', value }); },
    showToast(value) { calls.push({ name: 'showToast', value }); },
    showModal(value) { calls.push({ name: 'showModal', value }); },
    getStorageSync(key) { calls.push({ name: 'getStorageSync', key }); storageGuard('get', key); return storage.get(key); },
    setStorageSync(key, value) { calls.push({ name: 'setStorageSync', key, value }); storageGuard('set', key); storage.set(key, value); },
    removeStorageSync(key) { calls.push({ name: 'removeStorageSync', key }); storageGuard('remove', key); storage.delete(key); },
  }, {
    get(target, name) {
      if (Object.hasOwn(target, name)) return target[name];
      return () => forbid(`wx.${String(name)}`);
    },
  });
  const app = {
    globalData: { canteenEpoch: 0, consent: options.consent ?? false,
      status: options.cloudStatus || 'failed', preferenceReady: options.preferenceReady ?? false },
    syncPage(page) { page.setData({ themeClass: options.themeClass || 'theme-light', reducedMotion: !!options.reducedMotion }); },
    ensureTasteProfile() { return forbid('ensureTasteProfile'); },
    checkService() { return forbid('checkService'); },
    acceptConsent() { return forbid('acceptConsent'); },
  };
  const controlledMath = Object.create(Math);
  controlledMath.random = () => { randomCalls += 1; return randomValue; };
  const context = vm.createContext({
    wx: platform, Math: controlledMath,
    Date: class extends Date { static now() { return now; } },
    getApp: () => app,
    Page(value) { definition = value; },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, cancelled: false }); return id; },
    clearTimeout(id) { if (timers.has(id)) timers.get(id).cancelled = true; },
    fetch: () => forbid('fetch'),
    XMLHttpRequest: function XMLHttpRequest() { forbid('XMLHttpRequest'); },
    WebSocket: function WebSocket() { forbid('WebSocket'); },
  });
  const allowedModules = new Set([
    'lib/canteen-decision.js', 'lib/canteen-records.js', 'lib/decision-motion.js',
    'data/canteen-menu.js', 'data/canteen-policy.js',
  ]);
  function load(request, parent) {
    if (!request.startsWith('.')) return forbid(`require:${request}`);
    let filename = path.resolve(path.dirname(parent), request);
    if (!path.extname(filename)) filename += '.js';
    const relative = path.relative(ROOT, filename).replaceAll('\\', '/');
    assert.ok(allowedModules.has(relative), `Unexpected dependency ${relative}`);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const source = fs.readFileSync(filename, 'utf8');
    const execute = new vm.Script(`(function(require,module,exports){\n${source}\n})`, { filename }).runInContext(context);
    execute(child => load(child, filename), module, module.exports);
    return module.exports;
  }
  const entry = path.join(ROOT, 'entry.js');
  const decision = load('./lib/canteen-decision', entry);
  const recordsModule = load('./lib/canteen-records', entry);
  const records = recordsModule.createCanteenRecords({ storage: platform, now: () => now });
  const timing = load('./lib/decision-motion', entry).TIMING;
  function makePage(name = 'canteen') {
    assert.ok(['canteen', 'canteen-records'].includes(name));
    const filename = path.join(ROOT, `pages/${name}/index.js`);
    const execute = new vm.Script(`(function(require){\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename }).runInContext(context);
    execute(request => request === '../../lib/canteen-records' ? records : load(request, filename));
    const page = {
      ...definition,
      data: clone(definition.data),
      setData(update, callback) { Object.assign(this.data, clone(update)); if (callback) callback(); },
    };
    page.onLoad?.();
    page.onShow();
    return page;
  }
  const page = makePage();
  function flushTimers() {
    const pending = [...timers.entries()];
    timers.clear();
    for (const [, timer] of pending) if (!timer.cancelled) timer.callback();
  }
  return {
    page, app, decision, records, recordsModule, calls, forbidden, storage, timers, timing, makePage,
    failStorage(operation, key) { storageFailures.add(`${operation}:${key}`); },
    recoverStorage() { storageFailures.clear(); },
    setRandom(value) { randomValue = value; }, randomCalls: () => randomCalls,
    now: () => now, advance(value) { now += value; }, flushTimers,
    saved() { const raw = storage.get(recordsModule.KEY); return raw ? JSON.parse(raw).entries : []; },
    historyWrites() { return calls.filter(call => call.name === 'setStorageSync' && call.key === recordsModule.KEY); },
    assertIsolated() {
      assert.deepEqual(forbidden, []);
      assert.ok(calls.every(call => ['hideShareMenu', 'navigateTo', 'navigateBack', 'showToast', 'showModal',
        'getStorageSync', 'setStorageSync', 'removeStorageSync'].includes(call.name)));
      for (const call of calls.filter(call => call.key)) {
        assert.ok([recordsModule.KEY, recordsModule.ENABLED_KEY].includes(call.key));
      }
    },
  };
}

function category(h, name) {
  const index = h.page.data.categories.indexOf(name);
  assert.ok(index >= 0, `Unknown real menu category ${name}`);
  h.page.changeCategory(input(index));
}

function choose(h, name, stallName) {
  const candidates = h.decision.getCandidates(h.page._round.snapshot().filters).candidates;
  const index = candidates.findIndex(candidate => candidate.item.name === name && (!stallName || candidate.stall.name === stallName));
  assert.ok(index >= 0, `Real menu food ${name} must match the current filters`);
  h.setRandom((index + 0.5) / candidates.length);
  h.page.next(tap(h.page));
  h.flushTimers();
  assert.equal(h.page.data.cards[0].name, name);
}

test('canteen starts with 124 unrestricted real foods without cloud, taste-profile, network or location gates', () => {
  for (const options of [
    {}, { consent: true, cloudStatus: 'ready', preferenceReady: true },
    { consent: false, cloudStatus: 'loading', preferenceReady: false, themeClass: 'theme-dark' },
  ]) {
    const h = harness(options);
    assert.equal(h.page.data.totalCount, 124);
    assert.equal(h.page.data.remainingCount, 124);
    assert.equal(h.page.data.seenCount, 0);
    assert.equal(h.page.data.cards.length, 0);
    assert.equal(h.page.data.status, 'idle');
    assert.equal(h.page.data.recordsEnabled, false);
    assert.equal(h.page.data.storageChecked, true);
    assert.equal(h.page.data.filterSummary, '预算不限 · 全部分类');
    assert.equal(h.page.data.themeClass, options.themeClass || 'theme-light');
    h.page.next(tap(h.page));
    assert.equal(h.page.data.cards[0].name, '牛肉馄饨');
    assert.equal(h.page.data.cards[0].stallName, '民族风味');
    assert.equal(h.page.data.cards[0].priceLabel, '6元/份');
    assert.equal(h.page.data.seenCount, 1);
    assert.equal(h.randomCalls(), 1);
    h.assertIsolated();
  }
});

test('budget text is parsed as exact fen, including zero, hundredths and non-whole yuan', () => {
  const h = harness();
  for (const [text, fen, count] of [['0', 0, 0], ['0.01', 1, 0], ['1.5', 150, 6], ['1.00', 100, 4], [' 1.50 ', 150, 6]]) {
    h.page.inputBudget(input(text));
    assert.equal(h.page._round.snapshot().filters.budgetMaxFen, fen);
    assert.equal(h.page.data.totalCount, count);
    assert.equal(h.page.data.weightedExcludedCount, 3);
    assert.equal(h.page.data.filterError, '');
    assert.equal(h.page.data.cards.length, 0);
  }
  h.page.inputBudget(input(''));
  assert.equal(h.page._round.snapshot().filters.budgetMaxFen, null);
  assert.equal(h.page.data.totalCount, 124);
  assert.equal(h.page.data.weightedExcludedCount, 0);
  h.assertIsolated();
});

test('incomplete or invalid budget input immediately disables the old card and cannot silently widen the budget', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  for (const text of ['1.', '-1', '1.234', 'abc', '1e2', '01', 'Infinity', '.5']) {
    h.page.clearFilters();
    choose(h, '牛肉馄饨');
    const oldEvent = tap(h.page);
    h.page.inputBudget(input(text));
    assert.equal(h.page.data.status, 'invalid', text);
    assert.equal(h.page.data.cards.length, 0, text);
    assert.equal(h.page.data.totalCount, 0, text);
    assert.ok(h.page.data.filterError, text);
    h.page.confirm(oldEvent);
    h.page.confirm(tap(h.page));
    h.page.next(tap(h.page));
    assert.equal(h.page.data.cards.length, 0, text);
    assert.equal(h.saved().length, 0, text);
  }
  h.page.inputBudget(input('1.5'));
  assert.equal(h.page.data.status, 'idle');
  assert.equal(h.page.data.totalCount, 6);
  assert.equal(h.page.data.filterError, '');
  h.assertIsolated();
});

test('category controls use full source names and combine with the strict budget', () => {
  const h = harness();
  assert.ok(h.page.data.categories.includes('煎饼、烤冷面与饼类'));
  assert.ok(h.page.data.categories.includes('千里香海味馄饨'));
  assert.ok(!h.page.data.categories.includes('豆浆'));
  assert.ok(!h.page.data.categories.some(name => name.startsWith('加料') || name.startsWith('米线浇头')));
  category(h, '主食');
  assert.equal(h.page.data.totalCount, 3);
  h.page.inputBudget(input('6'));
  assert.equal(h.page.data.totalCount, 2);
  h.page.next(tap(h.page)); h.flushTimers();
  assert.equal(h.page.data.cards[0].category, '主食');
  assert.equal(h.page.data.cards[0].stallName, '民族风味');
  const before = clone(h.page.data);
  for (const invalid of [-1, 1.5, 999, 'unknown']) h.page.changeCategory(input(invalid));
  assert.deepEqual(h.page.data, before);
  h.page.clearFilters();
  assert.equal(h.page.data.totalCount, 124);
  assert.equal(h.page.data.cards.length, 0);
  assert.equal(h.page.data.categoryIndex, 0);
});

test('budget-limited multi-spec cards show both real prices, disable the over-budget size and require an explicit choice', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  h.page.inputBudget(input('8'));
  category(h, '千里香海味馄饨');
  choose(h, '紫菜虾米馄饨');
  const card = h.page.data.cards[0];
  assert.equal(card.priceLabel, '请选择规格');
  assert.equal(card.canConfirm, false);
  assert.deepEqual(card.variants.map(variant => [variant.id, variant.originalPriceText, variant.allowed, variant.unit, variant.budgetLabel]), [
    ['small', '小份8元', true, null, '预算内可选'], ['large', '大份13元', false, null, '超出预算'],
  ]);
  h.page.confirm(tap(h.page));
  assert.equal(h.page.data.confirmed, false);
  assert.match(h.page.data.error, /规格/);
  assert.equal(h.saved().length, 0);
  h.page.selectVariant(tap(h.page, { id: 'large' }));
  assert.equal(h.page.data.cards[0].canConfirm, false);
  assert.match(h.page.data.error, /符合条件/);
  h.page.selectVariant(tap(h.page, { id: 'small' }));
  assert.equal(h.page.data.cards[0].canConfirm, true);
  assert.equal(h.page.data.cards[0].priceLabel, '小份8元');
  h.page.confirm(tap(h.page));
  assert.equal(h.saved().length, 1);
  assert.deepEqual(h.saved()[0], {
    recordedAtEpochMillis: h.now(), menuVersion: 'canteen-menu-v1', itemId: card.id,
    stallId: 'fujian-fengwei', variantId: 'small', variantName: '小份', priceKind: 'variants',
    amountFen: 800, unit: null, priceText: '小份8元',
  });
  h.assertIsolated();
});

test('unrestricted multi-spec confirmation preserves the large size and does not count sizes as separate dishes', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  category(h, '千里香海味馄饨');
  choose(h, '紫菜虾米馄饨');
  const firstId = h.page.data.cards[0].id;
  assert.equal(h.page.data.totalCount, 4);
  h.page.selectVariant(tap(h.page, { id: 'small' }));
  h.page.selectVariant(tap(h.page, { id: 'large' }));
  assert.equal(h.page.data.seenCount, 1);
  assert.equal(h.page.data.remainingCount, 3);
  h.page.confirm(tap(h.page));
  assert.equal(h.saved()[0].amountFen, 1300);
  assert.equal(h.saved()[0].variantId, 'large');
  assert.equal(h.saved()[0].unit, null);
  h.page.next(tap(h.page)); h.flushTimers();
  assert.notEqual(h.page.data.cards[0].id, firstId);
  assert.equal(h.page.data.cards[0].priceLabel, '请选择规格');
  assert.equal(h.page.data.confirmed, false);
});

test('weight-priced cards display the original rates, save no paid amount, and disappear under any strict budget', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  category(h, '餐品与称重价格');
  choose(h, '麻辣香锅');
  assert.equal(h.page.data.totalCount, 3);
  assert.equal(h.page.data.cards[0].priceLabel, '称重计价');
  assert.equal(h.page.data.cards[0].originalPriceText, '素菜1.2元/50g；荤菜2.8元/50g，均价14');
  h.page.confirm(tap(h.page));
  assert.equal(h.saved()[0].amountFen, null);
  assert.equal(h.saved()[0].unit, null);
  assert.equal(h.saved()[0].priceKind, 'weight');
  h.page.inputBudget(input('9999'));
  assert.equal(h.page.data.status, 'empty');
  assert.equal(h.page.data.cards.length, 0);
  assert.equal(h.page.data.weightedExcludedCount, 3);
  assert.equal(h.page._round.snapshot().filters.budgetMaxFen, 999900);
});

test('rapid consecutive taps draw only once during the press lock in both motion settings', () => {
  for (const reducedMotion of [false, true]) {
    const h = harness({ reducedMotion });
    const oldEvent = tap(h.page);
    h.page.next(oldEvent);
    assert.equal(h.page.data.seenCount, 1);
    h.page.next(oldEvent);
    h.page.next(tap(h.page));
    h.page.next(tap(h.page));
    assert.equal(h.randomCalls(), 1, `reducedMotion=${reducedMotion}`);
    assert.equal(h.page.data.seenCount, 1);
    assert.equal(h.page.data.busy, true);
    assert.ok([...h.timers.values()].some(timer => timer.delay === h.timing.press));
    h.flushTimers();
    assert.equal(h.page.data.busy, false);
    h.page.next(tap(h.page));
    assert.equal(h.randomCalls(), 2);
  }
});

test('stale card revisions cannot change the dish, select a size or confirm a different result', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  category(h, '千里香海味馄饨');
  choose(h, '紫菜虾米馄饨');
  const oldEvent = tap(h.page, { id: 'small' });
  h.page.next(tap(h.page)); h.flushTimers();
  const before = clone(h.page.data);
  h.page.next(oldEvent);
  h.page.selectVariant(oldEvent);
  h.page.confirm(oldEvent);
  assert.deepEqual(h.page.data, before);
  assert.equal(h.saved().length, 0);
  assert.equal(h.randomCalls(), 2);
});

test('changing filters cancels the old press lock, clears selection and rejects late timer callbacks', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  h.page.next(tap(h.page));
  const oldEvent = tap(h.page);
  const oldTimer = [...h.timers.values()].at(-1);
  assert.equal(h.page.data.busy, true);
  h.page.inputBudget(input('1'));
  assert.equal(h.page.data.busy, false);
  assert.equal(h.page.data.cards.length, 0);
  assert.equal(h.page.data.seenCount, 0);
  assert.equal(oldTimer.cancelled, true);
  const before = clone(h.page.data);
  oldTimer.callback();
  h.page.confirm(oldEvent);
  h.page.next(oldEvent);
  assert.deepEqual(h.page.data, before);
  h.page.next(tap(h.page));
  assert.equal(h.page.data.busy, true);
  oldTimer.callback();
  assert.equal(h.page.data.busy, true, 'A late old timer cannot unlock the newer draw');
  h.flushTimers();
  assert.equal(h.page.data.cards[0].priceLabel, '1元/个');
  assert.equal(h.saved().length, 0);
});

test('hide and unload reject old actions and late timers without writing a choice', () => {
  for (const method of ['onHide', 'onUnload']) {
    const h = harness();
    h.page.changeRemember(input(true));
    h.page.next(tap(h.page));
    const oldEvent = tap(h.page);
    const oldTimer = [...h.timers.values()].at(-1);
    h.page[method]();
    const before = clone(h.page.data);
    oldTimer.callback();
    h.page.confirm(oldEvent);
    h.page.next(oldEvent);
    h.page.restart(oldEvent);
    h.page.selectVariant({ currentTarget: { dataset: { ...oldEvent.currentTarget.dataset, id: 'small' } } });
    h.page.inputBudget(input('1'));
    h.page.changeRemember(input(false));
    assert.deepEqual(h.page.data, before, method);
    assert.equal(h.saved().length, 0);
    if (method === 'onHide') {
      h.page.onShow();
      h.page.confirm(oldEvent);
      assert.equal(h.saved().length, 0);
      h.page.confirm(tap(h.page));
      assert.equal(h.saved().length, 1);
    } else assert.equal(h.page._round, null);
  }
});

test('recording stays off by default; explicit enable saves once and disabling erases local history', () => {
  const h = harness();
  choose(h, '牛肉馄饨');
  h.page.confirm(tap(h.page));
  assert.equal(h.page.data.confirmed, true);
  assert.match(h.page.data.confirmationText, /仅保留本次选择/);
  assert.equal(h.saved().length, 0);
  assert.equal(h.historyWrites().length, 0);
  h.page.changeRemember(input(true));
  assert.equal(h.page.data.recordsEnabled, true);
  assert.equal(h.saved().length, 0, 'Enabling does not silently save an earlier confirmation');
  h.page.next(tap(h.page)); h.flushTimers();
  const event = tap(h.page);
  h.page.confirm(event);
  h.page.confirm(event);
  h.page.confirm(tap(h.page));
  assert.equal(h.saved().length, 1);
  assert.equal(h.historyWrites().length, 1);
  assert.match(h.page.data.confirmationText, /记在本机/);
  h.page.changeRemember(input(false));
  assert.equal(h.page.data.recordsEnabled, false);
  assert.equal(h.saved().length, 0);
  assert.equal(h.storage.get(h.recordsModule.ENABLED_KEY), false);
  h.page.next(tap(h.page)); h.flushTimers(); h.page.confirm(tap(h.page));
  assert.equal(h.saved().length, 0);
  h.assertIsolated();
});

test('same-name foods keep their exact stall, original unit and price through page confirmation', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  for (const [stallName, amountFen, unit] of [['山东煎饼', 1300, null], ['韩式拌饭', 1400, '份']]) {
    h.page.clearFilters();
    choose(h, '番茄鸡排饭', stallName);
    assert.equal(h.page.data.cards[0].stallName, stallName);
    h.page.confirm(tap(h.page));
    const saved = h.saved()[0];
    assert.equal(saved.amountFen, amountFen);
    assert.equal(saved.unit, unit);
    h.advance(1);
  }
  assert.equal(new Set(h.saved().map(entry => entry.itemId)).size, 2);
  assert.equal(new Set(h.saved().map(entry => entry.stallId)).size, 2);
});

test('one complete round displays all 124 IDs once, keeps the final card and restarts only on explicit action', () => {
  const h = harness();
  const ids = new Set();
  for (let index = 0; index < 124; index += 1) {
    h.page.next(tap(h.page)); h.flushTimers();
    const id = h.page.data.cards[0].id;
    assert.ok(!ids.has(id));
    ids.add(id);
  }
  assert.equal(h.page.data.remainingCount, 0);
  assert.equal(h.page.data.seenCount, 124);
  const lastId = h.page.data.cards[0].id;
  h.page.next(tap(h.page)); h.flushTimers();
  assert.equal(h.page.data.remainingCount, 0);
  assert.equal(h.page.data.cards[0].id, lastId);
  assert.equal(h.randomCalls(), 124);
  h.page.onHide(); h.page.onShow();
  assert.equal(h.page.data.remainingCount, 0);
  assert.equal(h.page.data.cards[0].id, lastId);
  h.page.restart(tap(h.page));
  assert.equal(h.page.data.cards.length, 0);
  assert.equal(h.page.data.status, 'idle');
  assert.equal(h.page.data.remainingCount, 124);
  assert.equal(h.randomCalls(), 124);
  h.page.next(tap(h.page));
  assert.equal(h.randomCalls(), 125);
});

test('single and empty pools preserve their conditions and never automatically fall back', () => {
  const h = harness();
  category(h, '福建小吃');
  h.page.inputBudget(input('1'));
  assert.equal(h.page.data.totalCount, 1);
  choose(h, '香干');
  assert.equal(h.page.data.remainingCount, 0);
  h.page.next(tap(h.page)); h.flushTimers();
  assert.equal(h.page.data.cards[0].name, '香干');
  assert.equal(h.randomCalls(), 1);
  h.page.confirm(tap(h.page));
  assert.equal(h.page.data.confirmed, true);
  h.page.inputBudget(input('0.99'));
  assert.equal(h.page.data.status, 'empty');
  assert.equal(h.page.data.cards.length, 0);
  h.page.next(tap(h.page)); h.page.restart(tap(h.page));
  assert.equal(h.page.data.status, 'empty');
  assert.equal(h.randomCalls(), 1);
  assert.deepEqual(clone(h.page._round.snapshot().filters), { budgetMaxFen: 99, category: '福建小吃' });
  h.page.clearFilters();
  assert.equal(h.page.data.status, 'idle');
  assert.equal(h.page.data.totalCount, 124);
});

test('privacy epoch changes invalidate the previous round, receipt and card events on page return', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  choose(h, '牛肉馄饨');
  h.page.confirm(tap(h.page));
  const oldEvent = tap(h.page);
  h.page.onHide();
  h.records.withdraw();
  h.app.globalData.canteenEpoch += 1;
  h.page.onShow();
  assert.equal(h.page.data.cards.length, 0);
  assert.equal(h.page.data.confirmed, false);
  assert.equal(h.page.data.seenCount, 0);
  assert.equal(h.page.data.recordsEnabled, false);
  h.page.confirm(oldEvent);
  assert.equal(h.saved().length, 0);
  assert.equal(h.page._receipt, null);
});

test('page event bindings, real menu placeholders and long names have matching native controls', () => {
  const h = harness();
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/canteen/index.wxml'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'pages/canteen/index.wxss'), 'utf8');
  for (const match of wxml.matchAll(/(?:bind|catch)(?::?[a-z]+)="([A-Za-z]\w*)"/g)) {
    assert.equal(typeof h.page[match[1]], 'function', `Missing handler ${match[1]}`);
  }
  assert.match(wxml, /bindtap="next" data-revision="\{\{revision\}\}"/);
  assert.match(wxml, /bindtap="confirm" data-revision="\{\{revision\}\}"/);
  assert.match(wxml, /bindtap="restart" data-revision="\{\{revision\}\}"/);
  assert.match(wxml, /这一轮都看过了/);
  assert.match(wxml, /当前条件只有这一个菜品，没有其他可换结果/);
  assert.match(wxml, /实付按所选重量计算/);
  assert.match(wxml, /meal-placeholder\.svg/);
  assert.doesNotMatch(wxml, /换个档口|https?:\/\/[^"']+\.(?:jpg|png)|学校选择|楼层/);
  assert.match(css, /\.dish-name\s*\{[^}]*overflow-wrap:anywhere;[^}]*word-break:break-all;/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  choose(h, '生烫牛肉米线（02：米线+青菜+卤蛋+牛肉丸+肉酱）');
  assert.equal(h.page.data.cards[0].name, '生烫牛肉米线（02：米线+青菜+卤蛋+牛肉丸+肉酱）');
  assert.equal(h.page.data.cards[0].priceLabel, '13元');
  assert.equal(h.page.data.cards[0].stallName, '福建风味');
});

test('routes add both canteen pages and home keeps its left-aligned location entry and existing decision controls', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  for (const route of ['pages/index/index', 'pages/canteen/index', 'pages/canteen-records/index',
    'pages/location/index', 'pages/conditions/index', 'pages/results/index', 'pages/account/index']) {
    assert.ok(config.pages.includes(route), route);
  }
  const home = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxss'), 'utf8');
  assert.match(home, /data-page="canteen" bindtap="open"/);
  assert.match(home, /data-page="canteen-records" bindtap="open"/);
  assert.match(home, /帮你决定在学校食堂吃什么/);
  assert.match(home, /class="location" bindtap="open" data-page="location"/);
  assert.match(home, /class="location-current">虚拟地点/);
  assert.match(home, /data-target="PACKAGE"/);
  assert.match(home, /data-target="RESTAURANT"/);
  assert.match(home, /bindtap="decide"/);
  assert.ok(home.indexOf('class="location"') < home.indexOf('class="canteen-entry"'));
  assert.match(css, /button\.location\s*\{[^}]*justify-content:flex-start;[^}]*padding:0;[^}]*text-align:left;[^}]*margin:0;/);
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'pages/canteen/index.json'), 'utf8'));
  assert.equal(settings.navigationBarTitleText, '食堂吃什么');
});

test('the real home routing handler opens canteen and location without requesting cloud consent', async () => {
  let definition;
  const navigations = [];
  const source = fs.readFileSync(path.join(ROOT, 'pages/index/index.js'), 'utf8');
  const context = vm.createContext({
    Page(value) { definition = value; },
    wx: { navigateTo(value) { navigations.push(value.url); }, showToast() { assert.fail('Offline routes must not request consent'); } },
    getApp: () => ({ ensureTasteProfile: () => true, checkService() { assert.fail('Offline routes must not connect to cloud'); } }),
  });
  const execute = new vm.Script(`(function(require){\n${source}\n})`).runInContext(context);
  execute(request => {
    if (request === '../../lib/service') return { VERSION: 'test', state: { consent: false, status: 'failed' } };
    if (request === '../../lib/decision/service') return {};
    if (request === '../../lib/home-title') return require('../lib/home-title');
    assert.fail(`Unexpected home routing dependency ${request}`);
  });
  const home = { ...definition, _active: true, data: clone(definition.data), setData(value) { Object.assign(this.data, clone(value)); } };
  for (const page of ['canteen', 'canteen-records', 'location', 'conditions', 'settings']) {
    await home.open({ currentTarget: { dataset: { page } } });
  }
  assert.deepEqual(navigations, ['canteen', 'canteen-records', 'location', 'conditions', 'settings'].map(page => `/pages/${page}/index`));
});

test('empty-pool adjustment always opens filters and cannot accidentally collapse an already open panel', () => {
  const h = harness();
  h.page.inputBudget(input('0'));
  assert.equal(h.page.data.status, 'empty');
  h.page.openFilters();
  assert.equal(h.page.data.filtersOpen, true);
  h.page.openFilters();
  assert.equal(h.page.data.filtersOpen, true);
  h.page.onHide();
  h.page.setData({ filtersOpen: false });
  h.page.openFilters();
  assert.equal(h.page.data.filtersOpen, false);
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/canteen/index.wxml'), 'utf8');
  assert.match(wxml, /bindtap="openFilters">调整条件/);
});

test('closing records updates the saved confirmation copy immediately without undoing the current choice', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  choose(h, '牛肉馄饨');
  h.page.confirm(tap(h.page));
  assert.match(h.page.data.confirmationText, /记在本机/);
  const selected = h.page.data.cards[0].id;
  h.page.changeRemember(input(false));
  assert.equal(h.page.data.confirmed, true);
  assert.equal(h.page.data.cards[0].id, selected);
  assert.match(h.page.data.confirmationText, /仅保留本次选择/);
  assert.equal(h.saved().length, 0);
  h.page.changeRemember(input(true));
  assert.match(h.page.data.confirmationText, /仅保留本次选择/);
  assert.equal(h.saved().length, 0);
});

test('failed local cleanup remains actionable after rereading settings and confirming another unsaved choice', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  choose(h, '牛肉馄饨');
  h.page.confirm(tap(h.page));
  h.failStorage('remove', h.recordsModule.KEY);
  h.page.changeRemember(input(false));
  assert.equal(h.page.data.cleanupNeeded, true);
  assert.equal(h.page.data.recordsEnabled, false);
  assert.match(h.page.data.recordError, /清除失败/);
  assert.equal(h.saved().length, 1, 'A failed deletion must not be represented as success');
  h.page.readStorageChoice();
  assert.equal(h.page.data.cleanupNeeded, true);
  assert.match(h.page.data.recordError, /清除失败/);
  h.page.next(tap(h.page)); h.flushTimers();
  h.page.confirm(tap(h.page));
  assert.equal(h.page.data.confirmed, true);
  assert.equal(h.page.data.cleanupNeeded, true);
  assert.match(h.page.data.recordError, /清除失败/);
  assert.equal(h.saved().length, 1);
  h.page.retryCleanup();
  assert.equal(h.page.data.cleanupNeeded, true);
  h.recoverStorage();
  h.page.retryCleanup();
  assert.equal(h.page.data.cleanupNeeded, false);
  assert.equal(h.page.data.recordError, '');
  assert.equal(h.page.data.recordsEnabled, false);
  assert.equal(h.storage.has(h.recordsModule.KEY), false);
  assert.equal(h.storage.has(h.recordsModule.ENABLED_KEY), false);
  h.assertIsolated();
});

test('failed local persistence keeps the confirmation honest and duplicate confirmation cannot retry an implicit write', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  choose(h, '牛肉馄饨');
  h.failStorage('set', h.recordsModule.KEY);
  const currentEvent = tap(h.page);
  h.page.confirm(currentEvent);
  assert.equal(h.page.data.confirmed, true);
  assert.match(h.page.data.confirmationText, /记录未保存/);
  assert.match(h.page.data.recordError, /暂未保存/);
  assert.doesNotMatch(h.page.data.recordError, /Private native/);
  assert.equal(h.saved().length, 0);
  const attempts = h.historyWrites().length;
  h.recoverStorage();
  h.page.confirm(currentEvent);
  h.page.confirm(tap(h.page));
  assert.equal(h.historyWrites().length, attempts);
  assert.equal(h.saved().length, 0);
});

test('history defaults to off and both page navigation actions operate only while active', () => {
  const h = harness();
  const history = h.makePage('canteen-records');
  assert.equal(history.data.enabled, false);
  assert.deepEqual(history.data.entries, []);
  assert.equal(history.data.error, '');
  history.openCanteen();
  h.page.openRecords();
  assert.deepEqual(h.calls.filter(call => call.name === 'navigateTo').map(call => call.value.url),
    ['/pages/canteen/index', '/pages/canteen-records/index']);
  history.onHide(); h.page.onHide();
  history.openCanteen(); h.page.openRecords();
  assert.equal(h.calls.filter(call => call.name === 'navigateTo').length, 2);
  h.assertIsolated();
});

test('history displays real fixed, selected-size and weighted choices in time order without fabricated paid amounts', () => {
  const h = harness({ themeClass: 'theme-dark' });
  h.page.changeRemember(input(true));
  choose(h, '番茄鸡排饭', '山东煎饼');
  h.page.confirm(tap(h.page));
  h.advance(1000);
  h.page.clearFilters();
  choose(h, '福建扁食');
  h.page.selectVariant(tap(h.page, { id: 'large' }));
  h.page.confirm(tap(h.page));
  h.advance(1000);
  h.page.clearFilters();
  choose(h, '麻辣拌');
  h.page.confirm(tap(h.page));
  h.page.onHide();
  const history = h.makePage('canteen-records');
  assert.equal(history.data.enabled, true);
  assert.equal(history.data.themeClass, 'theme-dark');
  assert.deepEqual(history.data.entries.map(entry => [entry.name, entry.stallName, entry.priceText, entry.variantName, entry.weighted]), [
    ['麻辣拌', '麻辣香锅', '素菜1.2元/50g；荤菜2.8元/50g，均价14', null, true],
    ['福建扁食', '福建风味', '大份13元', '大份', false],
    ['番茄鸡排饭', '山东煎饼', '13元', null, false],
  ]);
  for (const entry of history.data.entries) assert.match(entry.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  history.onHide();
  assert.deepEqual(history.data.entries, []);
  history.onShow();
  assert.equal(history.data.entries.length, 3);
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/canteen-records/index.wxml'), 'utf8');
  assert.match(wxml, /称重计价 · 未记录实付总额/);
  assert.match(wxml, /清单标价，非付款记录/);
  for (const match of wxml.matchAll(/(?:bind|catch)(?::?[a-z]+)="([A-Za-z]\w*)"/g)) {
    assert.equal(typeof history[match[1]], 'function', `Missing history handler ${match[1]}`);
  }
  h.assertIsolated();
});

test('history clearing requires an affirmative modal and updates the saved choice copy on return', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  choose(h, '牛肉馄饨');
  h.page.confirm(tap(h.page));
  h.page.onHide();
  const history = h.makePage('canteen-records');
  history.clearRecords();
  let modal = h.calls.filter(call => call.name === 'showModal').at(-1).value;
  assert.match(modal.title, /清空食堂/);
  assert.equal(h.saved().length, 1);
  modal.success({ confirm: false });
  assert.equal(h.saved().length, 1);
  history.clearRecords();
  modal = h.calls.filter(call => call.name === 'showModal').at(-1).value;
  modal.success({ confirm: true });
  assert.equal(h.saved().length, 0);
  assert.equal(history.data.entries.length, 0);
  assert.equal(history.data.enabled, true);
  history.onHide();
  h.page.onShow();
  assert.equal(h.page.data.confirmed, true);
  assert.match(h.page.data.confirmationText, /仅保留本次选择/);
  assert.equal(h.page.data.cards[0].name, '牛肉馄饨');
});

test('late history clear callbacks cannot delete records after hide, unload or a privacy epoch change', () => {
  for (const action of ['onHide', 'onUnload', 'epoch']) {
    const h = harness();
    h.page.changeRemember(input(true));
    choose(h, '牛肉馄饨');
    h.page.confirm(tap(h.page));
    const history = h.makePage('canteen-records');
    history.clearRecords();
    const modal = h.calls.filter(call => call.name === 'showModal').at(-1).value;
    if (action === 'epoch') { h.app.globalData.canteenEpoch += 1; history.syncState(); }
    else history[action]();
    modal.success({ confirm: true });
    assert.equal(h.saved().length, 1, action);
  }
});

test('history disables writes before failed cleanup and keeps its retry operation available until actual removal succeeds', () => {
  const h = harness();
  h.page.changeRemember(input(true));
  choose(h, '牛肉馄饨');
  h.page.confirm(tap(h.page));
  const history = h.makePage('canteen-records');
  h.failStorage('remove', h.recordsModule.KEY);
  history.changeRemember(input(false));
  assert.equal(history.data.enabled, false);
  assert.deepEqual(history.data.entries, []);
  assert.equal(history.data.cleanupNeeded, true);
  assert.match(history.data.error, /清除失败/);
  assert.equal(h.saved().length, 1);
  history.syncState();
  assert.equal(history.data.cleanupNeeded, true);
  assert.ok(history.data.error);
  history.retryCleanup();
  assert.equal(history.data.cleanupNeeded, true);
  h.recoverStorage();
  history.retryCleanup();
  assert.equal(history.data.cleanupNeeded, false);
  assert.equal(history.data.error, '');
  assert.equal(history.data.enabled, false);
  assert.equal(h.saved().length, 0);
  history.changeRemember(input(true));
  assert.equal(history.data.enabled, true);
  assert.equal(history.data.entries.length, 0);
  history.onHide();
  const before = clone(history.data);
  const callCount = h.calls.length;
  history.changeRemember(input(false)); history.retryCleanup(); history.clearRecords(); history.syncState();
  assert.deepEqual(history.data, before);
  assert.equal(h.calls.length, callCount);
  h.assertIsolated();
});

test('failed cleanup remains shared across both page recreations until a successful withdrawal retry', () => {
  for (const origin of ['canteen', 'canteen-records']) {
    const h = harness();
    h.page.changeRemember(input(true));
    choose(h, '牛肉馄饨');
    h.page.confirm(tap(h.page));
    const original = origin === 'canteen' ? h.page : h.makePage('canteen-records');
    h.failStorage('set', h.recordsModule.ENABLED_KEY);
    h.failStorage('remove', h.recordsModule.ENABLED_KEY);
    h.failStorage('remove', h.recordsModule.KEY);
    original.changeRemember(input(false));
    assert.equal(original.data.cleanupNeeded, true);
    const pending = h.records.getCleanupError();
    assert.match(pending, /清理成功前请不要关闭小程序/);
    original.onUnload();
    const recreatedCanteen = h.makePage('canteen');
    const recreatedHistory = h.makePage('canteen-records');
    assert.equal(recreatedCanteen.data.recordsEnabled, false);
    assert.equal(recreatedCanteen.data.cleanupNeeded, true);
    assert.equal(recreatedCanteen.data.recordError, pending);
    assert.equal(recreatedHistory.data.enabled, false);
    assert.equal(recreatedHistory.data.cleanupNeeded, true);
    assert.equal(recreatedHistory.data.error, pending);
    assert.equal(h.storage.get(h.recordsModule.ENABLED_KEY), true, 'Failed storage operations cannot persist withdrawal');
    h.recoverStorage();
    recreatedCanteen.readStorageChoice();
    recreatedHistory.syncState();
    assert.equal(recreatedCanteen.data.cleanupNeeded, true);
    assert.equal(recreatedHistory.data.cleanupNeeded, true);
    assert.equal(h.records.getCleanupError(), pending, 'Pruning records must not clear a pending opt-in-key cleanup');
    const retryPage = origin === 'canteen' ? recreatedHistory : recreatedCanteen;
    retryPage.retryCleanup();
    assert.equal(h.records.getCleanupError(), '');
    assert.equal(h.storage.has(h.recordsModule.ENABLED_KEY), false);
    assert.equal(h.storage.has(h.recordsModule.KEY), false);
    recreatedCanteen.readStorageChoice();
    recreatedHistory.syncState();
    assert.equal(recreatedCanteen.data.cleanupNeeded, false);
    assert.equal(recreatedCanteen.data.recordError, '');
    assert.equal(recreatedHistory.data.cleanupNeeded, false);
    assert.equal(recreatedHistory.data.error, '');
    h.assertIsolated();
  }
});
