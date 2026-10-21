const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const event = page => ({ currentTarget: { dataset: { page } } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setTestTimeout(callback, delay, ...args) {
  const timer = setTimeout(callback, delay, ...args);
  // Keep navigation timers real; long page-refresh timers must not hold Node open.
  if (delay >= 1000) timer.unref();
  return timer;
}

function config() {
  return {
    coverageName: '合成测试范围', dataRightsMode: 'LIVE_DISPLAY_ONLY', aiEnabled: false,
    accountsEnabled: true, favoritesEnabled: false, supportFeedbackEnabled: true,
    nearbyRestaurantCollectionEnabled: true,
    minimumSupportedVersion: '0.1.3', ruleVersion: 'rules-test', promptVersion: 'prompt-test', modelVersion: 'rules',
    authCapabilities: { accountsEnabled: true, registrationEnabled: true, phoneEnabled: true, emailEnabled: true, wechatEnabled: false, qqEnabled: false, dataExportEnabled: true },
    serviceCapabilities: { recommendationsEnabled: true, groupRecommendationsEnabled: false, locationSearchEnabled: true, placeSearchEnabled: false },
    persistenceCapabilities: { favoritesEnabled: false, historyEnabled: false, privateFeedbackEnabled: false, savedResourceIdsEnabled: false },
    specialtyCapabilities: { breakfastProfileEnabled: true, dinnerProfileEnabled: true, milkTeaEnabled: false, coffeeEnabled: false, dessertEnabled: false, userReportedWeatherEnabled: false },
  };
}

// Run the real App, Page, service, nearby and feedback module graph together.
// Only the wx host is simulated: all coordinates, storage and HTTP bodies are
// synthetic, and no request can leave this process. navigateTo intentionally
// calls Page lifecycle hooks without calling App.onShow again.
function harness(options = {}) {
  const modules = new Map();
  const stack = [];
  const requests = [];
  const locations = [];
  const permissions = [];
  const entropy = [];
  const modals = [];
  const storage = new Map([['eatwhat.wechat.consent.v2', options.consent !== false]]);
  if (options.enabled) storage.set('eatwhat.wechat.nearby.enabled.v1', true);
  let app;
  let definition;
  const platform = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 }),
    getAppBaseInfo: () => ({ theme: 'light' }), onThemeChange() {}, hideShareMenu() {}, showToast() {}, setNavigationBarColor() {}, setNavigationBarTitle() {},
    request(callbacks) {
      assert.ok(callbacks.url.startsWith('https://api.eatwhat.pro/v1/'));
      const request = { callbacks, path: callbacks.url.slice('https://api.eatwhat.pro'.length), aborted: false };
      requests.push(request);
      return { abort() { request.aborted = true; callbacks.fail({ errMsg: 'synthetic abort' }); } };
    },
    getSetting(callbacks) {
      permissions.push(callbacks);
      if (!options.deferPermission) callbacks.success({ authSetting: { 'scope.userLocation': options.permission !== false } });
    },
    getLocation(callbacks) {
      locations.push(callbacks);
      if (!options.deferLocation) callbacks.success({ latitude: 0, longitude: 0, accuracy: 12 });
    },
    getRandomValues(callbacks) {
      entropy.push(callbacks);
      if (!options.deferEntropy) callbacks.success({ randomValues: new Uint8Array(16).fill(7).buffer });
    },
    showModal(callbacks) { modals.push(callbacks); },
    navigateTo({ url }) { navigate(url); },
    navigateBack() { back(); },
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
    page.showing = Promise.resolve(page.onShow?.());
    return page;
  }
  function back() {
    const page = stack.pop();
    page.onHide?.(); page.onUnload?.();
    const current = stack.at(-1);
    if (current) current.showing = Promise.resolve(current.onShow?.());
    return current;
  }
  load('./app');
  const service = load('./lib/service');
  const nearby = load('./lib/nearby');
  const tasteProfile = load('./lib/taste-profile');
  // Existing online flows begin with explicitly confirmed synthetic preferences.
  // Use the real storage/model APIs so App.onLaunch must restore a valid record.
  tasteProfile.start();
  for (const [field, value] of Object.entries({ spicyLevel: 2, flavorIntensity: 50 })) {
    tasteProfile.answer(field, value, tasteProfile.getState().revision);
  }
  tasteProfile.confirm(tasteProfile.getState().revision);
  assert.equal(tasteProfile.isReady(), true);
  function coldStart(name = 'index') {
    app.onLaunch(); app.onShow();
    return navigate(`/pages/${name}/index`);
  }
  function reply(request, data, statusCode = 200) {
    request.callbacks.success({ data, statusCode, header: { 'x-chishenme-contract-version': '1' } });
  }
  async function ready(page) {
    reply(requests.at(-1), config());
    await page.showing;
    await tick();
  }
  async function finishCollection() {
    const request = requests.at(-1);
    assert.equal(request.path, '/v1/restaurants/nearby');
    reply(request, { radiusMeters: 3500, retentionDays: 90, page: 1, nextPage: null, truncated: false, restaurants: [] });
    await tick();
  }
  function background() { app.onHide(); stack.at(-1)?.onHide?.(); }
  function foreground() {
    app.onShow();
    const page = stack.at(-1);
    if (page) page.showing = Promise.resolve(page.onShow?.());
  }
  return { app, service, nearby, tasteProfile, requests, locations, permissions, entropy, modals, storage, coldStart, navigate, back, reply, ready, finishCollection, background, foreground, top: () => stack.at(-1) };
}

