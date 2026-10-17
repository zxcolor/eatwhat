const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalRecords, KEY, RETENTION_MS } = require('../lib/local-records');

// Synthetic metadata only. Never reads real wx storage or calls a location API.
const INPUT = { mealPeriod: 'LUNCH', decisionMode: 'QUICK', budgetMaxYuan: 25, availableMinutes: 60, travelMode: 'WALK' };
function harness() {
  const data = new Map();
  let time = 2000000000000;
  let consent = true;
  const storage = { getStorageSync: key => data.get(key), setStorageSync: (key, value) => data.set(key, value), removeStorageSync: key => data.delete(key) };
  const records = createLocalRecords({ storage, now: () => time, hasConsent: () => consent });
  return { data, storage, records, advance: value => { time += value; }, withdraw: () => { consent = false; } };
}
test('local history persists only the Android seven-field summary, including for a LIVE input', () => {
  const { records, data } = harness();
  records.recordDecision({ ...INPUT, latitude: 0, location: { latitude: 0, longitude: 0 }, dataMode: 'LIVE', name: '合成测试餐厅', resultToken: 'x'.repeat(43), target: 'COFFEE' }, 2);
  const payload = JSON.parse(data.get(KEY));
  assert.deepEqual(Object.keys(payload), ['schemaVersion', 'entries']);
  assert.deepEqual(payload.entries, [{ recordedAtEpochMillis: 2000000000000, ...INPUT, resultCount: 2 }]);
});
test('history keeps newest 30 entries and expires physically on every read', () => {
  const h = harness();
  for (let index = 0; index < 35; index += 1) { h.records.recordDecision(INPUT, 1); h.advance(1); }
  assert.equal(h.records.list().length, 30);
  assert.equal(h.records.list()[0].recordedAtEpochMillis, 2000000000034);
  h.advance(RETENTION_MS);
  assert.deepEqual(h.records.list(), []);
  assert.equal(h.data.has(KEY), false);
});
test('history retains the exact 90-day boundary as Android does', () => {
  const h = harness();
  h.records.recordDecision(INPUT, 1);
  h.advance(RETENTION_MS);
  assert.equal(h.records.list().length, 1);
  h.advance(1);
  assert.equal(h.records.list().length, 0);
});
test('malformed, foreign schema, sensitive extra fields and future history are physically removed', () => {
  const h = harness();
  for (const raw of ['{', JSON.stringify({ schemaVersion: 2, entries: [] }), JSON.stringify({ schemaVersion: 1, entries: [{ recordedAtEpochMillis: 2000000000000, ...INPUT, resultCount: 1, location: { latitude: 0 } }] }), JSON.stringify({ schemaVersion: 1, entries: [{ recordedAtEpochMillis: 2000000000001, ...INPUT, resultCount: 1 }] })]) {
    h.data.set(KEY, raw);
    assert.deepEqual(h.records.list(), []);
    assert.equal(h.data.has(KEY), false);
  }
});
test('invalid metadata is rejected and missing/negative counts cannot inject data', () => {
  const h = harness();
  assert.throws(() => h.records.recordDecision({ ...INPUT, mealPeriod: 'ANY' }, 1));
  assert.throws(() => h.records.recordDecision(INPUT, 4));
  assert.throws(() => h.records.recordDecision(INPUT, NaN));
  h.records.recordDecision(INPUT, -1);
  assert.equal(h.records.list()[0].resultCount, 0);
});
test('withdrawal removes history and blocks further writes; clear preserves unrelated storage', () => {
  const h = harness();
  h.data.set('unrelated', true);
  h.records.recordDecision(INPUT, 1);
  h.withdraw();
  assert.equal(h.records.recordDecision(INPUT, 1), false);
  assert.deepEqual(h.records.list(), []);
  assert.equal(h.data.has(KEY), false);
  assert.equal(h.data.get('unrelated'), true);
});
test('storage failures use safe local messages rather than disk error text', () => {
  const h = harness();
  h.storage.setStorageSync = () => { throw new Error('sensitive raw storage content'); };
  assert.throws(() => h.records.recordDecision(INPUT, 1), { message: '推荐完成，但最近决策暂未保存到本机。' });
});
