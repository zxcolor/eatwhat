const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../lib/decision/taste-profile');
const copy = value => JSON.parse(JSON.stringify(value));
const COMPLETE = { likedGroups: ['noodles'], avoidedGroups: ['drinks'], budgetCents: 3000, maxSpicy: 1, priority: 'balanced' };
const nextTimerTurn = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(options = {}) {
  let definition;
  const calls = [];
  const state = { started: !!options.started, ready: !!options.ready, editing: false, revision: 0, answers: copy(options.answers || {}), error: '' };
  const operations = [];
  const store = {
    getState() { return copy(state); },
    start() {
      operations.push({ type: 'start' });
      if (options.startError) throw new Error('raw-storage-error providerSecret=never-render');
      state.started = true; state.revision += 1;
      return this.getState();
    },
    beginEdit() {
      operations.push({ type: 'beginEdit' });
      state.started = true; state.editing = state.ready; state.revision += 1;
      return this.getState();
    },
    answer(field, value, revision) {
      assert.equal(revision, state.revision);
      const next = model.normalizeAnswers({ ...state.answers, [field]: value });
      state.answers = copy(next); state.revision += 1;
      operations.push({ type: 'answer', field, value: copy(value), revision });
      return this.getState();
    },
    assess() {
      operations.push({ type: 'assess' });
      const missingFields = model.missingFields(state.answers);
      const ready = missingFields.length === 0 && !options.infeasible;
      return { ready, profileComplete: missingFields.length === 0, missingFields,
        message: options.infeasible ? '当前条件下没有可选结果，请调整偏好。' : ready ? '将按你的选择为你决定。' : '请完成每一项偏好选择。' };
    },
  };
  const app = {
    syncPage(page) { page.setData({ themeClass: 'theme-dark' }); },
    completeTasteProfile(revision) {
      operations.push({ type: 'complete', revision });
      assert.equal(revision, state.revision);
      return options.complete ? options.complete() : undefined;
    },
  };
  const wx = new Proxy({}, { get(_target, key) {
    if (/Storage|request|getLocation|login/i.test(String(key))) return () => { throw new Error(`Unexpected page platform call: ${String(key)}`); };
    return value => {
      calls.push({ type: key, value });
      if (key === 'reLaunch' && options.reLaunch) options.reLaunch(value);
    };
  } });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/preferences/index.js'), 'utf8'), {
    require(id) {
      if (id === '../../lib/taste-profile') return store;
      if (id === '../../lib/decision/taste-profile') return model;
      throw new Error(`Unexpected module ${id}`);
    },
    Page(value) { definition = value; }, getApp: () => app, wx, setTimeout, clearTimeout,
  });
  const page = { ...definition, data: copy(definition.data), setData(update) { Object.assign(this.data, copy(update)); } };
  page.onLoad(options.route || {});
  const event = extra => ({ currentTarget: { dataset: { revision: page.data.revision, ...extra } } });
  return { page, state, store, operations, calls, event };
}
function count(h, type) { return h.operations.filter(operation => operation.type === type).length; }

test('preference introduction reads only and saves nothing before explicit start', () => {
  const h = harness(); h.page.onShow();
  assert.equal(h.page.data.started, false);
  assert.equal(h.page.data.themeClass, 'theme-dark');
  assert.equal(h.operations.filter(operation => operation.type !== 'assess').length, 0);
  assert.equal(h.page.data.budgets.some(option => option.selected), false);
  assert.equal(h.page.data.spicyOptions.some(option => option.selected), false);
  h.page.start(); h.page.start();
  assert.equal(count(h, 'start'), 1);
  assert.equal(h.page.data.step, 1);
  assert.equal(h.page.data.canNext, false);
});

