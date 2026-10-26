const service = require('./service');
const account = require('./account');
const random = require('./random');
const CATEGORIES = [
  { value: 'PRODUCT', label: '产品建议' }, { value: 'PLACE_CORRECTION', label: '地点纠错' },
  { value: 'PRIVACY', label: '隐私问题' }, { value: 'COMPLAINT', label: '投诉' },
];
function normalize(message) { return String(message).replace(/\r\n?/g, '\n').trim(); }
function valid(message) {
  const value = normalize(message);
  const characters = Array.from(value);
  return characters.length >= 10 && characters.length <= 2000 && !characters.some(character => {
    const code = character.codePointAt(0);
    return code <= 8 || (code >= 11 && code <= 31) || (code >= 127 && code <= 159);
  });
}
function enabled() { return service.state.consent && service.state.status === 'ready' && service.state.config?.supportFeedbackEnabled === true; }
function create() {
  let generation = 0;
  let submissionId = null;
  let draft = { category: 'PRODUCT', message: '' };
  let busy = false;
  let guestConfirmationRequired = false;
  let forceGuest = false;
  let result = null;
  let error = '';
  function clear() { generation += 1; submissionId = null; draft = { category: 'PRODUCT', message: '' }; busy = false; guestConfirmationRequired = false; forceGuest = false; result = null; error = ''; }
  function view() { return { ...draft, busy, guestConfirmationRequired, result, error, enabled: enabled(), length: Array.from(normalize(draft.message)).length, canSubmit: enabled() && !busy && !guestConfirmationRequired && valid(draft.message) }; }
  function edit(category, message) {
    if (busy || !CATEGORIES.some(item => item.value === category)) return;
    const next = { category, message: Array.from(String(message)).slice(0, 2200).join('') };
    if (next.category !== draft.category || next.message !== draft.message) submissionId = null;
    draft = next; result = null; error = '';
  }
  function confirmGuest() { if (enabled() && !busy && guestConfirmationRequired) { forceGuest = true; guestConfirmationRequired = false; error = ''; } }
  async function submit() {
    if (!view().canSubmit) return;
    const ticket = ++generation;
    const epoch = service.state.epoch;
    const authentication = { ...account.view() };
    const current = () => ticket === generation && epoch === service.state.epoch && enabled();
    busy = true; error = ''; result = null;
    try {
      const nextId = submissionId || await random.uuid();
      if (!current()) return;
      submissionId = nextId;
      const nextAuth = account.view();
      if (!forceGuest && (nextAuth.authenticationRevision !== authentication.authenticationRevision || nextAuth.signedIn !== authentication.signedIn)) throw Object.assign(new Error('登录状态已变化，请重新确认提交身份。'), { code: 'LOGIN_STATE' });
      const data = { submissionId, category: draft.category, message: normalize(draft.message) };
      const response = authentication.signedIn && !forceGuest
        ? await account.authorizedRequest('/v1/support-feedback', { method: 'POST', data })
        : await service.request('/v1/support-feedback', { method: 'POST', data });
      if (!current()) return;
      if (!forceGuest && account.view().authenticationRevision !== authentication.authenticationRevision) throw Object.assign(new Error('登录状态已变化，请重新确认提交身份。'), { code: 'LOGIN_STATE' });
      if (response?.accepted !== true || typeof response.feedbackId !== 'string' || response.feedbackId.toLowerCase() !== submissionId || response.retentionAfterClosureDays !== 180 || Object.keys(response).length !== 3) throw new Error('服务响应未通过校验，本次不视为已提交。');
      result = { feedbackId: response.feedbackId, retentionAfterClosureDays: 180 };
      draft.message = ''; submissionId = null; forceGuest = false;
    } catch (cause) {
      if (!current()) return;
      if (cause.statusCode === 401 || cause.statusCode === 403 || ['LOGIN_STATE', 'SESSION_EXPIRED', 'NOT_SIGNED_IN', 'INVALID_SESSION'].includes(cause.code) || (!forceGuest && authentication.signedIn && !account.view().signedIn)) {
        guestConfirmationRequired = true; forceGuest = false;
        error = '登录状态无法确认，本次没有转为游客提交。你可以重新登录，或明确选择以游客身份重试。';
      } else if (cause.statusCode === 409) { submissionId = null; error = '提交标识发生冲突，请确认内容后重试。'; }
      else error = cause.message || '暂时无法提交，请稍后重试。';
    } finally { if (current()) busy = false; }
  }
  return { view, edit, clear, confirmGuest, submit };
}
module.exports = { CATEGORIES, normalize, valid, enabled, create };
