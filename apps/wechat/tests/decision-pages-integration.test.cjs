'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const event = dataset => ({ currentTarget: { dataset } });

// The harness reads repository files, then runs the actual decision module graph
// and native page callbacks in one isolated context. Product code receives no
// filesystem, network, storage, GPS or account-service implementation. Every
// journal is explicitly source=qa and remains in memory.
function harness(options = {}) {
  const platformCalls = [];
  const forbiddenCalls = [];
  const renderCallbacks = [];
  const stack = [];
  const modules = new Map();
  let definition;
  const allowedPlatform = new Set(['hideShareMenu', 'navigateTo', 'navigateBack', 'redirectTo', 'reLaunch', 'showToast', 'setNavigationBarTitle']);
  function forbid(name) {
    forbiddenCalls.push(name);
    throw new Error(`Forbidden integration capability: ${name}`);
  }
  const platform = new Proxy({}, {
    get(_target, key) {
      return value => {
        if (!allowedPlatform.has(key)) return forbid(`wx.${String(key)}`);
        platformCalls.push({ name: key, value });
      };
    },
  });
  const online = {
    VERSION: 'qa',
    state: { consent: false, status: 'idle', error: '', config: null },
  };
  const context = vm.createContext({
    wx: platform,
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: () => forbid('fetch'),
    XMLHttpRequest: function XMLHttpRequest() { forbid('XMLHttpRequest'); },
    WebSocket: function WebSocket() { forbid('WebSocket'); },
    Page(value) { definition = value; },
    getCurrentPages: () => stack,
    getApp: () => ({
      // This suite isolates the decision graph after onboarding; no storage capability is introduced here.
      ensureTasteProfile() { return true; },
      syncPage(page) { page.setData({ themeClass: 'theme-light' }); },
      checkService() { return forbid('checkService'); },
      acceptConsent() { return forbid('acceptConsent'); },
    }),
  });
  function load(request, parent) {
    if (!request.startsWith('.')) return forbid(`require:${request}`);
    let filename = path.resolve(path.dirname(parent), request);
    if (!path.extname(filename)) filename += '.js';
    const relative = path.relative(ROOT, filename).replaceAll('\\', '/');
    assert.ok(relative.startsWith('lib/decision/') || ['data/virtual-catalog.json', 'data/virtual-catalog.js'].includes(relative), `Unexpected dependency ${relative}`);
    if (relative === 'lib/decision/service.js' && parent.endsWith('result-presenter.js')) return service;
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.json')) module.exports = new vm.Script(`JSON.parse(${JSON.stringify(source)})`, { filename }).runInContext(context);
    else {
      const execute = new vm.Script(`(function(require,module,exports){\n${source}\n})`, { filename }).runInContext(context);
      execute(child => load(child, filename), module, module.exports);
    }
    return module.exports;
  }
  const serviceModule = load('./lib/decision/service', path.join(ROOT, 'entry.js'));
  const catalog = load('./lib/decision/catalog', path.join(ROOT, 'entry.js'));
  const runtimeCatalog = options.selectCandidates ? {
    ...catalog,
    buildProblem(settings) {
      const problem = catalog.buildProblem(settings);
      problem.candidates = options.selectCandidates(problem.candidates, settings);
      return problem;
    },
  } : catalog;
  const service = serviceModule.createService({ catalog: runtimeCatalog, seed: 17, source: 'qa' });
  if (options.configure) service.configure(options.configure);

  function page(name, route = {}) {
    const filename = path.join(ROOT, 'pages', name, 'index.js');
    const source = fs.readFileSync(filename, 'utf8');
    const execute = new vm.Script(`(function(require){\n${source}\n})`, { filename }).runInContext(context);
    execute(request => {
      if (request === '../../lib/decision/service') return service;
      if (request === '../../lib/decision/result-presenter') return load(request, filename);
      if (request === '../../lib/service' && name === 'index') return online;
      if (request === '../../lib/home-title' && name === 'index') return require('../lib/home-title');
      return forbid(`page require:${request}`);
    });
    const instance = {
      ...definition,
      route: `pages/${name}/index`,
      data: clone(definition.data),
      setData(update, callback) {
        Object.assign(this.data, clone(update));
        if (callback) {
          if (options.deferRender) renderCallbacks.push(callback);
          else callback();
        }
      },
    };
    stack.push(instance);
    if (instance.onLoad) instance.onLoad(route);
    return instance;
  }
  function flushRender() {
    for (const callback of renderCallbacks.splice(0)) callback();
  }
  function events(type) {
    return clone(service.getDiagnostics().events.events).filter(item => !type || item.type === type);
  }
  function assertIsolated() {
    assert.deepEqual(forbiddenCalls, []);
    const journal = service.getDiagnostics().events;
    assert.equal(journal.source, 'qa');
    assert.equal(journal.memoryOnly, true);
    assert.equal(journal.researchEligible, false);
    for (const item of journal.events) {
      assert.equal(item.source, 'qa');
      assert.equal(item.researchEligible, false);
      assert.equal(item.intent, 'virtual_decision');
    }
  }
  return { page, service, catalog, platformCalls, flushRender, events, assertIsolated };
}

