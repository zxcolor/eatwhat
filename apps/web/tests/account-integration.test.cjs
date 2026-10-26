const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { adaptModule } = require('../scripts/compiler.cjs');

const ROOT = path.resolve(__dirname, '../source/wechat');
const NOW = Date.UTC(2030, 0, 1, 12);
const id = value => `20000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const instant = delta => new Date(NOW + delta).toISOString();
const PHONE = '+8613800138000';
const EMAIL = 'synthetic@example.test';
const ACCESS_TOKEN = 'A'.repeat(43);

function configuration() {
  return {
    coverageName: 'Synthetic transport fixture', dataRightsMode: 'LIVE_DISPLAY_ONLY', aiEnabled: false,
    accountsEnabled: true, favoritesEnabled: false, minimumSupportedVersion: '0.1.3',
    ruleVersion: 'synthetic-rules', promptVersion: 'synthetic-prompt', modelVersion: 'rules',
    authCapabilities: { accountsEnabled: true, registrationEnabled: true, phoneEnabled: true, emailEnabled: true,
      wechatEnabled: true, wechatMiniProgramEnabled: true, qqEnabled: true, dataExportEnabled: false },
    serviceCapabilities: { recommendationsEnabled: true, groupRecommendationsEnabled: false, locationSearchEnabled: true,
      placeSearchEnabled: false, takeoutScreenshotsEnabled: true, restaurantDecisionPoolEnabled: true },
    persistenceCapabilities: { favoritesEnabled: false, historyEnabled: false, privateFeedbackEnabled: false, savedResourceIdsEnabled: false },
    specialtyCapabilities: { breakfastProfileEnabled: true, dinnerProfileEnabled: true, milkTeaEnabled: false,
      coffeeEnabled: false, dessertEnabled: false, userReportedWeatherEnabled: false },
  };
}

// All business modules, the account page and platform/request adapters are real
// source. Only the browser shell and HTTP responses are synthetic. No request
// is ever sent to a network, phone, mailbox or verification-code provider.
function harness(t) {
  class FixedDate extends Date { static now() { return NOW; } }
  const requests = [], storage = new Map(), modules = new Map();
  let definition, page;
  const context = {
    URL, URLSearchParams, Headers, Response, Blob, Uint8Array, ArrayBuffer, TextEncoder, AbortController,
    Date: FixedDate, crypto: webcrypto, btoa, queueMicrotask, setTimeout, clearTimeout,
    setInterval(...args) { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval,
    document: { querySelector: () => null }, navigator: {}, screen: { width: 390, height: 844 },
    innerWidth: 390, innerHeight: 844,
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, removeEventListener() {},
    localStorage: {
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key), key: index => [...storage.keys()][index], get length() { return storage.size; },
    },
    Page(value) { definition = value; },
    getApp: () => ({ syncPage() {} }), getCurrentPages: () => page ? [page] : [],
    fetch: async (url, options) => {
      assert.match(url, /^\/api\/v1\//);
      const data = options.body === undefined ? undefined : JSON.parse(options.body);
      requests.push({ url, method: options.method, data, headers: { ...options.headers }, credentials: options.credentials });
      let body;
      if (url === '/api/v1/config') body = configuration();
      else if (url === '/api/v1/auth/phone/request-code' || url === '/api/v1/auth/email/request-code') {
        const phone = url.includes('/phone/');
        assert.equal(data[phone ? 'phoneNumber' : 'email'], phone ? PHONE : EMAIL);
        body = { challengeId: id(10), targetType: phone ? 'PHONE' : 'EMAIL', maskedTarget: phone ? '+86138****8000' : 's***@example.test',
          expiresAt: instant(300000), resendAvailableAt: instant(30000) };
      } else if (url === '/api/v1/auth/login') {
        assert.equal(data.otpCode, '123456'); assert.equal(data.challengeId, id(10));
        body = { userId: id(1), sessionId: id(3), tokenType: 'Bearer', accessToken: ACCESS_TOKEN,
          accessTokenExpiresAt: instant(900000), refreshToken: 'B'.repeat(43), refreshTokenExpiresAt: instant(3600000) };
      } else if (url === '/api/v1/auth/identities') {
        assert.equal(options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
        body = { items: [
          { bindingId: id(20), type: 'PHONE', maskedValue: '+86138****8000', boundAt: instant(-3600000), primary: true, canUnbind: false },
          { bindingId: id(21), type: 'EMAIL', maskedValue: 's***@example.test', boundAt: instant(-3600000), primary: false, canUnbind: true },
          { bindingId: id(22), type: 'WECHAT', maskedValue: '微信账号', boundAt: instant(-3600000), primary: false, canUnbind: true },
          { bindingId: id(23), type: 'QQ', maskedValue: 'QQ 账号', boundAt: instant(-3600000), primary: false, canUnbind: false },
        ] };
      } else if (url === '/api/v1/auth/sessions?includePlatforms=ALL_WITH_WEB') {
        assert.equal(options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
        body = { items: ['ANDROID', 'MINIPROGRAM', 'WEB'].map((platform, index) => ({ sessionId: id(index + 1),
          deviceLabel: `Synthetic ${platform}`, platform, current: platform === 'WEB', createdAt: instant(-3600000),
          lastActiveAt: instant(-1000), expiresAt: instant(3600000) })) };
      } else throw new Error(`Unexpected synthetic transport route: ${url}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'X-ChiShenMe-Contract-Version': '1' } });
    },
  };
  context.window = context; context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../runtime/platform.js'), 'utf8'), context);
  context.installPlatform({ currentPages: () => page ? [page] : [], navigate() {}, back() {}, setTitle() {}, setNavColor() {} });
  function load(relative, parent = path.join(ROOT, 'entry.js')) {
    const file = path.resolve(path.dirname(parent), relative.endsWith('.js') ? relative : relative + '.js');
    assert.ok(file.startsWith(ROOT + path.sep));
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const sourcePath = path.relative(ROOT, file).split(path.sep).join('/');
    const source = adaptModule(fs.readFileSync(file, 'utf8'), sourcePath);
    const factory = vm.runInContext(`(function(require,module,exports){\n${source}\n})`, context, { filename: sourcePath });
    factory(request => load(request, file), module, module.exports);
    return module.exports;
  }
  const service = load('./lib/service'), account = load('./lib/account');
  function mountAccount() {
    load('./pages/account/index');
    page = { ...definition, route: 'pages/account/index', data: JSON.parse(JSON.stringify(definition.data)),
      setData(patch) { Object.assign(this.data, patch); } };
    page.onShow(); return page;
  }
  t.after(() => { page?.onUnload(); account.clear(); service.setConsent(false); });
  return { service, account, mountAccount, requests, storage };
}

