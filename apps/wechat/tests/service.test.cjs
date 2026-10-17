'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// All fixtures are synthetic, including coordinates, result handles and identities.
const ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'A'.repeat(43);
const LOCATION = { latitude: 0, longitude: 0, crs: 'GCJ02', accuracyMeters: 30 };
const HEADER = { 'x-chishenme-contract-version': '1' };
function config(changes = {}) {
  return {
    coverageName: '全国', dataRightsMode: 'LIVE_DISPLAY_ONLY', aiEnabled: false,
    accountsEnabled: true, favoritesEnabled: false, supportFeedbackEnabled: true,
    minimumSupportedVersion: '0.1.3', ruleVersion: 'rules-test', promptVersion: 'prompt-test', modelVersion: 'rules',
    recommendationDefaults: { areaCode: 'NATIONWIDE', defaultRadiusMeters: 1500, maximumRadiusMeters: 5000 },
    authCapabilities: { accountsEnabled: true, registrationEnabled: true, phoneEnabled: true, emailEnabled: true, wechatEnabled: true, qqEnabled: true, dataExportEnabled: true },
    serviceCapabilities: { recommendationsEnabled: true, groupRecommendationsEnabled: false, locationSearchEnabled: true, placeSearchEnabled: false },
    persistenceCapabilities: { favoritesEnabled: false, historyEnabled: false, privateFeedbackEnabled: false, savedResourceIdsEnabled: false },
    specialtyCapabilities: { breakfastProfileEnabled: true, dinnerProfileEnabled: true, milkTeaEnabled: false, coffeeEnabled: false, dessertEnabled: false, userReportedWeatherEnabled: false },
    ...changes,
  };
}
function result(changes = {}) {
  return {
    provider: 'SYNTHETIC', resultToken: TOKEN, dataMode: 'DEMO',
    actions: { navigate: true, call: false, copyAddress: true, share: false },
    name: '合成测试餐厅', address: '合成测试地址', rank: 1, fitScore: null,
    sourceRating: null, averageCostYuan: 10, distanceMeters: 300,
    estimatedTravelMinutes: 5, estimatedMealMinutes: 20, openStatus: 'UNKNOWN', tags: ['面食'],
    imageUrl: null, phone: null, location: { ...LOCATION },
    reasons: [{ code: 'DISTANCE_FIT', text: '合成测试说明' }], warnings: ['仅为测试夹具'],
    confidence: 'LOW', aiAssisted: false, sourceAttribution: '合成测试数据', ...changes,
  };
}
function response(changes = {}) {
  return {
    requestId: ID, generatedAt: new Date().toISOString(), coverage: 'NATIONWIDE',
    dataRightsMode: 'LIVE_DISPLAY_ONLY', ruleVersion: 'rules-test', promptVersion: 'prompt-test', modelVersion: 'rules',
    aiFallbackUsed: false, profile: { target: 'MEAL', family: 'MEAL_LUNCH', version: 'meal-lunch-v1', providerCapabilityRequired: false },
    weatherApplication: { kind: 'NONE', version: 'weather-none-v1', queryModifier: null },
    results: [result()], notice: null, ...changes,
  };
}
function harness() {
  const calls = [];
  global.wx = {
    request(options) {
      const call = { options, aborted: false };
      calls.push(call);
      return { abort() { call.aborted = true; options.fail({ errMsg: 'private transport detail' }); } };
    },
    setStorageSync() { throw new Error('Transient state must not be persisted'); },
    setStorage() { throw new Error('Transient state must not be persisted'); },
  };
  const modulePath = require.resolve('../lib/service.js');
  delete require.cache[modulePath];
  const service = require(modulePath);
  function reply(index, data, statusCode = 200, header = HEADER) {
    calls[index].options.success({ data, statusCode, header });
  }
  async function ready(value = config()) {
    service.setConsent(true);
    const promise = service.refreshConfig();
    reply(calls.length - 1, value);
    return promise;
  }
  return { service, calls, reply, ready };
}
test.afterEach(() => { delete global.wx; });

