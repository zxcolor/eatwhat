const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { apiPath, browserCapabilities, toGcj02, STORAGE_PREFIX } = require('../runtime/platform.js');
const source = fs.readFileSync(path.join(__dirname, '../runtime/platform.js'), 'utf8');

function harness(overrides = {}) {
  const values = new Map(), listeners = new Map(), revoked = [], urls = [];
  let sequence = 0;
  class TestURL extends URL {}
  TestURL.createObjectURL = () => { const value = `blob:https://eatwhat.pro/test-${++sequence}`; urls.push(value); return value; };
  TestURL.revokeObjectURL = value => revoked.push(value);
  const window = {
    document: { querySelector: () => null }, navigator: {}, screen: { width: 390, height: 844 },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    crypto: webcrypto, btoa,
    localStorage: {
      getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key), key: index => [...values.keys()][index], get length() { return values.size; },
    },
    addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener() {},
    ...overrides,
  };
  const context = vm.createContext({ window, URL: TestURL, URLSearchParams, Blob, AbortController, Uint8Array, ArrayBuffer,
    TextEncoder, setTimeout, clearTimeout, queueMicrotask, console });
  vm.runInContext(source, context);
  const navigations = [];
  const runtime = { currentPages: () => [], navigate: (url, mode) => navigations.push({ url, mode }), back() {}, setTitle() {}, setNavColor() {} };
  const wx = window.installPlatform(runtime);
  const call = (name, options = {}) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
  const fsCall = (name, options = {}) => new Promise((resolve, reject) => wx.getFileSystemManager()[name]({ ...options, success: resolve, fail: reject }));
  return { wx, call, fsCall, values, window, listeners, revoked, urls, runtime, navigations };
}
function jsonResponse(data, status = 200) {
  return { status, headers: new Headers({ 'x-chishenme-contract-version': '1', 'content-type': 'application/json' }), text: async () => JSON.stringify(data) };
}

test('API adapter uses only the exact HTTPS API origin and v1 route', () => {
  assert.equal(apiPath('https://api.eatwhat.pro/v1/config'), '/api/v1/config');
  assert.equal(apiPath('https://api.eatwhat.pro/v1/canteen/ratings?page=2'), '/api/v1/canteen/ratings?page=2');
  for (const url of ['http://api.eatwhat.pro/v1/config', 'https://api.eatwhat.pro.evil.test/v1/config',
    'https://api.eatwhat.pro/admin', 'https://user:secret@api.eatwhat.pro/v1/config',
    'https://api.eatwhat.pro/v1/config#secret', 'https://api.eatwhat.pro/v1/%2fadmin',
    'https://api.eatwhat.pro/v1/%2e%2e/admin', 'https://api.eatwhat.pro\\evil/v1/config', '/api/v1/config']) {
    assert.throws(() => apiPath(url), url);
  }
});

test('browser disables only native auth capabilities while retaining phone/email', () => {
  const value = { authCapabilities: { accountsEnabled: true, phoneEnabled: true, emailEnabled: true, wechatMiniProgramEnabled: true, wechatEnabled: true, qqEnabled: true } };
  assert.equal(browserCapabilities(value), value);
  assert.deepEqual(value.authCapabilities, { accountsEnabled: true, phoneEnabled: true, emailEnabled: true, wechatMiniProgramEnabled: false, wechatEnabled: false, qqEnabled: false });
});

test('storage reads/writes are isolated from other site keys and preserve typed values', () => {
  const h = harness(); h.values.set('unrelated', 'preserved'); h.values.set('eatwhat.wechat.consent.v2', 'true');
  assert.equal(h.wx.getStorageSync('eatwhat.wechat.consent.v2'), '');
  h.wx.setStorageSync('preference', { spicy: 2, enabled: false });
  assert.deepEqual(JSON.parse(JSON.stringify(h.wx.getStorageSync('preference'))), { spicy: 2, enabled: false });
  assert.ok(h.values.has(STORAGE_PREFIX + 'preference'));
  assert.deepEqual(Array.from(h.wx.getStorageInfoSync().keys), ['preference']);
  h.wx.removeStorageSync('preference');
  assert.equal(h.values.get('unrelated'), 'preserved');
  assert.equal(h.values.get('eatwhat.wechat.consent.v2'), 'true');
});

test('request keeps sensitive JSON in the body and contract headers, avoids cookies, cache and redirects', async () => {
  let captured;
  const h = harness({ fetch: async (url, options) => { captured = { url, options }; return jsonResponse({ success: true }); } });
  const result = await h.call('request', { url: 'https://api.eatwhat.pro/v1/location-search', method: 'POST',
    data: { keyword: 'synthetic input' }, header: { 'X-ChiShenMe-Contract-Version': '1', 'Content-Type': 'application/json' } });
  assert.equal(captured.url, '/api/v1/location-search');
  assert.equal(captured.options.body, '{"keyword":"synthetic input"}');
  assert.equal(captured.options.credentials, 'omit'); assert.equal(captured.options.cache, 'no-store'); assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.referrerPolicy, 'no-referrer');
  assert.equal(result.statusCode, 200); assert.equal(result.header['x-chishenme-contract-version'], '1'); assert.equal(result.data.success, true);
});

