'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const motion = require('../lib/decision-motion');
const clone = value => JSON.parse(JSON.stringify(value));

function sheetHarness(options = {}) {
  let clock = 0, nextTimer = 0, definition, rendered = null, index = 0;
  const timers = new Map(), events = [], calls = [], frames = [], callbacks = [];
  const state = { status: 'idle', target: 'PACKAGE', current: null, revision: 0, origin: { label: '虚拟测试点' }, reasons: [], uncertainties: [] };
  const failures = { recommend: options.failRecommend === true, confirm: false };
  const service = {
    getState: () => clone(state),
    previewCandidates: () => ({ cards: [{ id: 'actual-preview' }], counts: { feasible: 2 }, remaining: 1 }),
    recommend({ reroll } = {}) {
      calls.push({ type: 'recommend', reroll });
      if (failures.recommend) throw new Error('合成请求失败');
      if (state.current && !reroll) return clone(state);
      index++; state.revision++; state.status = 'recommended'; rendered = null;
      state.current = { id: 'card-' + index, revision: state.revision, name: '虚拟套餐 ' + index, restaurantName: '虚拟餐厅 ' + index,
        priceText: '¥' + index, distanceText: index + ' 虚拟距离单位', factsSummary: [], reasons: ['真实测试依据 ' + index], uncertainties: ['配料未知'] };
      return clone(state);
    },
    resolve(id, revision) { return state.current?.id === id && state.revision === revision ? clone(state.current) : null; },
    markRendered(binding) { assert.ok(this.resolve(binding.candidateId, binding.revision)); rendered = clone(binding); calls.push({ type: 'render', ...binding }); },
    confirm(binding) {
      assert.deepEqual(clone(binding), rendered, 'The visible native-render binding is required');
      if (failures.confirm) throw new Error('合成确认失败');
      calls.push({ type: 'confirm', ...binding }); state.status = 'confirmed'; return clone(state);
    },
    reset() { state.status = 'idle'; state.current = null; state.revision++; rendered = null; },
    configure() { state.status = 'idle'; state.current = null; state.revision++; rendered = null; },
  };
  const context = vm.createContext({
    Date: { now: () => clock },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { due: clock + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    wx: { hideShareMenu() {}, getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }), navigateTo() {} },
    getApp: () => ({ ensureTasteProfile: () => true }), Component(value) { definition = value; },
  });
  const root = path.resolve(__dirname, '..');
  function load(name, dependencies) {
    const filename = path.join(root, name), module = { exports: {} };
    new vm.Script('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename }).runInContext(context)(id => {
      assert.ok(Object.hasOwn(dependencies, id), 'Unexpected module ' + id);
      return dependencies[id];
    }, module, module.exports);
    return module.exports;
  }
  const presenter = load('lib/decision/result-presenter.js', { './service': service });
  const nativeMotion = load('lib/decision-motion.js', {});
  load('components/decision-sheet/index.js', { '../../lib/decision/result-presenter': presenter, '../../lib/decision/service': service, '../../lib/decision-motion': nativeMotion });
  const properties = Object.fromEntries(Object.entries(definition.properties).map(([name, property]) => [name, property.value]));
  properties.revealOrigin = { x: 93, y: 470, width: 375, height: 667 };
  properties.reducedMotion = options.reducedMotion === true;
  const sheet = { ...definition.methods, properties, data: { ...clone(definition.data), ...clone(properties) },
    setData(update, callback) {
      Object.assign(this.data, clone(update)); frames.push(clone(this.data));
      if (!callback) return;
      if (options.deferResult && Object.hasOwn(update, 'current') && update.preferenceReady) callbacks.push(callback);
      else callback();
    },
    triggerEvent(name, detail) { events.push({ name, detail }); },
  };
  definition.lifetimes.attached.call(sheet);
  function visible(value) { properties.visible = value; definition.observers.visible.call(sheet, value); }
  function tick(ms) {
    const end = clock + ms;
    for (let count = 0; count < 2000; count++) {
      const pending = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!pending) { clock = end; return; }
      timers.delete(pending[0]); clock = pending[1].due; pending[1].callback();
    }
    throw new Error('Motion timers did not settle');
  }
  const event = () => ({ currentTarget: { dataset: { id: sheet.data.displayCard?.id, revision: sheet.data.displayCard?.revision } } });
  return { sheet, state, failures, calls, frames, events, callbacks, tick, visible, event, timers };
}

test('gesture thresholds separate vertical scrolling, deliberate swipes and short flicks; spring preserves position', () => {
  assert.equal(motion.gestureAxis(4, 40), 'y');
  assert.equal(motion.gestureAxis(35, 6), 'x');
  assert.equal(motion.swipeDecision({ x: 20, velocity: 2, width: 375 }).commits, false);
  assert.equal(motion.swipeDecision({ x: -30, velocity: -.8, width: 375 }).commits, true);
  assert.equal(motion.swipeDecision({ x: 95, velocity: 0, width: 375 }).commits, true);
  let spring = { x: 60, velocity: -30 };
  for (let frame = 0; frame < 45; frame++) spring = motion.springStep(spring, .016);
  assert.ok(Math.abs(spring.x) < 1);
  const reveal = motion.revealGeometry({ x: 93, y: 470 }, { left: 0, top: 150, width: 375, height: 500 });
  assert.deepEqual({ x: reveal.x, y: reveal.y }, { x: 93, y: 320 });
  assert.ok(reveal.radius >= Math.hypot(375 - 93, 320));
  assert.equal(motion.revealGeometry(null, { width: 375, height: 500 }), null);
});

