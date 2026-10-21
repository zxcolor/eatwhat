const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const event = page => ({ currentTarget: { dataset: { page } } });
const HEADER = { 'x-chishenme-contract-version': '1' };
function setTestTimeout(callback, delay, ...args) {
  const timer = setTimeout(callback, delay, ...args);
  // Keep navigation timers real; long page-refresh timers must not hold Node open.
  if (delay >= 1000) timer.unref();
  return timer;
}

function config() {
  return {
    coverageName: '合成测试范围', dataRightsMode: 'LIVE_DISPLAY_ONLY', aiEnabled: false,
    accountsEnabled: true, favoritesEnabled: false,
    minimumSupportedVersion: '0.1.3', ruleVersion: 'rules-test', promptVersion: 'prompt-test', modelVersion: 'rules',
    authCapabilities: { accountsEnabled: true, registrationEnabled: true, phoneEnabled: true, emailEnabled: true, wechatEnabled: false, wechatMiniProgramEnabled: true, qqEnabled: false, dataExportEnabled: false },
    serviceCapabilities: { recommendationsEnabled: true, groupRecommendationsEnabled: false, locationSearchEnabled: true, placeSearchEnabled: false },
    persistenceCapabilities: { favoritesEnabled: false, historyEnabled: false, privateFeedbackEnabled: false, savedResourceIdsEnabled: false },
    specialtyCapabilities: { breakfastProfileEnabled: true, dinnerProfileEnabled: true, milkTeaEnabled: false, coffeeEnabled: false, dessertEnabled: false, userReportedWeatherEnabled: false },
  };
}

// Run the real App, pages and service graph. Only the wx host is simulated;
// this harness rejects every request except synthetic configuration responses.
function harness(t, options = {}) {
  const modules = new Map();
  const stack = [];
  const requests = [];
  const toasts = [];
  const attempted = { requests: [], logins: 0, locations: 0 };
  const storage = new Map([['eatwhat.wechat.consent.v2', options.consent !== false]]);
  let app;
  let definition;
  const platform = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 }),
    getAppBaseInfo: () => ({ theme: 'light' }), onThemeChange() {}, hideShareMenu() {}, setNavigationBarColor() {}, setNavigationBarTitle() {},
    showToast: value => toasts.push(clone(value)),
    request(callbacks) {
      attempted.requests.push({ url: callbacks.url, method: callbacks.method, hasData: callbacks.data !== undefined });
      assert.equal(callbacks.url, 'https://api.eatwhat.pro/v1/config');
      assert.equal(callbacks.method, 'GET');
      assert.equal(callbacks.data, undefined);
      const request = { callbacks, aborted: false };
      requests.push(request);
      return { abort() { request.aborted = true; callbacks.fail({ errMsg: 'synthetic abort' }); } };
    },
    login() { attempted.logins += 1; assert.fail('A connection check must not request a WeChat login code'); },
    getLocation() { attempted.locations += 1; assert.fail('A connection check must not request a location'); },
    navigateTo: ({ url }) => navigate(url),
    reLaunch({ url }) {
      for (const page of stack.splice(0)) { page.onHide?.(); page.onUnload?.(); }
      navigate(url);
    },
  };
  const context = vm.createContext({
    wx: platform, setTimeout: setTestTimeout, clearTimeout, setInterval, clearInterval,
    App(value) { app = value; }, Page(value) { definition = value; },
    getApp: () => app, getCurrentPages: () => stack,
  });
  function load(request, parent = path.join(ROOT, 'entry.js')) {
    assert.ok(request.startsWith('.'), `Unexpected external module: ${request}`);
    let filename = path.resolve(path.dirname(parent), request);
    if (!path.extname(filename)) filename += '.js';
    assert.ok(filename.startsWith(`${ROOT}${path.sep}`));
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const source = fs.readFileSync(filename, 'utf8');
    const execute = new vm.Script(`(function(require,module,exports){\n${source}\n})`, { filename }).runInContext(context);
    execute(child => load(child, filename), module, module.exports);
    return module.exports;
  }
  function navigate(url) {
    stack.at(-1)?.onHide?.();
    const route = url.split('?')[0].replace(/^\//, '');
    const filename = path.join(ROOT, `${route}.js`);
    const source = fs.readFileSync(filename, 'utf8');
    const execute = new vm.Script(`(function(require){\n${source}\n})`, { filename }).runInContext(context);
    execute(child => load(child, filename));
    const page = { ...definition, route, data: clone(definition.data), setData(value) { Object.assign(this.data, clone(value)); } };
    stack.push(page);
    page.onLoad?.();
    page.onShow?.();
    return page;
  }
  load('./app');
  const service = load('./lib/service');
  const tasteProfile = load('./lib/taste-profile');
  // This suite checks account connectivity after explicit local onboarding.
  // A real record is created and then restored by App.onLaunch below.
  tasteProfile.start();
  for (const [field, value] of Object.entries({ likedGroups: ['noodles'], avoidedGroups: [], budgetCents: null, maxSpicy: null, priority: 'balanced' })) {
    tasteProfile.answer(field, value, tasteProfile.getState().revision);
  }
  tasteProfile.confirm(tasteProfile.getState().revision);
  assert.equal(tasteProfile.isReady(), true);
  app.onLaunch();
  app.onShow();
  const home = navigate('/pages/index/index');
  t.after(() => {
    for (const page of stack.splice(0)) page.onUnload?.();
    assert.equal(attempted.logins, 0);
    assert.equal(attempted.locations, 0);
    for (const request of attempted.requests) {
      assert.equal(request.url, 'https://api.eatwhat.pro/v1/config');
      assert.equal(request.method, 'GET');
      assert.equal(request.hasData, false);
    }
  });
  return { app, service, tasteProfile, home, requests, toasts, navigate, top: () => stack.at(-1) };
}

