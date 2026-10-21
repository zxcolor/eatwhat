// The real canteen menu uses explicit product groupings and declared tastes.
// It does not use the virtual restaurant or research decision flow.
const copy = (value) => JSON.parse(JSON.stringify(value));
const menu = copy(require('../data/canteen-menu.js'));
const policy = copy(require('../data/canteen-policy.js'));
const tastePolicy = copy(require('../data/canteen-taste-policy.js'));
const defaultIds = new Set(policy.items.filter(rule => rule.defaultCandidate === true).map(rule => rule.itemId));
const stalls = new Map(menu.stalls.map(stall => [stall.id, stall]));
const tasteGroups = new Map(tastePolicy.items.map(rule => [rule.itemId, rule.groupId]));

function invalid(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    invalid('CANTEEN_INVALID_FILTER', '筛选条件格式不正确');
  }
  if (Object.keys(filters).some(key => key !== 'category')) {
    invalid('CANTEEN_INVALID_FILTER', '筛选条件仅支持原始菜品分类');
  }
  const category = filters.category === undefined ? null : filters.category;
  if (category !== null && typeof category !== 'string') {
    invalid('CANTEEN_INVALID_FILTER', '请选择原始菜品分类');
  }
  return { category };
}

function normalizeTastePreferences(preferences = {}) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    invalid('CANTEEN_INVALID_TASTE', '口味偏好格式不正确');
  }
  if (Object.keys(preferences).some(key => key !== 'likedGroupIds' && key !== 'avoidedGroupIds')) {
    invalid('CANTEEN_INVALID_TASTE', '食堂偏好仅接受喜欢或避开的类型');
  }
  function groupIds(field) {
    const value = preferences[field] === undefined ? [] : preferences[field];
    if (!Array.isArray(value) || [...value].some(id => typeof id !== 'string' || !id)) {
      invalid('CANTEEN_INVALID_TASTE', '请选择有效的喜欢或避开类型');
    }
    return [...new Set(value)].sort();
  }
  return { likedGroupIds: groupIds('likedGroupIds'), avoidedGroupIds: groupIds('avoidedGroupIds') };
}

function getCategories() {
  return [...new Set(menu.items.filter(item => defaultIds.has(item.id)).map(item => item.category)
    .filter(category => typeof category === 'string' && category.length > 0))];
}

function getCandidates(filters = {}, tastePreferences = {}) {
  const { category } = normalizeFilters(filters);
  const preferences = normalizeTastePreferences(tastePreferences);
  const liked = new Set(preferences.likedGroupIds);
  const avoided = new Set(preferences.avoidedGroupIds);
  const tasteSummary = { ...preferences, preferredTotal: 0, neutralTotal: 0, avoidedCount: 0 };
  const candidates = [];
  for (const item of menu.items) {
    if (!defaultIds.has(item.id) || (category !== null && item.category !== category)) continue;
    // Missing or explicitly unknown mappings remain neutral. No dish-name,
    // ingredient or spiciness inference supplements the declared grouping.
    const tasteGroupId = tasteGroups.get(item.id) ?? null;
    if (tasteGroupId !== null && avoided.has(tasteGroupId)) {
      tasteSummary.avoidedCount += 1;
      continue;
    }
    const isPreferred = tasteGroupId !== null && liked.has(tasteGroupId);
    if (isPreferred) tasteSummary.preferredTotal += 1;
    else tasteSummary.neutralTotal += 1;
    const price = item.price;
    let variants = [];
    if (price.kind === 'variants') {
      variants = price.variants;
    } else if (price.kind !== 'fixed' && price.kind !== 'weight') {
      invalid('CANTEEN_INVALID_MENU', '餐品计价信息不完整');
    }
    const stall = stalls.get(item.stallId);
    if (!stall) invalid('CANTEEN_INVALID_MENU', '餐品所属档口不存在');
    candidates.push({ item, stall, variants, tasteGroupId, isPreferred });
  }
  return copy({ candidates, tasteSummary });
}

