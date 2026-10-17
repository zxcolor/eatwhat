const test = require('node:test');
const assert = require('node:assert/strict');
const { createSavedClient, validPresentation, validRecord, validPage } = require('../lib/saved');

// Synthetic account records and injected transport only. No network, WeChat,
// storage, provider data or real account is used by these tests.
const NOW = Date.parse('2026-10-17T01:00:00Z');
const ID = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const TOKEN = 'r'.repeat(43);
const CURSOR = 'c'.repeat(43);
const clone = value => JSON.parse(JSON.stringify(value));
function presentation() { return { presentationStatus: 'AVAILABLE', name: '合成餐厅', address: '合成街道', sourceLabel: '授权合成夹具', dataMode: 'LIVE', openStatus: 'UNKNOWN', averageCostYuan: 25, tags: ['合成标签'], resolvedAt: '2026-10-17T00:00:00Z' }; }
function favorite(id = ID, group = 'WANT_TO_GO') { return { favoriteId: id, group, createdAt: '2026-10-17T00:00:00Z', presentation: presentation() }; }
function feedback(id = ID, type = 'LIKE') { return { feedbackId: id, type, visibility: 'PRIVATE', createdAt: '2026-10-17T00:00:00Z', presentation: presentation() }; }
function history(id = ID) { return { historyId: id, action: 'NAVIGATION_OPENED', mealPeriod: 'LUNCH', occurredAt: '2026-10-17T00:00:00Z', expiresAt: new Date(Date.parse('2026-10-17T00:00:00Z') + 90 * 86400000).toISOString(), presentation: presentation() }; }
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(handler = async () => { throw new Error('Unexpected transport call'); }) {
  const state = { consent: true, status: 'ready', epoch: 1, config: { accountsEnabled: true, favoritesEnabled: true, authCapabilities: { accountsEnabled: true }, dataRightsMode: 'LICENSED_ENRICHMENT', persistenceCapabilities: { favoritesEnabled: true, historyEnabled: true, privateFeedbackEnabled: true, savedResourceIdsEnabled: true } } };
  const result = { dataMode: 'LIVE', resultToken: TOKEN, name: 'This must not be uploaded', location: { latitude: 12.34, longitude: 56.78 } };
  const response = { requestId: OTHER, generatedAt: '2026-10-17T00:00:00Z', dataRightsMode: 'LICENSED_ENRICHMENT', results: [result] };
  state.results = response;
  const auth = { signedIn: true, authenticationRevision: 1 };
  const calls = [];
  const account = { view: () => auth, authorizedRequest(path, options) { calls.push({ path, options: clone(options) }); return handler(path, options); } };
  let sequence = 1;
  const client = createSavedClient({ state }, account, { now: () => NOW, uuid: () => `20000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}` });
  return { state, auth, calls, client, result, response };
}
function safeProjection(value) { assert.equal(/resultToken|latitude|longitude|accessToken|refreshToken|nextCursor/.test(JSON.stringify(value)), false); assert.equal(JSON.stringify(value).includes(CURSOR), false); }

test('every persistence path stays closed for LIVE_DISPLAY_ONLY even with contradictory flags', async () => {
  const f = fixture(); f.state.config.dataRightsMode = 'LIVE_DISPLAY_ONLY';
  for (const section of ['FAVORITES', 'HISTORY', 'PRIVATE_FEEDBACK']) await assert.rejects(f.client.load(section), { code: 'RIGHTS_UNAVAILABLE' });
  await assert.rejects(f.client.createFavorite(f.response, f.result, 'WANT_TO_GO'), { code: 'RIGHTS_UNAVAILABLE' });
  await assert.rejects(f.client.createFeedback(f.response, f.result, 'LIKE'), { code: 'RIGHTS_UNAVAILABLE' });
  await assert.rejects(f.client.clear('HISTORY'), { code: 'RIGHTS_UNAVAILABLE' });
  assert.deepEqual(f.client.view().sections, []); assert.equal(f.calls.length, 0);
});