test('virtual home and settings stay offline even with saved nearby opt-in', async () => {
  const h = harness({ enabled: true });
  const home = h.coldStart();
  await home.open(event('settings'));
  assert.equal(h.top().route, 'pages/settings/index');
  h.background(); h.foreground();
  await h.top().showing;
  assert.equal(h.requests.length, 0);
  assert.equal(h.locations.length, 0);
  assert.equal(h.permissions.length, 0);
});

for (const name of ['nearby', 'support']) {
  for (const entry of ['settings', 'direct']) {
    test(`${name} initializes through ${entry} entry on a consented cold start`, async () => {
      const h = harness({ enabled: true });
      if (entry === 'direct') h.coldStart(name);
      else {
        const home = h.coldStart();
        await home.open(event('settings'));
        h.top().open(event(name));
      }
      const page = h.top();
      assert.equal(page.route, `pages/${name}/index`);
      assert.deepEqual(h.requests.map(request => request.path), ['/v1/config']);
      assert.equal(h.locations.length, 0);
      await h.ready(page);
      if (name === 'nearby') {
        assert.equal(page.data.available, true);
        assert.equal(h.locations.length, 1);
        await h.finishCollection();
        assert.equal(page.data.phase, 'DONE');
        assert.equal(page.data.snapshots.length, 1);
      } else {
        assert.equal(page.data.enabled, true);
        assert.equal(h.requests.length, 1);
        assert.equal(h.locations.length, 0);
      }
    });
  }

  test(`${name} direct entry without consent sends no request or location call`, async () => {
    const h = harness({ consent: false, enabled: true });
    const page = h.coldStart(name);
    await page.showing;
    assert.equal(h.requests.length, 0);
    assert.equal(h.locations.length, 0);
    assert.equal(page.data.enabled, false);
  });

  test(`${name} leaving during configuration cannot activate the hidden page`, async () => {
    const h = harness({ enabled: true });
    const page = h.coldStart(name);
    h.navigate('/pages/index/index');
    const hidden = clone(page.data);
    await h.ready(page);
    assert.equal(h.locations.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(page._active, false);
    assert.deepEqual(clone(page.data), hidden);
    assert.equal(h.nearby.state.location, null);
  });

  test(`${name} failed configuration stays closed and a fresh visit can retry`, async () => {
    const h = harness({ enabled: true });
    const page = h.coldStart(name);
    h.reply(h.requests[0], { error: 'synthetic failure' }, 503);
    await page.showing;
    assert.equal(h.service.state.status, 'error');
    assert.equal(name === 'nearby' ? page.data.available : page.data.enabled, false);
    assert.equal(h.locations.length, 0);
    h.navigate('/pages/index/index');
    h.back();
    assert.deepEqual(h.requests.map(request => request.path), ['/v1/config', '/v1/config']);
    await h.ready(page);
    assert.equal(name === 'nearby' ? page.data.available : page.data.enabled, true);
    if (name === 'nearby') await h.finishCollection();
  });

  test(`${name} withdrawal aborts configuration and rejects its late response`, async () => {
    const h = harness({ enabled: true });
    const page = h.coldStart(name);
    const request = h.requests[0];
    h.app.withdrawConsent();
    assert.equal(request.aborted, true);
    h.reply(request, config());
    await page.showing;
    await tick();
    assert.equal(h.service.state.consent, false);
    assert.equal(h.service.state.config, null);
    assert.equal(h.top().route, 'pages/preferences/index');
    assert.equal(h.tasteProfile.isReady(), false);
    assert.equal(h.locations.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(page.data.enabled, false);
  });
}

test('nearby permission callback after leaving cannot begin location collection', async () => {
  const h = harness({ enabled: true, deferPermission: true });
  const page = h.coldStart('nearby');
  await h.ready(page);
  assert.equal(h.permissions.length, 1);
  h.navigate('/pages/index/index');
  h.permissions[0].success({ authSetting: { 'scope.userLocation': true } });
  await tick();
  assert.equal(h.locations.length, 0);
  assert.equal(h.requests.length, 1);
});

test('nearby location callback after leaving cannot write a snapshot or request restaurants', async () => {
  const h = harness({ enabled: true, deferLocation: true });
  const page = h.coldStart('nearby');
  await h.ready(page);
  assert.equal(h.locations.length, 1);
  h.navigate('/pages/index/index');
  h.locations[0].success({ latitude: 0, longitude: 0, accuracy: 12 });
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.nearby.listSnapshots().length, 0);
  assert.equal(h.nearby.state.location, null);
  assert.equal(h.service.state.location, null);
});

test('nearby background cancels location; foreground page reuses the App config request', async () => {
  const h = harness({ enabled: true, deferLocation: true });
  const page = h.coldStart('nearby');
  await h.ready(page);
  h.background();
  h.locations[0].success({ latitude: 0, longitude: 0, accuracy: 12 });
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.nearby.listSnapshots().length, 0);
  h.foreground();
  assert.deepEqual(h.requests.map(request => request.path), ['/v1/config', '/v1/config']);
  await h.ready(page);
  assert.equal(h.locations.length, 2);
  h.locations[1].success({ latitude: 0, longitude: 0, accuracy: 12 });
  await tick();
  await h.finishCollection();
  assert.equal(page.data.phase, 'DONE');
  assert.equal(page.data.snapshots.length, 1);
});