for (const method of ['PHONE', 'EMAIL']) test(`actual ${method} account page logs in as WEB and refreshes all three session types`, async t => {
  const h = harness(t), target = method === 'PHONE' ? PHONE : EMAIL;
  h.service.setConsent(true); await h.service.refreshConfig();
  const page = h.mountAccount();
  page.setData({ method, purpose: 'LOGIN', target, otpCode: '123456' });
  await page.sendCode(); assert.equal(page.data.hasChallenge, true); assert.equal(page.data.error, '');
  await page.login();
  assert.equal(page.data.error, ''); assert.equal(page.data.signedIn, true); assert.equal(page.data.detailsReady, true);
  const login = h.requests.find(request => request.url === '/api/v1/auth/login');
  assert.equal(login.data.device.platform, 'WEB'); assert.equal(login.data.device.label, '吃什么网页版');
  assert.match(login.data.device.installationId, /^[0-9a-f-]{36}$/);
  assert.equal(login.data.method, method);
  assert.ok(h.requests.some(request => request.url === '/api/v1/auth/sessions?includePlatforms=ALL_WITH_WEB'));
  assert.deepEqual(Array.from(page.data.sessions, item => item.platform), ['Android', '小程序', '浏览器']);
  assert.deepEqual(Array.from(page.data.sessions, item => item.label), ['Synthetic ANDROID', 'Synthetic MINIPROGRAM', 'Synthetic WEB']);
  assert.equal(page.data.sessions[2].current, true);
  assert.deepEqual(Array.from(page.data.identities, item => item.label), ['手机号', '邮箱', '微信', 'QQ']);
  const before = h.requests.length;
  await page.refreshDetails();
  assert.equal(page.data.error, ''); assert.equal(page.data.detailsReady, true); assert.equal(h.requests.length, before + 2);
  assert.ok(h.requests.every(request => request.credentials === 'omit'));
  assert.equal(h.storage.size, 0, 'OTP, tokens and device identifiers must never be persisted');
});

test('actual service continues to reject unknown session query values without sending HTTP', async t => {
  const h = harness(t); h.service.setConsent(true);
  for (const query of ['includePlatforms=UNKNOWN', 'includePlatforms=all_with_web', 'includePlatforms=ALL_WITH_WEB&includePlatforms=ALL',
    'includePlatforms=ALL_WITH_WEB&extra=1', 'extra=ALL_WITH_WEB']) {
    await assert.rejects(h.service.request('/v1/auth/sessions?' + query), error => error.code === 'INVALID_PATH');
  }
  assert.equal(h.requests.length, 0);
});

test('browser native login stays disabled even if the server advertises native capabilities', async t => {
  const h = harness(t); h.service.setConsent(true); await h.service.refreshConfig();
  const before = h.requests.length;
  assert.equal(h.account.view().capabilities.wechatMiniProgramEnabled, false);
  let askedForCode = false;
  await assert.rejects(h.account.loginWithWechat(async () => { askedForCode = true; return 'not-a-real-code'; }), error => error.code === 'UNAVAILABLE');
  assert.equal(askedForCode, false); assert.equal(h.requests.length, before);
});