test('consent, fresh configuration, both accounts flags, saved IDs, section flag and login are independently required', async () => {
  const changes = [f => { f.state.consent = false; }, f => { f.state.status = 'loading'; }, f => { f.state.config = null; }, f => { f.state.config.accountsEnabled = false; }, f => { f.state.config.authCapabilities.accountsEnabled = false; }, f => { delete f.state.config.persistenceCapabilities; }, f => { f.state.config.persistenceCapabilities.savedResourceIdsEnabled = false; }, f => { f.state.config.persistenceCapabilities.favoritesEnabled = false; }];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.client.load('FAVORITES'), { code: 'RIGHTS_UNAVAILABLE' }); assert.equal(f.calls.length, 0); }
  const f = fixture(); f.auth.signedIn = false; await assert.rejects(f.client.load('FAVORITES'), { code: 'LOGIN_REQUIRED' }); assert.equal(f.calls.length, 0);
});

test('favorites pagination follows only the opaque cursor, deduplicates records and omits credentials from view', async () => {
  let count = 0;
  const f = fixture(async () => ++count === 1 ? { items: [favorite()], nextCursor: CURSOR } : { items: [favorite(), favorite(OTHER, 'REGULAR')], nextCursor: null });
  await f.client.load('FAVORITES'); await f.client.load('FAVORITES', true);
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/favorites?limit=20', `/v1/favorites?limit=20&cursor=${CURSOR}`]);
  assert.equal(f.client.view().rows.length, 2); assert.equal(f.client.view().hasMore, false);
  safeProjection(f.client.view()); assert.deepEqual(f.calls[0].options, { method: 'GET' });
});

test('history and private feedback paginate with their actual contracts', async () => {
  const f = fixture(async path => path.startsWith('/v1/history') ? { items: [history()], nextCursor: null, retentionDays: 90 } : { items: [feedback()], nextCursor: CURSOR });
  await f.client.load('HISTORY'); await f.client.load('PRIVATE_FEEDBACK');
  assert.equal(f.client.view('HISTORY').rows[0].kind, '打开了导航');
  assert.equal(f.client.view('PRIVATE_FEEDBACK').rows[0].kind, '喜欢');
  assert.equal(f.client.view('PRIVATE_FEEDBACK').hasMore, true);
  safeProjection(f.client.view('HISTORY')); safeProjection(f.client.view('PRIVATE_FEEDBACK'));
});

test('a repeated page cursor fails closed and removes the affected rendered page', async () => {
  const f = fixture(async () => ({ items: [favorite()], nextCursor: CURSOR }));
  await f.client.load('FAVORITES'); await assert.rejects(f.client.load('FAVORITES', true), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(f.client.view().rows, []); assert.equal(f.client.view().hasMore, false);
});

test('revoked or temporarily unavailable presentation never carries hidden restaurant fields', () => {
  assert.equal(validPresentation({ presentationStatus: 'RIGHTS_REVOKED', retryable: false }), true);
  assert.equal(validPresentation({ presentationStatus: 'TEMPORARILY_UNAVAILABLE', retryable: true }), true);
  assert.equal(validPresentation({ presentationStatus: 'RIGHTS_REVOKED', retryable: false, name: 'Forbidden' }), false);
  assert.equal(validPresentation({ presentationStatus: 'TEMPORARILY_UNAVAILABLE', retryable: true, location: { latitude: 1, longitude: 2 } }), false);
});

test('strict validators reject unknown fields, sensitive display text, duplicate IDs, bad cursors, dates and retention', () => {
  for (const value of [{ ...favorite(), providerId: 'not-allowed' }, { ...favorite(), createdAt: '2026-02-31T00:00:00Z' }]) assert.equal(validRecord('FAVORITES', value), false);
  for (const text of [TOKEN, '13800138000', 'test@example.invalid', '12.3456, 56.7890']) assert.equal(validPresentation({ ...presentation(), name: text }), false);
  assert.equal(validRecord('PRIVATE_FEEDBACK', { ...feedback(), visibility: 'PUBLIC' }), false);
  assert.equal(validRecord('HISTORY', { ...history(), mealPeriod: 'NIGHT_SNACK' }), false);
  assert.equal(validRecord('HISTORY', { ...history(), expiresAt: '2026-10-18T00:00:00Z' }), false);
  assert.equal(validPage('FAVORITES', { items: [favorite(), favorite()], nextCursor: null }), false);
  assert.equal(validPage('FAVORITES', { items: [], nextCursor: 'short' }), false);
  assert.equal(validPage('HISTORY', { items: [], nextCursor: null, retentionDays: 30 }), false);
});

test('mutation uploads only account-scoped result reference, group and a stable idempotency key', async () => {
  const f = fixture(async () => favorite());
  await f.client.createFavorite(f.response, f.result, 'WANT_TO_GO');
  await f.client.createFavorite(f.response, f.result, 'WANT_TO_GO');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0].options.data).sort(), ['group', 'idempotencyKey', 'result']);
  assert.deepEqual(f.calls[0].options.data.result, { requestId: OTHER, resultToken: TOKEN });
  assert.equal(f.client.creationView(f.response, f.result).favoriteSaved, true);
  safeProjection(f.client.creationView(f.response, f.result)); safeProjection(f.client.view());
});

