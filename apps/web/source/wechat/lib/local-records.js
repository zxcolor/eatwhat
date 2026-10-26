// Android DecisionHistoryStore parity: the schema cannot hold a location or POI.
const KEY = 'eatwhat.wechat.decision-history.v1';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 30;
const FIELDS = ['recordedAtEpochMillis', 'mealPeriod', 'decisionMode', 'budgetMaxYuan', 'availableMinutes', 'travelMode', 'resultCount'];

function valid(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry) &&
    Object.keys(entry).length === FIELDS.length && Object.keys(entry).every(key => FIELDS.includes(key)) &&
    Number.isSafeInteger(entry.recordedAtEpochMillis) && entry.recordedAtEpochMillis > 0 &&
    ['BREAKFAST', 'LUNCH', 'DINNER'].includes(entry.mealPeriod) && ['QUICK', 'GUIDED'].includes(entry.decisionMode) &&
    (entry.budgetMaxYuan === null || Number.isInteger(entry.budgetMaxYuan) && entry.budgetMaxYuan >= 1 && entry.budgetMaxYuan <= 2000) &&
    Number.isInteger(entry.availableMinutes) && entry.availableMinutes >= 15 && entry.availableMinutes <= 240 &&
    ['WALK', 'BIKE', 'TRANSIT'].includes(entry.travelMode) && Number.isInteger(entry.resultCount) && entry.resultCount >= 0 && entry.resultCount <= 3;
}
function createLocalRecords(options = {}) {
  const storage = () => options.storage || wx;
  const now = options.now || Date.now;
  const accepted = options.hasConsent || (() => require('./service').state.consent);
  function clear() {
    try { storage().removeStorageSync(KEY); }
    catch (_) { throw new Error('本机记录清除失败，请重试。'); }
  }
  function list() {
    try {
      if (!accepted()) { clear(); return []; }
      const raw = storage().getStorageSync(KEY);
      if (!raw) return [];
      let payload;
      try { payload = JSON.parse(raw); } catch (_) { clear(); return []; }
      if (payload?.schemaVersion !== 1 || Object.keys(payload).length !== 2 || !Array.isArray(payload.entries)) { clear(); return []; }
      const time = now();
      const entries = payload.entries.filter(entry => valid(entry) && entry.recordedAtEpochMillis >= time - RETENTION_MS && entry.recordedAtEpochMillis <= time)
        .sort((a, b) => b.recordedAtEpochMillis - a.recordedAtEpochMillis).slice(0, MAX_ENTRIES);
      if (!entries.length) clear();
      else {
        const normalized = JSON.stringify({ schemaVersion: 1, entries });
        if (normalized !== raw) storage().setStorageSync(KEY, normalized);
      }
      return entries;
    } catch (_) { throw new Error('本机记录暂时无法读取，请重试。'); }
  }
  function recordDecision(input, resultCount) {
    if (!accepted()) return false;
    const entry = {
      recordedAtEpochMillis: now(), mealPeriod: input?.mealPeriod, decisionMode: input?.decisionMode,
      budgetMaxYuan: input?.budgetMaxYuan ?? null, availableMinutes: input?.availableMinutes,
      travelMode: input?.travelMode, resultCount: Math.max(0, resultCount),
    };
    if (!valid(entry)) throw new Error('本次决策摘要无效。');
    const entries = [entry, ...list()].sort((a, b) => b.recordedAtEpochMillis - a.recordedAtEpochMillis).slice(0, MAX_ENTRIES);
    try { storage().setStorageSync(KEY, JSON.stringify({ schemaVersion: 1, entries })); }
    catch (_) { throw new Error('推荐完成，但最近决策暂未保存到本机。'); }
    return true;
  }
  return { list, prune: list, recordDecision, clear };
}
module.exports = { ...createLocalRecords(), createLocalRecords, KEY, MAX_ENTRIES, RETENTION_MS };
