const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const savedModule = require('../lib/saved');

const ID = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const TOKEN = 'r'.repeat(43);
const CURSOR = 'c'.repeat(43);
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function presentation() { return { presentationStatus: 'AVAILABLE', name: '合成餐厅', address: '合成街道', sourceLabel: '合成授权数据', dataMode: 'LIVE', openStatus: 'UNKNOWN', averageCostYuan: null, tags: [], resolvedAt: new Date().toISOString() }; }
function favorite(id = ID, group = 'WANT_TO_GO') { return { favoriteId: id, group, createdAt: new Date().toISOString(), presentation: presentation() }; }
function history(id = ID) { const time = Date.now(); return { historyId: id, action: 'PHONE_DIALER_OPENED', mealPeriod: 'DINNER', occurredAt: new Date(time).toISOString(), expiresAt: new Date(time + 90 * 86400000).toISOString(), presentation: presentation() }; }
function feedback(type = 'LIKE') { return { feedbackId: ID, type, visibility: 'PRIVATE', createdAt: new Date().toISOString(), presentation: null }; }
function harness(name, options = {}) {
  const state = { consent: true, epoch: 1, status: 'ready', config: { accountsEnabled: true, authCapabilities: { accountsEnabled: true }, dataRightsMode: options.rights || 'LICENSED_ENRICHMENT', persistenceCapabilities: { favoritesEnabled: true, historyEnabled: true, privateFeedbackEnabled: true, savedResourceIdsEnabled: true }, serviceCapabilities: { recommendationsEnabled: true } } };
  const result = { resultToken: TOKEN, name: '合成推荐餐厅', address: '合成地址', sourceAttribution: '合成来源', dataMode: 'LIVE', openStatus: 'UNKNOWN', averageCostYuan: null, distanceMeters: 500, estimatedTravelMinutes: 8, estimatedMealMinutes: 30, sourceRating: null, tags: [], reasons: [], warnings: [], actions: { navigate: true, call: true, copyAddress: true, share: false }, location: { latitude: 0, longitude: 0, crs: 'GCJ02' }, phone: '010-12345678' };
  state.results = { requestId: OTHER, generatedAt: new Date().toISOString(), dataRightsMode: options.rights || 'LICENSED_ENRICHMENT', results: [result] };
  const auth = { signedIn: options.signedIn !== false, authenticationRevision: 1 };
  const calls = []; const events = []; const wxCalls = [];
  const service = { state, recordEvent(index, type, response) { events.push({ index, type, response }); return Promise.resolve(true); } };
  const account = { view: () => auth, authorizedRequest: async (url, request) => {
    calls.push({ url, request: clone(request) });
    if (options.handler) return options.handler(url, request);
    if (request.method === 'DELETE') return undefined;
    if (request.method === 'POST') return url.includes('private-feedback') ? feedback(request.data.type) : favorite(ID, request.data.group);
    return url.includes('/history') ? { items: [history()], nextCursor: null, retentionDays: 90 } : url.includes('private-feedback') ? { items: [feedback()], nextCursor: null } : { items: [favorite()], nextCursor: null };
  } };
  const client = savedModule.createSavedClient(service, account);
  const saved = { ...savedModule, ...client };
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'pages', name, 'index.js'), 'utf8'), {
    require(id) { if (id === '../../lib/service') return service; if (id === '../../lib/saved') return saved; throw new Error(`Unexpected module ${id}`); },
    Page(value) { definition = value; },
    wx: new Proxy({}, { get(_target, property) { if (/storage/i.test(property)) throw new Error('Storage must not be used'); return value => { wxCalls.push({ type: property, value }); }; } }),
    getApp: () => ({ syncPage(page) { page.setData({ themeClass: 'theme-dark' }); } }),
    getCurrentPages: () => [{ route: `pages/${name}/index` }], Date, Number, Object,
  });
  const page = { ...definition, data: clone(definition.data), setData(value) { Object.assign(this.data, clone(value)); } };
  page.onLoad({ section: options.section || 'FAVORITES', index: '0' });
  return { page, calls, wxCalls, auth, state, client, result, events };
}
function noSecrets(page) { const value = JSON.stringify(page.data); assert.equal(/resultToken|latitude|longitude|accessToken|refreshToken|nextCursor/.test(value), false); assert.equal(value.includes(TOKEN), false); assert.equal(value.includes(CURSOR), false); }
function lastModal(f) { return f.wxCalls.filter(call => call.type === 'showModal').at(-1).value; }

