// A source-ordered, process-local restaurant pool. No wx storage or account state.
const RESULT_TTL_MS = 2 * 60 * 60 * 1000;
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.keys(value).forEach(key => { freeze(value[key]); }); Object.freeze(value);
  }
  return value;
}
function createRestaurantRound(options = {}) {
  const now = options.now || Date.now;
  let pool = null, binding = '', projection = null, index = -1, revision = 0, invalidReason = '';
  function clear(reason = 'cleared') {
    pool = null; binding = ''; projection = null; index = -1; revision += 1;
    invalidReason = ['expired', 'conditions', 'background', 'cleared'].includes(reason) ? reason : 'cleared';
  }
  function current(key) {
    if (!pool) return false;
    if (key !== binding) { clear('conditions'); return false; }
    const age = now() - Date.parse(pool.generatedAt);
    if (!Number.isFinite(age) || age < -60000 || age >= RESULT_TTL_MS) { clear('expired'); return false; }
    return true;
  }
  function project() {
    // The complete candidate, source rank, timestamp and scoped token are kept
    // verbatim. Only the public-facing results array is reduced to one item.
    projection = Object.freeze({ ...pool, results: Object.freeze(index < 0 ? [] : [pool.results[index]]) });
    return projection;
  }
  function install(value, key) {
    if (!value || !Array.isArray(value.results) || value.results.length > 100 || typeof key !== 'string' || !key ||
      value.results.some(item => !item || typeof item.resultToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.resultToken)) ||
      new Set(value.results.map(item => item?.resultToken)).size !== value.results.length) {
      throw failure('INVALID_RESPONSE', '本轮餐厅数据无法使用，请重新收集。');
    }
    const age = now() - Date.parse(value.generatedAt);
    if (!Number.isFinite(age) || age < -60000 || age >= RESULT_TTL_MS) throw failure('RESULT_EXPIRED', '本轮餐厅已过期，请重新收集。');
    // The service validates the full response before installation. Take a
    // frozen copy so callers cannot rewrite a later candidate or its price.
    const accepted = freeze(JSON.parse(JSON.stringify(value)));
    clear(); pool = accepted; binding = key; index = pool.results.length ? 0 : -1; invalidReason = '';
    return project();
  }
  function next(key, expectedProjection) {
    if (!current(key)) throw failure('RESULT_EXPIRED', '本轮餐厅已失效，请重新收集。');
    if (expectedProjection !== projection) throw failure('CANCELLED', '当前餐厅已经变化。');
    if (index + 1 >= pool.results.length) throw failure('ROUND_EXHAUSTED', '本轮餐厅已全部看过，请主动重新收集。');
    index += 1; revision += 1;
    return project();
  }
  function snapshot(key) {
    current(key);
    const totalCount = pool?.results.length || 0;
    const seenCount = pool ? index + 1 : 0;
    return {
      revision, hasPool: Boolean(pool), response: projection, collection: pool?.pool || null,
      totalCount, seenCount, remainingCount: Math.max(0, totalCount - seenCount),
      exhausted: Boolean(pool) && totalCount > 0 && seenCount === totalCount,
      expiresAt: pool ? Date.parse(pool.generatedAt) + RESULT_TTL_MS : null, invalidReason,
    };
  }
  return { install, next, snapshot, clear };
}
module.exports = { createRestaurantRound, RESULT_TTL_MS };
