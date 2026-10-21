const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const titleModule = path.resolve(__dirname, '../lib/home-title.js');
const { getHomeTitle } = require(titleModule);

test('Beijing meal titles change at 11:00, 17:00 and midnight, including UTC date rollover', () => {
  for (const [time, title] of [
    ['2026-10-19T15:59:59.999Z', '今天晚上吃什么'],
    ['2026-10-19T16:00:00.000Z', '今天早上吃什么'],
    ['2026-10-20T02:59:59.999Z', '今天早上吃什么'],
    ['2026-10-20T03:00:00.000Z', '今天中午吃什么'],
    ['2026-10-20T08:59:59.999Z', '今天中午吃什么'],
    ['2026-10-20T09:00:00.000Z', '今天晚上吃什么'],
    ['2026-12-31T16:00:00.000Z', '今天早上吃什么'],
  ]) assert.equal(getHomeTitle(Date.parse(time)), title, time);
});

test('the same instant uses Beijing time in several host time zones', () => {
  const code = `const {getHomeTitle}=require(process.argv[1]);process.stdout.write(getHomeTitle(Date.parse('2026-10-20T03:00:00Z')));`;
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    assert.equal(execFileSync(process.execPath, ['-e', code, titleModule], {
      env: { ...process.env, TZ }, encoding: 'utf8', windowsHide: true,
    }), '今天中午吃什么');
  }
});

function harness(time, ready = true) {
  let now = Date.parse(time);
  let definition;
  let serial = 0;
  let rejectTitle = false;
  const timers = new Map();
  const calls = [];
  class LocalDate extends Date { static now() { return now; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/index/index.js'), 'utf8'), {
    require(name) {
      if (name === '../../lib/home-title') return { getHomeTitle };
      if (name === '../../lib/service') return { VERSION: 'test', state: {} };
      if (name === '../../lib/decision/service') return { getState: () => ({}) };
      throw new Error(name);
    },
    Date: LocalDate,
    Page(value) { definition = value; },
    getApp: () => ({ ensureTasteProfile: () => ready, syncPage() {} }),
    wx: { setNavigationBarTitle(options) { calls.push(options.title); if (rejectTitle) options.fail(); } },
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const page = { ...definition, data: { ...definition.data }, setData(update) { Object.assign(this.data, update); } };
  page.onLoad();
  function pending() { assert.equal(timers.size, 1); return timers.values().next().value; }
  return {
    page, calls, timers, pending,
    setTime(time) { now = Date.parse(time); },
    reject(value) { rejectTitle = value; },
    tick() { const timer = pending(); timers.clear(); timer.callback(); },
  };
}

test('a visible homepage refreshes exactly at the next minute and does not repeat unchanged titles', () => {
  const h = harness('2026-10-20T02:59:59.500Z');
  h.page.onShow();
  assert.deepEqual(h.calls, ['今天早上吃什么']);
  assert.equal(h.pending().delay, 500);
  h.setTime('2026-10-20T03:00:00.000Z'); h.tick();
  assert.deepEqual(h.calls, ['今天早上吃什么', '今天中午吃什么']);
  assert.equal(h.pending().delay, 60000);
  h.setTime('2026-10-20T03:01:00.000Z'); h.tick();
  assert.equal(h.calls.length, 2);
});

test('background, resume and unload invalidate old callbacks without changing another page title', () => {
  const h = harness('2026-10-20T08:59:00.000Z');
  h.page.onShow();
  const old = h.pending();
  h.page.onHide();
  assert.equal(h.timers.size, 0);
  h.setTime('2026-10-20T09:15:00.000Z'); old.callback();
  assert.deepEqual(h.calls, ['今天中午吃什么']);
  h.page.onShow();
  assert.deepEqual(h.calls, ['今天中午吃什么', '今天晚上吃什么']);
  old.callback();
  assert.equal(h.timers.size, 1);
  const current = h.pending();
  h.page.onUnload(); current.callback();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.length, 2);
});

test('title refresh recalculates after a clock correction and retries a failed native update', () => {
  const h = harness('2026-10-20T09:30:00.000Z');
  h.reject(true); h.page.onShow();
  h.reject(false); h.tick();
  assert.deepEqual(h.calls, ['今天晚上吃什么', '今天晚上吃什么']);
  h.setTime('2026-10-20T02:30:00.000Z'); h.tick();
  assert.equal(h.calls.at(-1), '今天早上吃什么');
});

test('a homepage blocked by the preference gate neither changes the title nor starts a clock', () => {
  const h = harness('2026-10-20T03:00:00.000Z', false);
  h.page.onShow();
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.size, 0);
});
