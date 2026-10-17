const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Page callbacks are evaluated in a synthetic JS context: no real wx/storage/location calls.
function harness(name) {
  const calls = [];
  let definition;
  let listener;
  const service = { state: { consent: true } };
  const records = { list: () => [{ recordedAtEpochMillis: 2000000000000, mealPeriod: 'LUNCH', decisionMode: 'QUICK', budgetMaxYuan: null, availableMinutes: 60, travelMode: 'WALK', resultCount: 3 }], clear: () => { calls.push({ type: 'clear-records' }); } };
  const nearby = {
    RETENTION_MS: 90 * 86400000,
    state: { enabled: false, available: true, phase: 'IDLE', count: 0, attempt: 0, message: '' },
    listSnapshots: () => [], subscribe(callback) { listener = callback; return () => { listener = null; }; },
    async setEnabled(value) { calls.push({ type: 'enabled', value }); },
    async retry() { calls.push({ type: 'retry' }); },
    syncCapabilities() { calls.push({ type: 'configure' }); },
    clear() { calls.push({ type: 'clear-cache' }); },
    dismissReminder() { calls.push({ type: 'dismiss' }); },
  };
  const platform = {
    hideShareMenu() {}, showModal(value) { calls.push({ type: 'modal', ...value }); },
    openSetting(value) { calls.push({ type: 'setting', ...value }); },
    getLocation() { throw new Error('Pages must delegate only after an explicit action'); },
  };
  const source = fs.readFileSync(path.resolve(__dirname, `../pages/${name}/index.js`), 'utf8');
  vm.runInNewContext(source, { require: key => key.endsWith('/service') ? service : key.endsWith('/local-records') ? records : nearby, Page: value => { definition = value; }, wx: platform, getApp: () => ({ syncPage() {} }) });
  const page = { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
  return { page, calls, service, records, nearby, notify: () => { if (listener) listener(); } };
}
test('history page shows only local summary and rejects a confirmation after leaving', () => {
  const h = harness('local-records');
  h.page.onShow();
  assert.equal(h.page.data.entries.length, 1);
  assert.equal(h.page.data.entries[0].summary.includes('预算不限'), true);
  assert.deepEqual(Object.keys(h.page.data.entries[0]), ['id', 'title', 'summary', 'count']);
  h.page.clearRecords();
  const modal = h.calls.find(call => call.type === 'modal');
  h.page.onHide();
  modal.success({ confirm: true });
  assert.equal(h.calls.some(call => call.type === 'clear-records'), false);
  assert.equal(h.page.data.entries.length, 0);
});
test('history page clear uses explicit confirmation and privacy loss clears displayed records', () => {
  const h = harness('local-records');
  h.page.onShow();
  h.page.clearRecords();
  h.calls.find(call => call.type === 'modal').success({ confirm: true });
  assert.equal(h.calls.some(call => call.type === 'clear-records'), true);
  h.service.state.consent = false;
  h.page.syncState();
  assert.equal(h.page.data.entries.length, 0);
});
test('nearby page mount does not locate or opt in and stale opt-in confirmation is ignored', async () => {
  const h = harness('nearby');
  h.page.onShow();
  assert.equal(h.calls.length, 0);
  h.page.enableCollection();
  const modal = h.calls.find(call => call.type === 'modal');
  assert.equal(modal.content.includes('位置和精度'), true);
  h.page.onHide();
  await modal.success({ confirm: true });
  assert.equal(h.calls.some(call => call.type === 'enabled'), false);
});
test('nearby opt-in and permission retries require explicit active consent', async () => {
  const h = harness('nearby');
  h.page.onShow();
  h.page.enableCollection();
  await h.calls.find(call => call.type === 'modal').success({ confirm: true });
  assert.equal(h.calls.some(call => call.type === 'enabled' && call.value === true), true);
  h.nearby.state.enabled = true;
  h.nearby.state.phase = 'PERMISSION';
  h.notify();
  await h.page.retry();
  assert.equal(h.calls.filter(call => call.type === 'retry').length, 1);
  h.service.state.consent = false;
  h.notify();
  await h.page.retry();
  assert.equal(h.calls.filter(call => call.type === 'retry').length, 1);
});
test('nearby clear confirmation cannot apply after page leaves and returning does not retain restaurant display', () => {
  const h = harness('nearby');
  h.page.onShow();
  h.page.clearCache();
  const modal = h.calls.find(call => call.type === 'modal');
  h.page.onHide();
  modal.success({ confirm: true });
  assert.equal(h.calls.some(call => call.type === 'clear-cache'), false);
  assert.equal(h.page.data.snapshots.length, 0);
});
test('nearby UI projects cache data without coordinates or stable provider identifiers', () => {
  const h = harness('nearby');
  h.nearby.listSnapshots = () => [{ id: '123', startedAtMillis: 2000000000000, status: 'COMPLETE', limited: false, pagesCollected: 1, userLocation: { latitude: 0, longitude: 0, crs: 'WGS84', accuracyMeters: null }, restaurants: [{ name: '合成餐厅', address: '合成地址', provider: 'SYNTHETIC', providerPlaceId: 'synthetic-id', location: { latitude: 0, longitude: 0, crs: 'GCJ02' }, sourceAttribution: '合成来源', dataMode: 'DEMO', averageCostYuan: null, sourceRating: null, openStatus: 'UNKNOWN' }] }];
  h.page.onShow();
  h.page.toggleSnapshot({ currentTarget: { dataset: { id: '123' } } });
  assert.equal(h.page.data.snapshots[0].places.length, 1);
  assert.equal(h.page.data.snapshots[0].accuracy, '精度未知');
  const raw = JSON.stringify(h.page.data);
  for (const field of ['latitude', 'longitude', 'providerPlaceId', 'synthetic-id']) assert.equal(raw.includes(field), false);
});