function binding(page) {
  return { id: page.data.current.id, revision: page.data.current.revision };
}
function twoCandidates(candidates) {
  return candidates.filter(item => item.facts.priceCents.state === 'known' && item.facts.priceCents.value <= 3000).slice(0, 2);
}

test('real catalog and service drive the default package page with QA-only render evidence', () => {
  const h = harness();
  const home = h.page('index'); home.onShow(); home.decide();
  assert.equal(home.data.decisionOpen, true);
  assert.equal(h.platformCalls.some(call => call.name === 'navigateTo'), false);
  const results = h.page('results'); results.onShow();
  const state = h.service.getState();
  assert.equal(state.target, 'PACKAGE');
  assert.equal(state.status, 'recommended');
  assert.equal(state.counts.total, h.catalog.manifest.counts.meals);
  assert.equal(results.data.current.id, state.current.id);
  assert.equal(results.data.current.restaurantName, state.current.restaurantName);
  assert.equal(results.data.current.priceText, state.current.priceText);
  assert.equal(results.data.current.distanceText, state.current.distanceText);
  assert.equal(results.data.items, undefined);
  assert.ok(results.data.current.uncertainties.includes('具体配料、分量和营养未知'));
  assert.equal(h.events('prepared').length, 1);
  assert.equal(h.events('client_reported_rendered').length, 1);
  assert.equal(h.events('client_reported_rendered')[0].payload.meaning, 'client_reported_rendered_not_verified_viewed');
  assert.equal(h.events('choose').length, 0);
  assert.equal(h.service.getDiagnostics().policy.learningEnabled, false);
  h.assertIsolated();
});

test('real configure integrates condition drafts and virtual map changes while invalidating old detail', () => {
  const h = harness({ selectCandidates: twoCandidates });
  const results = h.page('results'); results.onShow();
  const oldBinding = binding(results);
  const detail = h.page('detail', { id: oldBinding.id, revision: String(oldBinding.revision) }); detail.onShow();
  const conditions = h.page('conditions'); conditions.onShow();
  conditions.select(event({ key: 'budgetCents', index: 2 }));
  conditions.priority({ currentTarget: { dataset: { key: 'price' } }, detail: { value: 3 } });
  assert.equal(h.service.getState().options.budgetCents, null);
  conditions.submit();
  assert.equal(h.service.getState().options.budgetCents, 3000);
  assert.equal(h.service.getState().options.weights.price, 3);
  const location = h.page('location'); location.onShow();
  location.choose(event({ id: 'library' })); location.confirm();
  assert.deepEqual(clone(h.service.getState().origin), { x: 250, y: 300, label: '云朵书店' });
  detail.syncState(); detail.confirm();
  assert.equal(detail.data.current, false);
  assert.equal(h.service.resolve(oldBinding.id, oldBinding.revision), null);
  assert.equal(h.events('choose').length, 0);
  results.onShow();
  assert.ok(h.service.getState().revision > oldBinding.revision);
  assert.equal(results.data.current.revision, h.service.getState().revision);
  h.assertIsolated();
});

