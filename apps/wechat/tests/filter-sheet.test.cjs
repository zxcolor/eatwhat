const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createService } = require('../lib/decision/service');
const filters = require('../lib/filter-view');

const clone = value => JSON.parse(JSON.stringify(value));
function service() {
  const value = createService({ seed: 19, source: 'qa' });
  value.setProfile({ likedGroups: ['hotpot'], avoidedGroups: ['drinks'], budgetCents: null, maxSpicy: null, priority: 'balanced' });
  return value;
}
function harness(options = {}) {
  const decision = service();
  const events = [];
  const timers = new Map();
  let definition; let now = 0; let timerId = 0; let allowed = true;
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/filter-sheet/index'), 'utf8'), {
    Component(value) { definition = value; },
    getApp: () => ({ ensureTasteProfile: () => allowed }),
    require(name) {
      if (name === '../../lib/decision/service') return decision;
      if (name === '../../lib/filter-view') return filters;
      throw new Error(`Unexpected filter dependency: ${name}`);
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, { filename: 'components/filter-sheet/index.js' });
  const properties = Object.fromEntries(Object.entries(definition.properties).map(([key, value]) => [key, value.value]));
  properties.reducedMotion = options.reducedMotion === true;
  const sheet = { ...definition.methods, properties, data: { ...clone(definition.data), ...properties },
    setData(value, callback) { Object.assign(this.data, clone(value)); callback?.(); },
    triggerEvent(name, detail) {
      events.push({ name, detail });
      if (name === 'close') { this.properties.visible = false; definition.observers.visible.call(this, false); }
    },
  };
  definition.lifetimes.attached.call(sheet);
  return { sheet, decision, events,
    open() { sheet.properties.visible = true; definition.observers.visible.call(sheet, true); },
    expire() { allowed = false; },
    hide() { definition.pageLifetimes.hide.call(sheet); },
    detach() { definition.lifetimes.detached.call(sheet); },
    tick(milliseconds = 100) {
      const end = now + milliseconds;
      for (let steps = 0; steps < 50; steps++) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) { now = end; return; }
        timers.delete(next[0]); now = next[1].due; next[1].callback();
      }
      throw new Error('Unexpected repeating filter timer');
    },
  };
}
function event(sheet, key, value, extra = {}) {
  return { currentTarget: { dataset: { session: sheet.data.session, key } }, detail: { value }, ...extra };
}

test('draft counts match the real engine for both targets and preview leaves recommendation state untouched', () => {
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    const decision = service();
    decision.configure({ target, options: { budgetCents: 2400, maxDistanceUnits: 350, maxSpicy: 1, vegetarianOnly: true } });
    const before = decision.getState();
    const diagnostics = decision.getDiagnostics();
    const draft = filters.createFilterDraft(before);
    const expected = decision.previewCandidates(1).counts;
    assert.deepEqual(filters.evaluateFilters(before, draft), expected);
    assert.equal(Object.hasOwn(draft, 'taste'), false);
    assert.deepEqual(decision.getState(), before);
    assert.deepEqual(decision.getDiagnostics(), diagnostics);
  }
});

test('live sliders update visible values and count, while cancel preserves the existing result and diagnostics', () => {
  const h = harness();
  h.decision.recommend();
  const before = h.decision.getState();
  const diagnostics = h.decision.getDiagnostics();
  h.open(); h.tick();
  const { sheet } = h;
  sheet.rangeChanging(event(sheet, 'budgetCents', 0));
  sheet.rangeChanging(event(sheet, 'maxDistanceUnits', 150));
  assert.equal(sheet.data.budget.text, '0 元内');
  assert.equal(sheet.data.distance.text, '150 虚拟单位内');
  assert.equal(sheet.data.countPending, true);
  assert.ok(sheet.data.summary.some(row => row.label === '0 元内'));
  h.tick();
  assert.equal(sheet.data.count, 0, 'Zero known feasible choices must remain zero');
  assert.equal(sheet.data.countPending, false);
  sheet.close(event(sheet)); h.tick(300);
  assert.equal(sheet.data.mounted, false);
  assert.deepEqual(h.decision.getState(), before);
  assert.deepEqual(h.decision.getDiagnostics(), diagnostics);
  assert.deepEqual(h.events.map(item => item.name), ['close']);
  h.detach();
});

