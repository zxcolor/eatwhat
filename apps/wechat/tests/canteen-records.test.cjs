const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const menu = require('../data/canteen-menu');
const policy = require('../data/canteen-policy');
const { createCanteenRecords, KEY, ENABLED_KEY, RETENTION_MS, MAX_ENTRIES } = require('../lib/canteen-records');

// Menu facts come from the supplied menu. Only the clock and storage are test doubles.
function itemNamed(name, stallName) {
  const stall = stallName && menu.stalls.find(value => value.name === stallName);
  const item = menu.items.find(value => value.name === name && (!stall || value.stallId === stall.id));
  assert.ok(item, `Missing menu item: ${name}`);
  return item;
}

function choice(item, variantId = null) {
  const variant = item.price.kind === 'variants' && item.price.variants.find(value => value.id === variantId);
  return {
    menuVersion: menu.version, itemId: item.id, stallId: item.stallId,
    variantId: variant ? variant.id : null, variantName: variant ? variant.name : null,
    priceKind: item.price.kind,
    amountFen: variant ? variant.amountFen : item.price.kind === 'fixed' ? item.price.amountFen : null,
    unit: variant ? variant.unit : item.price.kind === 'fixed' ? item.price.unit : null,
    priceText: variant ? variant.originalPriceText : item.originalPriceText,
  };
}

function harness(enabled = false) {
  const data = new Map(enabled ? [[ENABLED_KEY, true]] : []);
  const calls = [];
  let time = 2000000000000;
  const storage = {
    getStorageSync(key) { calls.push(['get', key]); return data.get(key); },
    setStorageSync(key, value) { calls.push(['set', key, value]); data.set(key, value); },
    removeStorageSync(key) { calls.push(['remove', key]); data.delete(key); },
  };
  const records = createCanteenRecords({ storage, now: () => time });
  return { data, calls, storage, records, now: () => time, advance: value => { time += value; } };
}

const fixed = () => choice(itemNamed('鸡肉石锅拌饭', '韩式拌饭'));
const entryAt = (time, value = fixed()) => ({ recordedAtEpochMillis: time, ...value });
const envelope = entries => JSON.stringify({ schemaVersion: 1, entries });

test('record validation works without Object.hasOwn in the mini-program runtime', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/canteen-records.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, require });
  vm.runInContext('Object.hasOwn = undefined;', context);
  assert.equal(vm.runInContext('typeof Object.hasOwn', context), 'undefined');
  vm.runInContext(source, context);
  const h = harness();
  const records = context.module.exports.createCanteenRecords({ storage: h.storage, now: h.now });
  records.setEnabled(true);
  assert.equal(records.recordChoice(fixed()), true);
  assert.equal(records.list()[0].amountFen, fixed().amountFen);
  assert.throws(() => records.recordChoice({ ...fixed(), extra: true }), /与菜单不一致/);
});

test('canteen recording is off by default and cannot write before its separate opt-in', () => {
  const h = harness();
  assert.equal(h.records.isEnabled(), false);
  assert.equal(h.records.recordChoice(fixed()), false);
  assert.equal(h.data.size, 0);
  assert.equal(h.calls.some(([operation]) => operation === 'set'), false);
  assert.throws(() => h.records.setEnabled('true'), /设置无效/);
  h.data.set(ENABLED_KEY, 'true');
  h.data.set(KEY, envelope([entryAt(h.now())]));
  assert.deepEqual(h.records.prune(), []);
  assert.equal(h.data.has(KEY), false);
});

test('explicit opt-in persists exact fixed-price choices and clear preserves the setting', () => {
  const h = harness();
  h.data.set('unrelated', 'keep');
  assert.equal(h.records.setEnabled(true), true);
  assert.equal(h.records.isEnabled(), true);
  assert.equal(h.records.recordChoice(fixed()), true);
  assert.deepEqual(JSON.parse(h.data.get(KEY)), { schemaVersion: 1, entries: [entryAt(h.now())] });
  h.records.setEnabled(true);
  assert.equal(h.records.list().length, 1);
  h.records.clear();
  assert.equal(h.data.has(KEY), false);
  assert.equal(h.records.isEnabled(), true);
  assert.equal(h.data.get('unrelated'), 'keep');
});