function createRound({ random = Math.random, tastePreferences = {} } = {}) {
  if (typeof random !== 'function') invalid('CANTEEN_INVALID_RANDOM', '抽取函数不可用');
  let filters = normalizeFilters();
  let preferences = normalizeTastePreferences(tastePreferences);
  let pool = getCandidates(filters, preferences);
  let seen = new Set();
  let current = null;
  let selectedVariantId = null;
  let status = 'idle';

  function snapshot() {
    return copy({
      filters,
      totalCount: pool.candidates.length,
      seenCount: seen.size,
      seenIds: [...seen],
      remainingCount: pool.candidates.length - seen.size,
      current,
      selectedVariantId,
      status,
      tasteSummary: pool.tasteSummary,
    });
  }

  function restart() {
    seen = new Set();
    current = null;
    selectedVariantId = null;
    status = pool.candidates.length === 0 ? 'empty' : 'idle';
    return snapshot();
  }

  function configure(nextFilters = {}, nextTastePreferences = preferences) {
    // Validate and build before changing state: a malformed filter cannot
    // partially replace a valid round or silently remove its restrictions.
    const normalized = normalizeFilters(nextFilters);
    const normalizedPreferences = normalizeTastePreferences(nextTastePreferences);
    const nextPool = getCandidates(normalized, normalizedPreferences);
    filters = normalized;
    preferences = normalizedPreferences;
    pool = nextPool;
    return restart();
  }

  function next() {
    if (pool.candidates.length === 0) {
      status = 'empty';
      return snapshot();
    }
    const remaining = pool.candidates.filter(candidate => !seen.has(candidate.item.id));
    if (remaining.length === 0) {
      status = 'exhausted';
      return snapshot();
    }
    const preferred = remaining.filter(candidate => candidate.isPreferred);
    const eligible = preferred.length ? preferred : remaining;
    const value = random();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      invalid('CANTEEN_INVALID_RANDOM', '抽取函数必须返回 0（含）到 1（不含）的数值');
    }
    // Consume the preferred tier first, then the neutral tier. Within each
    // tier every unseen dish has one slot, regardless of stall or variant count.
    current = eligible[Math.floor(value * eligible.length)];
    seen.add(current.item.id);
    selectedVariantId = null;
    status = 'ready';
    return snapshot();
  }

  function selectVariant(id) {
    if (current?.item.price.kind !== 'variants' || !current.variants.some(variant => variant.id === id)) {
      invalid('CANTEEN_INVALID_VARIANT', '请选择当前菜品符合条件的规格');
    }
    selectedVariantId = id;
    return snapshot();
  }

  function choose(id) {
    const candidate = pool.candidates.find(entry => entry.item.id === id && !seen.has(id));
    if (!candidate) invalid('CANTEEN_INVALID_SELECTION', '返回的菜品不属于本轮剩余候选');
    current = candidate;
    seen.add(id);
    selectedVariantId = null;
    status = 'ready';
    return snapshot();
  }

  function confirmation() {
    if (!current) invalid('CANTEEN_NO_SELECTION', '请先决定一道餐品');
    const candidate = getCandidates(filters, preferences).candidates.find(entry => entry.item.id === current.item.id && entry.stall.id === current.stall.id);
    if (!candidate) invalid('CANTEEN_NO_SELECTION', '当前餐品不再符合筛选条件，请重新决定');
    const { item } = candidate;
    const price = item.price;
    let variant = null;
    if (price.kind === 'variants') {
      variant = candidate.variants.find(entry => entry.id === selectedVariantId);
      if (!variant) invalid('CANTEEN_INVALID_VARIANT', '请先选择符合条件的规格');
    }
    return {
      menuVersion: menu.version,
      itemId: item.id,
      stallId: item.stallId,
      variantId: variant ? variant.id : null,
      variantName: variant ? variant.name : null,
      priceKind: price.kind,
      amountFen: variant ? variant.amountFen : price.kind === 'fixed' ? price.amountFen : null,
      unit: variant ? variant.unit : price.kind === 'fixed' ? price.unit : null,
      priceText: variant ? variant.originalPriceText : item.originalPriceText,
    };
  }

  return { configure, next, restart, choose, selectVariant, snapshot, confirmation };
}

module.exports = { getCategories, getCandidates, createRound };