test('real journal rejects confirmation before render and accepts exactly the current rendered choice', () => {
  const h = harness({ selectCandidates: twoCandidates, deferRender: true });
  const results = h.page('results'); results.onShow();
  const choice = binding(results);
  results.confirm(event(choice));
  assert.equal(h.events('choose').length, 0);
  assert.equal(h.events('client_reported_rendered').length, 0);
  assert.throws(() => h.service.confirm({ candidateId: choice.id, revision: choice.revision }), /rendering/);
  h.flushRender();
  results.confirm(event(choice)); results.confirm(event(choice));
  assert.equal(h.events('choose').length, 1);
  assert.equal(h.events('choose')[0].payload.meaning, 'selected_this_virtual_option_only');
  assert.equal(h.service.getState().status, 'confirmed');
  assert.equal(h.service.getState().receipt.candidateId, choice.id);
  assert.match(h.service.getState().receipt.meaning, /不代表已购买、吃过或优于/);
  h.assertIsolated();
});

test('late native render callbacks cannot mark a hidden page or a replaced decision revision', () => {
  const h = harness({ selectCandidates: twoCandidates, deferRender: true });
  const results = h.page('results'); results.onShow();
  const first = binding(results);
  results.onHide(); h.flushRender();
  assert.equal(h.events('client_reported_rendered').length, 0);
  results.onShow();
  h.service.configure({ options: { budgetCents: 4000 } });
  h.service.recommend();
  h.flushRender();
  assert.equal(h.events('client_reported_rendered').length, 0);
  results.syncState(); h.flushRender();
  assert.equal(h.events('client_reported_rendered').length, 1);
  results.confirm(event(first));
  assert.equal(h.events('choose').length, 0);
  results.confirm(event(binding(results)));
  assert.equal(h.events('choose').length, 1);
  h.assertIsolated();
});

test('real two-item decision pool is shown once per item then remains exhausted on page return', () => {
  const h = harness({ selectCandidates: twoCandidates });
  const results = h.page('results'); results.onShow();
  const first = binding(results);
  results.next(event(first));
  const second = binding(results);
  assert.notEqual(first.id, second.id);
  results.confirm(event(first));
  assert.equal(h.events('choose').length, 0);
  results.next(event(second));
  assert.equal(results.data.current, null);
  assert.equal(results.data.status, 'exhausted');
  assert.equal(h.events('prepared').length, 2);
  assert.equal(h.events('reroll').length, 2);
  assert.equal(h.events('reroll')[0].payload.meaning, 'requested_another_option_not_pairwise_preference');
  const revision = h.service.getState().revision;
  results.onHide(); results.onShow(); results.syncState();
  assert.equal(h.service.getState().revision, revision);
  assert.equal(results.data.current, null);
  h.assertIsolated();
});

test('real unknown dietary facts produce needs-information rather than a falsely feasible card', () => {
  const h = harness({
    selectCandidates: candidates => candidates.filter(item => item.facts.vegetarian.state === 'unknown').slice(0, 1),
    configure: { options: { vegetarianOnly: true } },
  });
  const results = h.page('results'); results.onShow();
  assert.equal(results.data.status, 'needs_information');
  assert.equal(results.data.current, null);
  assert.equal(h.service.getState().counts.unknown, 1);
  assert.equal(h.events('prepared').length, 0);
  assert.equal(h.events('client_reported_rendered').length, 0);
  h.assertIsolated();
});

test('real known price failures produce no-feasible with no card, render or choice', () => {
  const h = harness({
    selectCandidates: candidates => candidates.filter(item => item.facts.priceCents.state === 'known' && item.facts.priceCents.value > 0).slice(0, 2),
    configure: { options: { budgetCents: 0 } },
  });
  const results = h.page('results'); results.onShow(); results.confirm();
  assert.equal(results.data.status, 'no_feasible_candidate');
  assert.equal(results.data.current, null);
  assert.equal(h.service.getState().counts.rejected, 2);
  assert.equal(h.events('prepared').length, 0);
  assert.equal(h.events('choose').length, 0);
  h.assertIsolated();
});

