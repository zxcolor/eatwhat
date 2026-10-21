'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TIMING } = require('../lib/decision-motion');

const ROOT = path.resolve(__dirname, '..');
const TASTE_KEY = 'eatwhat.wechat.taste-profile.v1';
const CONSENT_KEY = 'eatwhat.wechat.consent.v2';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function setTestTimeout(callback, delay, ...args) {
  const timer = setTimeout(callback, delay, ...args);
  // Keep navigation timers real; long page-refresh timers must not hold Node open.
  if (delay >= 1000) timer.unref();
  return timer;
}

// Load the real App, Pages, preference store, catalog and decision engine in one
// module graph. Only wx and time are synthetic. These tests collect no real
// answers and cannot request the network, login, permissions or device location.
function harness(options = {}) {
  const modules = new Map();
  const stack = [];
  const storage = new Map((options.storage || []).map(([key, value]) => [key, clone(value)]));
  if (options.consent !== undefined) storage.set(CONSENT_KEY, options.consent);
  const writes = [];
  const navigation = [];
  const relaunches = [];
  const forbidden = [];
  const modals = [];
  const toasts = [];
  const componentEvents = [];
  const renderCallbacks = [];
  const sheetFrames = [];
  const failures = { tasteWrite: false, tasteRemove: false };
  let clock = options.now === undefined ? 2000000000000 : options.now;
  let app;
  let definition;
  let componentDefinition;
  let navigationDepth = 0;
  let remainingNavigationFailures = options.failRelaunches || 0;
  class LocalDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const deny = operation => () => {
    forbidden.push(operation);
    throw new Error(`Unexpected external operation during local onboarding: ${operation}`);
  };
  const platform = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync(key, value) {
      writes.push({ key, value: clone(value) });
      if (key === TASTE_KEY && failures.tasteWrite) throw new Error('Synthetic taste storage write failure');
      storage.set(key, clone(value));
    },
    removeStorageSync(key) {
      if (key === TASTE_KEY && failures.tasteRemove) throw new Error('Synthetic taste storage remove failure');
      storage.delete(key);
    },
    getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 }),
    getAppBaseInfo: () => ({ theme: 'light' }),
    onThemeChange() {}, hideShareMenu() {}, setNavigationBarColor() {}, setNavigationBarTitle() {}, pageScrollTo() {},
    showToast(value) { toasts.push(value); },
    showModal(value) { modals.push(value); },
    request: deny('request'), getLocation: deny('getLocation'), getSetting: deny('getSetting'),
    login: deny('login'), getUserProfile: deny('getUserProfile'), getRandomValues: deny('getRandomValues'),
    navigateTo(options) { navigate(options.url); options.success?.({}); options.complete?.({}); },
    redirectTo(options) {
      const previous = stack.pop();
      hidePage(previous); unloadPage(previous);
      navigate(options.url); options.success?.({}); options.complete?.({});
    },
    reLaunch(options) {
      relaunches.push({ url: options.url, depth: navigationDepth });
      if ((navigationDepth > 0 && harnessOptions.rejectReentrant) || remainingNavigationFailures > 0) {
        if (remainingNavigationFailures > 0) remainingNavigationFailures--;
        options.fail?.({ errMsg: 'reLaunch:fail synthetic navigation busy' }); options.complete?.({});
        return;
      }
      for (const page of stack.splice(0)) { hidePage(page); unloadPage(page); }
      navigate(options.url); options.success?.({}); options.complete?.({});
    },
    navigateBack(options = {}) {
      const previous = stack.pop();
      hidePage(previous); unloadPage(previous);
      showPage(stack.at(-1)); options.success?.({}); options.complete?.({});
    },
  };
  const harnessOptions = options;
  const context = vm.createContext({
    wx: platform, Date: LocalDate, setTimeout: setTestTimeout, clearTimeout, setInterval, clearInterval,
    App(value) { app = value; }, Page(value) { definition = value; }, Component(value) { componentDefinition = value; },
    getApp: () => app, getCurrentPages: () => stack,
  });
  function load(request, parent = path.join(ROOT, 'entry.js')) {
    assert.ok(request.startsWith('.'), `Only local modules belong to onboarding: ${request}`);
    let filename = path.resolve(path.dirname(parent), request);
    if (!path.extname(filename)) filename += '.js';
    assert.ok(filename.startsWith(`${ROOT}${path.sep}`), 'Module loading stays inside the Mini Program');
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const source = fs.readFileSync(filename, 'utf8');
    const execute = new vm.Script(`(function(require,module,exports){\n${source}\n})`, { filename }).runInContext(context);
    execute(child => load(child, filename), module, module.exports);
    return module.exports;
  }
  function syncSheetProperties(page) {
    const sheet = page._decisionSheet;
    if (!sheet) return;
    for (const [name, value] of Object.entries({ visible: page.data.decisionOpen === true, themeClass: page.data.themeClass,
      revealOrigin: page.data.revealOrigin || null, sourceRect: page.data.sourceRect || null, reducedMotion: page.data.reducedMotion === true })) {
      if (sheet.properties[name] === value) continue;
      const previous = sheet.properties[name];
      sheet.properties[name] = value;
      sheet.data[name] = value;
      const observer = sheet._definition.properties[name]?.observer;
      if (typeof observer === 'function') observer.call(sheet, value, previous);
      else if (typeof observer === 'string') sheet[observer](value, previous);
      sheet._definition.observers?.[name]?.call(sheet, value);
    }
  }
  function mountSheet(page) {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'pages/index/index.json'), 'utf8'));
    assert.equal(config.usingComponents['decision-sheet'], '/components/decision-sheet/index');
    const filename = path.join(ROOT, 'components/decision-sheet/index.js');
    componentDefinition = null;
    const source = fs.readFileSync(filename, 'utf8');
    new vm.Script(`(function(require){\n${source}\n})`, { filename }).runInContext(context)(child => load(child, filename));
    assert.ok(componentDefinition, 'The real decision-sheet Component must register');
    const properties = Object.fromEntries(Object.entries(componentDefinition.properties).map(([name, value]) => [name, value.value]));
    const sheet = {
      ...componentDefinition.methods,
      properties,
      data: { ...clone(componentDefinition.data), ...clone(properties) },
      _definition: componentDefinition,
      setData(value, callback) {
        Object.assign(this.data, clone(value));
        if (options.captureSheetFrames) sheetFrames.push(clone(this.data));
        if (callback) {
          // The existing deferred-result cases hold only a live result frame;
          // opening-frame cases explicitly hold every native render callback.
          if (options.deferAllSheetRender || (options.deferSheetRender && Object.hasOwn(value, 'current') && value.preferenceReady === true)) renderCallbacks.push(callback);
          else callback();
        }
      },
      triggerEvent(name, detail) {
        componentEvents.push({ name, detail: clone(detail) });
        if (name === 'close') page.closeDecision();
        else if (name === 'statechange') page.decisionChanged();
        else if (name === 'adjust') page.openFilter();
        else assert.fail(`Unexpected decision-sheet event: ${name}`);
      },
    };
    page._decisionSheet = sheet;
    componentDefinition.lifetimes?.attached?.call(sheet);
    syncSheetProperties(page);
    componentDefinition.lifetimes?.ready?.call(sheet);
    return sheet;
  }
  function showPage(page) {
    page?.onShow?.();
    const sheet = page?._decisionSheet;
    sheet?._definition.pageLifetimes?.show?.call(sheet);
  }
  function hidePage(page) {
    page?.onHide?.();
    const sheet = page?._decisionSheet;
    sheet?._definition.pageLifetimes?.hide?.call(sheet);
  }
  function unloadPage(page) {
    page?.onUnload?.();
    const sheet = page?._decisionSheet;
    sheet?._definition.lifetimes?.detached?.call(sheet);
  }
  function navigate(url) {
    navigationDepth++;
    try {
      navigation.push(url);
      hidePage(stack.at(-1));
      const [pathname, search = ''] = url.split('?');
      const route = pathname.replace(/^\//, '');
      const query = Object.fromEntries(new URLSearchParams(search));
      const filename = path.join(ROOT, `${route}.js`);
      definition = null;
      const source = fs.readFileSync(filename, 'utf8');
      new vm.Script(`(function(require){\n${source}\n})`, { filename }).runInContext(context)(child => load(child, filename));
      assert.ok(definition, `Page registered for ${route}`);
      const page = { ...definition, route, data: clone(definition.data),
        setData(value, callback) { Object.assign(this.data, clone(value)); syncSheetProperties(this); callback?.(); } };
      stack.push(page);
      page.onLoad?.(query);
      if (route === 'pages/index/index') mountSheet(page);
      showPage(page);
      return page;
    } finally { navigationDepth--; }
  }
  load('./app');
  const profile = load('./lib/taste-profile');
  const decision = load('./lib/decision/service');
  const model = load('./lib/decision/taste-profile');
  const service = load('./lib/service');
  const appConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  function coldStart(route = appConfig.pages[0]) {
    app.onLaunch(); app.onShow();
    navigate(`/${route}`);
    return stack.at(-1);
  }
  function foreground() {
    app.onShow();
    showPage(stack.at(-1));
    return stack.at(-1);
  }
  function assertOffline() { assert.deepEqual(forbidden, [], 'The local preference flow must never call an external capability'); }
  async function settleNavigation() {
    // Actual timers, including failure retries. Never invoke a queued callback
    // directly or replace failed navigation with a synthetic successful route.
    await new Promise(resolve => setTimeout(resolve, 10));
    for (let i = 0; i < 40 && app._preferenceRedirect; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(app._preferenceRedirect || null, null, 'Deferred navigation must settle within its bounded retry budget');
    return stack.at(-1);
  }
  return { app, profile, decision, model, service, appConfig, storage, writes, navigation, relaunches, modals, toasts, failures, componentEvents,
    settleNavigation,
    coldStart, navigate, foreground, assertOffline, top: () => stack.at(-1),
    sheet: () => stack.at(-1)?._decisionSheet,
    async settleSheet({ pendingRender = false } = {}) {
      const sheet = stack.at(-1)?._decisionSheet;
      for (let i = 0; i < 100 && (sheet?._opening || sheet?.data.interactionLocked); i++) {
        if (pendingRender && renderCallbacks.length) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (pendingRender) assert.ok(renderCallbacks.length, 'The real result has reached a deliberately held native render callback');
      else {
        assert.equal(sheet?._opening, false, 'The actual enter timer and render callbacks must settle before the card can be used');
        assert.equal(sheet?.data.interactionLocked, false, 'The actual reveal or card transition must release the interaction guard');
      }
      return sheet;
    },
    async nextRenderCallbacks() {
      for (let i = 0; i < 100 && !renderCallbacks.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      return renderCallbacks.splice(0);
    },
    takeRenderCallbacks: () => renderCallbacks.splice(0),
    takeSheetFrames: () => sheetFrames.splice(0),
    flushRender() { for (const callback of renderCallbacks.splice(0)) callback(); },
    background() { app.onHide(); hidePage(stack.at(-1)); },
    advance(ms) { clock += ms; }, now: () => clock,
    snapshot: () => [...storage.entries()].map(([key, value]) => [key, clone(value)]) };
}

function event(page, data = {}) {
  return { currentTarget: { dataset: { revision: page.data.revision, ...data } } };
}
function assertLiveAssessment(h, page, count) {
  const state = h.profile.getState();
  const assessment = h.profile.assess();
  assert.equal(page.data.coverage, count);
  assert.equal(page.data.ready, assessment.ready, 'The page reflects the actual current catalog assessment after each answer');
  assert.equal(page.data.readinessMessage, assessment.message);
  assert.equal(Object.keys(state.answers).length, count);
  assert.equal(h.profile.isReady(), false, 'Answer sufficiency does not replace explicit confirmation');
  assert.equal(h.decision.getState().current, null);
  assert.equal(page.data.error, '');
}

function fillThroughPage(h, liked = 'hotpot') {
  const page = h.top();
  assert.equal(page.route, 'pages/preferences/index');
  page.start();
  assert.equal(page.data.started, true);
  assertLiveAssessment(h, page, 0);
  page.toggleGroup(event(page, { id: liked }));
  assertLiveAssessment(h, page, 1);
  page.next(event(page));
  assert.equal(page.data.step, 2);
  page.chooseNone(event(page));
  assertLiveAssessment(h, page, 2);
  page.next(event(page));
  assert.equal(page.data.step, 3);
  page.selectOption(event(page, { field: 'budgetCents', index: 0 }));
  assertLiveAssessment(h, page, 3);
  assert.equal(page.data.canNext, false, 'Budget alone does not answer the separate spice field');
  page.selectOption(event(page, { field: 'maxSpicy', index: 0 }));
  assertLiveAssessment(h, page, 4);
  page.next(event(page));
  assert.equal(page.data.step, 4);
  page.selectPriority(event(page, { id: 'taste' }));
  assertLiveAssessment(h, page, 5);
  assert.equal(page.data.ready, true);
  assert.equal(h.top(), page);
  page.next(event(page));
  assert.equal(page.data.step, 5);
  return page;
}

async function finishThroughPage(h, page = h.top()) {
  await page.finish(event(page));
  assert.equal(h.top().route, 'pages/index/index');
  assert.equal(h.top().data.preferenceReady, true);
  assert.equal(h.profile.isReady(), true);
  assert.equal(h.decision.getState().profileReady, true);
  assert.equal(h.top().data.error, '');
  h.assertOffline();
  return h.top();
}

async function currentCard(h) {
  const home = h.top();
  assert.equal(home.route, 'pages/index/index');
  const navigationCount = h.navigation.length;
  home.decide();
  assert.equal(h.top(), home, 'Deciding opens an in-place sheet and keeps the home Page');
  assert.equal(h.navigation.length, navigationCount);
  assert.equal(home.data.decisionOpen, true);
  const sheet = h.sheet();
  assert.equal(sheet.properties.visible, true);
  await h.settleSheet();
  assert.equal(sheet.data.error, '');
  const state = h.decision.getState();
  assert.equal(state.status, 'recommended');
  assert.ok(sheet._shown, 'The actual sheet presenter marks the current engine revision rendered');
  assert.equal(sheet.data.current.id, state.current.id);
  return state;
}

test('integration: first launch opens an unanswered preference Page without saving implied consent', () => {
  const h = harness();
  const page = h.coldStart();
  assert.equal(h.appConfig.pages[0], 'pages/preferences/index');
  assert.equal(page.route, 'pages/preferences/index');
  assert.equal(page.data.started, false);
  assert.equal(page.data.coverage, 0);
  assert.equal(page.data.ready, false);
  assert.deepEqual(clone(h.profile.getState().answers), {});
  assert.equal(page.data.groups.some(group => group.selected), false);
  assert.equal(page.data.budgets.some(option => option.selected), false);
  assert.equal(page.data.spicyOptions.some(option => option.selected), false);
  assert.equal(page.data.priorities.some(option => option.selected), false);
  assert.equal(h.storage.has(TASTE_KEY), false);
  assert.equal(h.writes.some(write => write.key === TASTE_KEY), false);
  assert.equal(h.decision.getState().profileReady, false);
  assert.equal(h.decision.getState().current, null);
  assert.equal(page.data.error, '');
  h.assertOffline();
});

test('integration: all five deep-linked decision routes remain blocked while a real draft is incomplete', async () => {
  const h = harness({ rejectReentrant: true });
  const start = h.coldStart();
  start.start();
  start.toggleGroup(event(start, { id: 'hotpot' }));
  for (const route of ['index', 'conditions', 'results', 'detail', 'location']) {
    const rejected = h.navigate(`/pages/${route}/index?id=synthetic&revision=1`);
    await h.settleNavigation();
    assert.equal(h.top().route, 'pages/preferences/index', route);
    assert.equal(rejected.data.preferenceReady, false, `${route} cannot render its decision content`);
    assert.equal(h.profile.isReady(), false);
    assert.equal(h.decision.getState().current, null);
    assert.equal(h.top().data.coverage, 1);
    assert.deepEqual(clone(h.profile.getState().answers), { likedGroups: ['hotpot'] });
  }
  assert.equal(h.decision.getDiagnostics().events.events.length, 0);
  h.assertOffline();
});

test('integration: every Page answer updates sufficiency and confirmation produces an actual preferred-type card', async () => {
  const h = harness();
  h.coldStart();
  const page = fillThroughPage(h, 'hotpot');
  assert.equal(h.navigation.includes('/pages/index/index'), false);
  await finishThroughPage(h, page);
  const state = await currentCard(h);
  assert.ok(h.model.GROUPS.find(group => group.id === 'hotpot').categories.includes(state.current.storeCategory));
  assert.match(state.current.scoreMeaning, /不是满意度概率/);
  assert.equal(h.decision.getDiagnostics().policy.learningEnabled, false);
  assert.equal(h.decision.getDiagnostics().policy.activeQuestionsEnabled, false);
  assert.equal(h.decision.getDiagnostics().evidence.status, 'evidence_insufficient');
  h.assertOffline();
});

test('integration: a fresh module graph restores only a confirmed profile and enters home', async () => {
  const first = harness();
  first.coldStart();
  const page = fillThroughPage(first, 'noodles');
  const unconfirmed = harness({ storage: first.snapshot(), now: first.now() });
  assert.equal(unconfirmed.coldStart().route, 'pages/preferences/index');
  assert.equal(unconfirmed.profile.isReady(), false);
  assert.equal(unconfirmed.top().data.step, 5);
  await finishThroughPage(first, page);
  const second = harness({ storage: first.snapshot(), now: first.now(), rejectReentrant: true });
  second.coldStart();
  assert.equal(second.relaunches.length, 0, 'Confirmed cold start must leave the Page onShow stack before navigation');
  assert.equal((await second.settleNavigation()).route, 'pages/index/index');
  assert.equal(second.relaunches.length, 1);
  assert.equal(second.relaunches[0].depth, 0);
  assert.deepEqual(clone(second.profile.getProfile().likedGroups), ['noodles']);
  const state = await currentCard(second);
  assert.ok(second.model.GROUPS.find(group => group.id === 'noodles').categories.includes(state.current.storeCategory));
  first.assertOffline(); unconfirmed.assertOffline(); second.assertOffline();
});

test('integration: editing immediately invalidates the rendered card and changed likes change the actual result', async () => {
  const h = harness();
  h.coldStart();
  await finishThroughPage(h, fillThroughPage(h, 'hotpot'));
  const before = await currentCard(h);
  const oldBinding = { candidateId: before.current.id, revision: before.revision };
  h.navigate('/pages/preferences/index?edit=1');
  assert.equal(h.top().data.editing, true);
  assert.equal(h.profile.isReady(), false);
  assert.equal(h.decision.resolve(oldBinding.candidateId, oldBinding.revision), null);
  assert.throws(() => h.decision.confirm(oldBinding));
  h.navigate('/pages/index/index');
  await h.settleNavigation();
  assert.equal(h.top().route, 'pages/preferences/index');
  assert.equal(h.top().data.editing, true);
  const editing = h.top();
  editing.editStep(event(editing, { step: 1 }));
  editing.toggleGroup(event(editing, { id: 'noodles' }));
  editing.toggleGroup(event(editing, { id: 'hotpot' }));
  assert.deepEqual(clone(h.profile.getState().answers.likedGroups), ['noodles']);
  assert.equal(h.profile.isReady(), false);
  while (editing.data.step < 5) editing.next(event(editing));
  await finishThroughPage(h, editing);
  const after = await currentCard(h);
  assert.notEqual(after.current.id, before.current.id);
  assert.ok(h.model.GROUPS.find(group => group.id === 'noodles').categories.includes(after.current.storeCategory));
  assert.throws(() => h.decision.confirm(oldBinding));
  h.assertOffline();
});

test('integration: immediately reconfirming identical answers starts a new decision epoch without an intervening engine read', async () => {
  const h = harness({ rejectReentrant: true });
  h.coldStart();
  await finishThroughPage(h, fillThroughPage(h, 'hotpot'));
  const before = await currentCard(h);
  const oldBinding = { candidateId: before.current.id, revision: before.revision };
  const editing = h.navigate('/pages/preferences/index?edit=1');
  assert.equal(editing.data.editing, true);
  assert.equal(editing.data.step, 5);
  // Do not read decision state or resolve a binding while the draft is open.
  // Those reads would lazily clear the old approval and hide a stale-card bug.
  await editing.finish(event(editing));
  assert.equal(h.top().route, 'pages/index/index');
  assert.equal(h.decision.resolve(oldBinding.candidateId, oldBinding.revision), null);
  assert.throws(() => h.decision.confirm(oldBinding));
  assert.equal(h.decision.getState().current, null);
  const after = await currentCard(h);
  assert.notEqual(after.revision, before.revision);
  assert.throws(() => h.decision.confirm(oldBinding));
  h.assertOffline();
});

test('integration: seven-day incomplete draft and ninety-day approval expire through real lifecycle checks', async () => {
  const draft = harness();
  const first = draft.coldStart();
  first.start(); first.toggleGroup(event(first, { id: 'hotpot' }));
  draft.advance(draft.profile.DRAFT_TTL_MS);
  const expiredDraft = draft.foreground();
  assert.equal(expiredDraft.route, 'pages/preferences/index');
  assert.equal(expiredDraft.data.started, false);
  assert.equal(draft.profile.isReady(), false);
  assert.deepEqual(clone(draft.profile.getState().answers), {});
  draft.navigate('/pages/index/index');
  await draft.settleNavigation();
  assert.equal(draft.top().route, 'pages/preferences/index');

  const approved = harness();
  approved.coldStart();
  await finishThroughPage(approved, fillThroughPage(approved));
  const card = await currentCard(approved);
  approved.advance(approved.profile.PROFILE_TTL_MS);
  approved.foreground();
  assert.equal((await approved.settleNavigation()).route, 'pages/preferences/index');
  assert.equal(approved.profile.isReady(), false);
  assert.equal(approved.decision.getState().current, null);
  assert.equal(approved.decision.resolve(card.current.id, card.revision), null);
  assert.throws(() => approved.decision.confirm({ candidateId: card.current.id, revision: card.revision }));
  draft.assertOffline(); approved.assertOffline();
});

test('integration: Settings clear and privacy withdrawal erase approval and return to preference Page', async () => {
  for (const action of ['clearTaste', 'withdrawConsent']) {
    const h = harness({ consent: true });
    h.coldStart();
    await finishThroughPage(h, fillThroughPage(h));
    const card = await currentCard(h);
    const settings = h.navigate('/pages/settings/index');
    settings[action]();
    assert.equal(h.modals.length, 1);
    h.modals[0].success({ confirm: true, cancel: false });
    assert.equal(h.top().route, 'pages/preferences/index');
    assert.equal(h.top().data.started, false);
    assert.equal(h.profile.isReady(), false);
    assert.equal(h.storage.has(TASTE_KEY), false);
    assert.equal(h.decision.getState().current, null);
    assert.equal(h.decision.resolve(card.current.id, card.revision), null);
    if (action === 'withdrawConsent') {
      assert.equal(h.service.state.consent, false);
      assert.notEqual(h.storage.get(CONSENT_KEY), true);
    }
    assert.equal(h.top().data.error, '');
    h.assertOffline();
  }
});

test('integration: storage failures on Start and confirmation never open home or create a recommendation', async () => {
  const h = harness();
  const introduction = h.coldStart();
  h.failures.tasteWrite = true;
  introduction.start();
  assert.equal(h.top().route, 'pages/preferences/index');
  assert.equal(introduction.data.started, false);
  assert.match(introduction.data.error, /保存失败/);
  assert.equal(h.profile.isReady(), false);
  assert.equal(h.storage.has(TASTE_KEY), false);
  h.failures.tasteWrite = false;
  const confirmation = fillThroughPage(h);
  h.failures.tasteWrite = true;
  await confirmation.finish(event(confirmation));
  assert.equal(h.top().route, 'pages/preferences/index');
  assert.equal(confirmation.data.step, 5);
  assert.equal(confirmation.data.busy, false);
  assert.match(confirmation.data.error, /保存失败/);
  assert.equal(h.profile.isReady(), false);
  assert.equal(h.decision.getState().current, null);
  assert.equal(h.navigation.includes('/pages/index/index'), false);
  h.failures.tasteWrite = false;
  await finishThroughPage(h, confirmation);
  assert.equal((await currentCard(h)).status, 'recommended');
  h.assertOffline();
});

test('integration: failed edit persistence closes the old approval and invalidates its rendered card', async () => {
  for (const removeAlsoFails of [false, true]) {
    const h = harness();
    h.coldStart();
    await finishThroughPage(h, fillThroughPage(h));
    const card = await currentCard(h);
    h.failures.tasteWrite = true;
    h.failures.tasteRemove = removeAlsoFails;
    const editing = h.navigate('/pages/preferences/index?edit=1');
    assert.equal(h.top().route, 'pages/preferences/index');
    assert.match(editing.data.error, /保存失败/);
    if (removeAlsoFails) assert.match(editing.data.error, /旧记录可能仍存在/);
    assert.equal(h.profile.isReady(), false);
    assert.equal(h.decision.resolve(card.current.id, card.revision), null);
    assert.throws(() => h.decision.confirm({ candidateId: card.current.id, revision: card.revision }));
    h.navigate('/pages/index/index');
    await h.settleNavigation();
    assert.equal(h.top().route, 'pages/preferences/index');
    if (!removeAlsoFails) {
      const restored = harness({ storage: h.snapshot(), now: h.now() });
      assert.equal(restored.coldStart().route, 'pages/preferences/index');
      assert.equal(restored.profile.isReady(), false);
      restored.assertOffline();
    }
    h.failures.tasteWrite = false;
    h.failures.tasteRemove = false;
    h.app.clearTasteProfile();
    assert.equal(h.top().route, 'pages/preferences/index');
    assert.equal(h.storage.has(TASTE_KEY), false);
    h.assertOffline();
  }
});

test('integration: onShow gate defers native navigation and coalesces repeated checks', async () => {
  const h = harness({ rejectReentrant: true });
  h.coldStart();
  const rejected = h.navigate('/pages/index/index');
  assert.equal(rejected.data.preferenceReady, false);
  assert.equal(h.decision.getState().current, null);
  assert.equal(h.relaunches.length, 0, 'No native navigation may run inside the protected Page onShow stack');
  h.app.ensureTasteProfile(); h.app.ensureTasteProfile();
  assert.equal(h.relaunches.length, 0, 'Repeated synchronous gate checks share one pending timer');
  assert.equal((await h.settleNavigation()).route, 'pages/preferences/index');
  assert.equal(h.relaunches.length, 1);
  assert.equal(h.relaunches[0].depth, 0);
  assert.equal(h.app._openingPreferences, false);
  h.assertOffline();
});

test('integration: reported native navigation failures retry finitely outside lifecycle callbacks', async () => {
  for (const failures of [2, Number.POSITIVE_INFINITY]) {
    const h = harness({ rejectReentrant: true, failRelaunches: failures });
    h.coldStart(); h.navigate('/pages/results/index');
    await h.settleNavigation();
    assert.equal(h.relaunches.length, 3);
    assert.ok(h.relaunches.every(attempt => attempt.depth === 0));
    assert.equal(h.profile.isReady(), false);
    assert.equal(h.decision.getState().current, null);
    if (failures === 2) {
      assert.equal(h.top().route, 'pages/preferences/index');
      assert.equal(h.toasts.length, 0);
    } else {
      assert.equal(h.top().route, 'pages/results/index', 'A failed host navigation is not fabricated into a success');
      assert.equal(h.top().data.preferenceReady, false);
      assert.equal(h.toasts.length, 1);
      assert.match(h.toasts[0].title, /暂时无法打开口味偏好/);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(h.relaunches.length, 3, 'Terminal failure must not spin or exceed the retry budget');
    }
    h.assertOffline();
  }
});

test('sheet: closing and reopening keeps the same current revision without an implicit reroll or choice', async () => {
  const h = harness();
  h.coldStart();
  const home = await finishThroughPage(h, fillThroughPage(h));
  const before = await currentCard(h);
  const sheet = h.sheet();
  const prepared = h.decision.getDiagnostics().events.events.filter(item => item.type === 'prepared').length;
  sheet.close();
  assert.equal(home.data.decisionOpen, false);
  assert.equal(sheet._active, false, 'Interaction stops when dismissal starts, before the exit animation ends');
  assert.equal(sheet._shown, null);
  const reopened = await currentCard(h);
  assert.equal(h.sheet(), sheet);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(sheet.data.mounted, true, 'An old exit-animation timer cannot remove the reopened sheet');
  assert.equal(sheet.data.entered, true);
  assert.equal(sheet.data.closing, false);
  assert.equal(reopened.revision, before.revision);
  assert.equal(reopened.current.id, before.current.id);
  assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'prepared').length, prepared);
  assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, 0);
  const choice = { currentTarget: { dataset: { id: sheet.data.current.id, revision: sheet.data.current.revision } } };
  sheet.confirm(choice); sheet.confirm(choice);
  assert.equal(h.decision.getState().status, 'confirmed');
  assert.equal(sheet.data.confirmed, true);
  assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, 1);
  sheet.close(); home.decide();
  await h.settleSheet();
  assert.equal(sheet.data.confirmed, true, 'Reopening retains the confirmed result and its success state');
  assert.equal(sheet.data.current.id, before.current.id);
  assert.equal(h.decision.getState().revision, before.revision);
  assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, 1);
  h.assertOffline();
});

