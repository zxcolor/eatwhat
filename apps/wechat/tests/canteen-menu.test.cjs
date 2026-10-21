const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const menu = require('../data/canteen-menu.json');
const policy = require('../data/canteen-policy.json');
const { ARTIFACTS, serializeRuntime, buildArtifacts } = require('../scripts/build-canteen-data.cjs');

const SOURCE_PATH = path.resolve(__dirname, '../../..', 'docs/canteen/餐品清单.md');
const sourceText = fs.readFileSync(SOURCE_PATH, 'utf8');
const STALLS = [
  ['minzu-fengwei', '民族风味', 9],
  ['lanzhou-lamian', '兰州拉面', 14],
  ['shandong-jianbing', '山东煎饼', 25],
  ['shishang-luroufan', '食尚卤肉饭', 26],
  ['hanshi-banfan', '韩式拌饭', 21],
  ['anhui-baozi', '安徽包子', 15],
  ['mala-xiangguo', '麻辣香锅', 3],
  ['fujian-fengwei', '福建风味', 30],
];

// Read the supplied Markdown independently of the static data and runtime code.
// Titles are the source categories; only table body rows are menu records.
function readSource() {
  const stalls = [];
  const rows = [];
  let stallName = null;
  let category = null;
  for (const rawLine of sourceText.split(/\r?\n/)) {
    const heading = /^(#{2,3}) (.+)$/.exec(rawLine);
    if (heading) {
      if (heading[1] === '##') {
        stallName = heading[2];
        category = null;
        stalls.push({ name: stallName, sourceImages: [] });
      } else {
        category = heading[2];
      }
      continue;
    }
    if (rawLine.startsWith('来源：')) {
      stalls[stalls.length - 1].sourceImages = Array.from(
        rawLine.matchAll(/\]\(([^)]+)\)/g), match => match[1],
      );
      continue;
    }
    const row = /^\| ([^|]+?) \| ([^|]+?) \|$/.exec(rawLine);
    if (!row || row[1] === '餐品' || /^[- :]+$/.test(row[1])) continue;
    assert.ok(stallName && category, `unscoped source row: ${rawLine}`);
    rows.push({ stallName, category, name: row[1], originalPriceText: row[2] });
  }
  return { stalls, rows };
}

const source = readSource();
const itemById = new Map(menu.items.map(item => [item.id, item]));
const policyById = new Map(policy.items.map(item => [item.itemId, item]));
const findItem = (stallId, name) => menu.items.find(item => item.stallId === stallId && item.name === name);

test('source snapshot is the supplied Markdown, with no photograph verification claim', () => {
  const normalized = `${sourceText.replace(/\r\n/g, '\n').trimEnd()}\n`;
  assert.equal(crypto.createHash('sha256').update(normalized).digest('hex'),
    '7bc37f65f94c5611dfe1931571439e32abc8dc04c35b861cf1d2884333231c1c');
  assert.equal(menu.schemaVersion, 1);
  assert.equal(menu.version, 'canteen-menu-v1');
  assert.deepEqual(menu.source, {
    document: '餐品清单.md', basis: 'user-provided-markdown', imagesVerified: false,
  });
  assert.equal(source.stalls.length, 8);
  assert.equal(source.rows.length, 143);
  assert.equal(source.stalls.reduce((count, stall) => count + stall.sourceImages.length, 0), 12);
});

test('all eight stalls retain original names and source links, with exact per-stall counts', () => {
  assert.equal(menu.stalls.length, 8);
  assert.deepEqual(menu.stalls.map(({ name, sourceImages }) => ({ name, sourceImages })), source.stalls);
  assert.deepEqual(menu.stalls.map(stall => [stall.id, stall.name]), STALLS.map(([id, name]) => [id, name]));
  for (const [id, name, count] of STALLS) {
    assert.equal(menu.items.filter(item => item.stallId === id).length, count, name);
    assert.equal(source.rows.filter(item => item.stallName === name).length, count, name);
  }
});

test('all 143 rows match the source names, full categories, price wording and stall binding', () => {
  const nameById = new Map(menu.stalls.map(stall => [stall.id, stall.name]));
  assert.equal(menu.items.length, 143);
  assert.deepEqual(menu.items.map(item => ({
    stallName: nameById.get(item.stallId), category: item.category,
    name: item.name, originalPriceText: item.originalPriceText,
  })), source.rows);
  for (const item of menu.items) {
    assert.deepEqual(Object.keys(item).sort(),
      ['id', 'stallId', 'category', 'name', 'originalPriceText', 'notes', 'price'].sort());
    assert.ok(Array.isArray(item.notes));
    const priceNotes = Array.from(item.originalPriceText.matchAll(/（([^）]+)）/g), match => match[1]);
    assert.deepEqual(item.notes, priceNotes, item.id);
  }
});