test('real uniform and weighted strategies are reached only through the explicit page controls', () => {
  const h = harness({ selectCandidates: twoCandidates });
  const results = h.page('results'); results.onShow();
  assert.equal(h.service.getState().strategy, 'explicit');
  results.chooseStrategy(event({ strategy: 'uniform' }));
  assert.equal(h.service.getState().strategy, 'uniform');
  assert.equal(results.data.status, 'recommended');
  results.chooseStrategy(event({ strategy: 'weighted' }));
  assert.equal(h.service.getState().strategy, 'weighted');
  assert.equal(results.data.current.revision, h.service.getState().revision);
  const diagnostics = h.service.getDiagnostics();
  assert.equal(diagnostics.policy.learningEnabled, false);
  assert.equal(diagnostics.policy.questionsPublished, 0);
  assert.equal(diagnostics.events.researchEligible, false);
  h.assertIsolated();
});

test('restaurant mode retains one same-meal witness and does not expose ineffective main-role controls', () => {
  const h = harness({ selectCandidates: twoCandidates });
  const home = h.page('index'); home.onShow(); home.selectTarget(event({ target: 'RESTAURANT' }));
  const conditions = h.page('conditions'); conditions.onShow();
  assert.equal(conditions.data.priorities.some(item => item.key === 'main'), false);
  const results = h.page('results'); results.onShow();
  const current = h.service.getState().current;
  assert.equal(results.data.target, 'RESTAURANT');
  assert.equal(results.data.current.name, current.restaurantName);
  assert.equal(results.data.current.mealName, current.mealName);
  assert.ok(current.witnessMealId);
  assert.equal(current.witnessMealId, current.mealId);
  assert.ok(results.data.current.reasons.includes('由同一份套餐满足全部硬条件'));
  h.assertIsolated();
});

test('real detail resolves only its route binding and emits a memory-only confirmation', () => {
  const h = harness({ selectCandidates: twoCandidates });
  const results = h.page('results'); results.onShow(); results.detail(event(binding(results)));
  const route = new URL(h.platformCalls.at(-1).value.url, 'https://virtual.invalid');
  const detail = h.page('detail', { id: route.searchParams.get('id'), revision: route.searchParams.get('revision') });
  detail.onShow();
  assert.equal(detail.data.current, true);
  assert.ok(detail.data.result.uncertainties.includes('具体配料、分量和营养未知'));
  detail.confirm(); detail.confirm();
  assert.equal(h.events('choose').length, 1);
  h.service.configure({ origin: { x: 0, y: 1000, label: '边界虚拟点' } });
  detail.syncState(); detail.confirm();
  assert.equal(detail.data.current, false);
  assert.equal(detail.data.result, null);
  assert.equal(h.events('choose').length, 1);
  h.assertIsolated();
});

test('display copy discloses historical virtual prototypes and unknown composition', () => {
  for (const name of ['index', 'results', 'detail']) {
    const source = fs.readFileSync(path.join(ROOT, 'pages', name, 'index.wxml'), 'utf8');
    // Home keeps the compact location label; result and detail carry the full disclosure.
    assert.match(source, name === 'index' ? /<text>虚拟地图<\/text>/ : /历史原型构建的虚拟场景/);
    assert.doesNotMatch(source, /全部内容均为合成|均为合成数据|这份包含什么/);
  }
  const conditions = fs.readFileSync(path.join(ROOT, 'pages/conditions/index.wxml'), 'utf8');
  assert.match(conditions, /优先模拟正餐/);
  assert.doesNotMatch(conditions, /优先有主食|主食搭配/);
  const detail = fs.readFileSync(path.join(ROOT, 'pages/detail/index.wxml'), 'utf8');
  assert.match(detail, /具体配料、分量和营养未知/);
});