test('disabling immediately removes choices and withdrawal also removes the opt-in key', () => {
  const h = harness(true);
  h.data.set('unrelated', true);
  h.records.recordChoice(fixed());
  assert.equal(h.records.setEnabled(false), false);
  assert.equal(h.records.isEnabled(), false);
  assert.equal(h.data.has(KEY), false);
  assert.equal(h.records.recordChoice(fixed()), false);
  assert.equal(createCanteenRecords({ storage: h.storage, now: h.now }).isEnabled(), false);
  h.records.setEnabled(true);
  h.records.recordChoice(fixed());
  h.records.withdraw();
  assert.equal(h.data.has(KEY), false);
  assert.equal(h.data.has(ENABLED_KEY), false);
  assert.equal(h.data.get('unrelated'), true);
});

test('every default menu food can be recorded while all excluded drinks and additions are rejected', () => {
  const h = harness(true);
  const included = new Set(policy.items.filter(value => value.defaultCandidate).map(value => value.itemId));
  let accepted = 0;
  let rejected = 0;
  for (const item of menu.items) {
    const payload = choice(item, item.price.kind === 'variants' ? item.price.variants[0].id : null);
    if (included.has(item.id)) { assert.equal(h.records.recordChoice(payload), true); accepted += 1; }
    else { assert.throws(() => h.records.recordChoice(payload), /与菜单不一致/); rejected += 1; }
  }
  assert.equal(accepted, 87);
  assert.equal(rejected, 0);
  assert.throws(() => h.records.recordChoice({ ...fixed(), itemId: 'shandong-jianbing-016' }), /与菜单不一致/);
});

test('all five variable-price dishes preserve the actual chosen size, amount and original unit', () => {
  const h = harness(true);
  const variants = menu.items.filter(item => item.price.kind === 'variants');
  assert.equal(variants.length, 5);
  for (const item of variants) {
    for (const variant of item.price.variants) {
      const payload = choice(item, variant.id);
      h.records.recordChoice(payload);
      assert.deepEqual(h.records.list()[0], entryAt(h.now(), payload));
      assert.equal(h.records.list()[0].unit, null);
      h.advance(1);
    }
    assert.throws(() => h.records.recordChoice(choice(item)), /与菜单不一致/);
    const selected = choice(item, item.price.variants[0].id);
    for (const corrupt of [{ variantId: 'unknown' }, { variantName: '未售规格' }, { amountFen: selected.amountFen + 1 }, { priceText: '伪造价格' }, { unit: '份' }]) {
      assert.throws(() => h.records.recordChoice({ ...selected, ...corrupt }), /与菜单不一致/);
    }
  }
});

test('same-named dishes retain their own stall and price without inventing a missing unit', () => {
  const h = harness(true);
  const shandong = choice(itemNamed('番茄鸡排饭', '山东煎饼'));
  const korean = choice(itemNamed('番茄鸡排饭', '韩式拌饭'));
  assert.equal(shandong.amountFen, 1300);
  assert.equal(shandong.unit, null);
  assert.equal(korean.amountFen, 1400);
  assert.equal(korean.unit, '份');
  h.records.recordChoice(shandong);
  h.advance(1);
  h.records.recordChoice(korean);
  assert.deepEqual(h.records.list().map(value => [value.itemId, value.amountFen, value.unit]), [
    [korean.itemId, 1400, '份'], [shandong.itemId, 1300, null],
  ]);
  for (const corrupt of [{ stallId: korean.stallId }, { amountFen: korean.amountFen }, { priceText: korean.priceText }, { unit: korean.unit }]) {
    assert.throws(() => h.records.recordChoice({ ...shandong, ...corrupt }), /与菜单不一致/);
  }
});

test('all weight-priced choices retain pricing rules and never accept a fabricated total', () => {
  const h = harness(true);
  const weighted = menu.items.filter(item => item.price.kind === 'weight');
  assert.equal(weighted.length, 3);
  for (const item of weighted) {
    const payload = choice(item);
    h.records.recordChoice(payload);
    const saved = h.records.list()[0];
    assert.equal(saved.amountFen, null);
    assert.equal(saved.priceText, '素菜1.2元/50g；荤菜2.8元/50g，均价14');
    for (const corrupt of [{ amountFen: 1400 }, { amountFen: 0 }, { priceKind: 'fixed' }, { unit: '50g' }, { priceText: '14元' }, { variantId: 'small' }, { variantName: '小份' }]) {
      assert.throws(() => h.records.recordChoice({ ...payload, ...corrupt }), /与菜单不一致/);
    }
    h.advance(1);
  }
});

