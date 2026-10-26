// Account-scoped records stay in memory. Result tokens and cursors never enter
// page data, URLs used for navigation, storage, logs, or third-party requests.
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const GROUPS = { WANT_TO_GO: '想去', REGULAR: '常吃' };
const FEEDBACK = { WANT_TO_EAT: '想吃', ATE: '吃过', LIKE: '喜欢', DISLIKE: '不喜欢', TOO_FAR: '太远', TOO_EXPENSIVE: '太贵', RECENTLY_ATE: '最近吃过', AVOID_CUISINE: '不想吃这个菜系' };
const ACTIONS = { RECOMMENDATION_SHOWN: '看到了推荐', DETAIL_VIEWED: '查看了详情', FAVORITE_ADDED: '加入了收藏', NAVIGATION_OPENED: '打开了导航', PHONE_DIALER_OPENED: '打开了拨号器', REROLL_REQUESTED: '按相同条件重新请求了推荐' };
const SECTIONS = { FAVORITES: '收藏', HISTORY: '历史', PRIVATE_FEEDBACK: '私有反馈' };
const ROUTES = { FAVORITES: '/v1/favorites', HISTORY: '/v1/history', PRIVATE_FEEDBACK: '/v1/private-feedback' };
const IDS = { FAVORITES: 'favoriteId', HISTORY: 'historyId', PRIVATE_FEEDBACK: 'feedbackId' };
const CAPABILITIES = { FAVORITES: 'favoritesEnabled', HISTORY: 'historyEnabled', PRIVATE_FEEDBACK: 'privateFeedbackEnabled' };
const MEALS = { BREAKFAST: '早餐', LUNCH: '午餐', DINNER: '晚餐' };
const OPEN = { OPEN: '营业中', CLOSED: '已休息', UNKNOWN: '营业状态未知' };
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function exact(value, keys) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function date(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function safeText(value, min, max) {
  return typeof value === 'string' && value === value.trim() && value.length >= min && value.length <= max &&
    !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159) && !/[A-Za-z0-9_-]{43}/.test(value) &&
    !/(?:^|\D)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?:\D|$)/.test(value) &&
    !/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/u.test(value) &&
    !/(?:^|[^\d.])[+-]?\d{1,3}\.\d+\s*[,，]\s*[+-]?\d{1,3}\.\d+(?:[^\d.]|$)/.test(value);
}
function validPresentation(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.presentationStatus === 'TEMPORARILY_UNAVAILABLE') return exact(value, ['presentationStatus', 'retryable']) && value.retryable === true;
  if (value.presentationStatus === 'RIGHTS_REVOKED') return exact(value, ['presentationStatus', 'retryable']) && value.retryable === false;
  return exact(value, ['presentationStatus', 'name', 'address', 'sourceLabel', 'dataMode', 'openStatus', 'averageCostYuan', 'tags', 'resolvedAt']) &&
    value.presentationStatus === 'AVAILABLE' && value.dataMode === 'LIVE' && safeText(value.name, 1, 160) &&
    (value.address === null || safeText(value.address, 0, 240)) && safeText(value.sourceLabel, 1, 80) && Object.hasOwn(OPEN, value.openStatus) &&
    (value.averageCostYuan === null || Number.isFinite(value.averageCostYuan) && value.averageCostYuan >= 0 && value.averageCostYuan <= 20000) &&
    Array.isArray(value.tags) && value.tags.length <= 8 && value.tags.every(tag => safeText(tag, 1, 40)) && date(value.resolvedAt);
}
function validRecord(section, item) {
  if (section === 'FAVORITES') return exact(item, ['favoriteId', 'group', 'createdAt', 'presentation']) && UUID.test(item.favoriteId) && Object.hasOwn(GROUPS, item.group) && date(item.createdAt) && validPresentation(item.presentation);
  if (section === 'PRIVATE_FEEDBACK') return exact(item, ['feedbackId', 'type', 'visibility', 'createdAt', 'presentation']) && UUID.test(item.feedbackId) && Object.hasOwn(FEEDBACK, item.type) && item.visibility === 'PRIVATE' && date(item.createdAt) && (item.presentation === null || validPresentation(item.presentation));
  return section === 'HISTORY' && exact(item, ['historyId', 'action', 'mealPeriod', 'occurredAt', 'expiresAt', 'presentation']) && UUID.test(item.historyId) &&
    Object.hasOwn(ACTIONS, item.action) && Object.hasOwn(MEALS, item.mealPeriod) && date(item.occurredAt) && date(item.expiresAt) &&
    Date.parse(item.expiresAt) - Date.parse(item.occurredAt) === RETENTION_MS && (item.presentation === null || validPresentation(item.presentation));
}
function validPage(section, value) {
  return exact(value, section === 'HISTORY' ? ['items', 'nextCursor', 'retentionDays'] : ['items', 'nextCursor']) &&
    (section !== 'HISTORY' || value.retentionDays === 90) && Array.isArray(value.items) && value.items.length <= 50 &&
    value.items.every(item => validRecord(section, item)) && new Set(value.items.map(item => item[IDS[section]])).size === value.items.length &&
    (value.nextCursor === null || typeof value.nextCursor === 'string' && OPAQUE.test(value.nextCursor));
}
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => { const value = Math.floor(Math.random() * 16); return (character === 'x' ? value : (value & 3) | 8).toString(16); }); }
function displayDate(value) { return value.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC'); }
function present(section, record) {
  const source = record.presentation;
  const available = source?.presentationStatus === 'AVAILABLE';
  const title = available ? source.name : source?.presentationStatus === 'RIGHTS_REVOKED' ? '餐厅展示授权已撤回' : source ? '餐厅信息暂时不可用' : '本条记录没有餐厅展示信息';
  return {
    id: record[IDS[section]], title,
    kind: section === 'FAVORITES' ? GROUPS[record.group] : section === 'HISTORY' ? ACTIONS[record.action] : FEEDBACK[record.type],
    date: displayDate(record.createdAt || record.occurredAt),
    group: record.group || '', meal: MEALS[record.mealPeriod] || '',
    expires: record.expiresAt ? displayDate(record.expiresAt) : '',
    available, address: available ? source.address || '暂无地址' : '',
    sourceLabel: available ? source.sourceLabel : '',
    openLabel: available ? OPEN[source.openStatus] : '',
    price: available ? source.averageCostYuan === null ? '人均未知' : `约 ¥${Math.round(source.averageCostYuan)} / 人` : '',
    tags: available ? source.tags.slice() : [], resolved: available ? displayDate(source.resolvedAt) : '',
  };
}

function createSavedClient(service, account, options = {}) {
  const now = options.now || Date.now;
  const createId = options.uuid || uuid;
  let generation = 0;
  let lease = null;
  let busy = false;
  let records = { FAVORITES: [], HISTORY: [], PRIVATE_FEEDBACK: [] };
  let cursors = {};
  let loaded = {};
  let mutationKeys = new Map();
  let mutationBodies = new Map();
  let completed = new Set();
  let pendingMutation = null;

  function invalidate() {
    generation += 1; lease = null; busy = false;
    records = { FAVORITES: [], HISTORY: [], PRIVATE_FEEDBACK: [] };
    cursors = {}; loaded = {}; mutationKeys = new Map(); mutationBodies = new Map(); completed = new Set(); pendingMutation = null;
  }
  function context() {
    const auth = account.view();
    const config = service.state.config;
    const caps = config?.persistenceCapabilities;
    const scope = auth.authenticationRevision;
    const valid = service.state.consent && service.state.status === 'ready' && config?.accountsEnabled === true &&
      config?.authCapabilities?.accountsEnabled === true && config?.dataRightsMode === 'LICENSED_ENRICHMENT' && caps?.savedResourceIdsEnabled === true && Number.isSafeInteger(scope) && scope >= 0;
    const sections = valid ? Object.keys(SECTIONS).filter(section => caps[CAPABILITIES[section]] === true) : [];
    if (!lease || lease.epoch !== service.state.epoch || lease.config !== config || lease.scope !== scope || lease.signedIn !== auth.signedIn || lease.sections !== sections.join(',')) {
      invalidate(); lease = { epoch: service.state.epoch, config, scope, signedIn: auth.signedIn, sections: sections.join(',') };
    }
    return { sections, signedIn: auth.signedIn === true };
  }
  function gate(section) {
    const access = context();
    if (!access.sections.includes(section)) fail('RIGHTS_UNAVAILABLE', '收藏、账号历史与私有反馈尚未开放；本次不会上传或读取餐厅记录。');
    if (!access.signedIn) fail('LOGIN_REQUIRED', '请先登录，再查看收藏与账号记录。');
    return generation;
  }
  function current(section, attempt) { context(); if (attempt !== generation) fail('STALE', '账号或授权状态已变化，请重新加载。'); gate(section); }
  function mapFailure(error) {
    if (['STALE', 'RIGHTS_UNAVAILABLE', 'LOGIN_REQUIRED', 'INPUT', 'BUSY', 'INVALID_RESPONSE', 'RESULT_EXPIRED'].includes(error?.code)) return error;
    const code = error?.statusCode;
    if (code === 401 || ['SESSION_EXPIRED', 'UNAUTHORIZED', 'INVALID_SESSION'].includes(error?.code)) { invalidate(); return { code: 'LOGIN_REQUIRED', message: '登录已过期，请重新登录。' }; }
    if (code === 403) { invalidate(); return { code: 'RIGHTS_UNAVAILABLE', message: '当前账号或数据授权不允许此操作，请重新检查。' }; }
    if (code === 410) return { code: 'RESULT_EXPIRED', message: '本次餐厅结果已过期，请重新获取推荐后操作。' };
    if (code === 409) return { code: 'CONFLICT', message: '保存状态发生冲突，请刷新后重试。' };
    if (code === 404) return { code: 'NOT_FOUND', message: '记录不存在或已删除，请刷新。' };
    if (code === 429) return { code: 'RATE_LIMITED', message: '操作过于频繁，请稍后再试。' };
    return { code: 'UNAVAILABLE', message: '账号记录服务暂时不可用，请稍后重试。' };
  }
  function view(section = 'FAVORITES') {
    const access = context();
    const enabled = access.sections.includes(section);
    return {
      busy, enabled, signedIn: access.signedIn,
      sections: access.sections.map(id => ({ id, label: SECTIONS[id] })),
      rows: enabled && access.signedIn ? records[section].map(record => present(section, record)) : [],
      hasMore: enabled && access.signedIn && !!cursors[section], loaded: !!loaded[section],
      notice: !access.sections.length ? '收藏、账号历史与私有反馈当前未开放；本机最近决策不会被静默上传。' : !access.signedIn ? '主动登录后才能读取跨设备账号记录。' : '餐厅信息按当前授权解析。私有反馈仅自己可见，不形成公开评分。',
    };
  }
  async function load(section, append = false) {
    const attempt = gate(section);
    if (busy) fail('BUSY', '正在处理，请稍候。');
    const cursor = append ? cursors[section] : null;
    if (append && !cursor) return view(section);
    busy = true;
    try {
      const page = await account.authorizedRequest(`${ROUTES[section]}?limit=20${cursor ? `&cursor=${cursor}` : ''}`, { method: 'GET' });
      current(section, attempt);
      if (!validPage(section, page) || cursor && page.nextCursor === cursor) fail('INVALID_RESPONSE', '账号记录未通过安全校验，请刷新。');
      const merged = append ? records[section].concat(page.items) : page.items;
      const unique = new Map(merged.map(record => [record[IDS[section]], record]));
      records[section] = copy([...unique.values()]); cursors[section] = page.nextCursor; loaded[section] = true;
      return view(section);
    } catch (error) {
      context(); if (attempt !== generation) fail('STALE', '账号或授权状态已变化，请重新加载。');
      if (attempt === generation && error?.code === 'INVALID_RESPONSE') { records[section] = []; cursors[section] = null; loaded[section] = false; }
      throw mapFailure(error);
    } finally { if (attempt === generation) busy = false; }
  }
  function creationGate(response, result, section) {
    const attempt = gate(section);
    const age = now() - Date.parse(response?.generatedAt);
    if (!response || response !== service.state.results || !Array.isArray(response.results) || !response.results.includes(result) || response.dataRightsMode !== 'LICENSED_ENRICHMENT' || result.dataMode !== 'LIVE') fail('RIGHTS_UNAVAILABLE', '当前结果不允许保存，请重新获取已授权的推荐结果。');
    if (!UUID.test(response.requestId) || !OPAQUE.test(result.resultToken) || !Number.isFinite(age) || age < -60000 || age >= 7200000) fail('RESULT_EXPIRED', '本次餐厅结果已过期，请重新获取推荐。');
    return attempt;
  }
  function creationView(response, result) {
    const access = context();
    let favorite = false; let feedback = false;
    try { creationGate(response, result, 'FAVORITES'); favorite = true; } catch (_) { /* Closed by current authorization. */ }
    try { creationGate(response, result, 'PRIVATE_FEEDBACK'); feedback = true; } catch (_) { /* Closed by current authorization. */ }
    const key = response && result ? `${response.requestId}:${result.resultToken}` : '';
    return { canFavorite: favorite, canFeedback: feedback, signedIn: access.signedIn, busy,
      favoriteSaved: completed.has(`favorite:${key}`),
      feedbackTypes: Object.keys(FEEDBACK).map(type => ({ type, label: FEEDBACK[type], submitted: completed.has(`feedback:${key}:${type}`) })),
      notice: favorite || feedback ? '反馈仅自己可见，不形成公开评分。' : !access.sections.length ? '当前数据授权未开放收藏与私有反馈。' : !access.signedIn ? '登录后可使用当前已开放的账号记录功能。' : '当前结果不可保存，请重新获取已授权的推荐。',
    };
  }
  async function mutate(section, key, path, method, dataFactory, validate, apply) {
    const attempt = gate(section);
    if (pendingMutation?.key === key) return pendingMutation.promise;
    if (busy) fail('BUSY', '正在处理，请勿重复提交。');
    let id = mutationKeys.get(key);
    if (!id) { id = createId(); if (!UUID.test(id)) fail('INPUT', '暂时无法创建操作凭据。'); mutationKeys.set(key, id); }
    const data = dataFactory ? dataFactory(id) : undefined;
    const body = JSON.stringify(data);
    if (mutationBodies.has(key) && mutationBodies.get(key) !== body) fail('INPUT', '请先按原选项重试或刷新确认上次保存状态。');
    mutationBodies.set(key, body);
    busy = true;
    const promise = (async () => {
      try {
        const value = await Promise.resolve().then(() => {
          current(section, attempt);
          return account.authorizedRequest(path, { method, ...(data === undefined ? {} : { data }) });
        });
        current(section, attempt);
        if (!validate(value)) fail('INVALID_RESPONSE', '保存结果未通过校验，请刷新确认；重试会沿用原操作凭据。');
        apply(value === undefined ? undefined : copy(value)); return;
      } catch (error) { context(); if (attempt !== generation) fail('STALE', '账号或授权状态已变化，请重新加载。'); throw mapFailure(error); }
      finally { if (attempt === generation) { busy = false; pendingMutation = null; } }
    })();
    pendingMutation = { key, promise };
    return promise;
  }
  async function createFavorite(response, result, group) {
    creationGate(response, result, 'FAVORITES');
    if (!Object.hasOwn(GROUPS, group)) fail('INPUT', '收藏分组无效。');
    const key = `favorite:${response.requestId}:${result.resultToken}`;
    if (completed.has(key)) return;
    return mutate('FAVORITES', key, ROUTES.FAVORITES, 'POST', id => ({ idempotencyKey: id, result: { requestId: response.requestId, resultToken: result.resultToken }, group }),
      value => validRecord('FAVORITES', value) && value.group === group,
      value => { completed.add(key); records.FAVORITES = [value, ...records.FAVORITES.filter(item => item.favoriteId !== value.favoriteId)]; });
  }
  async function createFeedback(response, result, type) {
    creationGate(response, result, 'PRIVATE_FEEDBACK');
    if (!Object.hasOwn(FEEDBACK, type)) fail('INPUT', '反馈类型无效。');
    const key = `feedback:${response.requestId}:${result.resultToken}:${type}`;
    if (completed.has(key)) return;
    return mutate('PRIVATE_FEEDBACK', key, ROUTES.PRIVATE_FEEDBACK, 'POST', id => ({ idempotencyKey: id, result: { requestId: response.requestId, resultToken: result.resultToken }, type }),
      value => validRecord('PRIVATE_FEEDBACK', value) && value.type === type,
      value => { completed.add(key); records.PRIVATE_FEEDBACK = [value, ...records.PRIVATE_FEEDBACK.filter(item => item.feedbackId !== value.feedbackId)]; });
  }
  function record(section, id) { gate(section); const found = records[section].find(item => item[IDS[section]] === id); if (!found) fail('INPUT', '记录已变化，请刷新。'); return found; }
  async function moveFavorite(id) {
    const item = record('FAVORITES', id);
    const group = item.group === 'WANT_TO_GO' ? 'REGULAR' : 'WANT_TO_GO';
    const key = `move:${id}:${group}`;
    return mutate('FAVORITES', key, `${ROUTES.FAVORITES}/${id}/group`, 'POST', operation => ({ idempotencyKey: operation, group }),
      value => validRecord('FAVORITES', value) && value.favoriteId === id && value.group === group,
      value => { records.FAVORITES = records.FAVORITES.map(old => old.favoriteId === id ? value : old); mutationKeys.delete(`move:${id}:${item.group}`); mutationBodies.delete(`move:${id}:${item.group}`); });
  }
  async function remove(section, id) {
    if (!['FAVORITES', 'PRIVATE_FEEDBACK'].includes(section)) fail('INPUT', '不支持删除这类单条记录。');
    record(section, id);
    return mutate(section, `remove:${section}:${id}`, `${ROUTES[section]}/${id}`, 'DELETE', null, value => value === undefined || value === null || value === '',
      () => { records[section] = records[section].filter(item => item[IDS[section]] !== id); });
  }
  async function clear(section) {
    if (!['HISTORY', 'PRIVATE_FEEDBACK'].includes(section)) fail('INPUT', '不支持清空这类记录。');
    return mutate(section, `clear:${section}`, ROUTES[section], 'DELETE', null, value => value === undefined || value === null || value === '',
      () => { records[section] = []; cursors[section] = null; loaded[section] = true; });
  }
  function revision() { context(); return generation; }
  return { invalidate, syncCapabilities: context, revision, view, creationView, load, createFavorite, createFeedback, moveFavorite, remove, clear };
}

let singleton;
function defaultClient() { if (!singleton) singleton = createSavedClient(require('./service'), require('./account')); return singleton; }
module.exports = { GROUPS, FEEDBACK, SECTIONS, createSavedClient, validPresentation, validRecord, validPage };
['invalidate', 'syncCapabilities', 'revision', 'view', 'creationView', 'load', 'createFavorite', 'createFeedback', 'moveFavorite', 'remove', 'clear'].forEach(name => { module.exports[name] = (...args) => defaultClient()[name](...args); });