test('an uncertain save retries with the same idempotency key and disallows changing the unconfirmed payload', async () => {
  let count = 0;
  const f = fixture(async () => { if (++count === 1) throw new Error('untrusted provider error'); return favorite(); });
  await assert.rejects(f.client.createFavorite(f.response, f.result, 'WANT_TO_GO'), { code: 'UNAVAILABLE' });
  await assert.rejects(f.client.createFavorite(f.response, f.result, 'REGULAR'), { code: 'INPUT' });
  await f.client.createFavorite(f.response, f.result, 'WANT_TO_GO');
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0].options.data, f.calls[1].options.data);
});

test('duplicate in-flight submit shares one mutation and different writes are rejected while busy', async () => {
  const pending = deferred(); const f = fixture(() => pending.promise);
  const first = f.client.createFavorite(f.response, f.result, 'WANT_TO_GO');
  const second = f.client.createFavorite(f.response, f.result, 'WANT_TO_GO');
  await assert.rejects(f.client.createFeedback(f.response, f.result, 'LIKE'), { code: 'BUSY' });
  assert.equal(f.calls.length, 1); pending.resolve(favorite()); await Promise.all([first, second]);
});

test('every private feedback type submits once per current recommendation result', async () => {
  const f = fixture(async (_path, options) => feedback(ID, options.data.type));
  const types = f.client.creationView(f.response, f.result).feedbackTypes;
  for (const item of types) { await f.client.createFeedback(f.response, f.result, item.type); await f.client.createFeedback(f.response, f.result, item.type); }
  assert.equal(f.calls.length, 8);
  assert.equal(f.client.creationView(f.response, f.result).feedbackTypes.every(item => item.submitted), true);
  assert.equal(f.calls.every(call => call.path === '/v1/private-feedback' && Object.keys(call.options.data).length === 3), true);
});

test('demo, replacement, detached, stale and display-only recommendation references cannot be submitted', async () => {
  for (const change of [f => { f.result.dataMode = 'DEMO'; }, f => { f.state.results = clone(f.response); }, f => { f.response.results = []; }, f => { f.response.generatedAt = '2026-10-16T20:00:00Z'; }, f => { f.response.dataRightsMode = 'LIVE_DISPLAY_ONLY'; }]) {
    const f = fixture(); change(f); await assert.rejects(f.client.createFavorite(f.response, f.result, 'WANT_TO_GO')); assert.equal(f.calls.length, 0);
  }
});

test('moving a favorite supports both directions with a new key for each actual change', async () => {
  const f = fixture(async (_path, options) => options.method === 'GET' ? { items: [favorite()], nextCursor: null } : favorite(ID, options.data.group));
  await f.client.load('FAVORITES'); await f.client.moveFavorite(ID); await f.client.moveFavorite(ID); await f.client.moveFavorite(ID);
  assert.deepEqual(f.calls.slice(1).map(call => call.options.data.group), ['REGULAR', 'WANT_TO_GO', 'REGULAR']);
  assert.equal(new Set(f.calls.slice(1).map(call => call.options.data.idempotencyKey)).size, 3);
  assert.equal(f.client.view().rows[0].kind, '常吃');
});

