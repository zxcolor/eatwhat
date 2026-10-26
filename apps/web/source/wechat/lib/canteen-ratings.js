// Public canteen ratings are server-owned. No score, identity or credential is
// persisted here; authenticated requests remain owned by the account client.
const service = require('./service');
const account = require('./account');
const menu = require('../data/canteen-menu');
const policy = require('../data/canteen-policy');
const ROUTE = '/v1/canteen/ratings';
const FIELDS = ['menuVersion', 'itemId', 'stallId', 'averageScore', 'ratingCount', 'myScore'];
const items = new Map(menu.items.map(item => [item.id, item]));
const stalls = new Set(menu.stalls.map(stall => stall.id));
const candidateIds = new Set(policy.items.filter(item => item.defaultCandidate === true).map(item => item.itemId));
const pending = new Set();
const reads = new Map();
const mutations = new Map();
let generation = 0;

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function cancelled() { return failure('CANCELLED', '本次评分操作已取消，请重新读取。'); }
function score(value) { return Number.isInteger(value) && value >= 1 && value <= 5; }
function exact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const names = Object.keys(value);
  return names.length === FIELDS.length && FIELDS.every(field => names.includes(field));
}
function scope() {
  const auth = account.view();
  return Object.freeze({ generation, epoch: service.state.epoch,
    authenticationRevision: auth.authenticationRevision,
    signedIn: auth.signedIn === true, consent: service.state.consent === true });
}
function isCurrent(expected) {
  if (!expected) return false;
  try {
    const current = scope();
    return current.consent && current.generation === expected.generation && current.epoch === expected.epoch &&
      current.authenticationRevision === expected.authenticationRevision && current.signedIn === expected.signedIn;
  } catch (_) { return false; }
}
function cancel() {
  generation += 1;
  for (const entry of [...pending]) entry.cancel();
}
function selectedItem(itemId) {
  const item = typeof itemId === 'string' && /^[a-z][a-z0-9-]{1,79}$/.test(itemId) ? items.get(itemId) : null;
  if (!item || !candidateIds.has(itemId) || !stalls.has(item.stallId)) {
    throw failure('INVALID_ITEM', '该菜品不属于当前食堂菜单，请重新选择。');
  }
  return item;
}
function validated(value, item, context, method, requestedScore) {
  const valid = exact(value) && value.menuVersion === menu.version && value.itemId === item.id && value.stallId === item.stallId &&
    Number.isSafeInteger(value.ratingCount) && value.ratingCount >= 0 &&
    (value.myScore === null || score(value.myScore)) &&
    (value.ratingCount === 0 ? value.averageScore === null && value.myScore === null
      : typeof value.averageScore === 'number' && Number.isFinite(value.averageScore) && value.averageScore >= 1 && value.averageScore <= 5) &&
    (context.signedIn || value.myScore === null) &&
    (method !== 'POST' || value.myScore === requestedScore) &&
    (method !== 'DELETE' || value.myScore === null);
  if (!valid) throw failure('INVALID_RESPONSE', '评分数据未通过校验，请重新读取。');
  return Object.freeze({ menuVersion: value.menuVersion, itemId: value.itemId, stallId: value.stallId,
    averageScore: value.averageScore, ratingCount: value.ratingCount, myScore: value.myScore });
}
function safeFailure(error) {
  if (['CANCELLED', 'STALE'].includes(error?.code)) return cancelled();
  if (error?.code === 'INVALID_RESPONSE') return failure('INVALID_RESPONSE', '评分数据未通过校验，请重新读取。');
  if (error?.code === 'CONSENT_REQUIRED') return failure('CONSENT_REQUIRED', '请先阅读并同意隐私说明，再查看或提交云端评分。');
  if (error?.statusCode === 401 || ['SESSION_EXPIRED', 'INVALID_SESSION', 'UNAUTHORIZED'].includes(error?.code)) {
    return failure('LOGIN_REQUIRED', '请先登录，再提交或撤回自己的评分。');
  }
  if (error?.statusCode === 403) return failure('UNAVAILABLE', '当前账号暂时不能操作评分，请稍后重试。');
  if (error?.statusCode === 409) return failure('CONFLICT', '菜单或评分状态已变化，请重新读取。');
  if (error?.statusCode === 429) return failure('RATE_LIMITED', '评分操作较频繁，请稍后重试。');
  return failure('UNAVAILABLE', '评分服务暂时不可用，请稍后重新读取。');
}
async function requestRating(itemId, method, requestedScore) {
  const item = selectedItem(itemId);
  if (method === 'POST' && !score(requestedScore)) throw failure('INVALID_SCORE', '请选择1至5星的整数评分。');
  const context = scope();
  if (!context.consent) throw failure('CONSENT_REQUIRED', '请先阅读并同意隐私说明，再查看或提交云端评分。');
  if (!Number.isSafeInteger(context.authenticationRevision) || context.authenticationRevision < 0) {
    throw failure('UNAVAILABLE', '登录状态暂时无法确认，请稍后重试。');
  }
  if (method !== 'GET' && !context.signedIn) throw failure('LOGIN_REQUIRED', '请先登录，再提交或撤回自己的评分。');
  if (mutations.has(itemId)) throw failure('BUSY', '这道菜的评分正在保存，请稍候再读取或修改。');
  const previousRead = reads.get(itemId);
  if (previousRead) previousRead.cancel();
  const query = `${ROUTE}?menuVersion=${encodeURIComponent(menu.version)}&itemId=${encodeURIComponent(item.id)}`;
  const path = method === 'POST' ? ROUTE : query;
  const options = method === 'POST' ? { method, data: { menuVersion: menu.version, itemId: item.id, score: requestedScore } } : { method };
  return new Promise((resolve, reject) => {
    let settled = false;
    const entry = { cancel: () => finish(cancelled()) };
    function finish(error, value) {
      if (settled) return;
      settled = true;
      pending.delete(entry);
      if (reads.get(itemId) === entry) reads.delete(itemId);
      if (error) reject(error); else resolve(value);
    }
    function releaseMutation() {
      if (mutations.get(itemId) === entry) mutations.delete(itemId);
    }
    pending.add(entry);
    if (method === 'GET') reads.set(itemId, entry); else mutations.set(itemId, entry);
    try {
      const operation = context.signedIn ? account.authorizedRequest(path, options) : service.request(path, options);
      Promise.resolve(operation).then(value => {
        releaseMutation();
        if (settled) return;
        if (!isCurrent(context)) { finish(cancelled()); return; }
        try { finish(null, validated(value, item, context, method, requestedScore)); }
        catch (error) { finish(safeFailure(error)); }
      }, error => {
        releaseMutation();
        if (!settled) finish(isCurrent(context) ? safeFailure(error) : cancelled());
      });
    } catch (error) {
      releaseMutation();
      finish(isCurrent(context) ? safeFailure(error) : cancelled());
    }
  });
}

// Cancellation hides late replies; it cannot undo a write already accepted by
// the server. Keep that item's mutation lock until its transport has settled.
module.exports = { read: itemId => requestRating(itemId, 'GET'),
  rate: (itemId, value) => requestRating(itemId, 'POST', value),
  remove: itemId => requestRating(itemId, 'DELETE'), cancel, scope, isCurrent };
