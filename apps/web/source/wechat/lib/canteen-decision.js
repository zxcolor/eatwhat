// The real canteen menu uses explicit product groupings and declared tastes.
// It does not use the virtual restaurant or research decision flow.
const copy = (value) => JSON.parse(JSON.stringify(value));
const menu = copy(require('../data/canteen-menu.js'));
const policy = copy(require('../data/canteen-policy.js'));
const tastePolicy = copy(require('../data/canteen-taste-policy.js'));
const dishAttributes = require('./canteen-attributes');
const tasteModel = require('./taste-model');
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
  if (Object.keys(filters).some(key => !['category', 'stallId', 'stapleType', 'hasSoup', 'temperature'].includes(key))) {
    invalid('CANTEEN_INVALID_FILTER', '请选择有效的档口、分类、主食、汤汁或温度条件');
  }
  const category = filters.category === undefined ? null : filters.category;
  if (category !== null && typeof category !== 'string') {
    invalid('CANTEEN_INVALID_FILTER', '请选择原始菜品分类');
  }
  const stallId = filters.stallId === undefined ? null : filters.stallId;
  if (stallId !== null && (typeof stallId !== 'string' || !stalls.has(stallId))) {
    invalid('CANTEEN_INVALID_FILTER', '请选择菜单中已有的档口');
  }
  const stapleType = filters.stapleType === undefined ? null : filters.stapleType;
  if (stapleType !== null && !Object.keys(dishAttributes.STAPLE_LABELS).includes(stapleType)) {
    invalid('CANTEEN_INVALID_FILTER', '请选择有效的主食类型');
  }
  const hasSoup = filters.hasSoup === undefined ? null : filters.hasSoup;
  if (hasSoup !== null && typeof hasSoup !== 'boolean') {
    invalid('CANTEEN_INVALID_FILTER', '请选择是否带汤');
  }
  const temperature = filters.temperature === undefined ? null : filters.temperature;
  if (temperature !== null && !Object.keys(dishAttributes.TEMPERATURE_LABELS).includes(temperature)) {
    invalid('CANTEEN_INVALID_FILTER', '请选择有效的温度类型');
  }
  // Keep the unrestricted snapshot compatible with existing callers.
  const normalized = { category };
  if (stallId !== null) normalized.stallId = stallId;
  if (stapleType !== null) normalized.stapleType = stapleType;
  if (hasSoup !== null) normalized.hasSoup = hasSoup;
  if (temperature !== null) normalized.temperature = temperature;
  return normalized;
}

function normalizeTastePreferences(preferences = {}) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    invalid('CANTEEN_INVALID_TASTE', '口味偏好格式不正确');
  }
  if (Object.keys(preferences).some(key => !['likedGroupIds', 'avoidedGroupIds', ...tasteModel.FIELDS].includes(key))) {
    invalid('CANTEEN_INVALID_TASTE', '食堂偏好格式不正确');
  }
  function groupIds(field) {
    const value = preferences[field] === undefined ? [] : preferences[field];
    if (!Array.isArray(value) || [...value].some(id => typeof id !== 'string' || !id)) {
      invalid('CANTEEN_INVALID_TASTE', '请选择有效的喜欢或避开类型');
    }
    return [...new Set(value)].sort();
  }
  const declared = {};
  for (const field of tasteModel.FIELDS) {
    if (Object.keys(preferences).includes(field)) declared[field] = preferences[field];
  }
  let answers;
  try { answers = tasteModel.normalizeAnswers(declared); }
  catch (_) { invalid('CANTEEN_INVALID_TASTE', '请选择有效的辣度和口味轻重'); }
  return { likedGroupIds: groupIds('likedGroupIds'), avoidedGroupIds: groupIds('avoidedGroupIds'), ...answers };
}

function tasteDistance(attributes, preferences) {
  if (!attributes || preferences.spicyLevel === undefined && preferences.flavorIntensity === undefined) return null;
  // Equal full-range weight for the two declared dimensions, using integers.
  // These are recipe-reference similarities, never verified taste guarantees.
  let distance = 0;
  if (preferences.spicyLevel !== undefined) distance += Math.abs(attributes.spicyLevel - preferences.spicyLevel) * 100;
  if (preferences.flavorIntensity !== undefined) {
    distance += Math.abs((attributes.flavor === 'LIGHT' ? 0 : 100) - preferences.flavorIntensity) * 6;
  }
  return distance;
}

