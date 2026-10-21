// Explicit, device-local declarations. No API, identity, location or learning.
const model = require('./decision/taste-profile');
const catalog = require('./decision/catalog');
const STORAGE_KEY = 'eatwhat.wechat.taste-profile.v1';
const PROFILE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
// biome-ignore lint/suspicious/noPrototypeBuiltins: WeChat does not require ES2022 Object.hasOwn.
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function createStore(dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const storage = () => dependencies.storage || wx;
  let active = null;
  let draft = null;
  let sequence = 0;
  let consentAt = null;
  let error = '';
  let assessment = null;
  let activeAssessment = null;
  let loaded = false;
  let revokeBlocked = false;

  function fail(message, code = 'TASTE_PROFILE_ERROR') {
    error = message;
    const failure = new Error(message);
    failure.code = code;
    throw failure;
  }
  function validTime(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= now() + 60000;
  }
  function expired(value, ttl) { return now() - value >= ttl; }
  function record(nextActive = active, nextDraft = draft, nextSequence = sequence, nextConsent = consentAt) {
    return { schemaVersion: model.SCHEMA_VERSION, policyVersion: model.POLICY_VERSION,
      consentAt: nextConsent, sequence: nextSequence, active: nextActive, draft: nextDraft };
  }
  function persist(value) {
    try {
      storage().setStorageSync(STORAGE_KEY, clone(value));
      if (!equal(storage().getStorageSync(STORAGE_KEY), value)) throw new Error('readback mismatch');
    } catch (_) { fail('本机偏好保存失败，请重试。完成保存前不会进入首页。', 'TASTE_STORAGE_ERROR'); }
  }
  function revokeStored() {
    let cleared = false;
    try {
      storage().setStorageSync(STORAGE_KEY, {
        schemaVersion: model.SCHEMA_VERSION, policyVersion: model.POLICY_VERSION, revoked: true,
      });
      const value = storage().getStorageSync(STORAGE_KEY);
      cleared = value?.revoked === true && !value.active && !value.draft;
    } catch (_) { /* Removing the record is an independent fallback. */ }
    try {
      storage().removeStorageSync(STORAGE_KEY);
      const value = storage().getStorageSync(STORAGE_KEY);
      if (value === undefined || value === null || value === '') cleared = true;
    } catch (_) { /* A persisted tombstone also prevents restoration. */ }
    return cleared;
  }
  function expire() {
    const activeExpired = active && expired(active.confirmedAt, PROFILE_TTL_MS);
    const draftExpired = draft && expired(draft.updatedAt, DRAFT_TTL_MS);
    if (!activeExpired && !draftExpired) return;
    if (activeExpired) { active = null; activeAssessment = null; }
    // Starting an edit revokes the old approval. An expired draft must not
    // silently resurrect it and bypass the live questions gate.
    if (draftExpired) { draft = null; active = null; assessment = null; activeAssessment = null; }
    error = activeExpired ? '上次确认的偏好已超过90天，请重新选择。' : '未完成的选择已超过7天，请重新开始。';
    if (!active && !draft) {
      consentAt = null;
      if (!revokeStored()) { revokeBlocked = true; error = '过期偏好清理失败，已停止使用，请在本页重新开始或清除。'; }
    } else {
      try { persist(record()); }
      catch (_) { /* Expired declarations remain unusable even if pruning fails. */ }
    }
  }
  function validEntry(value, confirmed) {
    if (!only(value, confirmed ? ['answers', 'revision', 'confirmedRevision', 'confirmedAt'] : ['answers', 'revision', 'updatedAt'])) return false;
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > sequence) return false;
    if (!equal(value.answers, model.normalizeAnswers(value.answers))) return false;
    if (confirmed) return value.confirmedRevision === value.revision && validTime(value.confirmedAt)
      && value.confirmedAt >= consentAt && model.missingFields(value.answers).length === 0;
    return validTime(value.updatedAt) && value.updatedAt >= consentAt;
  }
  function load() {
    // A failed revoke cannot be reversed by reloading the same process.
    if (revokeBlocked) return getState();
    active = null; draft = null; consentAt = null; assessment = null; activeAssessment = null;
    sequence = 0; error = ''; loaded = true;
    let saved;
    try { saved = storage().getStorageSync(STORAGE_KEY); }
    catch (_) { error = '暂时无法读取本机偏好，请重新开始选择。'; return getState(); }
    if (saved === undefined || saved === null || saved === '') return getState();
    if (saved?.revoked === true) return getState();
    try {
      if (!only(saved, ['schemaVersion', 'policyVersion', 'consentAt', 'sequence', 'active', 'draft'])
        || saved.schemaVersion !== model.SCHEMA_VERSION || saved.policyVersion !== model.POLICY_VERSION
        || !validTime(saved.consentAt) || !Number.isSafeInteger(saved.sequence) || saved.sequence < 1 || saved.sequence >= Number.MAX_SAFE_INTEGER - 1
        || !has(saved, 'active') || !has(saved, 'draft')) throw new Error('unsupported record');
      sequence = saved.sequence; consentAt = saved.consentAt;
      if ((saved.active !== null && !validEntry(saved.active, true)) || (saved.draft !== null && !validEntry(saved.draft, false))) throw new Error('invalid entry');
      active = clone(saved.active); draft = clone(saved.draft);
      if (active) {
        activeAssessment = catalog.assessProfile(active.answers);
        if (!activeAssessment.profileComplete || !activeAssessment.personalizedReady) throw new Error('invalid explicit profile');
      }
      expire();
    } catch (_) {
      active = null; draft = null; consentAt = null; assessment = null; activeAssessment = null;
      error = '本机偏好格式已失效，请重新选择并确认。';
    }
    return getState();
  }
  function isReady() {
    expire();
    return !!active && !draft && !revokeBlocked && activeAssessment?.ready === true;
  }
  function getState() {
    expire();
    const current = draft || active;
    return clone({ started: !!draft, ready: isReady(), editing: !!active && !!draft,
      revision: current ? current.revision : sequence,
      answers: current ? current.answers : {},
      missingFields: model.missingFields(current ? current.answers : {}), error });
  }
  function start() {
    if (!loaded) load();
    expire();
    if (draft && !revokeBlocked) { error = ''; return getState(); }
    const nextConsent = consentAt === null || revokeBlocked ? now() : consentAt;
    const nextDraft = { answers: {}, revision: sequence + 1, updatedAt: now() };
    persist(record(active, nextDraft, nextDraft.revision, nextConsent));
    consentAt = nextConsent; sequence = nextDraft.revision; draft = nextDraft;
    revokeBlocked = false; error = ''; assessment = null;
    return getState();
  }
  function beginEdit() {
    if (!loaded) load();
    expire();
    if (draft) return getState();
    if (!active) return start();
    const nextDraft = { answers: clone(active.answers), revision: sequence + 1, updatedAt: now() };
    try { persist(record(active, nextDraft, nextDraft.revision)); }
    catch (failure) {
      // An explicit edit closes the decision gate even when the draft cannot
      // be saved. Revoke the previous approval durably when storage permits.
      active = null; activeAssessment = null; assessment = null; revokeBlocked = true;
      if (revokeStored()) revokeBlocked = false;
      else error = '本机偏好保存失败，已停止使用；请重试，关闭后旧记录可能仍存在。';
      failure.message = error;
      throw failure;
    }
    draft = nextDraft; sequence = nextDraft.revision; assessment = null; error = '';
    return getState();
  }
  function answer(field, value, expectedRevision) {
    expire();
    if (!draft || revokeBlocked) fail('请先开始口味选择。');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== draft.revision) fail('这份选择已经更新，请按当前页面重新选择。', 'STALE_TASTE_PROFILE');
    if (!model.FIELDS.includes(field)) fail('这项选择无效，请重新选择。');
    let answers;
    try { answers = model.normalizeAnswers({ ...draft.answers, [field]: value }); }
    catch (_) { fail('选择存在冲突，请先取消重复的喜欢或避开类型，再重新选择。', 'INVALID_TASTE_PROFILE'); }
    if (equal(answers, draft.answers)) { error = ''; return getState(); }
    const nextDraft = { answers, revision: sequence + 1, updatedAt: now() };
    persist(record(active, nextDraft, nextDraft.revision));
    draft = nextDraft; sequence = nextDraft.revision; error = ''; assessment = null;
    return getState();
  }
  function assess() {
    expire();
    if (!assessment) assessment = catalog.assessProfile(draft ? draft.answers : active ? active.answers : {});
    return clone(assessment);
  }
  function confirm(expectedRevision) {
    expire();
    if (!draft && isReady() && expectedRevision === active.revision) return getState();
    if (!draft || revokeBlocked) fail('请先完成口味选择。');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== draft.revision) fail('这份选择已经更新，请核对后重新确认。', 'STALE_TASTE_PROFILE');
    const result = assess();
    if (!result.ready) fail(result.message || '还需要补充能用于推荐的偏好。', 'INCOMPLETE_TASTE_PROFILE');
    const nextActive = { answers: clone(draft.answers), revision: draft.revision,
      confirmedRevision: draft.revision, confirmedAt: now() };
    persist(record(nextActive, null));
    active = nextActive; draft = null; activeAssessment = result; assessment = null; error = '';
    return getState();
  }
  function getProfile() { return isReady() ? clone(active.answers) : null; }
  function clear() {
    active = null; draft = null; consentAt = null; activeAssessment = null; assessment = null;
    sequence += 1; loaded = true; revokeBlocked = true; error = '';
    if (!revokeStored()) fail('本机偏好清除失败，已停止使用；请重试清除，关闭后旧记录可能仍存在。', 'TASTE_STORAGE_ERROR');
    revokeBlocked = false;
    return getState();
  }
  return { load, getState, start, beginEdit, answer, assess, confirm, isReady, getProfile, clear };
}

module.exports = { ...createStore(), createStore, STORAGE_KEY, PROFILE_TTL_MS, DRAFT_TTL_MS };