test('confirmation rejects extra fields, missing fields, foreign menu versions and forged facts', () => {
  const h = harness(true);
  const payload = fixed();
  const missing = { ...payload };
  delete missing.unit;
  for (const corrupt of [missing, null, [], { ...payload, location: { latitude: 0 } }, { ...payload, recordedAtEpochMillis: h.now() },
    { ...payload, menuVersion: 'future-menu' }, { ...payload, itemId: 'unknown' }, { ...payload, amountFen: NaN },
    { ...payload, amountFen: 600.5 }, { ...payload, amountFen: '600' }, { ...payload, variantId: 'small' },
    { ...payload, variantName: '小份' }, { ...payload, priceText: '6元' }]) {
    assert.throws(() => h.records.recordChoice(corrupt), /与菜单不一致/);
  }
  assert.equal(h.data.has(KEY), false);
});

test('history keeps the newest 30 choices and expires physically after the inclusive 90-day boundary', () => {
  const h = harness(true);
  for (let index = 0; index < 35; index += 1) { h.records.recordChoice(fixed()); h.advance(1); }
  assert.equal(MAX_ENTRIES, 30);
  assert.equal(h.records.list().length, 30);
  assert.equal(h.records.list()[0].recordedAtEpochMillis, 2000000000034);
  assert.equal(h.records.list()[29].recordedAtEpochMillis, 2000000000005);
  h.advance(RETENTION_MS - 1);
  assert.equal(h.records.prune().length, 1);
  h.advance(1);
  assert.deepEqual(h.records.list(), []);
  assert.equal(h.data.has(KEY), false);
});

test('read prunes future, expired, tampered and extra-field records while retaining valid choices', () => {
  const h = harness(true);
  const valid = entryAt(h.now());
  h.data.set(KEY, envelope([
    entryAt(h.now() + 1), valid, entryAt(h.now() - RETENTION_MS - 1),
    { ...valid, amountFen: 1 }, { ...valid, menuVersion: 'foreign' }, { ...valid, latitude: 0 },
  ]));
  assert.deepEqual(h.records.prune(), [valid]);
  assert.deepEqual(JSON.parse(h.data.get(KEY)).entries, [valid]);
  const returned = h.records.list();
  returned[0].amountFen = 1;
  assert.equal(h.records.list()[0].amountFen, fixed().amountFen);
});

test('malformed and foreign storage envelopes are physically cleared', () => {
  const h = harness(true);
  for (const raw of ['{', 'null', 'false', '0', '[]', '{}', JSON.stringify({ schemaVersion: 2, entries: [] }),
    JSON.stringify({ schemaVersion: 1, entries: null }), JSON.stringify({ schemaVersion: 1, entries: [], extra: true }), envelope([])]) {
    h.data.set(KEY, raw);
    assert.deepEqual(h.records.list(), []);
    assert.equal(h.data.has(KEY), false);
  }
});

test('withdraw independently attempts both cleanup operations and aggregates failures safely', () => {
  const h = harness(true);
  h.records.recordChoice(fixed());
  h.storage.removeStorageSync = () => { throw new Error('private raw storage content'); };
  assert.throws(() => h.records.withdraw(), error => {
    assert.match(error.message, /启用设置清除失败/);
    assert.match(error.message, /选择记录清除失败/);
    assert.equal(error.message.includes('private raw'), false);
    return true;
  });
  assert.equal(h.records.isEnabled(), false);
  assert.equal(h.records.recordChoice(fixed()), false);
  assert.equal(h.data.get(ENABLED_KEY), false);
  assert.equal(createCanteenRecords({ storage: h.storage, now: h.now }).isEnabled(), false);
});

test('failed preference writes fall back to key deletion, and total failure still stops current writes', () => {
  const h = harness(true);
  h.records.recordChoice(fixed());
  h.storage.setStorageSync = () => { throw new Error('private raw failure'); };
  h.records.setEnabled(false);
  assert.equal(h.data.has(ENABLED_KEY), false);
  assert.equal(h.data.has(KEY), false);
  const broken = harness(true);
  broken.records.recordChoice(fixed());
  broken.storage.setStorageSync = () => { throw new Error('private raw failure'); };
  broken.storage.removeStorageSync = () => { throw new Error('private raw failure'); };
  assert.throws(() => broken.records.setEnabled(false), /关闭设置保存失败.*选择记录清除失败/);
  assert.equal(broken.records.isEnabled(), false);
  assert.equal(broken.records.recordChoice(fixed()), false);
});