test('saved LIVE mode displays closed capabilities without reading records or invoking login', async () => {
  const f = harness('saved', { rights: 'LIVE_DISPLAY_ONLY' }); f.page.onShow(); await tick();
  assert.equal(f.page.data.enabled, false); assert.deepEqual(f.page.data.rows, []); assert.equal(f.calls.length, 0);
  assert.equal(f.wxCalls.some(call => call.type === 'login'), false); noSecrets(f.page);
});

test('saved account reads require explicit login and no login flow starts on show', async () => {
  const f = harness('saved', { signedIn: false }); f.page.onShow(); await tick();
  assert.equal(f.page.data.signedIn, false); assert.equal(f.calls.length, 0); assert.equal(f.page.data.sections.length, 3);
  assert.equal(f.wxCalls.some(call => call.type === 'navigateTo'), false);
  f.page.login(); assert.equal(f.wxCalls.at(-1).value.url, '/pages/account/index');
});

test('saved favorite cards and expanded details are safe projections with no provider actions', async () => {
  const f = harness('saved'); f.page.onShow(); await tick();
  assert.equal(f.page.data.rows[0].title, '合成餐厅'); assert.equal(f.page.data.rows[0].kind, '想去');
  f.page.showDetail({ currentTarget: { dataset: { id: ID } } });
  assert.equal(f.page.data.detail.sourceLabel, '合成授权数据'); noSecrets(f.page);
  assert.equal(f.wxCalls.some(call => ['openLocation', 'makePhoneCall'].includes(call.type)), false);
  f.page.closeDetail(); assert.equal(f.page.data.detail, null);
});

test('saved history supports pagination and details from current safe presentation', async () => {
  let count = 0;
  const f = harness('saved', { section: 'HISTORY', handler: async () => ({ items: [history(++count === 1 ? ID : OTHER)], nextCursor: count === 1 ? CURSOR : null, retentionDays: 90 }) });
  f.page.onShow(); await tick(); await f.page.loadMore();
  assert.equal(f.page.data.rows.length, 2); assert.equal(f.page.data.hasMore, false);
  assert.equal(f.calls[1].url, `/v1/history?limit=20&cursor=${CURSOR}`);
  f.page.showDetail({ currentTarget: { dataset: { id: OTHER } } });
  assert.equal(f.page.data.detail.kind, '打开了拨号器'); assert.ok(f.page.data.detail.expires); noSecrets(f.page);
});

test('move and remove favorite handlers perform only the intended account operations', async () => {
  const f = harness('saved'); f.page.onShow(); await tick();
  await f.page.move({ currentTarget: { dataset: { id: ID } } }); assert.equal(f.page.data.rows[0].kind, '常吃');
  f.page.remove({ currentTarget: { dataset: { id: ID } } });
  lastModal(f).success({ confirm: false }); assert.equal(f.calls.filter(call => call.request.method === 'DELETE').length, 0);
  f.page.remove({ currentTarget: { dataset: { id: ID } } }); lastModal(f).success({ confirm: true }); await tick();
  assert.equal(f.calls.at(-1).url, `/v1/favorites/${ID}`); assert.equal(f.page.data.rows.length, 0);
});

test('confirmation from an older account revision is discarded before clear/delete', async () => {
  const f = harness('saved', { section: 'PRIVATE_FEEDBACK' }); f.page.onShow(); await tick();
  f.page.clearAll(); const modal = lastModal(f); f.auth.authenticationRevision += 1;
  modal.success({ confirm: true }); await tick();
  assert.equal(f.calls.some(call => call.request.method === 'DELETE'), false); f.page.sync(); assert.equal(f.page.data.rows.length, 0);
});

test('history clear is explicit and does not affect local history or send location data', async () => {
  const f = harness('saved', { section: 'HISTORY' }); f.page.onShow(); await tick();
  f.page.clearAll(); assert.match(lastModal(f).content, /不影响本机/); lastModal(f).success({ confirm: true }); await tick();
  assert.deepEqual(f.calls.at(-1), { url: '/v1/history', request: { method: 'DELETE' } }); assert.equal(f.page.data.rows.length, 0);
});