function reply(request, data = config(), statusCode = 200, header = HEADER) {
  request.callbacks.success({ data, statusCode, header });
}

const failures = [
  { name: 'network failure', message: '服务器域名尚未生效，请重新进入小程序后重试。', respond: request => request.callbacks.fail({ errMsg: 'request:fail url not in domain list PRIVATE_TEST_TRANSPORT' }) },
  { name: 'missing contract header', message: '服务版本不兼容，请更新小程序后重试。', respond: request => reply(request, config(), 200, {}) },
  { name: 'invalid configuration', message: '服务返回的信息不完整，请稍后重试。', respond: request => reply(request, { debug: 'PRIVATE_TEST_SERVER' }) },
  { name: 'minimum version requirement', message: '请更新小程序后继续使用，当前版本已不受支持。', respond: request => reply(request, { ...config(), minimumSupportedVersions: { android: '0.1.3', miniprogram: '9999.0.0' } }) },
  { name: 'server unavailable', message: '服务暂时不可用，请稍后重试。', respond: request => reply(request, { message: 'PRIVATE_TEST_SERVER' }, 503, {}) },
];

for (const failure of failures) {
  test(`${failure.name} stays actionable at account entry and in settings`, async t => {
    const h = harness(t);
    const opening = h.home.open(event('account'));
    failure.respond(h.requests.at(-1));
    await opening;
    assert.equal(h.top().route, 'pages/index/index');
    assert.equal(h.toasts.at(-1).title, failure.message);
    assert.equal(h.service.state.error, failure.message);

    await h.home.open(event('settings'));
    const settings = h.top();
    assert.equal(settings.data.error, failure.message);
    const retry = settings.refreshService();
    assert.equal(settings.data.busy, true);
    assert.equal(settings.data.error, '');
    await settings.refreshService();
    assert.equal(h.requests.length, 2, 'busy prevents a duplicate configuration request');
    failure.respond(h.requests.at(-1));
    await retry;
    assert.equal(settings.data.busy, false);
    assert.equal(settings.data.error, failure.message);
    assert.doesNotMatch(JSON.stringify({ page: settings.data, toasts: h.toasts }), /PRIVATE_TEST/);
  });
}