test('delete and clear use actual DELETE routes without inventing a history detail endpoint', async () => {
  const f = fixture(async (path, options) => options.method === 'DELETE' ? undefined : { items: path.startsWith('/v1/favorites') ? [favorite()] : [feedback()], nextCursor: null });
  await f.client.load('FAVORITES'); await f.client.remove('FAVORITES', ID);
  await f.client.load('PRIVATE_FEEDBACK'); await f.client.remove('PRIVATE_FEEDBACK', ID);
  await f.client.clear('HISTORY'); await f.client.clear('PRIVATE_FEEDBACK');
  assert.deepEqual(f.calls.filter(call => call.options.method === 'DELETE').map(call => call.path), [`/v1/favorites/${ID}`, `/v1/private-feedback/${ID}`, '/v1/history', '/v1/private-feedback']);
  assert.equal(f.client.view().rows.length, 0); assert.equal(f.client.view('PRIVATE_FEEDBACK').rows.length, 0);
  await assert.rejects(f.client.remove('FAVORITES', OTHER), { code: 'INPUT' });
  await assert.rejects(f.client.remove('HISTORY', ID), { code: 'INPUT' });
});

test('wrong response identity and unexpected DELETE body cannot silently change local records', async () => {
  let mode = 'load';
  const f = fixture(async () => mode === 'load' ? { items: [favorite()], nextCursor: null } : mode === 'move' ? favorite(OTHER, 'REGULAR') : { deleted: true });
  await f.client.load('FAVORITES'); mode = 'move';
  await assert.rejects(f.client.moveFavorite(ID), { code: 'INVALID_RESPONSE' });
  assert.equal(f.client.view().rows[0].group, 'WANT_TO_GO'); mode = 'delete';
  await assert.rejects(f.client.remove('FAVORITES', ID), { code: 'INVALID_RESPONSE' });
  assert.equal(f.client.view().rows.length, 1);
});

test('capability revocation clears all visible record details and rejects old successful callbacks', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture(() => ++count === 1 ? Promise.resolve({ items: [favorite()], nextCursor: CURSOR }) : pending.promise);
  await f.client.load('FAVORITES'); const request = f.client.load('FAVORITES', true);
  f.state.config.dataRightsMode = 'LIVE_DISPLAY_ONLY'; f.client.syncCapabilities();
  assert.deepEqual(f.client.view().rows, []);
  pending.resolve({ items: [favorite(OTHER)], nextCursor: null });
  await assert.rejects(request, { code: 'STALE' }); assert.deepEqual(f.client.view().rows, []);
});

test('old-account 401 cannot clear a new account or display its predecessor records', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture(() => ++count === 1 ? pending.promise : Promise.resolve({ items: [favorite(OTHER)], nextCursor: null }));
  const previous = f.client.load('FAVORITES');
  f.auth.authenticationRevision = 2; f.client.syncCapabilities(); await f.client.load('FAVORITES');
  const revision = f.client.revision(); pending.reject({ statusCode: 401 });
  await assert.rejects(previous, { code: 'STALE' });
  assert.equal(f.client.revision(), revision); assert.equal(f.client.view().rows[0].id, OTHER);
});

test('logout, epoch changes and replaced config objects discard cached data', async () => {
  for (const change of [f => { f.auth.signedIn = false; }, f => { f.state.epoch += 1; }, f => { f.state.config = clone(f.state.config); }]) {
    const f = fixture(async () => ({ items: [favorite()], nextCursor: null })); await f.client.load('FAVORITES'); change(f); assert.deepEqual(f.client.view().rows, []);
  }
});

test('invalidation before the mutation microtask prevents dispatch and does not recreate pending state', async () => {
  const f = fixture(); const operation = f.client.createFavorite(f.response, f.result, 'WANT_TO_GO'); f.client.invalidate();
  await assert.rejects(operation, { code: 'STALE' }); assert.equal(f.calls.length, 0); assert.equal(f.client.view().busy, false);
});

test('response objects are defensively copied and cannot inject fields after validation', async () => {
  const item = favorite(); const f = fixture(async () => ({ items: [item], nextCursor: null })); await f.client.load('FAVORITES');
  item.presentation.name = TOKEN; item.presentation.tags.push('late mutation');
  assert.equal(f.client.view().rows[0].title, '合成餐厅'); assert.deepEqual(f.client.view().rows[0].tags, ['合成标签']);
});