test('reveal waits for the actual result render and close cancels all callbacks before reopening', () => {
  const h = sheetHarness({ deferResult: true });
  h.visible(true); h.tick(16);
  assert.equal(h.sheet.data.contentReady, false);
  assert.equal(h.calls.filter(call => call.type === 'render').length, 0);
  h.sheet.close(); const old = h.callbacks.splice(0); h.tick(250);
  for (const callback of old) callback();
  assert.equal(h.sheet.data.mounted, false);
  h.visible(true); h.tick(16);
  for (const callback of h.callbacks.splice(0)) callback();
  h.tick(400);
  assert.equal(h.sheet.data.phase, 'idle');
  assert.equal(h.sheet.data.displayCard.id, h.state.current.id);
  assert.ok(h.frames.some(frame => /circle\(18px at 93px /.test(frame.revealStyle)));
  assert.equal(h.calls.filter(call => call.type === 'render').length, 1);
  h.sheet.close(); h.tick(250);
  assert.equal(h.timers.size, 0);
});

test('changing cards keeps atomic card content and rejects confirm until the new card is visible', () => {
  const h = sheetHarness(); h.visible(true); h.tick(500);
  const old = clone(h.sheet.data.displayCard), oldEvent = h.event();
  h.sheet.next(oldEvent); h.sheet.confirm(oldEvent); h.sheet.next(oldEvent);
  assert.equal(h.sheet.data.outgoingCard.id, old.id);
  assert.equal(h.sheet.data.outgoingCard.priceText, old.priceText);
  assert.equal(h.sheet.data.displayCard.id, 'card-2');
  assert.equal(h.sheet.data.displayCard.priceText, '¥2');
  assert.equal(h.sheet.data.displayCard.distanceText, '2 虚拟距离单位');
  assert.equal(h.calls.filter(call => call.type === 'recommend').length, 2);
  assert.equal(h.calls.filter(call => call.type === 'confirm').length, 0);
  h.tick(400);
  h.sheet.confirm(oldEvent);
  assert.equal(h.calls.filter(call => call.type === 'confirm').length, 0);
  h.sheet.confirm(h.event()); h.sheet.confirm(h.event());
  assert.equal(h.calls.filter(call => call.type === 'confirm').length, 1);
  assert.equal(h.sheet.data.confirmPhase, 'shrinking');
  h.tick(220); assert.equal(h.sheet.data.confirmPhase, 'drawing');
  h.tick(180); assert.equal(h.sheet.data.confirmPhase, 'done');
  h.sheet.close(); h.tick(250); assert.equal(h.timers.size, 0);
});

test('initial and next-result failures unlock a real retry without authorizing an unseen card', () => {
  const h = sheetHarness({ failRecommend: true }); h.visible(true); h.tick(500);
  assert.equal(h.sheet.data.error, '合成请求失败');
  assert.equal(h.sheet.data.interactionLocked, false);
  assert.equal(h.sheet._shown, null);
  h.failures.recommend = false; h.sheet.emptyAction(); h.tick(500);
  assert.ok(h.sheet._shown);
  h.failures.recommend = true; h.sheet.next(h.event()); h.tick(400);
  assert.equal(h.sheet.data.displayCard, null);
  assert.equal(h.sheet.data.interactionLocked, false);
  assert.equal(h.sheet._shown, null);
  h.failures.recommend = false; h.sheet.emptyAction(); h.tick(500);
  assert.ok(h.sheet._shown);
  h.failures.confirm = true; h.sheet.confirm(h.event());
  assert.equal(h.sheet.data.confirmPhase, 'idle');
  assert.equal(h.sheet.data.confirmed, false);
  assert.equal(h.sheet.data.interactionLocked, false);
});

test('reduced motion removes reveal and card travel while cancellation never changes the candidate', () => {
  const h = sheetHarness({ reducedMotion: true }); h.visible(true); h.tick(250);
  assert.equal(h.sheet.data.phase, 'idle');
  assert.ok(h.frames.every(frame => !frame.revealStyle.includes('circle(')));
  const id = h.state.current.id;
  h.sheet.dragStart({ touches: [{ identifier: 1, clientX: 100, clientY: 250 }], timeStamp: 10 });
  h.sheet.dragMove({ touches: [{ identifier: 1, clientX: 140, clientY: 252 }], timeStamp: 60 });
  h.sheet.dragCancel(); h.tick(200);
  assert.equal(h.state.current.id, id);
  assert.equal(h.sheet.data.cardStyle, '');
});
