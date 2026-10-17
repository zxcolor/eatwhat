'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// These page-handler checks use synthetic data only. They do not call WeChat,
// a real location provider, the public API, or any persistent storage API.
const FILTERS = {
  mealPeriod: 'LUNCH', target: 'MEAL', weatherContext: { kind: 'NONE' },
  decisionMode: 'QUICK', travelMode: 'WALK', explorationMode: 'BALANCED',
  aiAssistanceEnabled: false, budgetMaxYuan: 25, availableMinutes: 60,
  radiusMeters: 1500, excludedCuisines: [], preferredCuisines: [],
  preferenceVector: { quality: 100, time: 100, budget: 100, mealMatch: 100, diversity: 100 },
};
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function config() {
  return {
    serviceCapabilities: { recommendationsEnabled: true, locationSearchEnabled: true },
    specialtyCapabilities: {}, dataRightsMode: 'LIVE_DISPLAY_ONLY',
    recommendationDefaults: { defaultRadiusMeters: 1500, maximumRadiusMeters: 5000 },
  };
}
function state(changes = {}) {
  return {
    consent: true, status: 'ready', error: '', config: config(), epoch: 1,
    location: { latitude: 0, longitude: 0, crs: 'WGS84' },
    locationLabel: '合成测试地点', filters: clone(FILTERS), results: null, ...changes,
  };
}
function item(name, rank, changes = {}) {
  return {
    name, rank, resultToken: String(rank).repeat(43), dataMode: 'LIVE',
    averageCostYuan: null, distanceMeters: 300, estimatedTravelMinutes: 5,
    estimatedMealMinutes: 30, sourceRating: null, fitScore: null, openStatus: 'UNKNOWN',
    address: '合成测试地址', tags: [], reasons: [{ code: 'DISTANCE_FIT', text: '合成测试说明' }],
    warnings: ['仅为测试夹具'], sourceAttribution: '合成测试来源',
    actions: { navigate: true, call: true, copyAddress: true, share: false },
    phone: '010-12345678', location: { latitude: 0, longitude: 0, crs: 'GCJ02' }, ...changes,
  };
}
function response(changes = {}) {
  return {
    generatedAt: new Date().toISOString(), dataRightsMode: 'LIVE_DISPLAY_ONLY',
    results: [item('候选 B', 1), item('候选 A', 2)],
    profile: { version: 'meal-lunch-v1' }, notice: null, ...changes,
  };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(name, initial = state(), methods = {}) {
  const calls = [];
  let definition;
  const service = {
    state: initial,
    setLocation(location, label) { initial.location = clone(location); initial.locationLabel = label; initial.results = null; },
    setFilters(filters) { initial.filters = clone(filters); initial.results = null; },
    async recommend() { initial.results = response(); return initial.results; },
    async refreshConfig() { initial.config = config(); initial.status = 'ready'; },
    async searchLocations() { return { dataMode: 'LIVE', results: [], notice: null }; },
    ...methods,
  };
  const wx = new Proxy({}, {
    get(_, key) {
      if (/storage/i.test(key)) return () => { throw new Error('Page data must not be persisted'); };
      return options => { calls.push({ key, options }); };
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'pages', name, 'index.js'), 'utf8');
  vm.runInNewContext(source, {
    require(moduleName) { assert.equal(moduleName, '../../lib/service'); return service; },
    Page(value) { definition = value; }, wx,
    getApp: () => ({ syncPage(page) { page.setData({ themeClass: 'theme-dark' }); } }),
    getCurrentPages: () => [{ route: 'pages/index/index' }],
    Date, Number, Set,
  }, { filename: `${name}/index.js` });
  const page = { ...definition, data: clone(definition.data), setData(update) { Object.assign(this.data, update); } };
  if (page.onLoad) page.onLoad({ index: '0' });
  return { page, service, calls };
}
function tick() { return new Promise(resolve => setImmediate(resolve)); }
function noSensitiveRenderedFields(page) {
  assert.equal(/latitude|longitude|resultToken/.test(JSON.stringify(page.data)), false);
}

test('home retries a city request after hiding and rejects the previous response', async () => {
  const first = deferred();
  const second = deferred();
  let requests = 0;
  const { page } = harness('index', state(), {
    cityFor: () => ++requests === 1 ? first.promise : second.promise,
  });
  page.onShow();
  assert.equal(requests, 1);
  page.onHide();
  assert.equal(page._cityLocation, null);
  page.onShow();
  assert.equal(requests, 2);
  first.resolve('合成旧城市');
  await tick();
  assert.equal(page.data.city, '正在获取城市…');
  second.resolve('合成新城市');
  await tick();
  assert.equal(page.data.city, '合成新城市');
  noSensitiveRenderedFields(page);
});

test('all four pages gate entry on consent and expose the app lifecycle callback', () => {
  for (const name of ['location', 'conditions', 'results', 'detail']) {
    const { page, calls } = harness(name, state({ consent: false }));
    page.onShow();
    assert.equal(typeof page.syncState, 'function');
    assert.equal(calls.find(call => call.key === 'reLaunch').options.url, '/pages/index/index');
    assert.equal(calls.some(call => ['getLocation', 'openLocation', 'makePhoneCall'].includes(call.key)), false);
    assert.equal(page.data.themeClass, 'theme-dark');
  }
});

test('location is explicitly WGS84 and requested only by the user handler', () => {
  const { page, calls, service } = harness('location');
  page.onShow();
  assert.equal(calls.some(call => call.key === 'getLocation'), false);
  page.locate();
  const call = calls.find(entry => entry.key === 'getLocation');
  assert.equal(call.options.type, 'wgs84');
  call.options.success({ latitude: 0, longitude: 0, accuracy: 20 });
  assert.deepEqual(service.state.location, { latitude: 0, longitude: 0, accuracyMeters: 20, crs: 'WGS84' });
  assert.equal(service.state.locationLabel, '当前位置');
  noSensitiveRenderedFields(page);
});

test('late device location is discarded after app epoch invalidation', () => {
  const initial = state();
  const { page, calls } = harness('location', initial);
  page.onShow(); page.locate();
  initial.epoch += 1; initial.location = null; initial.locationLabel = ''; initial.status = 'idle'; initial.config = null;
  page.syncState();
  calls.find(call => call.key === 'getLocation').options.success({ latitude: 0, longitude: 0 });
  assert.equal(initial.location, null);
  assert.equal(page.data.locating, false);
  assert.equal(page.data.canSearch, false);
});

test('location search preserves response order and passes only an index through UI', async () => {
  const places = ['地点 B', '地点 A'].map((name, index) => ({ name, address: '合成地址', sourceLabel: '合成来源', providerRank: index + 1, location: { latitude: 0, longitude: 0, crs: 'GCJ02' } }));
  const { page } = harness('location', state(), { searchLocations: async () => ({ dataMode: 'LIVE', results: places }) });
  page.onShow(); page.setData({ query: '合成地点' }); await page.search();
  assert.equal(page.data.places.map(place => place.name).join(','), '地点 B,地点 A');
  noSensitiveRenderedFields(page);
});

test('location search completion cannot restore data after app invalidates the session', async () => {
  const pending = deferred();
  const initial = state();
  const { page } = harness('location', initial, { searchLocations: () => pending.promise });
  page.onShow(); page.setData({ query: '合成地点' }); const loading = page.search();
  initial.epoch += 1; initial.status = 'loading'; initial.config = null;
  page.syncState();
  pending.resolve({ dataMode: 'LIVE', results: [{ name: '旧地点', sourceLabel: '合成来源' }] });
  await loading;
  assert.equal(page.data.places.length, 0); assert.equal(page.data.query, ''); assert.equal(page.data.busy, false);
  initial.config = config(); initial.status = 'ready'; page.syncState();
  assert.equal(page.data.canSearch, true);
});

test('conditions receive async config capabilities without discarding user choices', () => {
  const initial = state({ status: 'loading', config: null });
  const { page } = harness('conditions', initial);
  page.onShow(); assert.equal(page.data.canRecommend, false);
  page.toggleCuisine({ currentTarget: { dataset: { name: '面食' } } });
  initial.config = config(); initial.config.specialtyCapabilities.breakfastProfileEnabled = true; initial.status = 'ready';
  page.syncState();
  assert.equal(page.data.canRecommend, true);
  assert.equal(page.data.options.mealPeriod.map(option => option.value).join(','), 'BREAKFAST,LUNCH');
  assert.equal(page.data.cuisines.find(cuisine => cuisine.name === '面食').selected, true);
  assert.equal(page.data.options.target.length, 1); assert.equal(page.data.showWeather, false); assert.equal(page.data.softPreferences, false);
  assert.equal(page.data.filters.budgetMaxYuan, 25); assert.equal(page.data.filters.availableMinutes, 60); assert.equal(page.data.filters.radiusMeters, 1500);
});

test('conditions cannot retain one cuisine as both preferred and excluded', () => {
  const initial = state(); initial.config.dataRightsMode = 'LICENSED_ENRICHMENT';
  const { page } = harness('conditions', initial); page.onShow();
  page.toggleCuisine({ currentTarget: { dataset: { name: '面食', preferred: 'yes' } } });
  page.toggleCuisine({ currentTarget: { dataset: { name: '面食' } } });
  assert.equal(page.data.preferredCuisines.find(cuisine => cuisine.name === '面食').selected, false);
  assert.equal(page.data.cuisines.find(cuisine => cuisine.name === '面食').selected, true);
});

test('specialty controls fail closed when core recommendation capability is disabled', () => {
  const initial = state();
  initial.config.specialtyCapabilities = { breakfastProfileEnabled: true, milkTeaEnabled: true, userReportedWeatherEnabled: true };
  initial.config.serviceCapabilities.recommendationsEnabled = false;
  const { page } = harness('conditions', initial); page.onShow();
  assert.equal(page.data.options.mealPeriod.length, 1); assert.equal(page.data.options.target.length, 1);
  assert.equal(page.data.showWeather, false); assert.equal(page.data.canRecommend, false);
});

test('revoked specialty selection must be corrected before requesting results', () => {
  const initial = state(); initial.filters.target = 'MILK_TEA';
  const { page, calls } = harness('conditions', initial); page.onShow(); page.submit();
  assert.equal(page.data.selectionError, '已选推荐目标当前未开放，请重新选择。');
  assert.equal(calls.some(call => call.key === 'navigateTo'), false);
});

test('result auto request waits for config and starts only once', async () => {
  const initial = state({ status: 'loading', config: null });
  let count = 0;
  const { page } = harness('results', initial, { async recommend() { count += 1; initial.results = response(); return initial.results; } });
  page.onShow(); assert.equal(count, 0); assert.equal(page.data.canRetry, false);
  initial.config = config(); initial.status = 'ready'; page.syncState(); await tick();
  assert.equal(count, 1); assert.equal(page.data.items.length, 2);
  page.syncState(); assert.equal(count, 1);
});

test('hidden result pages never issue an automatic recommendation during config refresh', () => {
  const initial = state({ status: 'loading', config: null });
  let count = 0;
  const { page } = harness('results', initial, { recommend() { count += 1; return Promise.resolve(response()); } });
  page.onShow(); page.onHide(); initial.config = config(); initial.status = 'ready'; page.syncState();
  assert.equal(count, 0);
});

test('LIVE results preserve provider order, null facts, and no fitting score', () => {
  const initial = state({ results: response() });
  const { page } = harness('results', initial); page.onShow();
  assert.equal(page.data.items.map(value => value.name).join(','), '候选 B,候选 A');
  assert.equal(page.data.items.every(value => !value.fitLabel), true);
  assert.equal(page.data.items[0].price, '人均未知'); assert.equal(page.data.items[0].sourceRating, '');
  noSensitiveRenderedFields(page);
});

test('results clear rendered data when background lifecycle invalidates the session', () => {
  const initial = state({ results: response() });
  const { page } = harness('results', initial); page.onShow();
  initial.epoch += 1; initial.results = null; initial.location = null; initial.config = null; initial.status = 'idle';
  page.syncState();
  assert.equal(page.data.items.length, 0); assert.equal(page.data.hasResponse, false); assert.equal(page.data.canOpen, false); assert.equal(page.data.canRetry, false);
});

test('expired results are not rendered or opened', () => {
  const initial = state({ results: response({ generatedAt: new Date(Date.now() - 7200001).toISOString() }) });
  const { page, calls } = harness('results', initial); page.onShow(); page.detail({ currentTarget: { dataset: { index: '0' } } });
  assert.equal(page.data.items.length, 0); assert.equal(page.data.hasResponse, false);
  assert.equal(calls.some(call => call.key === 'navigateTo'), false);
});

test('retry uses unchanged filters and distinguishes empty results from a request error', async () => {
  const initial = state({ results: response() });
  const { page, service } = harness('results', initial, { async recommend() { initial.results = response({ results: [] }); return initial.results; } });
  page.onShow(); const before = clone(initial.filters); await page.load();
  assert.deepEqual(initial.filters, before); assert.equal(page.data.hasResponse, true); assert.equal(page.data.items.length, 0); assert.equal(page.data.error, '');
  service.recommend = async () => { initial.results = null; throw new Error('合成网络失败'); }; await page.load();
  assert.equal(page.data.hasResponse, false); assert.equal(page.data.error, '合成网络失败');
});

test('detail navigation accepts only explicit GCJ02 and allowed server actions', () => {
  const initial = state({ results: response() }); const result = initial.results.results[0];
  const { page, calls } = harness('detail', initial); page.onShow(); page.navigate();
  assert.equal(calls.filter(call => call.key === 'openLocation').length, 1);
  result.location.crs = 'WGS84'; page.navigate(); assert.equal(page.data.canNavigate, false);
  result.location.crs = 'GCJ02'; result.actions.navigate = false; page.navigate();
  assert.equal(calls.filter(call => call.key === 'openLocation').length, 1);
  noSensitiveRenderedFields(page);
});

test('detail phone and clipboard recheck both facts and server authorization', () => {
  const initial = state({ results: response() }); const result = initial.results.results[0];
  const { page, calls } = harness('detail', initial); page.onShow(); page.call();
  assert.equal(calls.find(call => call.key === 'makePhoneCall').options.phoneNumber, '01012345678');
  result.phone = '010-12345678;1234'; page.call(); assert.equal(page.data.canCall, false);
  result.actions.copyAddress = false; page.copyAddress(); assert.equal(page.data.canCopy, false);
  assert.equal(calls.some(call => call.key === 'setClipboardData'), false);
  result.actions.copyAddress = true; result.address = ' '; page.copyAddress(); assert.equal(page.data.canCopy, false);
});

test('detail session identity and epoch prevent opening a replacement result', () => {
  const initial = state({ results: response() });
  const { page, calls } = harness('detail', initial); page.onShow();
  initial.results = response(); page.syncState(); page.navigate();
  assert.equal(page.data.current, false); assert.equal(page.data.result, null);
  assert.equal(page._response, null);
  assert.equal(calls.some(call => call.key === 'openLocation'), false);
  initial.epoch += 1; page.syncState(); assert.equal(page.data.canCall, false);
});

test('share stays closed on all recommendation pages', () => {
  for (const name of ['location', 'conditions', 'results', 'detail']) {
    const { page, calls } = harness(name, state({ results: response() })); page.onShow();
    assert.equal(page.onShareAppMessage, undefined); assert.equal(page.onShareTimeline, undefined);
    assert.equal(calls.some(call => call.key === 'hideShareMenu'), true);
    const template = fs.readFileSync(path.join(__dirname, '..', 'pages', name, 'index.wxml'), 'utf8');
    assert.equal(/open-type\s*=\s*["']share["']/.test(template), false);
    assert.equal(template.includes('&amp;&amp;'), false);
  }
});