test('partial draft resumes at missing budget step and theme or privacy round trips keep choices', () => {
  const h = harness({ started: true, answers: { likedGroups: ['noodles'], avoidedGroups: [] } });
  h.page.onShow(); assert.equal(h.page.data.step, 3); assert.equal(h.page.data.coverage, 2);
  h.page.selectOption(h.event({ field: 'budgetCents', index: 0 }));
  assert.equal(h.state.answers.budgetCents, null); assert.equal(h.page.data.canNext, false);
  h.page.privacy(); h.page.onHide(); h.page.onShow(); h.page.syncState();
  assert.equal(h.page.data.step, 3);
  assert.equal(h.page.data.budgets[0].selected, true);
  assert.equal(h.page.data.spicyOptions.some(option => option.selected), false);
  assert.equal(count(h, 'start'), 0);
  assert.equal(h.calls.find(call => call.type === 'navigateTo').value.url, '/pages/privacy/index');
});

test('explicit no-preference choices count as answers and do not preselect later fields', () => {
  const h = harness(); h.page.onShow(); h.page.start();
  h.page.chooseNone(h.event()); assert.deepEqual(h.state.answers.likedGroups, []);
  h.page.next(h.event()); assert.equal(h.page.data.step, 2);
  h.page.chooseNone(h.event()); h.page.next(h.event());
  assert.deepEqual(h.state.answers.avoidedGroups, []);
  assert.equal(h.page.data.step, 3); assert.equal(h.page.data.canNext, false);
  h.page.selectOption(h.event({ field: 'budgetCents', index: 0 }));
  h.page.selectOption(h.event({ field: 'maxSpicy', index: 0 }));
  h.page.next(h.event()); assert.equal(h.page.data.step, 4);
  assert.equal(h.page.data.priorities.some(option => option.selected), false);
  h.page.selectPriority(h.event({ id: 'balanced' })); h.page.next(h.event());
  assert.equal(h.page.data.step, 5); assert.equal(h.page.data.coverage, 5); assert.equal(h.page.data.ready, true);
});

test('liked and avoided conflict preserves both prior answers and gives a visible correction', () => {
  const h = harness({ started: true, answers: { likedGroups: ['noodles'] } }); h.page.onShow();
  assert.equal(h.page.data.step, 2);
  h.page.toggleGroup(h.event({ id: 'noodles' }));
  assert.deepEqual(h.state.answers.likedGroups, ['noodles']);
  assert.equal(Object.hasOwn(h.state.answers, 'avoidedGroups'), false);
  assert.match(h.page.data.error, /返回上一步/);
  assert.equal(count(h, 'answer'), 0);
  h.page.previous(h.event()); h.page.toggleGroup(h.event({ id: 'noodles' })); h.page.next(h.event());
  h.page.toggleGroup(h.event({ id: 'noodles' }));
  assert.deepEqual(h.state.answers.likedGroups, []);
  assert.deepEqual(h.state.answers.avoidedGroups, ['noodles']);
});

test('invalid ids, option indices and wrong-step actions never write preferences', () => {
  const h = harness({ started: true }); h.page.onShow();
  h.page.toggleGroup(h.event({ id: 'secret' }));
  h.page.selectPriority(h.event({ id: 'balanced' }));
  h.page.selectOption(h.event({ field: 'budgetCents', index: 2 }));
  h.page.editStep(h.event({ step: 3 }));
  h.page.selectOption(h.event({ field: 'apiKey', index: 0 }));
  h.page.selectOption(h.event({ field: 'budgetCents', index: 99 }));
  h.page.selectOption(h.event({ field: 'budgetCents', index: 1.5 }));
  assert.equal(count(h, 'answer'), 0);
});

test('stale revision and hidden taps cannot modify a restored preference draft', () => {
  const h = harness({ started: true }); h.page.onShow(); const stale = h.event({ id: 'noodles' });
  h.state.revision += 1;
  h.page.toggleGroup(stale);
  assert.equal(count(h, 'answer'), 0); assert.match(h.page.data.error, /偏好已更新/);
  assert.equal(h.page.data.revision, h.state.revision);
  h.page.onHide(); h.page.toggleGroup(h.event({ id: 'noodles' })); h.page.start();
  assert.equal(h.operations.filter(operation => operation.type !== 'assess').length, 0);
});