test('total storage failure warns against closing because a new instance can still read the old opt-in and choices', () => {
  for (const operation of ['setEnabled', 'withdraw']) {
    const h = harness(true);
    h.records.recordChoice(fixed());
    const set = h.storage.setStorageSync;
    const remove = h.storage.removeStorageSync;
    h.storage.setStorageSync = () => { throw new Error('private raw failure'); };
    h.storage.removeStorageSync = () => { throw new Error('private raw failure'); };
    assert.throws(() => h.records[operation](false), /关闭状态未能保存，清理成功前请不要关闭小程序/);
    assert.equal(h.records.isEnabled(), false);
    assert.equal(h.records.recordChoice(fixed()), false);
    // No in-memory flag can persist the withdrawal while both storage operations fail.
    const restarted = createCanteenRecords({ storage: h.storage, now: h.now });
    assert.equal(restarted.isEnabled(), true);
    assert.equal(restarted.list().length, 1);
    h.storage.setStorageSync = set;
    h.storage.removeStorageSync = remove;
    h.records.withdraw();
    assert.equal(h.data.has(ENABLED_KEY), false);
    assert.equal(h.data.has(KEY), false);
    assert.equal(createCanteenRecords({ storage: h.storage, now: h.now }).isEnabled(), false);
  }
});

test('re-enabling after failed cleanup cannot resurrect previous choices', () => {
  const h = harness(true);
  h.records.recordChoice(fixed());
  const remove = h.storage.removeStorageSync;
  h.storage.removeStorageSync = key => { if (key === KEY) throw new Error('disk failed'); return remove(key); };
  assert.throws(() => h.records.setEnabled(false), /记录清除失败/);
  assert.throws(() => h.records.setEnabled(true), /记录清除失败/);
  assert.equal(h.records.isEnabled(), false);
  h.storage.removeStorageSync = remove;
  h.records.setEnabled(true);
  assert.deepEqual(h.records.list(), []);
});

test('pending cleanup survives reads and record-only clearing until withdrawal or explicit re-enabling succeeds', () => {
  for (const recovery of ['withdraw', 'setEnabled']) {
    const h = harness(true);
    assert.equal(h.records.getCleanupError(), '');
    h.records.recordChoice(fixed());
    const set = h.storage.setStorageSync;
    const remove = h.storage.removeStorageSync;
    h.storage.setStorageSync = () => { throw new Error('private raw failure'); };
    h.storage.removeStorageSync = key => {
      if (key === ENABLED_KEY) throw new Error('private raw failure');
      remove(key);
    };
    assert.throws(() => h.records.withdraw(), /清理成功前请不要关闭小程序/);
    const pending = h.records.getCleanupError();
    assert.ok(pending);
    h.records.clear();
    assert.deepEqual(h.records.list(), []);
    assert.equal(h.records.getCleanupError(), pending);
    assert.equal(h.data.get(ENABLED_KEY), true);
    assert.throws(() => h.records.setEnabled(true), /启用设置保存失败/);
    assert.equal(h.records.getCleanupError(), pending);
    h.storage.setStorageSync = set;
    h.storage.removeStorageSync = remove;
    h.records[recovery](true);
    assert.equal(h.records.getCleanupError(), '');
    assert.equal(h.records.isEnabled(), recovery === 'setEnabled');
    assert.equal(h.data.has(KEY), false);
  }
});

test('storage failures expose useful local messages without leaking raw errors', () => {
  const h = harness();
  h.storage.setStorageSync = () => { throw new Error('private raw storage content'); };
  assert.throws(() => h.records.setEnabled(true), { message: '食堂记录启用设置保存失败，请重试。' });
  assert.equal(h.records.isEnabled(), false);
  const enabled = harness(true);
  enabled.storage.setStorageSync = h.storage.setStorageSync;
  assert.throws(() => enabled.records.recordChoice(fixed()), { message: '已确认选择，但食堂记录暂未保存到本机。' });
  enabled.data.set(KEY, envelope([entryAt(enabled.now() + 1), entryAt(enabled.now())]));
  assert.throws(() => enabled.records.prune(), { message: '食堂选择记录暂时无法读取或清理，请重试。' });
  enabled.storage.getStorageSync = () => { throw new Error('private raw storage content'); };
  assert.throws(() => enabled.records.isEnabled(), { message: '食堂记录设置暂时无法读取，请重试。' });
  assert.throws(() => enabled.records.list(), { message: '食堂选择记录暂时无法读取或清理，请重试。' });
});