test('nearby withdrawal invalidates late location and clears the stored opt-in', async () => {
  const h = harness({ enabled: true, deferLocation: true });
  const page = h.coldStart('nearby');
  await h.ready(page);
  h.app.withdrawConsent();
  h.locations[0].success({ latitude: 0, longitude: 0, accuracy: 12 });
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.nearby.listSnapshots().length, 0);
  assert.equal(h.storage.has('eatwhat.wechat.nearby.enabled.v1'), false);
  assert.equal(h.service.state.location, null);
});

test('nearby restaurant response after leaving cannot populate the snapshot or hidden page', async () => {
  const h = harness({ enabled: true });
  const page = h.coldStart('nearby');
  await h.ready(page);
  const request = h.requests.at(-1);
  assert.equal(request.path, '/v1/restaurants/nearby');
  h.navigate('/pages/index/index');
  h.reply(request, { radiusMeters: 3500, retentionDays: 90, page: 1, nextPage: null, truncated: false, restaurants: [] });
  await tick();
  const snapshot = h.nearby.listSnapshots()[0];
  assert.equal(snapshot.status, 'PARTIAL');
  assert.equal(snapshot.pagesCollected, 0);
  assert.equal(snapshot.restaurants.length, 0);
  assert.equal(page.data.snapshots.length, 0);
  assert.equal(h.nearby.state.location, null);
});

test('nearby still requires opt-in and ignores a modal confirmed after leaving', async () => {
  const h = harness();
  const page = h.coldStart('nearby');
  await h.ready(page);
  assert.equal(h.locations.length, 0);
  page.enableCollection();
  h.navigate('/pages/index/index');
  await h.modals[0].success({ confirm: true });
  assert.equal(h.storage.has('eatwhat.wechat.nearby.enabled.v1'), false);
  assert.equal(h.locations.length, 0);
});

test('nearby denied permission waits for an explicit retry on the visible page', async () => {
  const h = harness({ enabled: true, permission: false });
  const page = h.coldStart('nearby');
  await h.ready(page);
  assert.equal(page.data.phase, 'PERMISSION');
  assert.equal(h.locations.length, 0);
  const retry = page.retry();
  await tick();
  assert.equal(h.locations.length, 1);
  await h.finishCollection();
  await retry;
  assert.equal(page.data.phase, 'DONE');
});

test('support late submission cannot overwrite the new draft after leaving and returning', async () => {
  const h = harness();
  const page = h.coldStart('support');
  await h.ready(page);
  page.input({ detail: { value: '第一份合成测试反馈内容足够长。' } });
  const submitting = page.submit();
  await tick();
  const request = h.requests.at(-1);
  assert.equal(request.path, '/v1/support-feedback');
  h.navigate('/pages/index/index');
  h.back();
  await page.showing;
  page.input({ detail: { value: '返回页面后写入的另一份合成反馈。' } });
  h.reply(request, { feedbackId: request.callbacks.data.submissionId, accepted: true, retentionAfterClosureDays: 180 }, 201);
  await submitting;
  assert.equal(page.data.message, '返回页面后写入的另一份合成反馈。');
  assert.equal(page.data.result, null);
  assert.equal(page.data.busy, false);
  assert.equal(h.requests.length, 2);
});

test('support background clears its draft and foreground reuses one config refresh', async () => {
  const h = harness();
  const page = h.coldStart('support');
  await h.ready(page);
  page.input({ detail: { value: '仅保留当前页面的合成反馈正文。' } });
  h.background();
  assert.equal(page.data.message, '');
  assert.equal(page.data.enabled, false);
  h.foreground();
  assert.deepEqual(h.requests.map(request => request.path), ['/v1/config', '/v1/config']);
  await h.ready(page);
  assert.equal(page.data.enabled, true);
  assert.equal(page.data.message, '');
  assert.equal(h.locations.length, 0);
});

test('support withdrawal before entropy callback prevents a feedback submission', async () => {
  const h = harness({ deferEntropy: true });
  const page = h.coldStart('support');
  await h.ready(page);
  page.input({ detail: { value: '撤销同意后不得提交的合成反馈。' } });
  const submitting = page.submit();
  assert.equal(h.entropy.length, 1);
  h.app.withdrawConsent();
  h.entropy[0].success({ randomValues: new Uint8Array(16).fill(7).buffer });
  await submitting;
  assert.equal(h.requests.length, 1);
  assert.equal(page.data.message, '');
  assert.equal(page.data.result, null);
  assert.equal(h.service.state.consent, false);
});