test('valid configuration opens the account page without invoking any login channel', async t => {
  const h = harness(t);
  const opening = h.home.open(event('account'));
  reply(h.requests.at(-1));
  await opening;
  assert.equal(h.service.state.status, 'ready');
  assert.equal(h.top().route, 'pages/account/index');
  assert.equal(h.top().data.capabilities.phoneEnabled, true);
  assert.equal(h.top().data.capabilities.emailEnabled, true);
  assert.equal(h.top().data.capabilities.wechatMiniProgramEnabled, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.toasts.length, 0);
});

test('a successful settings retry clears the previous safe error and allows account entry', async t => {
  const h = harness(t);
  await h.home.open(event('settings'));
  const settings = h.top();
  const failed = settings.refreshService();
  failures[0].respond(h.requests.at(-1));
  await failed;
  assert.equal(settings.data.error, failures[0].message);
  const retry = settings.refreshService();
  reply(h.requests.at(-1));
  await retry;
  assert.equal(settings.data.error, '');
  assert.equal(settings.data.statusLabel, '已取得服务配置');
  assert.equal(settings.data.busy, false);
  const home = h.navigate('/pages/index/index');
  await home.open(event('account'));
  assert.equal(h.top().route, 'pages/account/index');
  assert.equal(h.requests.length, 2);
});

test('without privacy consent account entry and settings retries cannot request configuration', async t => {
  const h = harness(t, { consent: false });
  await h.home.open(event('account'));
  assert.equal(h.toasts.at(-1).title, '请先阅读并同意隐私说明');
  await h.home.open(event('settings'));
  const settings = h.top();
  await settings.refreshService();
  assert.equal(settings.data.statusLabel, '等待隐私同意');
  assert.equal(settings.data.error, '');
  assert.equal(settings.data.busy, false);
  assert.equal(h.requests.length, 0);
});

test('a failed connection cannot show a late toast or navigate after home leaves', async t => {
  const h = harness(t);
  const opening = h.home.open(event('account'));
  await h.home.open(event('settings'));
  failures[0].respond(h.requests.at(-1));
  await opening;
  assert.equal(h.top().route, 'pages/settings/index');
  assert.equal(h.toasts.length, 0);
  assert.equal(h.top().data.error, failures[0].message);
});

test('leaving settings during retry cannot navigate and returning restores the safe error', async t => {
  const h = harness(t);
  await h.home.open(event('settings'));
  const settings = h.top();
  const retry = settings.refreshService();
  h.navigate('/pages/index/index');
  const hiddenState = clone(settings.data);
  failures[0].respond(h.requests.at(-1));
  await retry;
  assert.deepEqual(settings.data, hiddenState);
  assert.equal(h.top().route, 'pages/index/index');
  assert.equal(h.toasts.length, 0);
  const returned = h.navigate('/pages/settings/index');
  assert.equal(returned.data.busy, false);
  assert.equal(returned.data.error, failures[0].message);
});

test('an unexpected connection exception keeps a fixed safe fallback in settings', async t => {
  const h = harness(t);
  await h.home.open(event('settings'));
  h.app.checkService = async () => { throw new Error('PRIVATE_TEST_UNEXPECTED'); };
  const settings = h.top();
  await settings.refreshService();
  assert.equal(settings.data.error, '暂时无法连接服务，请稍后再试');
  assert.equal(settings.data.busy, false);
  assert.doesNotMatch(JSON.stringify(settings.data), /PRIVATE_TEST/);
  assert.equal(h.requests.length, 0);
});

for (const entry of ['home', 'settings']) {
  test(`privacy withdrawal cancels the ${entry} connection and ignores a late failure`, async t => {
    const h = harness(t);
    let pending;
    if (entry === 'home') pending = h.home.open(event('account'));
    else { await h.home.open(event('settings')); pending = h.top().refreshService(); }
    const request = h.requests.at(-1);
    h.app.withdrawConsent();
    assert.equal(request.aborted, true);
    failures[0].respond(request);
    await pending;
    assert.equal(h.service.state.consent, false);
    assert.equal(h.service.state.error, '');
    assert.equal(h.top().route, 'pages/preferences/index');
    assert.equal(h.tasteProfile.isReady(), false);
    assert.equal(h.toasts.length, 0);
    h.navigate('/pages/settings/index');
    assert.equal(h.top().data.error, '');
    assert.equal(h.top().data.busy, false);
  });
}