test('sheet: delayed rendering cannot authorize a closed sheet or an older result after reopening', async () => {
  const h = harness({ deferSheetRender: true });
  h.coldStart();
  const home = await finishThroughPage(h, fillThroughPage(h));
  home.decide();
  const sheet = h.sheet();
  await h.settleSheet({ pendingRender: true });
  const before = h.decision.getState();
  const oldEvent = { currentTarget: { dataset: { id: before.current.id, revision: before.revision } } };
  const oldCallbacks = h.takeRenderCallbacks();
  assert.ok(oldCallbacks.length);
  sheet.confirm(oldEvent);
  assert.equal(h.decision.getState().status, 'recommended');
  assert.equal(sheet.data.confirmed, false);
  sheet.close();
  for (const callback of oldCallbacks) callback();
  assert.equal(sheet._shown, null);
  assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'client_reported_rendered').length, 0);
  home.decide();
  await h.settleSheet({ pendingRender: true });
  for (const callback of oldCallbacks) callback();
  assert.equal(sheet._shown, null, 'Callbacks from the previous visibility generation stay invalid after reopen');
  h.flushRender();
  await h.settleSheet();
  assert.ok(sheet._shown);
  assert.equal(h.decision.getState().revision, before.revision);
  sheet.next(oldEvent);
  const replacement = h.decision.getState();
  assert.notEqual(replacement.revision, before.revision);
  for (const callback of oldCallbacks) callback();
  sheet.confirm(oldEvent);
  assert.equal(h.decision.getState().status, 'recommended');
  assert.equal(sheet.data.confirmed, false);
  assert.equal(sheet._shown, null, 'The replacement card must finish its own render');
  h.flushRender();
  await h.settleSheet();
  assert.equal(sheet._shown.revision, replacement.revision);
  sheet.confirm({ currentTarget: { dataset: { id: replacement.current.id, revision: replacement.revision } } });
  assert.equal(h.decision.getState().status, 'confirmed');
  assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, 1);
  h.assertOffline();
});

