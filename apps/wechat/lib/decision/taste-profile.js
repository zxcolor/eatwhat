const SCHEMA_VERSION = 1;
const POLICY_VERSION = 'explicit-store-preferences-v1';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// These are explicit groupings of the catalog's store labels, not dish,
// ingredient, allergy or nutritional facts. No name-based inference is used.
const GROUPS = freeze([
  { id: 'hotpot', label: '火锅', description: '各种店铺类型的火锅', categories: [
    '川渝火锅', '炭火锅/铜锅', '潮汕牛肉火锅', '日韩火锅', '云南火锅', '打边炉/港式火锅',
    '串串香', '本地鸡窝火锅', '牛羊肉火锅', '海鲜火锅', '鱼火锅', '火锅鸡',
    '椰子鸡火锅', '螺蛳粉火锅', '自助火锅', '小火锅', '其他火锅',
  ] },
  { id: 'grill', label: '烧烤烤肉', description: '烤串、烤肉、烤鱼等店铺', categories: ['烤串', '烤鱼', '烤羊腿', '烤肉'] },
  { id: 'regional', label: '地方中餐', description: '各地中餐馆', categories: ['云贵菜', '东北菜', '西北菜', '江西菜', '京鲁菜', '徽菜', '豫菜'] },
  { id: 'southern', label: '江浙粤闽', description: '江浙、粤式、闽台及客家餐馆', categories: ['江浙菜', '粤菜/茶餐厅', '福建菜', '台湾/客家菜'] },
  { id: 'international', label: '西餐与亚洲料理', description: '西餐、东南亚及韩式餐馆', categories: ['西餐', '东南亚菜', '韩式料理'] },
  { id: 'buffet', label: '自助餐', description: '西餐、海鲜、烤肉及中日式自助', categories: ['西餐自助', '海鲜自助', '烤肉自助', '烤涮一体自助', '中式自助', '日式自助'] },
  { id: 'seafood', label: '海鲜河鲜', description: '海鲜、小龙虾及蟹类店铺', categories: ['小龙虾', '大闸蟹', '海鲜'] },
  { id: 'quick', label: '快餐简餐', description: '中式、日式、西式快餐及黄焖鸡店', categories: ['中式快餐', '日式简餐/快餐', '西式快餐', '黄焖鸡'] },
  { id: 'noodles', label: '粉面粥点', description: '米粉面馆、包子粥点', categories: ['米粉面馆', '包子粥点'] },
  { id: 'snacks', label: '小吃熟食', description: '炸物、小吃、卤味、麻辣烫及大排档', categories: ['炸鸡炸串', '特色小吃', '卤味鸭脖', '熟食熏酱', '麻辣烫', '大排档'] },
  { id: 'dessert', label: '甜品烘焙', description: '冰淇淋、面包蛋糕及甜品店', categories: ['冰淇淋', '面包蛋糕', '甜品'] },
  { id: 'drinks', label: '饮品咖啡', description: '奶茶果汁、咖啡及酸奶店', categories: ['奶茶果汁', '咖啡', '酸奶'] },
]);
const FIELDS = freeze(['likedGroups', 'avoidedGroups', 'budgetCents', 'maxSpicy', 'priority']);
const BUDGET_OPTIONS = freeze([
  { value: null, label: '不限预算' }, { value: 2000, label: '20 元内' },
  { value: 3000, label: '30 元内' }, { value: 4000, label: '40 元内' }, { value: 6000, label: '60 元内' },
]);
const SPICY_OPTIONS = freeze([
  { value: null, label: '辣度不限' }, { value: 0, label: '不辣' },
  { value: 1, label: '最多微辣' }, { value: 3, label: '辣一点也可以' },
]);
const PRIORITIES = freeze([
  { id: 'balanced', label: '均衡考虑', description: '综合喜欢的类型、价格与距离' },
  { id: 'taste', label: '喜欢最重要', description: '优先选择你喜欢的餐厅类型' },
  { id: 'price', label: '价格优先', description: '更在意少花一些钱' },
  { id: 'distance', label: '距离优先', description: '更在意离当前虚拟地点近一些' },
]);
const WEIGHTS = freeze({
  balanced: { taste: 4, price: 2, distance: 2, main: 1 },
  taste: { taste: 6, price: 1, distance: 1, main: 1 },
  price: { taste: 2, price: 6, distance: 1, main: 1 },
  distance: { taste: 2, price: 1, distance: 6, main: 1 },
});
const ids = new Set(GROUPS.map(group => group.id));

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_TASTE_PROFILE';
  throw error;
}
function object(value) {
  return value !== null && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]';
}
function groupList(value) {
  if (!Array.isArray(value) || [...value].some(id => typeof id !== 'string' || !ids.has(id))
    || new Set(value).size !== value.length) invalid('请选择有效的餐厅类型。');
  return [...value].sort();
}
function validateGroups(answers) {
  if (answers.likedGroups?.some(id => answers.avoidedGroups?.includes(id))) invalid('同一种类型不能同时喜欢和避开。');
  if (answers.avoidedGroups?.length === GROUPS.length) invalid('请至少保留一种可选的餐厅类型。');
  if (answers.priority === 'taste' && answers.likedGroups?.length === 0) invalid('喜欢优先需要至少选择一种喜欢的餐厅类型。');
}
function normalizeAnswers(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !FIELDS.includes(key))) invalid('偏好格式无效。');
  const answers = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (key === 'likedGroups' || key === 'avoidedGroups') answers[key] = groupList(value);
    else if (key === 'budgetCents') {
      if (!BUDGET_OPTIONS.some(option => option.value === value)) invalid('请选择有效的预算范围。');
      answers[key] = value;
    } else if (key === 'maxSpicy') {
      if (!SPICY_OPTIONS.some(option => option.value === value)) invalid('请选择有效的辣度范围。');
      answers[key] = value;
    } else {
      if (!PRIORITIES.some(option => option.id === value)) invalid('请选择决定时最在意的方面。');
      answers[key] = value;
    }
  }
  validateGroups(answers);
  return answers;
}
function missingFields(input) {
  const answers = normalizeAnswers(input);
  return FIELDS.filter(key => !Object.keys(answers).includes(key));
}
function compile(input) {
  const answers = normalizeAnswers(input);
  if (missingFields(answers).length) invalid('请先完成每一项偏好选择。');
  const selected = WEIGHTS[answers.priority];
  return {
    budgetCents: answers.budgetCents,
    maxSpicy: answers.maxSpicy,
    weights: { price: selected.price, distance: selected.distance, main: selected.main },
    taste: { version: SCHEMA_VERSION, likedGroups: [...answers.likedGroups], avoidedGroups: [...answers.avoidedGroups],
      weight: answers.likedGroups.length ? selected.taste : 0 },
  };
}
function normalizeTaste(input) {
  if (input === null) return null;
  if (!object(input) || Object.keys(input).sort().join(',') !== 'avoidedGroups,likedGroups,version,weight'
    || input.version !== SCHEMA_VERSION || typeof input.weight !== 'number'
    || !Number.isFinite(input.weight) || input.weight < 0 || input.weight > 1000000) invalid('偏好模型格式无效。');
  const result = { version: SCHEMA_VERSION, likedGroups: groupList(input.likedGroups),
    avoidedGroups: groupList(input.avoidedGroups), weight: input.weight };
  validateGroups(result);
  if ((result.likedGroups.length === 0) !== (result.weight === 0)) invalid('偏好权重与喜欢的类型不一致。');
  return result;
}

module.exports = { SCHEMA_VERSION, POLICY_VERSION, FIELDS, GROUPS, BUDGET_OPTIONS, SPICY_OPTIONS,
  PRIORITIES, normalizeAnswers, missingFields, compile, normalizeTaste };
