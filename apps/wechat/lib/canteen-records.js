// Canteen choices are local-only and require their own explicit opt-in.
// They never share the nearby-restaurant history schema or account APIs.
const menu = require('../data/canteen-menu');
const policy = require('../data/canteen-policy');

const KEY = 'eatwhat.wechat.canteen-history.v1';
const ENABLED_KEY = 'eatwhat.wechat.canteen-history.enabled.v1';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 30;
const CHOICE_FIELDS = ['menuVersion', 'itemId', 'stallId', 'variantId', 'variantName', 'priceKind', 'amountFen', 'unit', 'priceText'];
const ENTRY_FIELDS = ['recordedAtEpochMillis', ...CHOICE_FIELDS];
const items = new Map(menu.items.map(item => [item.id, item]));
const candidates = new Set(policy.items.filter(item => item.defaultCandidate === true).map(item => item.itemId));
// biome-ignore lint/suspicious/noPrototypeBuiltins: Keep validation working in WeChat runtimes without ES2022 Object.hasOwn.
const hasOwn = (value, field) => Object.prototype.hasOwnProperty.call(value, field);

function exact(value, fields) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => hasOwn(value, field));
}

function validChoice(value, recorded = false) {
  if (!exact(value, recorded ? ENTRY_FIELDS : CHOICE_FIELDS) || value.menuVersion !== menu.version) return false;
  if (recorded && (!Number.isSafeInteger(value.recordedAtEpochMillis) || value.recordedAtEpochMillis <= 0)) return false;
  const item = items.get(value.itemId);
  if (!item || !candidates.has(item.id) || value.stallId !== item.stallId || value.priceKind !== item.price.kind) return false;
  if (item.price.kind === 'weight') {
    return value.variantId === null && value.variantName === null && value.amountFen === null && value.unit === null && value.priceText === item.originalPriceText;
  }
  if (!Number.isSafeInteger(value.amountFen) || value.amountFen < 0) return false;
  if (item.price.kind === 'fixed') {
    return value.variantId === null && value.variantName === null && value.amountFen === item.price.amountFen &&
      value.unit === item.price.unit && value.priceText === item.originalPriceText;
  }
  if (item.price.kind !== 'variants') return false;
  const variant = item.price.variants.find(option => option.id === value.variantId);
  return !!variant && value.variantName === variant.name && value.amountFen === variant.amountFen &&
    value.unit === variant.unit && value.priceText === variant.originalPriceText;
}

function createCanteenRecords(options = {}) {
  const storage = () => options.storage || wx;
  const now = options.now || Date.now;
  let disabledInMemory = false;
  // Keep cleanup actionable across page recreation within this process.
  let cleanupError = '';

  function isEnabled() {
    if (disabledInMemory) return false;
    try { return storage().getStorageSync(ENABLED_KEY) === true; }
    catch (_) { throw new Error('食堂记录设置暂时无法读取，请重试。'); }
  }

  function clear() {
    try { storage().removeStorageSync(KEY); }
    catch (_) { throw new Error('食堂选择记录清除失败，请重试。'); }
  }

  function disable(removeSetting) {
    // Stop further writes before attempting any storage operations.
    disabledInMemory = true;
    const failures = [];
    let persistedDisabled = false;
    try { storage().setStorageSync(ENABLED_KEY, false); persistedDisabled = true; }
    catch (_) { /* Removing the key below is an independent fallback. */ }
    if (removeSetting || !persistedDisabled) {
      try { storage().removeStorageSync(ENABLED_KEY); persistedDisabled = true; }
      catch (_) {
        failures.push(removeSetting ? '食堂记录启用设置清除失败，请重试。' : '食堂记录关闭设置保存失败，请重试。');
      }
    }
    try { clear(); } catch (error) { failures.push(error.message); }
    if (!persistedDisabled) failures.push('食堂记录关闭状态未能保存，清理成功前请不要关闭小程序。');
    cleanupError = failures.join('；');
    if (cleanupError) throw new Error(cleanupError);
    return false;
  }

  function setEnabled(value) {
    if (typeof value !== 'boolean') throw new Error('食堂记录设置无效。');
    if (!value) return disable(false);
    // An old record left by failed cleanup must not reappear after opting in again.
    if (!isEnabled()) clear();
    try { storage().setStorageSync(ENABLED_KEY, true); }
    catch (_) { throw new Error('食堂记录启用设置保存失败，请重试。'); }
    disabledInMemory = false;
    cleanupError = '';
    return true;
  }

  function list() {
    try {
      if (!isEnabled()) { clear(); return []; }
      const raw = storage().getStorageSync(KEY);
      if (raw === undefined || raw === null || raw === '') return [];
      let payload;
      try { payload = JSON.parse(raw); } catch (_) { clear(); return []; }
      if (!exact(payload, ['schemaVersion', 'entries']) || payload.schemaVersion !== 1 || !Array.isArray(payload.entries)) { clear(); return []; }
      const time = now();
      if (!Number.isSafeInteger(time) || time <= 0) throw new Error('Invalid clock');
      const entries = payload.entries.filter(entry => validChoice(entry, true) && entry.recordedAtEpochMillis >= time - RETENTION_MS && entry.recordedAtEpochMillis <= time)
        .sort((a, b) => b.recordedAtEpochMillis - a.recordedAtEpochMillis).slice(0, MAX_ENTRIES);
      if (!entries.length) clear();
      else {
        const normalized = JSON.stringify({ schemaVersion: 1, entries });
        if (normalized !== raw) storage().setStorageSync(KEY, normalized);
      }
      return entries;
    } catch (_) { throw new Error('食堂选择记录暂时无法读取或清理，请重试。'); }
  }

  function recordChoice(payload) {
    if (!isEnabled()) return false;
    if (!validChoice(payload)) throw new Error('本次食堂选择与菜单不一致，暂未保存。');
    const recordedAtEpochMillis = now();
    if (!Number.isSafeInteger(recordedAtEpochMillis) || recordedAtEpochMillis <= 0) throw new Error('食堂记录时间无效，请重试。');
    const entry = { recordedAtEpochMillis };
    CHOICE_FIELDS.forEach(field => { entry[field] = payload[field]; });
    const entries = [entry, ...list()].sort((a, b) => b.recordedAtEpochMillis - a.recordedAtEpochMillis).slice(0, MAX_ENTRIES);
    try { storage().setStorageSync(KEY, JSON.stringify({ schemaVersion: 1, entries })); }
    catch (_) { throw new Error('已确认选择，但食堂记录暂未保存到本机。'); }
    return true;
  }

  return { isEnabled, setEnabled, list, prune: list, recordChoice, clear, withdraw: () => disable(true), getCleanupError: () => cleanupError };
}

module.exports = { ...createCanteenRecords(), createCanteenRecords, KEY, ENABLED_KEY, RETENTION_MS, MAX_ENTRIES };
