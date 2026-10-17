const test = require('node:test');
const assert = require('node:assert/strict');
const { createNearby, validatePage, withinRadius, PREFIX, ENABLED_KEY, RETENTION_MS } = require('../lib/nearby');

// All providers, coordinates, records and permissions below are synthetic.
const ORIGIN = { latitude: 0, longitude: 0, crs: 'WGS84' };
function place(id = 'synthetic-1', changes = {}) {
  return { provider: 'SYNTHETIC', providerPlaceId: id, name: '合成餐厅', address: '合成地址', location: { latitude: 0, longitude: 0, crs: 'GCJ02' }, sourceRating: null, averageCostYuan: null, openStatus: 'UNKNOWN', tags: [], phone: null, sourceAttribution: '合成测试来源', dataMode: 'DEMO', ...changes };
}
function page(number = 1, changes = {}) { return { radiusMeters: 3500, retentionDays: 90, page: number, nextPage: null, truncated: false, restaurants: [place()], ...changes }; }
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
function harness(options = {}) {
  const data = new Map();
  const requests = [];
  const locations = [];
  let time = 2000000000000;
  let permission = options.permission !== false;
  let storageLimit = 10240;
  const service = { state: { consent: options.consent !== false, status: 'ready', epoch: 1, config: { nearbyRestaurantCollectionEnabled: options.capability !== false, dataRightsMode: 'LIVE_DISPLAY_ONLY' } },
    request(path, requestOptions) {
      requests.push({ path, ...requestOptions });
      return options.request ? options.request(path, requestOptions) : Promise.resolve(page(requestOptions.data.page));
    },
  };
  const platform = {
    getStorageSync: key => data.get(key), setStorageSync: (key, value) => data.set(key, value), removeStorageSync: key => data.delete(key),
    getStorageInfoSync: () => ({ keys: [...data.keys()], currentSize: [...data.values()].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0) / 1024, limitSize: storageLimit }),
    getSetting: callbacks => callbacks.success({ authSetting: { 'scope.userLocation': permission } }),
    getLocation(callbacks) { locations.push(callbacks); if (!options.deferLocation) callbacks.success({ latitude: 0, longitude: 0, accuracy: 12 }); },
  };
  const nearby = createNearby({ service, platform, now: () => time, retryDelayMs: 0 });
  if (options.enabled !== false) data.set(ENABLED_KEY, true);
  return { nearby, service, platform, data, requests, locations, advance: value => { time += value; }, permission: value => { permission = value; }, capacity: value => { storageLimit = value; } };
}
test('requires consent, independent capability and an explicit local opt-in', async () => {
  for (const settings of [{ consent: false }, { capability: false }, { enabled: false }]) {
    const h = harness(settings);
    await h.nearby.open();
    assert.equal(h.requests.length, 0);
    assert.equal(h.locations.length, 0);
    assert.equal([...h.data.keys()].filter(key => key.startsWith(PREFIX)).length, 0);
  }
});
test('no permission causes a visible state, never an implicit permission prompt', async () => {
  const h = harness({ permission: false });
  await h.nearby.open();
  assert.equal(h.nearby.state.phase, 'PERMISSION');
  assert.equal(h.locations.length, 0);
  await h.nearby.retry();
  assert.equal(h.locations.length, 1);
  assert.equal(h.nearby.state.phase, 'DONE');
});
test('one collection per foreground opening, settings/config refresh cannot repeat it', async () => {
  const h = harness();
  await h.nearby.open();
  await h.nearby.open();
  await h.nearby.syncCapabilities();
  assert.equal(h.requests.length, 1);
  h.nearby.stop();
  h.advance(10);
  await h.nearby.open();
  assert.equal(h.requests.length, 2);
  assert.equal(h.nearby.listSnapshots().length, 2);
});
test('independent endpoint uses POST coordinates without accuracy, provider IDs dedupe and order is preserved', async () => {
  const h = harness({ request: (_, request) => Promise.resolve(request.data.page === 1 ? page(1, { nextPage: 2, restaurants: [place('a'), place('b')] }) : page(2, { truncated: true, restaurants: [place('a', { name: '更新后的合成餐厅' }), place('c')] })) });
  await h.nearby.open();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0], { path: '/v1/restaurants/nearby', method: 'POST', data: { location: ORIGIN, page: 1 } });
  const snapshot = h.nearby.listSnapshots()[0];
  assert.deepEqual(snapshot.restaurants.map(value => value.providerPlaceId), ['a', 'b', 'c']);
  assert.equal(snapshot.restaurants[0].name, '更新后的合成餐厅');
  assert.deepEqual(snapshot.userLocation, { ...ORIGIN, accuracyMeters: 12 });
  assert.equal(snapshot.status, 'COMPLETE');
  assert.equal(snapshot.limited, true);
  assert.equal(snapshot.pagesCollected, 2);
});
test('snapshot keeps unknown accuracy explicitly null and accepts large reported accuracy locally', async () => {
  for (const accuracy of [undefined, 0, -1, NaN, 25000]) {
    const h = harness({ deferLocation: true });
    const pending = h.nearby.open();
    await tick();
    h.locations[0].success({ latitude: 0, longitude: 0, accuracy });
    await pending;
    assert.equal(h.nearby.listSnapshots()[0].userLocation.accuracyMeters, accuracy === 25000 ? 25000 : null);
  }
});
test('strict page validation rejects malformed, oversized, unbounded or recommendation-shaped data', () => {
  for (const value of [
    page(1, { radiusMeters: 10000 }), page(1, { retentionDays: 91 }), page(2), page(1, { nextPage: 3 }),
    page(1, { truncated: true }), page(1, { restaurants: Array.from({ length: 26 }, () => place()) }),
    page(1, { restaurants: [place('x', { location: { latitude: 1, longitude: 1, crs: 'GCJ02' } })] }),
    page(1, { restaurants: [place('x', { resultToken: 'x'.repeat(43) })] }),
    page(1, { restaurants: [place('x', { provider: 'invalid' })] }),
    page(1, { restaurants: [place('x', { dataMode: 'UNKNOWN' })] }),
    page(1, { restaurants: [place('x', { openStatus: 'INVALID' })] }),
    page(1, { restaurants: [place('x', { tags: [' '] })] }),
    page(1, { restaurants: [place('x', { sourceRating: 6 })] }),
    page(1, { restaurants: [place('x', { averageCostYuan: 20001 })] }),
    page(1, { restaurants: [place('x', { location: { latitude: NaN, longitude: 0, crs: 'GCJ02' } })] }),
    page(1, { extra: 'untrusted' }),
  ]) assert.throws(() => validatePage(value, 1, ORIGIN), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validatePage(page(2, { nextPage: 2 }), 2, ORIGIN), { code: 'INVALID_RESPONSE' });
});
test('CRS alignment follows Android: WGS84 to GCJ02 supported, reverse transform fails closed', () => {
  assert.equal(withinRadius(ORIGIN, { latitude: 0, longitude: 0, crs: 'GCJ02' }), true);
  assert.equal(withinRadius({ ...ORIGIN, crs: 'GCJ02' }, ORIGIN), false);
  assert.equal(withinRadius(ORIGIN, { latitude: 0.031, longitude: 0, crs: 'WGS84' }), true);
  assert.equal(withinRadius(ORIGIN, { latitude: 0.032, longitude: 0, crs: 'WGS84' }), false);
});
test('failed page two leaves a partial first page without retrying the API', async () => {
  const h = harness({ request: (_, request) => request.data.page === 1 ? Promise.resolve(page(1, { nextPage: 2 })) : Promise.reject(new Error('private upstream response')) });
  await h.nearby.open();
  const snapshot = h.nearby.listSnapshots()[0];
  assert.equal(snapshot.status, 'PARTIAL');
  assert.equal(snapshot.pagesCollected, 1);
  assert.equal(snapshot.restaurants.length, 1);
  assert.equal(h.nearby.state.phase, 'FAILED');
  assert.equal(h.nearby.state.message.includes('private'), false);
  await h.nearby.syncCapabilities();
  assert.equal(h.requests.length, 2);
});
test('late network response after background does not save a page or update location state', async () => {
  const request = deferred();
  const h = harness({ request: () => request.promise });
  const pending = h.nearby.open();
  await tick();
  h.nearby.stop();
  request.resolve(page(1));
  await pending;
  const snapshot = h.nearby.listSnapshots()[0];
  assert.equal(snapshot.status, 'PARTIAL');
  assert.equal(snapshot.pagesCollected, 0);
  assert.equal(snapshot.restaurants.length, 0);
  assert.equal(h.nearby.state.location, null);
});
test('late location after background never calls API or creates a snapshot', async () => {
  const h = harness({ deferLocation: true });
  const pending = h.nearby.open();
  await tick();
  h.nearby.stop();
  h.locations[0].success({ latitude: 0, longitude: 0, accuracy: 30 });
  await pending;
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.nearby.listSnapshots(), []);
});
test('clear and withdrawal stop late writes, preserve unrelated storage and never restore a deleted session', async () => {
  for (const withdraw of [false, true]) {
    const request = deferred();
    const h = harness({ request: () => request.promise });
    h.data.set('unrelated', 'keep');
    const pending = h.nearby.open();
    await tick();
    if (withdraw) h.nearby.withdraw(); else h.nearby.clear();
    request.resolve(page(1));
    await pending;
    assert.deepEqual(h.nearby.listSnapshots(), []);
    assert.equal(h.data.get('unrelated'), 'keep');
    assert.equal(h.data.has(ENABLED_KEY), !withdraw);
    await h.nearby.syncCapabilities();
    assert.equal(h.requests.length, 1);
  }
});
test('capability loss during collection rejects the late page and cannot silently retry this opening', async () => {
  const request = deferred();
  const h = harness({ request: () => request.promise });
  const pending = h.nearby.open();
  await tick();
  h.service.state.config.nearbyRestaurantCollectionEnabled = false;
  await h.nearby.syncCapabilities();
  request.resolve(page(1));
  await pending;
  h.service.state.config.nearbyRestaurantCollectionEnabled = true;
  await h.nearby.syncCapabilities();
  assert.equal(h.requests.length, 1);
  assert.equal(h.nearby.listSnapshots()[0].pagesCollected, 0);
});
test('service epoch change invalidates a pending page even if capability remains enabled', async () => {
  const request = deferred();
  const h = harness({ request: () => request.promise });
  const pending = h.nearby.open();
  await tick();
  h.service.state.epoch += 1;
  request.resolve(page(1));
  await pending;
  assert.equal(h.nearby.listSnapshots()[0].pagesCollected, 0);
  assert.equal(h.nearby.state.phase, 'DONE');
});
test('a stale opening cannot overwrite the next opening or its complete snapshot', async () => {
  const first = deferred();
  let requestCount = 0;
  const h = harness({ request: () => ++requestCount === 1 ? first.promise : Promise.resolve(page(1, { restaurants: [place('new-opening')] })) });
  const pending = h.nearby.open();
  await tick();
  h.nearby.stop();
  h.advance(20);
  await h.nearby.open();
  first.resolve(page(1, { restaurants: [place('stale-opening')] }));
  await pending;
  const snapshots = h.nearby.listSnapshots();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].status, 'COMPLETE');
  assert.equal(snapshots[0].restaurants[0].providerPlaceId, 'new-opening');
  assert.equal(snapshots[1].status, 'PARTIAL');
  assert.equal(snapshots[1].restaurants.length, 0);
  assert.equal(h.nearby.state.phase, 'DONE');
  assert.equal(h.nearby.state.count, 1);
});
test('withdrawal still removes opt-in and other records when one storage deletion fails', async () => {
  const h = harness();
  await h.nearby.open();
  await h.nearby.retry();
  const keys = [...h.data.keys()].filter(key => key.startsWith(PREFIX));
  h.platform.removeStorageSync = key => { if (key === keys[0]) throw new Error('private storage failure'); h.data.delete(key); };
  assert.throws(() => h.nearby.withdraw(), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(h.data.has(keys[1]), false);
  assert.equal(h.data.has(ENABLED_KEY), false);
  assert.equal(h.nearby.state.enabled, false);
  assert.equal(h.nearby.state.location, null);
});
test('retention removes the entire snapshot exactly at 90 days, including origin and accuracy', async () => {
  const h = harness();
  await h.nearby.open();
  h.advance(RETENTION_MS - 1);
  assert.equal(h.nearby.listSnapshots().length, 1);
  h.advance(1);
  assert.deepEqual(h.nearby.listSnapshots(), []);
  assert.equal([...h.data.keys()].some(key => key.startsWith(PREFIX)), false);
});
test('malformed/future snapshots are physically pruned and orphan collecting snapshots become partial', async () => {
  const h = harness();
  await h.nearby.open();
  const key = [...h.data.keys()].find(value => value.startsWith(PREFIX));
  const value = JSON.parse(h.data.get(key));
  h.data.set(key, JSON.stringify({ ...value, status: 'COLLECTING' }));
  assert.equal(h.nearby.listSnapshots()[0].status, 'PARTIAL');
  h.data.set(key, JSON.stringify({ ...value, startedAtMillis: 2000000000001 }));
  h.data.set(`${PREFIX}garbage`, '{');
  assert.deepEqual(h.nearby.listSnapshots(), []);
  assert.equal([...h.data.keys()].some(name => name.startsWith(PREFIX)), false);
});
test('capacity failure preserves old records and reports safe failure without evicting within retention', async () => {
  const h = harness();
  await h.nearby.open();
  const previous = h.nearby.listSnapshots()[0];
  h.nearby.stop();
  h.capacity(1);
  h.advance(1);
  await h.nearby.open();
  assert.equal(h.nearby.state.failure, 'STORAGE_FULL');
  assert.equal(h.nearby.listSnapshots().length, 1);
  assert.deepEqual(h.nearby.listSnapshots()[0], previous);
});
test('explicit retry at the same timestamp allocates a distinct snapshot without overwriting', async () => {
  const h = harness();
  await h.nearby.open();
  await h.nearby.retry();
  const values = h.nearby.listSnapshots();
  assert.equal(values.length, 2);
  assert.notEqual(values[0].id, values[1].id);
  assert.equal(values[0].startedAtMillis, values[1].startedAtMillis);
});
test('location performs initial attempt plus five retries, permission denial never retries automatically', async () => {
  for (const denied of [false, true]) {
    const h = harness();
    h.platform.getLocation = callbacks => { h.locations.push(callbacks); callbacks.fail({ errMsg: denied ? 'getLocation:fail auth deny' : 'synthetic failure' }); };
    await h.nearby.open();
    assert.equal(h.locations.length, denied ? 1 : 6);
    assert.equal(h.nearby.state.phase, denied ? 'PERMISSION' : 'FAILED');
    assert.equal(h.requests.length, 0);
  }
});