test('sheet: profile expiry rejects the displayed binding and returns a fresh decision attempt to the preference gate', async () => {
  const h = harness({ rejectReentrant: true });
  h.coldStart();
  const home = await finishThroughPage(h, fillThroughPage(h));
  const before = await currentCard(h);
  const sheet = h.sheet();
  const oldEvent = { currentTarget: { dataset: { id: before.current.id, revision: before.revision } } };
  h.advance(h.profile.PROFILE_TTL_MS);
  sheet.confirm(oldEvent); sheet.next(oldEvent);
  assert.equal(h.profile.isReady(), false);
  assert.equal(h.decision.getState().current, null);
  assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, 0);
  home.decide();
  assert.equal((await h.settleNavigation()).route, 'pages/preferences/index');
  assert.equal(home.data.decisionOpen, false);
  assert.equal(sheet._active, false);
  assert.equal(sheet._shown, null);
  sheet.confirm(oldEvent);
  assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, 0);
  h.assertOffline();
});

test('sheet: detail navigation, target replacement and backgrounding close the previous interaction', async () => {
  const h = harness();
  h.coldStart();
  const firstHome = await finishThroughPage(h, fillThroughPage(h));
  const before = await currentCard(h);
  const firstSheet = h.sheet();
  firstSheet.detail({ currentTarget: { dataset: { id: before.current.id, revision: before.revision } } });
  assert.equal(h.top().route, 'pages/detail/index');
  assert.equal(h.top().data.current, true);
  assert.equal(firstHome.data.decisionOpen, false);
  assert.equal(firstSheet._active, false);
  const home = h.navigate('/pages/index/index');
  const reopened = await currentCard(h);
  assert.equal(reopened.revision, before.revision);
  home.selectTarget({ currentTarget: { dataset: { target: 'RESTAURANT' } } });
  assert.equal(home.data.decisionOpen, false);
  assert.equal(h.sheet()._active, false);
  assert.equal(h.decision.resolve(before.current.id, before.revision), null);
  const restaurant = await currentCard(h);
  assert.equal(restaurant.target, 'RESTAURANT');
  h.background();
  assert.equal(home.data.decisionOpen, false);
  assert.equal(h.sheet()._shown, null);
  h.foreground();
  assert.equal(home.data.decisionOpen, false, 'Resuming never opens or rerolls a result without a fresh action');
  assert.equal(h.decision.getState().revision, restaurant.revision);
  h.assertOffline();
});