test('all fields present but no feasible candidates keeps finish blocked', async () => {
  const h = harness({ started: true, answers: COMPLETE, infeasible: true }); h.page.onShow();
  assert.equal(h.page.data.step, 5); assert.equal(h.page.data.coverage, 5);
  assert.equal(h.page.data.ready, false); assert.match(h.page.data.readinessMessage, /没有可选结果/);
  await h.page.finish(h.event()); assert.equal(count(h, 'complete'), 0);
  h.page.editStep(h.event({ step: 3 })); assert.equal(h.page.data.step, 3);
});

test('only ready review confirms latest revision and repeated finish waits for completion', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const h = harness({ started: true, answers: COMPLETE, complete: () => pending }); h.page.onShow();
  const finishing = h.page.finish(h.event());
  await h.page.finish(h.event());
  assert.equal(count(h, 'complete'), 1); assert.equal(h.page.data.busy, true);
  complete(); await finishing;
  assert.equal(h.page.data.busy, false);
});

test('late confirmation rejection after leaving the page does not overwrite resumed state', async () => {
  let reject;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const h = harness({ started: true, answers: COMPLETE, complete: () => pending }); h.page.onShow();
  const finishing = h.page.finish(h.event());
  h.page.onHide(); h.page.onShow();
  const before = copy(h.page.data);
  reject(new Error('raw-response accessToken=never-render')); await finishing;
  assert.deepEqual(h.page.data, before);
  h.page.syncState(); assert.equal(h.page.data.busy, false);
});

test('existing confirmed profile redirects after onShow returns; edit route opens a draft only once across shows', async () => {
  const h = harness({ ready: true, answers: COMPLETE }); h.page.onShow(); h.page.syncState();
  assert.equal(h.calls.some(call => call.type === 'reLaunch'), false, 'no navigation reentry during onShow or syncState');
  await nextTimerTurn();
  assert.equal(h.calls.filter(call => call.type === 'reLaunch').length, 1);
  assert.equal(h.calls.find(call => call.type === 'reLaunch').value.url, '/pages/index/index');
  const edit = harness({ ready: true, answers: COMPLETE, route: { edit: '1' } });
  edit.page.onShow(); edit.page.onHide(); edit.page.onShow(); edit.page.syncState();
  await nextTimerTurn();
  assert.equal(count(edit, 'beginEdit'), 1); assert.equal(edit.page.data.editing, true);
  assert.equal(edit.page.data.step, 5); assert.equal(edit.calls.some(call => call.type === 'reLaunch'), false);
});

test('hiding or unloading a confirmed-profile page cancels its pending home timer', async () => {
  for (const leave of ['onHide', 'onUnload']) {
    const h = harness({ ready: true, answers: COMPLETE }); h.page.onShow();
    h.page[leave]();
    await nextTimerTurn();
    assert.equal(h.calls.some(call => call.type === 'reLaunch'), false, leave);
    assert.equal(h.page._homeTimer, null);
  }
});

test('returning before a cancelled home timer runs only navigates for the new visible generation', async () => {
  const h = harness({ ready: true, answers: COMPLETE });
  h.page.onShow(); h.page.onHide(); h.page.onShow();
  await nextTimerTurn();
  assert.equal(h.calls.filter(call => call.type === 'reLaunch').length, 1);
});

test('queued home navigation rechecks readiness, drafts and editing immediately before navigating', async () => {
  for (const change of [{ ready: false }, { started: true }, { editing: true }]) {
    const h = harness({ ready: true, answers: COMPLETE }); h.page.onShow();
    Object.assign(h.state, change);
    await nextTimerTurn();
    assert.equal(h.calls.some(call => call.type === 'reLaunch'), false, JSON.stringify(change));
    assert.equal(h.page._redirecting, false);
    assert.equal(h.page._homeTimer, null);
  }
});