test('stable IDs are unique, stall-scoped and fixed to the original source order', () => {
  assert.equal(itemById.size, 143);
  assert.equal(new Set(menu.stalls.map(stall => stall.id)).size, 8);
  for (const [stallId] of STALLS) {
    const items = menu.items.filter(item => item.stallId === stallId);
    items.forEach((item, index) => {
      assert.equal(item.id, `${stallId}-${String(index + 1).padStart(3, '0')}`);
    });
  }
});

test('135 fixed prices use integer fen and retain original units or explicit null', () => {
  const fixed = menu.items.filter(item => item.price.kind === 'fixed');
  assert.equal(fixed.length, 135);
  for (const item of fixed) {
    const sourceRow = source.rows.find(row => row.name === item.name
      && row.stallName === menu.stalls.find(stall => stall.id === item.stallId).name);
    const original = /^(\d+)(?:\.(\d{1,2}))?元(?:\/([^（]+))?(?:（[^）]+）)?$/.exec(sourceRow.originalPriceText);
    assert.ok(original, item.id);
    const expectedFen = Number(original[1]) * 100 + Number((original[2] || '').padEnd(2, '0'));
    assert.deepEqual(item.price, { kind: 'fixed', amountFen: expectedFen, unit: original[3] || null }, item.id);
    assert.ok(Number.isSafeInteger(item.price.amountFen));
    assert.ok(item.price.amountFen > 0);
  }
  assert.equal(findItem('shandong-jianbing', '杂粮煎饼').price.unit, null);
  assert.equal(findItem('fujian-fengwei', '福鼎肉片').price.unit, null);
  assert.equal(findItem('fujian-fengwei', '牛面筋').price.amountFen, 50);
  assert.equal(findItem('anhui-baozi', '紫菜鸡蛋汤').price.amountFen, 250);
});

test('five multi-spec foods remain five records, with both exact small and large prices', () => {
  const expected = [
    ['福建扁食', 800, 1300], ['紫菜虾米馄饨', 800, 1300],
    ['虾三鲜馄饨', 1000, 1400], ['荠菜馄饨', 900, 1300], ['虾仁馄饨', 1100, 1500],
  ];
  const variants = menu.items.filter(item => item.price.kind === 'variants');
  assert.equal(variants.length, 5);
  assert.deepEqual(variants.map(item => item.name), expected.map(([name]) => name));
  for (const [name, small, large] of expected) {
    const item = findItem('fujian-fengwei', name);
    assert.deepEqual(item.price, { kind: 'variants', variants: [
      { id: 'small', name: '小份', amountFen: small, unit: null, originalPriceText: `小份${small / 100}元` },
      { id: 'large', name: '大份', amountFen: large, unit: null, originalPriceText: `大份${large / 100}元` },
    ] });
    assert.equal(item.price.variants.map(variant => variant.originalPriceText).join('；'), item.originalPriceText);
    assert.equal(menu.items.filter(row => row.name === name).length, 1);
  }
});

test('three weighted foods retain rates and average wording without a fictitious total', () => {
  const weighted = menu.items.filter(item => item.price.kind === 'weight');
  assert.deepEqual(weighted.map(item => item.name), ['麻辣香锅', '麻辣烫', '麻辣拌']);
  for (const item of weighted) {
    assert.equal(item.stallId, 'mala-xiangguo');
    assert.equal(item.originalPriceText, '素菜1.2元/50g；荤菜2.8元/50g，均价14');
    assert.deepEqual(item.price, { kind: 'weight', rates: [
      { name: '素菜', amountFen: 120, quantity: 50, unit: 'g', originalPriceText: '素菜1.2元/50g' },
      { name: '荤菜', amountFen: 280, quantity: 50, unit: 'g', originalPriceText: '荤菜2.8元/50g' },
    ], referenceText: '均价14' });
    assert.equal('amountFen' in item.price, false);
    assert.equal('totalFen' in item.price, false);
    assert.equal('minimumFen' in item.price, false);
  }
});

test('cross-stall duplicate names preserve distinct IDs, prices and units', () => {
  const shandong = findItem('shandong-jianbing', '番茄鸡排饭');
  const korean = findItem('hanshi-banfan', '番茄鸡排饭');
  assert.notEqual(shandong.id, korean.id);
  assert.equal(shandong.originalPriceText, '13元');
  assert.deepEqual(shandong.price, { kind: 'fixed', amountFen: 1300, unit: null });
  assert.equal(korean.originalPriceText, '14元/份');
  assert.deepEqual(korean.price, { kind: 'fixed', amountFen: 1400, unit: '份' });
  assert.equal(menu.items.filter(item => item.name === '小米粥').length, 2);
  assert.equal(menu.items.filter(item => item.name === '豆沙包').length, 2);
});