function getCategories() {
  return [...new Set(menu.items.filter(item => defaultIds.has(item.id)).map(item => item.category)
    .filter(category => typeof category === 'string' && category.length > 0))];
}

function getStalls() {
  return menu.stalls.map(stall => ({ id: stall.id, name: stall.name }));
}

function getCandidates(filters = {}, tastePreferences = {}) {
  const { category, stallId = null, stapleType = null, hasSoup = null, temperature = null } = normalizeFilters(filters);
  const preferences = normalizeTastePreferences(tastePreferences);
  const liked = new Set(preferences.likedGroupIds);
  const avoided = new Set(preferences.avoidedGroupIds);
  const tasteSummary = { ...preferences, preferredTotal: 0, neutralTotal: 0, avoidedCount: 0 };
  const candidates = [];
  for (const item of menu.items) {
    if (stallId !== null && item.stallId !== stallId) continue;
    if (!defaultIds.has(item.id) || (category !== null && item.category !== category)) continue;
    const attributes = dishAttributes.getAttributes(item.id);
    // Missing references cannot establish an explicit hard-condition match.
    if (stapleType !== null && attributes?.stapleType !== stapleType ||
      hasSoup !== null && attributes?.hasSoup !== hasSoup ||
      temperature !== null && attributes?.temperature !== temperature) continue;
    // Preserve explicit legacy group exclusions without deriving new groups
    // from researched flavor or spiciness references.
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
    candidates.push({ item, stall, variants, tasteGroupId, isPreferred, attributes,
      tasteDistance: tasteDistance(attributes, preferences) });
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

  function eligibleCandidates() {
    const remaining = pool.candidates.filter(candidate => !seen.has(candidate.item.id));
    if (!remaining.length) return [];
    let diverse = remaining;
    if (current) {
      const stapleType = current.attributes?.stapleType;
      const differentStaple = stapleType ? remaining.filter(candidate =>
        candidate.attributes && candidate.attributes.stapleType !== stapleType) : [];
      if (differentStaple.length) diverse = differentStaple;
      else {
        const category = current.item.category;
        const differentCategory = remaining.filter(candidate => candidate.item.category !== category);
        if (differentCategory.length) diverse = differentCategory;
      }
    }
    // Taste and liked groups affect local sampling weight, never eligibility.
    // MiMo receives this same broad pool after hard filters and diversity.
    return diverse;
  }

  function getRequestExcludedIds() {
    const eligible = new Set(eligibleCandidates().map(candidate => candidate.item.id));
    // The server uses the full default menu. Exclude every ID outside this
    // exact round pool, including hard filters, seen IDs and diversity choices.
    return [...defaultIds].filter(id => !eligible.has(id));
  }

  function next() {
    if (pool.candidates.length === 0) {
      status = 'empty';
      return snapshot();
    }
    const eligible = eligibleCandidates();
    if (eligible.length === 0) {
      status = 'exhausted';
      return snapshot();
    }
    const value = random();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      invalid('CANTEEN_INVALID_RANDOM', '抽取函数必须返回 0（含）到 1（不含）的数值');
    }
    // Bounded weights [1, 3] keep every eligible dish reachable. Taste is a
    // gentle preference, not a minimum-distance gate; price and variant count
    // never affect the weight. Without taste or liked groups this is uniform.
    const weights = eligible.map(candidate => {
      const tasteWeight = candidate.tasteDistance === null ? 1
        : 2 - Math.min(candidate.tasteDistance, 1200) / 1200;
      return tasteWeight * (candidate.isPreferred ? 1.5 : 1);
    });
    let threshold = value * weights.reduce((total, weight) => total + weight, 0);
    let index = 0;
    while (index < eligible.length - 1 && threshold >= weights[index]) {
      threshold -= weights[index];
      index += 1;
    }
    current = eligible[index];
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
    const candidate = eligibleCandidates().find(entry => entry.item.id === id);
    if (!candidate) invalid('CANTEEN_INVALID_SELECTION', '返回的菜品不属于本轮可选候选');
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

  return { configure, next, restart, choose, getRequestExcludedIds, selectVariant, snapshot, confirmation };
}

module.exports = { getCategories, getStalls, getCandidates, createRound };