test('queued navigation failure stays safe and its old callback cannot affect a later visit', async () => {
  const h = harness({ ready: true, answers: COMPLETE }); h.page.onShow();
  await nextTimerTurn();
  const old = h.calls.find(call => call.type === 'reLaunch').value;
  h.page.onHide(); h.state.started = true; h.page.onShow();
  const before = copy(h.page.data);
  old.fail({ errMsg: 'PRIVATE_TEST_ROUTER' });
  assert.deepEqual(h.page.data, before);
  const failed = harness({ ready: true, answers: COMPLETE, reLaunch: () => { throw new Error('PRIVATE_TEST_ROUTER'); } });
  failed.page.onShow();
  assert.equal(failed.calls.some(call => call.type === 'reLaunch'), false);
  await nextTimerTurn();
  assert.equal(failed.calls.filter(call => call.type === 'reLaunch').length, 1);
  assert.equal(failed.page.data.error, '暂时无法打开首页，请重新进入小程序。');
  assert.doesNotMatch(JSON.stringify(failed.page.data), /PRIVATE_TEST_ROUTER/);
});

test('edit route without an active profile can still start the normal draft flow', () => {
  const h = harness({ route: { edit: '1' } }); h.page.onShow();
  assert.equal(h.page.data.started, true); assert.equal(h.page.data.editing, false);
  assert.equal(h.page.data.step, 1);
  h.page.chooseNone(h.event()); assert.deepEqual(h.state.answers.likedGroups, []);
});

test('failed local start stays on intro and displays only a fixed safe message', () => {
  const h = harness({ startError: true }); h.page.onShow(); h.page.start();
  assert.equal(h.page.data.started, false);
  assert.equal(h.page.data.error, '暂时无法保存偏好，请重试。');
  assert.doesNotMatch(JSON.stringify(h.page.data), /providerSecret|raw-storage-error/);
});

test('taste-first with an explicit no-preference answer remains recoverable without clearing choices', () => {
  const answers = { likedGroups: [], avoidedGroups: [], budgetCents: null, maxSpicy: null };
  const h = harness({ started: true, answers }); h.page.onShow();
  h.page.selectPriority(h.event({ id: 'taste' }));
  assert.match(h.page.data.error, /至少选择一种/);
  assert.deepEqual(h.state.answers, answers); assert.equal(h.page.data.canNext, false);
  h.page.selectPriority(h.event({ id: 'price' }));
  assert.equal(h.page.data.error, ''); assert.equal(h.page.data.canNext, true);
});

test('every saved answer immediately rechecks readiness and shows remaining fields', () => {
  const h = harness({ started: true }); h.page.onShow();
  const before = count(h, 'assess');
  assert.match(h.page.data.missingSummary, /常想吃的类型/);
  h.page.toggleGroup(h.event({ id: 'noodles' }));
  assert.equal(count(h, 'assess'), before + 1);
  assert.doesNotMatch(h.page.data.missingSummary, /常想吃的类型/);
  assert.match(h.page.data.missingSummary, /避开的类型/);
  assert.equal(h.page.data.ready, false);
});

test('ready draft becoming insufficient stays on questions and cannot use the older active profile to exit', async () => {
  const options = { started: true, ready: true, answers: COMPLETE };
  const h = harness(options); h.page.onShow();
  assert.equal(h.page.data.ready, true);
  assert.equal(h.calls.some(call => call.type === 'reLaunch'), false);
  h.page.editStep(h.event({ step: 3 }));
  options.infeasible = true;
  h.page.selectOption(h.event({ field: 'budgetCents', index: 1 }));
  assert.equal(h.page.data.ready, false);
  assert.match(h.page.data.readinessMessage, /没有可选结果/);
  h.page.next(h.event()); h.page.next(h.event());
  await h.page.finish(h.event());
  assert.equal(count(h, 'complete'), 0);
  assert.equal(h.calls.some(call => call.type === 'reLaunch'), false);
});