test('no network before consent, including account transport and config', async () => {
  const { service: s, calls } = harness();
  assert.equal(s.VERSION, '0.1.11-alpha');
  assert.equal(s.state.status, 'idle');
  await assert.rejects(s.request('/v1/auth/identities'), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(s.refreshConfig(), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(s.recommend(), { code: 'CONSENT_REQUIRED' });
  assert.equal(calls.length, 0);
});

test('contract handshake, public token stripping, fixed origin, safe account query', async () => {
  const { service: s, calls, reply, ready } = harness();
  await ready();
  assert.equal(s.state.status, 'ready');
  const publicRequest = s.request('/v1/location-city', { method: 'POST', data: { location: LOCATION }, token: TOKEN });
  assert.equal(calls[1].options.url, 'https://api.eatwhat.pro/v1/location-city');
  assert.equal(calls[1].options.header['X-ChiShenMe-Contract-Version'], '1');
  assert.equal(calls[1].options.header.Authorization, undefined);
  reply(1, { city: null });
  await publicRequest;
  const account = s.request('/v1/auth/sessions?includePlatforms=ALL', { token: TOKEN });
  assert.equal(calls[2].options.header.Authorization, `Bearer ${TOKEN}`);
  reply(2, { sessions: [] });
  await account;
  for (const path of ['https://evil.invalid/v1/config', '//evil.invalid/v1/config', '/v1/../config', '/v1/config?latitude=0', '/v1/auth/sessions?includePlatforms=ALL&includePlatforms=ALL', '/v1/account/../../admin']) {
    await assert.rejects(s.request(path), { code: 'INVALID_PATH' });
  }
  assert.equal(calls.length, 3);
});

test('missing, duplicate and incompatible contract headers fail closed; errors hide server content', async () => {
  for (const header of [{}, { [Object.keys(HEADER)[0]]: '2' }, { ...HEADER, 'X-ChiShenMe-Contract-Version': '1' }, { 'X-ChiShenMe-Contract-Version': ['1'] }]) {
    const { service: s, reply } = harness();
    s.setConsent(true);
    const promise = s.refreshConfig();
    reply(0, config(), 200, header);
    await assert.rejects(promise, { code: 'CONTRACT_INCOMPATIBLE' });
    assert.equal(s.state.config, null);
    assert.equal(s.state.status, 'error');
  }
  const { service: s, reply } = harness();
  s.setConsent(true);
  const promise = s.request('/v1/config');
  reply(0, { message: 'SECRET_COORDINATE_AND_PROVIDER_KEY' }, 503, {});
  await assert.rejects(promise, error => error.code === 'HTTP_503' && !error.message.includes('SECRET'));
  global.wx.request = () => { const error = new Error('SECRET_NATIVE_DETAIL'); error.code = 'ENET'; throw error; };
  await assert.rejects(s.request('/v1/config'), error => error.code === 'NETWORK_UNAVAILABLE' && !error.message.includes('SECRET'));
});

test('withdrawal aborts and rejects in-flight operations, ignores late responses and clears sensitive state', async () => {
  const { service: s, calls, reply, ready } = harness();
  await ready();
  s.setLocation(LOCATION, '合成测试地点');
  const pendingResult = assert.rejects(s.recommend(), { code: 'CANCELLED' });
  s.setConsent(false);
  assert.equal(calls[1].aborted, true);
  reply(1, response());
  await pendingResult;
  assert.equal(s.state.consent, false);
  assert.equal(s.state.location, null);
  assert.equal(s.state.locationLabel, '');
  assert.equal(s.state.config, null);
  assert.equal(s.state.results, null);
  assert.equal(s.state.status, 'idle');
});

test('invalidate keeps consent but cancels request already resolved before consumer continuation', async () => {
  const { service: s, reply } = harness();
  s.setConsent(true);
  const pending = s.refreshConfig();
  const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  reply(0, config());
  s.invalidate();
  await rejected;
  assert.equal(s.state.consent, true);
  assert.equal(s.state.config, null);
});

test('new configuration wins races; failure cannot retain old capabilities or results', async () => {
  const { service: s, calls, reply, ready } = harness();
  await ready();
  s.setLocation(LOCATION, '合成地点');
  const first = assert.rejects(s.refreshConfig(), { code: 'CANCELLED' });
  const second = s.refreshConfig();
  reply(1, config());
  reply(2, config({ aiEnabled: true }));
  await first;
  await second;
  assert.equal(calls[1].aborted, true);
  assert.equal(s.state.config.aiEnabled, true);
  assert.deepEqual(s.state.location, LOCATION);
  const invalid = s.refreshConfig();
  reply(3, config({ accountsEnabled: 'true' }));
  await assert.rejects(invalid, { code: 'INVALID_RESPONSE' });
  assert.equal(s.state.config, null);
  assert.equal(s.state.status, 'error');
  await assert.rejects(s.recommend(), { code: 'CONFIG_UNAVAILABLE' });
});

test('minimum supported mini-program version is authoritative and malformed versions fail closed', async () => {
  const { service: s, ready } = harness();
  await assert.rejects(ready(config({ minimumSupportedVersions: { android: '0.1.3', miniprogram: '0.1.12' } })), { code: 'UPDATE_REQUIRED' });
  assert.equal(s.state.status, 'update-required');
  assert.equal(s.state.config, null);
  const next = harness();
  await assert.rejects(next.ready(config({ minimumSupportedVersion: '0.1' })), { code: 'INVALID_RESPONSE' });
});

test('LIVE config rejects persistence, missing service fields disable paths, specialty declarations are atomic', async () => {
  let h = harness();
  await assert.rejects(h.ready(config({ persistenceCapabilities: { favoritesEnabled: false, historyEnabled: true, privateFeedbackEnabled: false, savedResourceIdsEnabled: false } })), { code: 'INVALID_RESPONSE' });
  h = harness();
  await h.ready(config({ serviceCapabilities: undefined, authCapabilities: undefined, specialtyCapabilities: undefined }));
  await assert.rejects(h.service.searchLocations('测试地名'), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.service.state.config.authCapabilities.phoneEnabled, false);
  h = harness();
  await assert.rejects(h.ready(config({ specialtyCapabilities: { breakfastProfileEnabled: true } })), { code: 'INVALID_RESPONSE' });
});

test('recommend posts exact bounded defaults, does not add auth, stores only validated ordered results in memory', async () => {
  const { service: s, calls, reply, ready } = harness();
  await ready();
  s.setLocation(LOCATION, '合成地点');
  const pending = s.recommend();
  const sent = calls[1].options;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.header.Authorization, undefined);
  assert.equal(sent.data.partySize, 1);
  assert.equal(sent.data.aiAssistanceEnabled, false);
  assert.equal(sent.data.mealPeriod, 'LUNCH');
  assert.equal(sent.data.target, 'MEAL');
  assert.equal(sent.data.availableMinutes, 60);
  assert.equal(sent.data.budgetMaxYuan, 25);
  assert.equal(sent.data.radiusMeters, 1500);
  assert.equal(sent.data.decisionMode, 'QUICK');
  assert.deepEqual(sent.data.location, LOCATION);
  assert.deepEqual(sent.data.weatherContext, { kind: 'NONE' });
  assert.equal(Number.isFinite(Date.parse(sent.data.requestTime)), true);
  const value = response({ results: [result(), result({ resultToken: 'B'.repeat(43), rank: 2, name: '第二合成餐厅' })] });
  reply(1, value);
  const accepted = await pending;
  assert.equal(accepted, s.state.results);
  assert.deepEqual(accepted.results.map(item => item.rank), [1, 2]);
  assert.equal(Object.isFrozen(accepted.results), true);
});

test('superseded recommendations are aborted; stale responses never replace a newer result', async () => {
  const { service: s, calls, reply, ready } = harness();
  await ready();
  s.setLocation(LOCATION);
  const first = assert.rejects(s.recommend(), { code: 'CANCELLED' });
  const second = s.recommend();
  assert.equal(calls[1].aborted, true);
  reply(2, response({ requestId: '22222222-2222-4333-8444-555555555555' }));
  await second;
  reply(1, response());
  await first;
  assert.equal(s.state.results.requestId, '22222222-2222-4333-8444-555555555555');
});

test('invalid result schemas, provider order and request constraints are rejected', async () => {
  const variants = [
    { results: [result({ resultToken: 'short' })] },
    { results: [result(), result({ rank: 2 })] },
    { results: [result({ rank: 2 })] },
    { results: [result({ fitScore: 90 })] },
    { results: [result({ distanceMeters: NaN })] },
    { results: [result({ distanceMeters: 1501 })] },
    { results: [result({ averageCostYuan: 26 })] },
    { results: [result({ openStatus: 'CLOSED' })] },
    { results: [result({ imageUrl: 'http://example.invalid/test.png' })] },
    { results: [result({ aiAssisted: true })] },
    { results: [result({ actions: { navigate: true, call: false, copyAddress: true, share: true } })] },
    { dataRightsMode: 'LICENSED_ENRICHMENT' },
    { generatedAt: new Date(Date.now() - 7200001).toISOString() },
    { profile: { target: 'MEAL', family: 'MEAL_DINNER', version: 'meal-dinner-v1', providerCapabilityRequired: false } },
    { weatherApplication: { kind: 'USER_REPORTED', version: 'user-reported-weather-v1', preference: 'WARMING', queryModifier: 'PREFER_WARMING_OPTIONS' } },
  ];
  for (const variant of variants) {
    const { service: s, reply, ready } = harness();
    await ready();
    s.setLocation(LOCATION);
    const pending = s.recommend();
    reply(1, response(variant));
    await assert.rejects(pending, { code: 'INVALID_RESPONSE' });
    assert.equal(s.state.results, null);
  }
});

test('specialty/AI gates and LIVE preference behavior preserve hard exclusions', async () => {
  const { service: s, calls, reply, ready } = harness();
  await ready(config({ aiEnabled: true }));
  s.setLocation(LOCATION);
  s.setFilters({ target: 'COFFEE' });
  await assert.rejects(s.recommend(), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(calls.length, 1);
  s.setFilters({ target: 'MEAL', mealPeriod: 'BREAKFAST', aiAssistanceEnabled: true, excludedCuisines: ['川湘菜'], preferredCuisines: ['面食'], explorationMode: 'ADVENTUROUS' });
  const pending = s.recommend();
  assert.equal(calls[1].options.data.aiAssistanceEnabled, false);
  assert.deepEqual(calls[1].options.data.preferredCuisines, []);
  assert.equal(calls[1].options.data.explorationMode, 'BALANCED');
  assert.deepEqual(calls[1].options.data.excludedCuisines, ['川湘菜']);
  reply(1, response({ profile: { target: 'MEAL', family: 'MEAL_BREAKFAST', version: 'meal-breakfast-v1', providerCapabilityRequired: false }, results: [result({ tags: ['川菜'] })] }));
  await assert.rejects(pending, { code: 'INVALID_RESPONSE' });
});

test('filters validate atomically and changing filters invalidates old results', async () => {
  const { service: s, reply, ready } = harness();
  await ready();
  s.setLocation(LOCATION);
  const previous = { ...s.state.filters };
  assert.throws(() => s.setFilters({ radiusMeters: 10 }), { code: 'INVALID_INPUT' });
  assert.deepEqual(s.state.filters, previous);
  assert.throws(() => s.setFilters({ partySize: 2 }), { code: 'INVALID_INPUT' });
  const pending = s.recommend();
  reply(1, response());
  await pending;
  s.setFilters({ budgetMaxYuan: 40 });
  assert.equal(s.state.results, null);
  const refresh = s.refreshConfig();
  reply(2, config({ recommendationDefaults: { areaCode: 'NATIONWIDE', defaultRadiusMeters: 3000, maximumRadiusMeters: 5000 } }));
  await refresh;
  assert.equal(s.state.filters.radiusMeters, 3000);
  s.setFilters({ radiusMeters: 1000 });
  const later = s.refreshConfig();
  reply(3, config());
  await later;
  assert.equal(s.state.filters.radiusMeters, 1000);
});

test('location search rejects sensitive inputs and validates response; city sends coordinate body without accuracy', async () => {
  const { service: s, calls, reply, ready } = harness();
  await ready();
  for (const query of ['x', '0,0', '13900000000', 'test@example.invalid', '测试|地点']) {
    await assert.rejects(s.searchLocations(query), { code: 'INVALID_INPUT' });
  }
  assert.equal(calls.length, 1);
  const search = s.searchLocations('测试地点');
  assert.deepEqual(calls[1].options.data, { query: '测试地点' });
  reply(1, { requestId: ID, dataSource: 'SYNTHETIC', dataMode: 'DEMO', results: [{ name: '合成地点', address: null, location: LOCATION, sourceLabel: '合成测试', providerRank: 1 }] });
  assert.equal((await search).results.length, 1);
  const city = s.cityFor(LOCATION);
  assert.deepEqual(calls[2].options.data, { location: { latitude: 0, longitude: 0, crs: 'GCJ02' } });
  assert.equal(calls[2].options.header.Authorization, undefined);
  reply(2, { city: '测试城市' });
  assert.equal(await city, '测试城市');
  const bad = s.cityFor(LOCATION);
  reply(3, { city: '测试城市', latitude: 0 });
  await assert.rejects(bad, { code: 'INVALID_RESPONSE' });
});

test('empty recommendations and legacy lunch defaults are compatible', async () => {
  const { service: s, reply, ready } = harness();
  await ready();
  s.setLocation(LOCATION);
  const pending = s.recommend();
  const empty = response({ results: [] });
  delete empty.profile;
  delete empty.weatherApplication;
  reply(1, empty);
  const value = await pending;
  assert.equal(value.profile.family, 'MEAL_LEGACY');
  assert.deepEqual(value.results, []);
});