test('invalid destinations, GET bodies and Mini Program impersonation fail before fetch', async () => {
  let count = 0; const h = harness({ fetch: () => { count++; throw new Error('must not call'); } });
  for (const options of [
    { url: 'https://other.test/v1/config' },
    { url: 'https://api.eatwhat.pro/v1/config', data: { private: 'test' } },
    { url: 'https://api.eatwhat.pro/v1/auth/phone/login', method: 'POST', data: { device: { platform: 'MINIPROGRAM' } } },
    { url: 'https://api.eatwhat.pro/v1/config', header: { 'X-Forwarded-For': 'test' } },
  ]) await assert.rejects(h.call('request', options), value => value.errMsg.startsWith('request:fail'));
  assert.equal(count, 0);
});

test('config response disables incompatible native login methods', async () => {
  const h = harness({ fetch: async () => jsonResponse({ authCapabilities: { accountsEnabled: true, phoneEnabled: true, emailEnabled: true, wechatMiniProgramEnabled: true } }) });
  const result = await h.call('request', { url: 'https://api.eatwhat.pro/v1/config' });
  assert.equal(result.data.authCapabilities.wechatMiniProgramEnabled, false); assert.equal(result.data.authCapabilities.phoneEnabled, true);
});

test('explicit abort is settled once even if the network later returns success', async () => {
  let release, callbacks = 0, completed = 0;
  const h = harness({ fetch: () => new Promise(resolve => { release = resolve; }) });
  const task = h.wx.request({ url: 'https://api.eatwhat.pro/v1/config',
    success: () => { throw new Error('late success'); }, fail: error => { callbacks++; assert.match(error.errMsg, /abort/); }, complete: () => completed++ });
  await new Promise(resolve => queueMicrotask(resolve)); task.abort();
  release(jsonResponse({})); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(callbacks, 1); assert.equal(completed, 1);
});

