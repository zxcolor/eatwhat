const menu = require('../data/canteen-menu');
const policy = require('../data/canteen-policy');
const KEY = 'eatwhat.wechat.canteen-mimo-consent.v1';
const CONSENT_VERSION = 'canteen-mimo-v1';
const ROUTE = 'https://api.eatwhat.pro/v1/canteen/decisions';
const HEADER = 'X-ChiShenMe-Contract-Version';
const MODES = ['mimo-v2.6-flash', 'mimo-v2.6-pro'];
const REASONS = ['DISABLED', 'UNAVAILABLE', 'CAPACITY', 'INVALID_MODEL_RESULT', 'SINGLE_CANDIDATE', 'NO_CANDIDATES'];
const ids = new Set(policy.items.filter(item => item.defaultCandidate).map(item => item.itemId));
const pending = new Set();
let epoch = 0;
let sequence = 0;
let blocked = false;
function cancelled() { const error = new Error('本次决定已取消。'); error.code = 'CANCELLED'; return error; }
function preference() {
  if (blocked) return 'disabled';
  try {
    const value = wx.getStorageSync(KEY);
    if (value?.version !== CONSENT_VERSION || typeof value.enabled !== 'boolean') return 'ask';
    return value.enabled ? 'enabled' : 'disabled';
  } catch (_) { return 'disabled'; }
}
function cancel() {
  epoch += 1;
  for (const entry of [...pending]) { entry.finish(cancelled()); try { entry.task?.abort(); } catch (_) { /* Already completed. */ } }
}
function remember(enabled) {
  const value = { version: CONSENT_VERSION, enabled };
  wx.setStorageSync(KEY, value);
  const saved = wx.getStorageSync(KEY);
  if (saved?.version !== value.version || saved.enabled !== enabled) throw new Error('MiMo设置未保存，请重试。');
}
function disable() {
  blocked = true;
  cancel();
  try { remember(false); }
  catch (_) { throw new Error('MiMo已停止使用，但关闭设置未保存，请重试。'); }
}
function withdraw() {
  blocked = true;
  cancel();
  let persisted = false;
  try { remember(false); persisted = true; } catch (_) { /* Removing it is an independent fallback. */ }
  try { wx.removeStorageSync(KEY); if (!wx.getStorageSync(KEY)) persisted = true; } catch (_) { /* A false record still stops use. */ }
  if (!persisted) throw new Error('MiMo设置清理失败，已停止使用，请重试。');
}
async function requestConsent(isCurrent = () => true, force = false) {
  const current = preference();
  if (!force && current !== 'ask') return current === 'enabled';
  const started = epoch;
  const accepted = await new Promise((resolve) => {
    wx.showModal({ title: '开启MiMo食堂决策',
      content: '开启后，会把你选择的辣度、口味轻重和本轮已展示的菜品编号发送到吃什么服务器，由小米MiMo根据菜单提出建议。不发送账号或定位。可随时在设置中关闭；取消则继续在本机决定。',
      confirmText: '同意开启', cancelText: '本机决定',
      success: result => resolve(result.confirm === true), fail: () => resolve(false) });
  });
  if (!isCurrent() || started !== epoch) throw cancelled();
  remember(accepted);
  blocked = false;
  return accepted;
}
function exact(object, fields) {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: WeChat does not require ES2022 Object.hasOwn.
  const has = (key) => Object.prototype.hasOwnProperty.call(object, key);
  return object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === fields.length && fields.every(has);
}
function validResponse(value, request) {
  if (!exact(value, ['requestId', 'menuVersion', 'preferenceRevision', 'status', 'selectedItemId', 'source', 'model', 'fallbackReason', 'notice']) ||
    value.requestId !== request.requestId || value.menuVersion !== request.menuVersion || value.preferenceRevision !== request.preferenceRevision ||
    value.notice !== 'TASTE_ATTRIBUTES_UNVERIFIED') return false;
  const remaining = [...ids].filter(id => !request.excludedItemIds.includes(id));
  if (value.status === 'SELECTED' ? !remaining.includes(value.selectedItemId) : value.status !== 'EXHAUSTED' || remaining.length || value.selectedItemId !== null) return false;
  if (value.status === 'EXHAUSTED' ? value.source !== 'LOCAL' || value.fallbackReason !== 'NO_CANDIDATES' : value.fallbackReason === 'NO_CANDIDATES') return false;
  return value.source === 'MIMO' ? value.status === 'SELECTED' && MODES.includes(value.model) && value.fallbackReason === null
    : value.source === 'LOCAL' && value.model === null && REASONS.includes(value.fallbackReason);
}
function send(request, isCurrent) {
  const started = epoch;
  return new Promise((resolve, reject) => {
    const entry = { task: null, settled: false, finish: null };
    entry.finish = (error, value) => {
      if (entry.settled) return;
      entry.settled = true;
      pending.delete(entry);
      if (error) reject(error); else resolve(value);
    };
    pending.add(entry);
    try {
      entry.task = wx.request({ url: ROUTE, method: 'POST', data: request,
        header: { [HEADER]: '1', 'Content-Type': 'application/json' },
        timeout: 12000, dataType: 'json', responseType: 'text', enableCache: false,
        success: response => {
          if (entry.settled) return;
          if (!isCurrent() || started !== epoch || preference() !== 'enabled') return entry.finish(cancelled());
          const versions = Object.keys(response.header || {}).filter(key => key.toLowerCase() === HEADER.toLowerCase());
          if (response.statusCode !== 200 || versions.length !== 1 || String(response.header[versions[0]]) !== '1' || !validResponse(response.data, request)) {
            return entry.finish(new Error('MiMo服务暂不可用。'));
          }
          entry.finish(null, response.data);
        },
        fail: () => entry.finish(!isCurrent() || started !== epoch ? cancelled() : new Error('MiMo连接未完成。')),
      });
    } catch (_) { entry.finish(new Error('MiMo连接未完成。')); }
  });
}
async function choose({ preferences, excludedItemIds, preferenceRevision, isCurrent, onRequest }) {
  if (!await requestConsent(isCurrent)) return null;
  if (!isCurrent()) throw cancelled();
  if (onRequest) onRequest();
  const request = { requestId: `canteen-${Date.now()}-${++sequence}`, menuVersion: menu.version,
    preferenceRevision, consentVersion: CONSENT_VERSION,
    preferences: { spicyLevel: preferences.spicyLevel, flavorIntensity: preferences.flavorIntensity },
    excludedItemIds: [...excludedItemIds] };
  return send(request, isCurrent);
}

// Export only local consent controls and the fixed public API flow, never a key.
module.exports = { preference, requestConsent, choose, cancel, disable, withdraw, KEY, CONSENT_VERSION };
