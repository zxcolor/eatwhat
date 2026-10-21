const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const menu = require('../data/canteen-menu.json');
const policy = require('../data/canteen-policy.json');
const historical = require('../data/canteen-history-catalogs.json').catalogs[0];
const { ARTIFACTS, serializeRuntime, buildArtifacts } = require('../scripts/build-canteen-data.cjs');

const SOURCE_PATH = path.resolve(__dirname, '../../..', 'docs/canteen/餐品清单.md');
const sourceText = fs.readFileSync(SOURCE_PATH, 'utf8');
const STALLS = [
  ['lanzhou-lamian', '兰州拉面', 10],
  ['shandong-jianbing', '山东煎饼', 10],
  ['shishang-luroufan', '食尚卤肉饭', 26],
  ['hanshi-banfan', '韩式拌饭', 21],
  ['anhui-baozi', '安徽包子', 3],
  ['mala-xiangguo', '麻辣香锅', 3],
  ['fujian-fengwei', '福建风味', 14],
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
    if (!row || row[1].trim() === '餐品' || /^[- :]+$/.test(row[1])) continue;
    assert.ok(stallName, `unscoped source row: ${rawLine}`);
    rows.push({ stallName, category, name: row[1].trim(), originalPriceText: row[2].trim() });
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
    'aad6adb4f5c5a8f79541a9d01a4073f23405b1f0015d6c0065f077c8fe1c972f');
  assert.equal(menu.schemaVersion, 1);
  assert.equal(menu.version, 'canteen-menu-v2');
  assert.deepEqual(menu.source, {
    document: '餐品清单.md', basis: 'user-provided-markdown', imagesVerified: false,
  });
  assert.equal(source.stalls.length, 7);
  assert.equal(source.rows.length, 87);
  assert.equal(source.stalls.reduce((count, stall) => count + stall.sourceImages.length, 0), 0);
});

test('all seven current stalls retain original names and exactly the supplied source links', () => {
  assert.equal(menu.stalls.length, 7);
  assert.deepEqual(menu.stalls.map(({ name, sourceImages }) => ({ name, sourceImages })), source.stalls);
  assert.deepEqual(menu.stalls.map(stall => [stall.id, stall.name]), STALLS.map(([id, name]) => [id, name]));
  for (const [id, name, count] of STALLS) {
    assert.equal(menu.items.filter(item => item.stallId === id).length, count, name);
    assert.equal(source.rows.filter(item => item.stallName === name).length, count, name);
  }
});

