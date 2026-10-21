// The real canteen menu has its own equal-probability policy. It does not use
// the virtual restaurant or research decision flow.
const copy = (value) => JSON.parse(JSON.stringify(value));
const menu = copy(require('../data/canteen-menu.js'));
const policy = copy(require('../data/canteen-policy.js'));
const defaultIds = new Set(policy.items.filter(rule => rule.defaultCandidate === true).map(rule => rule.itemId));
const stalls = new Map(menu.stalls.map(stall => [stall.id, stall]));

function invalid(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    invalid('CANTEEN_INVALID_FILTER', '筛选条件格式不正确');
  }
  const budgetMaxFen = filters.budgetMaxFen === undefined ? null : filters.budgetMaxFen;
  const category = filters.category === undefined ? null : filters.category;
  if (budgetMaxFen !== null && (!Number.isSafeInteger(budgetMaxFen) || budgetMaxFen < 0)) {
    invalid('CANTEEN_INVALID_FILTER', '预算必须为非负整数分或不限预算');
  }
  if (category !== null && typeof category !== 'string') {
    invalid('CANTEEN_INVALID_FILTER', '请选择原始菜品分类');
  }
  return { budgetMaxFen, category };
}

function getCategories() {
  return [...new Set(menu.items.filter(item => defaultIds.has(item.id)).map(item => item.category))];
}

function getCandidates(filters = {}) {
  const { budgetMaxFen, category } = normalizeFilters(filters);
  let weightedExcludedCount = 0;
  const candidates = [];
  for (const item of menu.items) {
    if (!defaultIds.has(item.id) || (category !== null && item.category !== category)) continue;
    const price = item.price;
    let variants = [];
    if (price.kind === 'weight') {
      // Without selected weights, neither the reference average nor the rates
      // establish a total that can be guaranteed below a strict budget.
      if (budgetMaxFen !== null) {
        weightedExcludedCount += 1;
        continue;
      }
    } else if (price.kind === 'variants') {
      variants = price.variants.filter(variant => budgetMaxFen === null || variant.amountFen <= budgetMaxFen);
      if (variants.length === 0) continue;
    } else if (price.kind === 'fixed') {
      if (budgetMaxFen !== null && price.amountFen > budgetMaxFen) continue;
    } else {
      invalid('CANTEEN_INVALID_MENU', '餐品计价信息不完整');
    }
    const stall = stalls.get(item.stallId);
    if (!stall) invalid('CANTEEN_INVALID_MENU', '餐品所属档口不存在');
    candidates.push({ item, stall, variants });
  }
  return copy({ candidates, weightedExcludedCount });
}

function createRound({ random = Math.random } = {}) {
  if (typeof random !== 'function') invalid('CANTEEN_INVALID_RANDOM', '抽取函数不可用');
  let filters = normalizeFilters();
  let pool = getCandidates(filters);
  let seen = new Set();
  let current = null;
  let selectedVariantId = null;
  let status = 'idle';

  function snapshot() {
    return copy({
      filters,
      totalCount: pool.candidates.length,
      seenCount: seen.size,
      remainingCount: pool.candidates.length - seen.size,
      current,
      selectedVariantId,
      status,
      weightedExcludedCount: pool.weightedExcludedCount,
    });
  }

  function restart() {
    seen = new Set();
    current = null;
    selectedVariantId = null;
    status = pool.candidates.length === 0 ? 'empty' : 'idle';
    return snapshot();
  }

  function configure(nextFilters = {}) {
    // Validate and build before changing state: a malformed filter cannot
    // partially replace a valid round or silently remove its restrictions.
    const normalized = normalizeFilters(nextFilters);
    const nextPool = getCandidates(normalized);
    filters = normalized;
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
    const value = random();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      invalid('CANTEEN_INVALID_RANDOM', '抽取函数必须返回 0（含）到 1（不含）的数值');
    }
    // One slot per dish, regardless of stall size or number of price variants.
    current = remaining[Math.floor(value * remaining.length)];
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

  function confirmation() {
    if (!current) invalid('CANTEEN_NO_SELECTION', '请先决定一道餐品');
    const candidate = getCandidates(filters).candidates.find(entry => entry.item.id === current.item.id && entry.stall.id === current.stall.id);
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

  return { configure, next, restart, selectVariant, snapshot, confirmation };
}

module.exports = { getCategories, getCandidates, createRound };
