const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function fixture(consent = false) {
  const calls = [];
  const state = { consent: false };
  const storage = new Map([['eatwhat.wechat.consent.v1', consent]]);
  const service = {
    state,
    setConsent(value) { state.consent = value; calls.push(['consent', value]); },
    invalidate() { calls.push(['invalidate']); },
    async refreshConfig() { calls.push(['config']); }
  };
  let app;
  vm.runInNewContext(source, {
    require: name => name.endsWith('/service') ? service : { clear() { calls.push(['clear-account']); }, suspend() { calls.push(['suspend-account']); } },
    App(value) { app = value; },
    getCurrentPages: () => [],
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      getAppBaseInfo: () => ({ theme: 'light' }), onThemeChange() {},
      reLaunch(options) { calls.push(['navigate', options.url]); }
    }
  });
  return { app, calls, storage, state };
}
test('a fresh launch never requests network or signs in without consent', () => {
  const { app, calls } = fixture();
  app.onLaunch(); app.onShow();
  assert.equal(calls.filter(call => call[0] === 'config').length, 0);
});
test('accepted consent enables configuration, withdrawal removes consent and private state', async () => {
  const { app, calls, storage, state } = fixture();
  app.onLaunch();
  await app.acceptConsent();
  assert.equal(state.consent, true);
  assert.ok(calls.some(call => call[0] === 'config'));
  app.withdrawConsent();
  assert.equal(state.consent, false);
  assert.equal(storage.has('eatwhat.wechat.consent.v1'), false);
  assert.ok(calls.some(call => call[0] === 'clear-account'));
});
test('backgrounding suspends account secrets and cancels private in-flight state', () => {
  const { app, calls } = fixture(true);
  app.onLaunch(); app.onHide();
  assert.ok(calls.some(call => call[0] === 'suspend-account'));
  assert.ok(calls.some(call => call[0] === 'invalidate'));
});