for (const duringExit of [false, true]) {
  test(`sheet: opening frames never show the old confirmed card ${duringExit ? 'during exit-animation reversal' : 'before the next enter timer'}`, async () => {
    const options = {};
    const h = harness(options);
    h.coldStart();
    const home = await finishThroughPage(h, fillThroughPage(h));
    const before = await currentCard(h);
    const sheet = h.sheet();
    const oldEvent = { currentTarget: { dataset: { id: before.current.id, revision: before.revision } } };
    sheet.confirm(oldEvent);
    assert.equal(sheet.data.confirmed, true);
    const choicesBefore = h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length;
    sheet.close();
    if (!duringExit) await new Promise(resolve => setTimeout(resolve, TIMING.close + 30));
    assert.equal(sheet.data.mounted, duringExit);
    home.selectTarget({ currentTarget: { dataset: { target: 'RESTAURANT' } } });
    assert.equal(h.decision.resolve(before.current.id, before.revision), null);
    options.captureSheetFrames = true;
    options.deferAllSheetRender = true;
    const assertFreshFrames = () => {
      for (const frame of h.takeSheetFrames()) {
        assert.notEqual(frame.current?.revision, before.revision, 'No submitted opening frame may retain the old card revision');
        assert.equal(frame.confirmed, false, 'No submitted opening frame may flash the previous confirmation');
      }
    };
    const assertPreparing = () => {
      assert.equal(sheet.data.current, null);
      assert.equal(sheet.data.confirmed, false);
      assert.equal(sheet.data.preferenceReady, false);
      assert.equal(sheet._shown, null);
      sheet.confirm(oldEvent);
      assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, choicesBefore);
      assertFreshFrames();
    };
    home.decide();
    assertPreparing();
    const mountCallbacks = h.takeRenderCallbacks();
    assert.ok(mountCallbacks.length, 'Opening waits for the actual mount render acknowledgement');
    for (const callback of mountCallbacks) { callback(); assertFreshFrames(); }
    assertPreparing();
    // The real 16ms enter timer may run, but its render acknowledgement remains
    // pending. Neither first mount nor exit reversal may reveal old content.
    await new Promise(resolve => setTimeout(resolve, 25));
    assertPreparing();
    for (let batch = 0; batch < 8 && !sheet._shown; batch++) {
      const callbacks = await h.nextRenderCallbacks();
      assert.ok(callbacks.length, 'Every pending frame must advance through a real native callback batch');
      for (const callback of callbacks) { callback(); assertFreshFrames(); }
      if (sheet.data.current && !sheet._shown) {
        assert.notEqual(sheet.data.current.revision, before.revision);
        sheet.confirm({ currentTarget: { dataset: { id: sheet.data.current.id, revision: sheet.data.current.revision } } });
        assert.equal(h.decision.getState().status, 'recommended', 'A new card still cannot be chosen before its own render acknowledgement');
        assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, choicesBefore);
      }
    }
    assert.ok(sheet._shown);
    assert.equal(sheet.data.target, 'RESTAURANT');
    assert.equal(sheet.data.current.revision, h.decision.getState().revision);
    assert.notEqual(sheet.data.current.revision, before.revision);
    sheet.confirm(oldEvent);
    assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, choicesBefore);
    sheet.confirm({ currentTarget: { dataset: { id: sheet.data.current.id, revision: sheet.data.current.revision } } });
    assert.equal(h.decision.getState().status, 'confirmed');
    assert.equal(sheet.data.confirmed, true);
    assert.equal(h.decision.getDiagnostics().events.events.filter(item => item.type === 'choose').length, choicesBefore + 1);
    h.assertOffline();
  });
}