test('request timeout aborts the transport and reports timeout', async () => {
  let signal;
  const h = harness({ fetch: (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(h.call('request', { url: 'https://api.eatwhat.pro/v1/config', timeout: 1 }), value => /timeout/.test(value.errMsg));
  assert.equal(signal.aborted, true);
});

test('binary export remains ArrayBuffer with required response headers', async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const h = harness({ fetch: async () => ({ status: 200, headers: new Headers({ 'x-chishenme-contract-version': '1' }), arrayBuffer: async () => bytes }) });
  const value = await h.call('request', { url: 'https://api.eatwhat.pro/v1/account/export/content', responseType: 'arraybuffer', dataType: 'other' });
  assert.equal(value.data, bytes); assert.equal(value.header['x-chishenme-contract-version'], '1');
});

test('geolocation is user-triggered, preserves WGS84 and converts only requested GCJ02', async () => {
  let calls = 0;
  const h = harness({ navigator: { geolocation: { getCurrentPosition(success) { calls++; success({ coords: { latitude: 30, longitude: 120, accuracy: 75 } }); } } } });
  assert.equal(calls, 0);
  const wgs = await h.call('getLocation', { type: 'wgs84' }); assert.equal(wgs.latitude, 30); assert.equal(wgs.longitude, 120);
  const gcj = await h.call('getLocation', { type: 'gcj02' });
  assert.notEqual(gcj.latitude, wgs.latitude); assert.notEqual(gcj.longitude, wgs.longitude); assert.equal(gcj.accuracy, 75);
  assert.ok(Math.abs(gcj.latitude - wgs.latitude) < 0.01); assert.ok(Math.abs(gcj.longitude - wgs.longitude) < 0.01);
  assert.deepEqual(toGcj02(0, 0), { latitude: 0, longitude: 0 });
});

test('denied geolocation remains denied rather than claiming success', async () => {
  const h = harness({ navigator: { geolocation: { getCurrentPosition(_, fail) { fail({ code: 1 }); } } } });
  await assert.rejects(h.call('getLocation', { type: 'wgs84' }), error => /permission denied/.test(error.errMsg));
  const setting = await h.call('getSetting'); assert.equal(setting.authSetting['scope.userLocation'], false);
});

test('privacy API never creates application consent and authorization fails closed', async () => {
  const h = harness();
  const setting = await h.call('getPrivacySetting'); assert.equal(setting.needAuthorization, false); assert.equal(h.values.size, 0);
  await assert.rejects(h.call('requirePrivacyAuthorize'), error => /privacy denied/.test(error.errMsg));
  assert.equal(h.values.size, 0);
  h.wx.setStorageSync('eatwhat.wechat.consent.v2', true);
  await h.call('requirePrivacyAuthorize');
  h.wx.removeStorageSync('eatwhat.wechat.consent.v2');
  await assert.rejects(h.call('requirePrivacyAuthorize'), error => /privacy denied/.test(error.errMsg));
});

test('generated images exist only in memory and unlink is verifiably absent', async () => {
  const h = harness(), blob = new Blob([new Uint8Array([255, 216, 255, 1, 2, 3])], { type: 'image/jpeg' });
  const result = await h.call('canvasToTempFilePath', { canvas: { width: 1, height: 1, toBlob: fn => fn(blob) }, fileType: 'jpg' });
  assert.equal(h.values.size, 0);
  const stat = await h.fsCall('stat', { path: result.tempFilePath }); assert.equal(stat.stats.size, 6);
  const content = await h.fsCall('readFile', { filePath: result.tempFilePath, encoding: 'base64', length: 6, position: 0 }); assert.equal(content.data, '/9j/AQID');
  await h.fsCall('unlink', { filePath: result.tempFilePath });
  await assert.rejects(h.fsCall('access', { path: result.tempFilePath }), error => /ENOENT/.test(error.errMsg));
  assert.deepEqual(h.revoked, [result.tempFilePath]);
});

test('unchanged Mini Program cleanup registry removes browser-generated files', async () => {
  const { createCleanupRegistry } = require('../source/wechat/lib/takeout-cleanup.js');
  const h = harness();
  const file = await h.call('canvasToTempFilePath', { canvas: { width: 1, height: 1, toBlob: fn => fn(new Blob(['test'])) } });
  const filesystem = h.wx.getFileSystemManager(), registry = createCleanupRegistry({ runtime: h.wx, fs: filesystem });
  const ticket = registry.reserve(filesystem.unlink.bind(filesystem), { runtime: h.wx, fs: filesystem, allowMove: true });
  registry.commit(ticket, file.tempFilePath); assert.equal(registry.state().count, 1);
  assert.deepEqual(await registry.clearAll(), [true]); assert.equal(registry.state().count, 0);
  await assert.rejects(h.fsCall('access', { path: file.tempFilePath }), error => /ENOENT/.test(error.errMsg));
  assert.equal(h.values.size, 0);
});

test('explicit image-removal hook immediately releases every file and is idempotent', async () => {
  const h = harness();
  const files = await Promise.all([1, 2].map(() => h.call('canvasToTempFilePath', { canvas: { width: 1, height: 1, toBlob: fn => fn(new Blob(['test'])) } })));
  const released = h.wx.releaseImageFiles(); assert.equal(released.released, 2); assert.equal(released.remaining, 0);
  for (const file of files) await assert.rejects(h.fsCall('access', { path: file.tempFilePath }), error => /ENOENT/.test(error.errMsg));
  assert.equal(h.wx.releaseImageFiles().released, 0); assert.equal(h.revoked.length, 2);
});

test('late canvas export cannot restore a blob after explicit image removal', async () => {
  const h = harness(); let complete;
  const pending = h.call('canvasToTempFilePath', { canvas: { width: 1, height: 1, toBlob: fn => { complete = fn; } } });
  await new Promise(resolve => queueMicrotask(resolve));
  h.wx.releaseImageFiles(); complete(new Blob(['test']));
  await assert.rejects(pending, error => /cancel/.test(error.errMsg)); assert.equal(h.urls.length, 0);
});

test('image reads cannot cross the bounded byte range', async () => {
  const h = harness();
  const file = await h.call('canvasToTempFilePath', { canvas: { width: 1, height: 1, toBlob: fn => fn(new Blob(['abc'])) } });
  await assert.rejects(h.fsCall('readFile', { filePath: file.tempFilePath, position: 1, length: 3 }), error => /范围/.test(error.errMsg));
  await assert.rejects(h.fsCall('readFile', { filePath: 'https://external.test/private' }), error => /ENOENT/.test(error.errMsg));
});

test('pagehide revokes images and aborts pending requests', async () => {
  const h = harness({ fetch: () => new Promise(() => {}) });
  let cleared = 0; h.runtime.app = () => ({ clearTakeoutState: () => { cleared++; } });
  const file = await h.call('canvasToTempFilePath', { canvas: { width: 1, height: 1, toBlob: fn => fn(new Blob(['test'])) } });
  const pending = h.call('request', { url: 'https://api.eatwhat.pro/v1/config' });
  h.listeners.get('pagehide')();
  await assert.rejects(pending, error => /abort/.test(error.errMsg));
  await assert.rejects(h.fsCall('access', { path: file.tempFilePath }), error => /ENOENT/.test(error.errMsg));
  assert.equal(cleared, 1);
});

test('native login fails explicitly and secure random bytes are correctly sized', async () => {
  const h = harness();
  await assert.rejects(h.call('login'), error => /手机号或邮箱/.test(error.errMsg));
  const values = await h.call('getRandomValues', { length: 16 }); assert.equal(values.randomValues.byteLength, 16);
  await assert.rejects(h.call('getRandomValues', { length: 65537 }));
});

test('navigation preserves runtime mode and page URL', async () => {
  const h = harness(); await h.call('navigateTo', { url: '/pages/canteen/index' }); await h.call('reLaunch', { url: '/pages/index/index' });
  assert.deepEqual(h.navigations, [{ url: '/pages/canteen/index', mode: 'navigateTo' }, { url: '/pages/index/index', mode: 'reLaunch' }]);
});