test('rice noodles 01 and 02 retain complete names and egg keeps its one dual-use record', () => {
  const first = findItem('fujian-fengwei', '生烫牛肉米线（01：米线+青菜+肉酱）');
  const second = findItem('fujian-fengwei', '生烫牛肉米线（02：米线+青菜+卤蛋+牛肉丸+肉酱）');
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.price, { kind: 'fixed', amountFen: 1000, unit: null });
  assert.deepEqual(second.price, { kind: 'fixed', amountFen: 1300, unit: null });
  const eggs = menu.items.filter(item => item.stallId === 'fujian-fengwei' && item.name === '卤蛋');
  assert.equal(eggs.length, 1);
  assert.equal(eggs[0].category, '福建小吃');
  assert.equal(eggs[0].originalPriceText, '1.5元/份（亦可作米线浇头）');
  assert.deepEqual(eggs[0].notes, ['亦可作米线浇头']);
  assert.deepEqual(eggs[0].price, { kind: 'fixed', amountFen: 150, unit: '份' });
  assert.equal(policyById.get(eggs[0].id).defaultCandidate, true);
});

test('all 143 explicit policy records are separate from menu facts and yield 124 default foods', () => {
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.items.length, 143);
  assert.equal(policyById.size, 143);
  assert.deepEqual(policy.items.map(item => item.itemId), menu.items.map(item => item.id));
  assert.equal(policy.items.filter(item => item.defaultCandidate).length, 124);
  assert.equal(policy.items.filter(item => item.reason === 'food').length, 124);
  assert.equal(policy.items.filter(item => item.reason === 'addon').length, 17);
  assert.equal(policy.items.filter(item => item.reason === 'drink').length, 2);
  for (const entry of policy.items) {
    assert.deepEqual(Object.keys(entry).sort(), ['itemId', 'defaultCandidate', 'reason'].sort());
    assert.equal(typeof entry.defaultCandidate, 'boolean');
    assert.equal(entry.defaultCandidate, entry.reason === 'food');
    assert.ok(itemById.has(entry.itemId));
    assert.equal('defaultCandidate' in itemById.get(entry.itemId), false);
  }
});

test('only the 17 explicitly listed addons and two soy drinks are excluded by default', () => {
  const excludedIds = new Set([
    ...Array.from({ length: 8 }, (_, index) => `shandong-jianbing-${String(index + 18).padStart(3, '0')}`),
    ...Array.from({ length: 9 }, (_, index) => `fujian-fengwei-${String(index + 22).padStart(3, '0')}`),
    'shandong-jianbing-016', 'shandong-jianbing-017',
  ]);
  assert.deepEqual(new Set(policy.items.filter(item => !item.defaultCandidate).map(item => item.itemId)), excludedIds);
  assert.deepEqual(policy.items.filter(item => item.reason === 'drink').map(item => itemById.get(item.itemId).name),
    ['原味豆浆', '红枣豆浆']);
  assert.deepEqual(policy.items.filter(item => item.reason === 'addon').map(item => itemById.get(item.itemId).name),
    ['辣条', '双汇肠', '里脊', '鸡柳', '培根', '肉松', '鸡排', '纯肉肠',
      '牛面筋', '牛肉丸', '炸蛋', '肉丝', '鸡杂', '牛百叶', '鲜切吊龙', '鲜卤牛腩', '鲜虾仁']);
  for (const item of menu.items) {
    if (!excludedIds.has(item.id)) assert.equal(policyById.get(item.id).defaultCandidate, true, item.id);
  }
  for (const name of ['小米粥', '紫米粥', '煮鸡蛋', '豆沙包', '烤肠', '思念汤圆', '香干']) {
    for (const item of menu.items.filter(row => row.name === name)) {
      assert.equal(policyById.get(item.id).defaultCandidate, true, item.id);
    }
  }
});

test('native runtime mirrors deterministically export exactly the JSON, without loading JSON at runtime', () => {
  assert.deepEqual(buildArtifacts({ check: true }), ARTIFACTS);
  for (const artifact of ARTIFACTS) {
    const original = JSON.parse(fs.readFileSync(artifact.jsonPath, 'utf8'));
    const runtime = fs.readFileSync(artifact.runtimePath, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(runtime, serializeRuntime(original));
    const module = { exports: {} };
    vm.runInNewContext(runtime, { module }, { filename: artifact.runtimePath });
    assert.deepEqual(JSON.parse(JSON.stringify(module.exports)), original);
  }
});
