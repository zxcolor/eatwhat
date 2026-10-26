const { LIMITS, validCandidate, validReceipt, validExclusions } = require('./takeout-contract');
const copy = value => JSON.parse(JSON.stringify(value));
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function createRound(options = {}) {
  const now = options.now || Date.now;
  let candidates = [], receipt = '', expires = 0, revision = 0, current = null;
  let excluded = new Set(), seen = new Set();
  function clear() {
    candidates = []; receipt = ''; expires = 0; current = null;
    excluded = new Set(); seen = new Set(); revision += 1;
  }
  function load(value) {
    const expiry = Date.parse(value?.expiresAt);
    if (!Array.isArray(value?.candidates) || value.candidates.length < 1 || value.candidates.length > LIMITS.maxCandidates ||
      new Set(value.candidates.map(item => item?.id)).size !== value.candidates.length ||
      !value.candidates.every(item => validCandidate(item, ['image-1', 'image-2', 'image-3'])) || !validReceipt(value.receipt) ||
      !Number.isFinite(expiry)) {
      throw failure('INVALID_RESPONSE', '本次识别结果无法使用，请重新识别。');
    }
    clear(); candidates = copy(value.candidates); receipt = value.receipt;
    // This is only a local reminder. The signed receipt's validity and expiry
    // are enforced by the server, never inferred from a device's wall clock.
    expires = now() + LIMITS.receiptTtlMs;
  }
  function snapshot() {
    const kept = candidates.filter(item => !excluded.has(item.id));
    const remaining = kept.filter(item => !seen.has(item.id));
    const item = current ? candidates.find(value => value.id === current.id) : null;
    return { revision, candidates: candidates.map(item => ({ ...copy(item), included: !excluded.has(item.id) })),
      current: item ? { ...copy(item), source: current.source, fallbackReason: current.fallbackReason } : null,
      keptCount: kept.length, seenCount: seen.size, remainingCount: remaining.length,
      expiresAt: expires, expiryHint: Boolean(receipt) && expires <= now(), ready: Boolean(receipt) };
  }
  function setExcluded(ids) {
    if (!receipt || !validExclusions(ids, candidates)) throw failure('INVALID_INPUT', '候选已经变化，请重新核对。');
    excluded = new Set(ids); current = null; revision += 1;
    return snapshot();
  }
  function request() {
    if (!receipt) throw failure('RECEIPT_EXPIRED', '本次识别已失效，请重新识别截图。');
    return { receipt, candidates: copy(candidates), excludedCandidateIds: candidates
      .filter(item => excluded.has(item.id) || seen.has(item.id)).map(item => item.id), revision };
  }
  function accept(value, expectedRevision) {
    if (!receipt || revision !== expectedRevision) throw failure('CANCELLED', '本次候选已经变化。');
    const id = value.selectedCandidateId;
    if (value.status !== 'SELECTED' || !candidates.some(item => item.id === id) || excluded.has(id) || seen.has(id) ||
      !['MIMO', 'LOCAL'].includes(value.source)) throw failure('INVALID_RESPONSE', '返回的选项不属于本轮候选，请重试。');
    current = { id, source: value.source, fallbackReason: value.fallbackReason };
    seen.add(id); revision += 1;
    return snapshot();
  }
  function restart() {
    const state = snapshot();
    if (!state.ready || !state.keptCount || state.remainingCount) throw failure('INVALID_INPUT', '当前轮次尚未结束。');
    seen = new Set(); current = null; revision += 1;
    return snapshot();
  }
  return { load, snapshot, request, setExcluded, accept, restart, clear };
}
module.exports = { createRound };