test('apply writes the final draft once, preserves confirmed taste and never chooses a candidate', () => {
  const h = harness(); h.open(); h.tick();
  const { sheet } = h;
  const taste = h.decision.getState().options.taste;
  sheet.rangeChanging(event(sheet, 'budgetCents', 25));
  sheet.rangeChanging(event(sheet, 'maxDistanceUnits', 400));
  sheet.priorityChanging(event(sheet, 'price', 5));
  sheet.toggle(event(sheet, 'vegetarianOnly', true));
  const applyEvent = event(sheet);
  sheet.apply(applyEvent);
  assert.equal(h.events.length, 0, 'Apply waits until the current draft count has settled');
  h.tick();
  const expectedCount = sheet.data.count;
  sheet.apply(applyEvent); sheet.apply(applyEvent);
  const state = h.decision.getState();
  assert.equal(state.options.budgetCents, 2500);
  assert.equal(state.options.maxDistanceUnits, 400);
  assert.equal(state.options.weights.price, 5);
  assert.equal(state.options.vegetarianOnly, true);
  assert.deepEqual(state.options.taste, taste);
  assert.equal(state.current, null);
  assert.deepEqual(h.events.map(item => item.name), ['apply', 'close']);
  assert.equal(h.events[0].detail.count, expectedCount);
  assert.equal(h.events[0].detail.state.revision, state.revision);
  h.detach();
});

test('reopening cancels the old exit and ignores old slider, apply and close events', () => {
  const h = harness(); h.open(); h.tick();
  const { sheet } = h;
  const oldEvent = event(sheet, 'budgetCents', 5);
  sheet.rangeChanging(oldEvent);
  sheet.close(event(sheet));
  h.decision.configure({ target: 'RESTAURANT', options: { budgetCents: 3300 } });
  h.open();
  sheet.rangeChanging(oldEvent); sheet.apply(oldEvent); sheet.close(oldEvent);
  h.tick(400);
  assert.equal(sheet.data.mounted, true);
  assert.equal(sheet.data.target, 'RESTAURANT');
  assert.equal(sheet.data.budget.value, 33);
  assert.equal(h.events.filter(item => item.name === 'apply').length, 0);
  h.decision.configure({ options: { budgetCents: 4500 } });
  sheet.apply(event(sheet));
  assert.equal(sheet.data.stale, true);
  assert.equal(sheet.data.count, null, 'A changed external context must clear stale counts');
  assert.equal(h.decision.getState().options.budgetCents, 4500);
  h.detach();
});

test('profile expiry and page hide cancel deferred work; reduced motion has no panel displacement', () => {
  const expired = harness(); expired.open(); expired.expire(); expired.tick();
  assert.equal(expired.sheet.data.mounted, false);
  assert.equal(expired.events.filter(item => item.name === 'apply').length, 0);
  expired.detach();
  const hidden = harness(); hidden.open(); hidden.hide(); hidden.tick(500);
  assert.equal(hidden.sheet.data.mounted, false); hidden.detach();
  const h = harness({ reducedMotion: true }); h.open(); h.tick();
  const { sheet } = h;
  sheet.dragStart(event(sheet, undefined, undefined, { touches: [{ clientX: 100, clientY: 10 }], timeStamp: 0 }));
  sheet.dragMove(event(sheet, undefined, undefined, { touches: [{ clientX: 100, clientY: 130 }], timeStamp: 180 }));
  assert.equal(sheet.data.dragY, 0);
  sheet.dragEnd(event(sheet, undefined, undefined, { touches: [], timeStamp: 220 }));
  h.tick(0);
  assert.equal(sheet.data.mounted, false);
  assert.equal(h.events.filter(item => item.name === 'apply').length, 0);
  h.detach();
});
