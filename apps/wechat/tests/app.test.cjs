const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function fixture(consent = false, faults = {}, route = '') {
  const calls = [];
  const state = { consent: false };
  const storage = new Map([['eatwhat.wechat.consent.v2', consent]]);
  const service = {
    state,
    setConsent(value) { state.consent = value; calls.push(['consent', value]); },
    invalidate() { calls.push(['invalidate']); },
    async refreshConfig() { calls.push(['config']); }
  };
  let app;
  vm.runInNewContext(source, {
    setTimeout, clearTimeout,
    require(name) {
      if (name.endsWith('/decision/service')) return { reset() { calls.push(['clear-virtual']); }, setProfile(value) { calls.push([value === null ? 'clear-virtual' : 'set-profile']); } };
      if (name.endsWith('/taste-profile')) return { load() {}, getProfile: () => null, isReady: () => false, clear() { calls.push(['clear-taste']); } };
      if (name.endsWith('/service')) return service;
      if (name.endsWith('/account')) return { clear() { calls.push(['clear-account']); }, suspend() { calls.push(['suspend-account']); } };
      if (name.endsWith('/nearby')) return { state: {}, subscribe() {}, open() { calls.push(['nearby-open']); }, stop() { calls.push(['nearby-stop']); }, withdraw() { calls.push(['nearby-withdraw']); }, syncCapabilities() { calls.push(['nearby-sync']); } };
      if (name.endsWith('/local-records')) return { prune() {}, clear() { calls.push(['clear-local']); }, recordDecision() { calls.push(['record-decision']); } };
      if (name.endsWith('/canteen-records')) return {
        prune() { calls.push(['prune-canteen']); if (faults.canteenPrune) throw new Error('食堂记录读取失败'); },
        withdraw() { calls.push(['clear-canteen']); if (faults.canteenWithdraw) throw new Error('食堂记录清理失败'); },
      };
      if (name.endsWith('/saved')) return { invalidate() { calls.push(['clear-saved']); }, syncCapabilities() {} };
      throw new Error(name);
    },
    App(value) { app = value; },
    getCurrentPages: () => route ? [{ route, setData() {} }] : [],
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => { if (faults.write) throw new Error('storage error'); storage.set(key, value); },
      removeStorageSync: key => { if (faults.remove) throw new Error('storage error'); storage.delete(key); },
      getAppBaseInfo: () => ({ theme: 'light' }), onThemeChange() {},
      setNavigationBarColor() {},
      reLaunch(options) { calls.push(['navigate', options.url]); options.success?.({}); options.complete?.({}); },
      showToast(options) { calls.push(['toast', options.title]); }
    }
  });
  return { app, calls, storage, state };
}
test('a fresh launch never requests network or signs in without consent', () => {
  const { app, calls } = fixture();
  app.onLaunch(); app.onShow();
  assert.equal(calls.filter(call => call[0] === 'config').length, 0);
});
test('virtual home does not fetch online configuration or collect nearby data even with previous consent', () => {
  const { app, calls } = fixture(true);
  app.onLaunch(); app.onShow();
  assert.equal(calls.some(call => call[0] === 'config' || call[0] === 'nearby-open'), false);
});
test('accepted consent enables configuration, withdrawal removes consent and private state', async () => {
  const { app, calls, storage, state } = fixture();
  app.onLaunch();
  await app.acceptConsent();
  assert.equal(state.consent, true);
  assert.ok(calls.some(call => call[0] === 'config'));
  app.withdrawConsent();
  assert.equal(state.consent, false);
  assert.equal(storage.has('eatwhat.wechat.consent.v2'), false);
  assert.ok(calls.some(call => call[0] === 'clear-account'));
  assert.ok(calls.some(call => call[0] === 'clear-local'));
  assert.ok(calls.some(call => call[0] === 'clear-canteen'));
  assert.equal(app.globalData.canteenEpoch, 1);
  assert.ok(calls.some(call => call[0] === 'nearby-withdraw'));
  assert.ok(calls.some(call => call[0] === 'clear-virtual'));
  assert.ok(calls.some(call => call[0] === 'clear-taste'));
});
test('backgrounding suspends account secrets and cancels private in-flight state', () => {
  const { app, calls } = fixture(true);
  app.onLaunch(); app.onHide();
  assert.ok(calls.some(call => call[0] === 'suspend-account'));
  assert.ok(calls.some(call => call[0] === 'invalidate'));
  assert.ok(calls.some(call => call[0] === 'nearby-stop'));
  assert.ok(calls.some(call => call[0] === 'clear-saved'));
});

test('older consent cannot authorize the new local-data policy', () => {
  const h = fixture(); h.storage.set('eatwhat.wechat.consent.v1', true); h.app.onLaunch(); h.app.onShow();
  assert.equal(h.state.consent, false); assert.equal(h.calls.some(call => call[0] === 'config'), false);
});

test('failed consent deletion persists false and cannot restore consent after restart', () => {
  const h = fixture(true, { remove: true }); h.app.onLaunch(); h.app.withdrawConsent();
  assert.equal(h.storage.get('eatwhat.wechat.consent.v2'), false); h.app.onLaunch(); assert.equal(h.state.consent, false);
});
test('failed consent writes fall back to deletion; total storage failure stops services and reports retry', () => {
  const h = fixture(true, { write: true }); h.app.onLaunch(); h.app.withdrawConsent(); assert.equal(h.storage.has('eatwhat.wechat.consent.v2'), false);
  const broken = fixture(true, { write: true, remove: true }); broken.app.onLaunch(); broken.app.withdrawConsent();
  assert.equal(broken.state.consent, false); assert.match(broken.app.globalData.localDataError, /保存失败/); assert.equal(broken.calls.some(call => call[0] === 'toast'), true);
});

test('decision metadata is recorded only for the currently accepted response', () => {
  const h = fixture(true); h.app.onLaunch(); h.state.status = 'ready'; const response = { results: [{}] }; h.state.results = response;
  h.app.recordDecision({ results: [{}] }); assert.equal(h.calls.some(call => call[0] === 'record-decision'), false);
  h.app.recordDecision(response); assert.equal(h.calls.filter(call => call[0] === 'record-decision').length, 1);
  h.state.consent = false; h.app.recordDecision(response); assert.equal(h.calls.filter(call => call[0] === 'record-decision').length, 1);
});

test('canteen routes remain local without online consent, profile redirects or nearby collection', () => {
  for (const route of ['pages/canteen/index', 'pages/canteen-records/index']) {
    const h = fixture(false, {}, route);
    h.app.onLaunch(); h.app.onShow();
    assert.ok(h.calls.some(call => call[0] === 'prune-canteen'));
    assert.equal(h.calls.some(call => ['navigate', 'config', 'nearby-open'].includes(call[0])), false);
  }
});

test('canteen cleanup errors stay visible without skipping other withdrawal cleanup', () => {
  const h = fixture(true, { canteenWithdraw: true });
  h.app.onLaunch(); h.app.withdrawConsent();
  assert.equal(h.state.consent, false);
  assert.equal(h.app.globalData.canteenEpoch, 1);
  assert.match(h.app.globalData.localDataError, /食堂记录清理失败/);
  assert.ok(h.calls.some(call => call[0] === 'nearby-withdraw'));
  assert.ok(h.calls.some(call => call[0] === 'clear-local'));
});
