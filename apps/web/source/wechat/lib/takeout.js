// Screenshot requests are explicit, bounded and independent of account login.
const contract = require('./takeout-contract');
const cleanup = require('./takeout-cleanup');
const BASE = 'https://api.eatwhat.pro';
const HEADER = 'X-ChiShenMe-Contract-Version';
const PATHS = Object.freeze({ extract: '/v1/takeout/extractions', decide: '/v1/takeout/decisions' });
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function cancelled() { return failure('CANCELLED', '本次操作已取消。'); }
function createTakeoutClient(options = {}) {
  const api = () => options.wx || wx;
  const now = options.now || Date.now;
  const consent = options.getConsent || (() => require('./service').state.consent === true);
  const enabled = options.getEnabled || (() => {
    const state = require('./service').state;
    return state.status === 'ready' && state.config?.serviceCapabilities?.takeoutScreenshotsEnabled === true;
  });
  const transportEpoch = options.getEpoch || (() => require('./service').state.epoch);
  const pending = new Set(), listeners = new Set();
  let epoch = 0, sequence = 0;
  function stop(clear) {
    epoch += 1;
    for (const entry of [...pending]) {
      entry.finish(cancelled());
      try { entry.task?.abort(); } catch (_) { /* The response is already invalidated. */ }
    }
    let listenerFailed = false;
    const asynchronous = [];
    const inspectResult = result => { if (result === false || Array.isArray(result) && result.some(value => value === false)) listenerFailed = true; };
    for (const listener of [...listeners]) {
      try {
        const result = listener(clear ? 'clear' : 'cancel');
        // Invalidate every observer synchronously, then collect cleanup work.
        // One failed observer must not prevent other privacy cleanup paths.
        if (result && typeof result.then === 'function') asynchronous.push(Promise.resolve(result).then(inspectResult, () => { listenerFailed = true; }));
        else inspectResult(result);
      } catch (_) { listenerFailed = true; }
    }
    if (!clear) return;
    const finished = () => { if (listenerFailed) throw failure('CLEANUP_INCOMPLETE', cleanup.CLEANUP_MESSAGE); };
    if (asynchronous.length) return Promise.all(asynchronous).then(finished);
    return finished();
  }
  function requestId() { return `takeout-${now()}-${++sequence}`; }
  function errorFor(status) {
    if (status === 400) return failure('INVALID_INPUT', '图片或候选信息无法处理，请检查图片后重新识别。');
    if (status === 409) return failure('RECEIPT_EXPIRED', '本次识别已失效，请重新识别截图。');
    if (status === 413) return failure('IMAGE_TOO_LARGE', '图片仍然过大，请裁短列表或减少截图后重试。');
    if (status === 429) return failure('CAPACITY', '识别服务较忙，请稍后重试。');
    return failure('UNAVAILABLE', '截图服务暂不可用，请稍后重试。');
  }
  function send(path, data, timeout, isCurrent, validate, release) {
    if (!consent()) { release?.(); return Promise.reject(failure('CONSENT_REQUIRED', '请先同意隐私说明。')); }
    if (!enabled()) { release?.(); return Promise.reject(failure('UNAVAILABLE', '截图服务尚未就绪，请重新连接服务。')); }
    if (pending.size) { release?.(); return Promise.reject(failure('BUSY', '上一次操作尚未结束。')); }
    const started = epoch, requestEpoch = transportEpoch();
    const current = () => started === epoch && requestEpoch === transportEpoch() && consent() && enabled() && isCurrent();
    return new Promise((resolve, reject) => {
      const entry = { task: null, settled: false, finish: null };
      entry.finish = (error, value) => {
        if (entry.settled) return;
        entry.settled = true; pending.delete(entry); release?.();
        if (error) reject(error); else resolve(value);
      };
      pending.add(entry);
      if (!current()) { entry.finish(cancelled()); return; }
      try {
        entry.task = api().request({ url: BASE + path, method: 'POST', data,
          header: { [HEADER]: '1', 'Content-Type': 'application/json' }, timeout,
          dataType: 'json', responseType: 'text', enableCache: false,
          success(response) {
            if (entry.settled) return;
            if (!current()) { entry.finish(cancelled()); return; }
            const status = response?.statusCode;
            // A gateway may reject before reaching the API contract middleware.
            if ([413, 429, 502, 503, 504].includes(status)) { entry.finish(errorFor(status)); return; }
            const headers = response?.header || {};
            const versions = Object.keys(headers).filter(key => key.toLowerCase() === HEADER.toLowerCase());
            if (versions.length !== 1 || String(headers[versions[0]]) !== '1') {
              entry.finish(failure('INVALID_RESPONSE', '服务版本不兼容，请更新小程序后重试。')); return;
            }
            if (status !== 200) { entry.finish(errorFor(status)); return; }
            if (!validate(response.data)) { entry.finish(failure('INVALID_RESPONSE', '识别结果未通过校验，请重新识别。')); return; }
            entry.finish(null, JSON.parse(JSON.stringify(response.data)));
          },
          fail() { entry.finish(current() ? failure('NETWORK', '连接未完成，请检查网络后重试。') : cancelled()); },
        });
      } catch (_) { entry.finish(current() ? failure('NETWORK', '截图服务暂不可用，请稍后重试。') : cancelled()); }
    });
  }
  function extract({ images, consentVersion, isCurrent = () => true }) {
    if (consentVersion !== contract.CONSENT_VERSION || !contract.validImages(images)) {
      return Promise.reject(failure('INVALID_INPUT', '请选择有效截图并确认本次图片处理。'));
    }
    const data = { requestId: requestId(), consentVersion, images: images.map(image => ({ ...image })) };
    const imageIds = data.images.map(image => image.imageId);
    const release = () => { data.images.forEach(image => { image.base64 = ''; }); data.images.length = 0; };
    return send(PATHS.extract, data, 45000, isCurrent,
      value => contract.validExtraction(value, data.requestId, imageIds), release);
  }
  function decide({ receipt, candidates, excludedCandidateIds, preferences, preferenceRevision, consentVersion, candidatesConfirmed, isCurrent = () => true }) {
    if (consentVersion !== contract.CONSENT_VERSION || candidatesConfirmed !== true || !contract.validReceipt(receipt) ||
      !Array.isArray(candidates) || candidates.length < 1 || candidates.length > contract.LIMITS.maxCandidates ||
      !candidates.every(item => contract.validCandidate(item, ['image-1', 'image-2', 'image-3'])) ||
      new Set(candidates.map(item => item.id)).size !== candidates.length ||
      !contract.validExclusions(excludedCandidateIds, candidates) || !contract.validPreferences(preferences) ||
      !contract.integer(preferenceRevision, 1, Number.MAX_SAFE_INTEGER)) return Promise.reject(failure('INVALID_INPUT', '请先核对本次候选和口味偏好。'));
    const data = { requestId: requestId(), consentVersion, receipt, candidatesConfirmed: true,
      preferences: { ...preferences }, preferenceRevision, excludedCandidateIds: [...excludedCandidateIds] };
    const responseCandidates = candidates.map(item => ({ id: item.id }));
    return send(PATHS.decide, data, 15000, isCurrent,
      value => contract.validDecision(value, data, responseCandidates), () => { data.receipt = ''; });
  }
  return { extract, decide, cancel: () => stop(false), clear: () => stop(true),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
const singleton = createTakeoutClient();
// This observer survives page disposal and can retry only previously
// registered generated files. Background cancel deliberately does not delete.
singleton.subscribe(kind => kind === 'clear' ? cleanup.clearAll() : undefined);
module.exports = { ...singleton, createTakeoutClient, failure, CONSENT_VERSION: contract.CONSENT_VERSION };