test('hidden saved page clears details and rejects an earlier request completion', async () => {
  const pending = deferred(); const f = harness('saved', { handler: () => pending.promise }); f.page.onShow();
  f.page.onHide(); pending.resolve({ items: [favorite()], nextCursor: null }); await tick();
  assert.deepEqual(f.page.data.rows, []); assert.equal(f.page.data.detail, null); assert.equal(f.page.data.error, '');
});

test('capability change clears an open saved detail and previous section data', async () => {
  const f = harness('saved'); f.page.onShow(); await tick(); f.page.showDetail({ currentTarget: { dataset: { id: ID } } });
  f.state.config.dataRightsMode = 'LIVE_DISPLAY_ONLY'; f.page.syncState();
  assert.equal(f.page.data.detail, null); assert.deepEqual(f.page.data.rows, []); assert.equal(f.page.data.enabled, false);
});

test('detail keeps LIVE persistence disabled while preserving authorized navigation and phone behavior', () => {
  const f = harness('detail', { rights: 'LIVE_DISPLAY_ONLY' }); f.page.onShow();
  assert.equal(f.page.data.canFavorite, false); assert.equal(f.page.data.canFeedback, false);
  f.page.saveFavorite(); f.page.feedback({ currentTarget: { dataset: { type: 'LIKE' } } });
  assert.equal(f.calls.length, 0); assert.equal(f.wxCalls.some(call => call.type === 'showActionSheet'), false);
  f.page.navigate(); const map = f.wxCalls.find(call => call.type === 'openLocation'); map.value.success();
  f.page.call(); const phone = f.wxCalls.find(call => call.type === 'makePhoneCall'); phone.value.success();
  assert.deepEqual(f.events.map(event => event.type), ['NAVIGATION', 'CALL']); assert.equal(f.events[0].response, f.state.results); noSecrets(f.page);
});

test('detail licensed favorite selection and private feedback submit once without exposing result references', async () => {
  const f = harness('detail'); f.page.onShow(); f.page.saveFavorite();
  f.wxCalls.find(call => call.type === 'showActionSheet').value.success({ tapIndex: 1 }); await tick();
  assert.equal(f.calls[0].request.data.group, 'REGULAR'); assert.equal(f.page.data.favoriteSaved, true);
  f.page.saveFavorite(); assert.equal(f.calls.length, 1);
  await f.page.feedback({ currentTarget: { dataset: { type: 'LIKE' } } });
  await f.page.feedback({ currentTarget: { dataset: { type: 'LIKE' } } });
  assert.equal(f.calls.length, 2); assert.equal(f.page.data.feedbackTypes.find(item => item.type === 'LIKE').submitted, true); noSecrets(f.page);
});

test('detail action-sheet and in-flight save responses cannot restore an invalidated result', async () => {
  const pending = deferred(); const f = harness('detail', { handler: () => pending.promise }); f.page.onShow();
  f.page.saveFavorite(); const sheet = f.wxCalls.find(call => call.type === 'showActionSheet').value;
  f.auth.authenticationRevision += 1; sheet.success({ tapIndex: 0 }); await tick(); assert.equal(f.calls.length, 0);
  f.page.sync(); const operation = f.page.feedback({ currentTarget: { dataset: { type: 'LIKE' } } }); await tick();
  f.state.epoch += 1; f.state.results = null; f.page.syncState(); pending.resolve(feedback()); await operation;
  assert.equal(f.page.data.result, null); assert.equal(f.page.data.canFeedback, false); assert.equal(f.page.data.feedbackTypes.length, 0); noSecrets(f.page);
});

test('detail platform failure callbacks do not update an already hidden page', () => {
  const f = harness('detail'); f.page.onShow(); f.page.navigate(); f.page.call(); f.page.copyAddress(); f.page.onHide();
  for (const call of f.wxCalls.filter(item => ['openLocation', 'makePhoneCall', 'setClipboardData'].includes(item.type))) call.value.fail();
  assert.equal(f.page.data.error, '');
});

test('saved and detail templates expose no share actions and only registered handlers', () => {
  for (const name of ['saved', 'detail']) {
    const f = harness(name); const template = fs.readFileSync(path.join(__dirname, '..', 'pages', name, 'index.wxml'), 'utf8');
    assert.equal(/open-type\s*=\s*["']share["']/.test(template), false);
    for (const match of template.matchAll(/(?:bindtap|catchtap)="([A-Za-z]+)"/g)) assert.equal(typeof f.page[match[1]], 'function', `${name}.${match[1]}`);
  }
});