test('all 87 rows match the source names, nullable categories, price wording and stall binding', () => {
  const nameById = new Map(menu.stalls.map(stall => [stall.id, stall.name]));
  assert.equal(menu.items.length, 87);
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

test('stable IDs are unique and retain their v1 identities despite menu deletions', () => {
  assert.equal(itemById.size, 87);
  assert.equal(new Set(menu.stalls.map(stall => stall.id)).size, 7);
  for (const [stallId] of STALLS) {
    const items = menu.items.filter(item => item.stallId === stallId);
    items.forEach(item => {
      const original = historical.menu.items.find(entry => entry.id === item.id);
      assert.ok(original);
      assert.equal(item.stallId, original.stallId);
      assert.equal(item.name, original.name);
    });
  }
});

test('79 fixed prices use integer fen and retain original units or explicit null', () => {
  const fixed = menu.items.filter(item => item.price.kind === 'fixed');
  assert.equal(fixed.length, 79);
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
  assert.equal(findItem('shandong-jianbing', '番茄鸡排饭').price.unit, null);
  assert.equal(findItem('fujian-fengwei', '福鼎肉片').price.unit, null);
  assert.equal(findItem('fujian-fengwei', '牛面筋'), undefined);
  assert.equal(findItem('anhui-baozi', '紫菜鸡蛋汤'), undefined);
});

test('five specification-based foods retain only the exact sizes supplied by menu v2', () => {
  const expected = [
    ['福建扁食', null, 1300], ['紫菜虾米馄饨', null, 1300],
    ['虾三鲜馄饨', 1000, 1400], ['荠菜馄饨', null, 1300], ['虾仁馄饨', 1100, 1500],
  ];
  const variants = menu.items.filter(item => item.price.kind === 'variants');
  assert.equal(variants.length, 5);
  assert.deepEqual(variants.map(item => item.name), expected.map(([name]) => name));
  for (const [name, small, large] of expected) {
    const item = findItem('fujian-fengwei', name);
    assert.deepEqual(item.price, { kind: 'variants', variants: [
      ...(small === null ? [] : [{ id: 'small', name: '小份', amountFen: small, unit: null, originalPriceText: `小份${small / 100}元` }]),
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
  assert.equal(historical.menu.items.filter(item => item.name === '小米粥').length, 2);
  assert.equal(historical.menu.items.filter(item => item.name === '豆沙包').length, 2);
  assert.equal(menu.items.filter(item => ['小米粥', '豆沙包'].includes(item.name)).length, 0);
});

test('rice noodles 01 and 02 retain complete names while deleted egg remains only in history', () => {
  const first = findItem('fujian-fengwei', '生烫牛肉米线（01：米线+青菜+肉酱）');
  const second = findItem('fujian-fengwei', '生烫牛肉米线（02：米线+青菜+卤蛋+牛肉丸+肉酱）');
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.price, { kind: 'fixed', amountFen: 1000, unit: null });
  assert.deepEqual(second.price, { kind: 'fixed', amountFen: 1300, unit: null });
  const eggs = historical.menu.items.filter(item => item.stallId === 'fujian-fengwei' && item.name === '卤蛋');
  assert.equal(eggs.length, 1);
  assert.equal(eggs[0].category, '福建小吃');
  assert.equal(eggs[0].originalPriceText, '1.5元/份（亦可作米线浇头）');
  assert.deepEqual(eggs[0].notes, ['亦可作米线浇头']);
  assert.deepEqual(eggs[0].price, { kind: 'fixed', amountFen: 150, unit: '份' });
  assert.equal(policyById.has(eggs[0].id), false);
  assert.ok(historical.defaultCandidateIds.includes(eggs[0].id));
});

test('all 87 current policy records remain separate from menu facts and are eligible foods', () => {
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.items.length, 87);
  assert.equal(policyById.size, 87);
  assert.deepEqual(policy.items.map(item => item.itemId), menu.items.map(item => item.id));
  assert.equal(policy.items.filter(item => item.defaultCandidate).length, 87);
  assert.equal(policy.items.filter(item => item.reason === 'food').length, 87);
  assert.equal(policy.items.filter(item => item.reason === 'addon').length, 0);
  assert.equal(policy.items.filter(item => item.reason === 'drink').length, 0);
  for (const entry of policy.items) {
    assert.deepEqual(Object.keys(entry).sort(), ['itemId', 'defaultCandidate', 'reason'].sort());
    assert.equal(typeof entry.defaultCandidate, 'boolean');
    assert.equal(entry.defaultCandidate, entry.reason === 'food');
    assert.ok(itemById.has(entry.itemId));
    assert.equal('defaultCandidate' in itemById.get(entry.itemId), false);
  }
});

test('the historical 17 addons and two drinks remain outside the current menu and archive eligibility', () => {
  const excludedIds = new Set([
    ...Array.from({ length: 8 }, (_, index) => `shandong-jianbing-${String(index + 18).padStart(3, '0')}`),
    ...Array.from({ length: 9 }, (_, index) => `fujian-fengwei-${String(index + 22).padStart(3, '0')}`),
    'shandong-jianbing-016', 'shandong-jianbing-017',
  ]);
  assert.deepEqual(new Set(historical.menu.items.filter(item => !historical.defaultCandidateIds.includes(item.id)).map(item => item.id)), excludedIds);
  assert.deepEqual(historical.menu.items.filter(item => ['shandong-jianbing-016', 'shandong-jianbing-017'].includes(item.id)).map(item => item.name),
    ['原味豆浆', '红枣豆浆']);
  assert.deepEqual(historical.menu.items.filter(item => excludedIds.has(item.id) && !['shandong-jianbing-016', 'shandong-jianbing-017'].includes(item.id)).map(item => item.name),
    ['辣条', '双汇肠', '里脊', '鸡柳', '培根', '肉松', '鸡排', '纯肉肠',
      '牛面筋', '牛肉丸', '炸蛋', '肉丝', '鸡杂', '牛百叶', '鲜切吊龙', '鲜卤牛腩', '鲜虾仁']);
  for (const item of menu.items) {
    assert.equal(excludedIds.has(item.id), false);
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
