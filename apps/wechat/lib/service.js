// This module owns transient API state. It deliberately never calls a storage API.
const VERSION = '0.1.11-alpha';
const API_BASE = 'https://api.eatwhat.pro';
const CONTRACT_HEADER = 'X-ChiShenMe-Contract-Version';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER = /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/;
const CUISINES = ['中式快餐', '面食', '米饭', '火锅', '川湘菜', '清真', '素食', '西餐'];
const RIGHTS = ['LIVE_DISPLAY_ONLY', 'LICENSED_ENRICHMENT'];
const SPECIALTY_KEYS = ['breakfastProfileEnabled', 'dinnerProfileEnabled', 'milkTeaEnabled', 'coffeeEnabled', 'dessertEnabled', 'userReportedWeatherEnabled'];
const AUTH_KEYS = ['accountsEnabled', 'registrationEnabled', 'phoneEnabled', 'wechatEnabled', 'wechatMiniProgramEnabled', 'emailEnabled', 'qqEnabled', 'dataExportEnabled'];
const PERSISTENCE_KEYS = ['favoritesEnabled', 'historyEnabled', 'privateFeedbackEnabled', 'savedResourceIdsEnabled'];
const PUBLIC_PATHS = ['/v1/config', '/v1/recommendations', '/v1/recommendation-events', '/v1/location-search', '/v1/location-city', '/v1/restaurants/nearby', '/v1/auth/wechat-miniprogram/login'];

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.keys(value).forEach(key => { freeze(value[key]); });
    Object.freeze(value);
  }
  return value;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
const DEFAULT_FILTERS = freeze({
  mealPeriod: 'LUNCH', target: 'MEAL', weatherContext: { kind: 'NONE' },
  decisionMode: 'QUICK', travelMode: 'WALK', explorationMode: 'BALANCED',
  aiAssistanceEnabled: false, budgetMaxYuan: 25, availableMinutes: 60,
  radiusMeters: 1500, excludedCuisines: [], preferredCuisines: [],
  preferenceVector: { quality: 100, time: 100, budget: 100, mealMatch: 100, diversity: 100 },
});
const state = {
  consent: false, config: null, status: 'idle', error: '', epoch: 0,
  location: null, locationLabel: '', results: null, filters: clone(DEFAULT_FILTERS),
};
const pending = new Set();
const safeFailures = new WeakSet();
let recommendationSequence = 0;
let radiusExplicitlySelected = false;

function failure(message, code, statusCode) {
  const error = new Error(message);
  safeFailures.add(error);
  error.code = code;
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}
function cancelled() { return failure('本次操作已取消，请重新操作。', 'CANCELLED'); }
function invalidResponse() { return failure('服务返回的信息不完整，请稍后重试。', 'INVALID_RESPONSE'); }
function assert(test, message, code) { if (!test) throw failure(message || '服务返回的信息不完整，请稍后重试。', code || 'INVALID_RESPONSE'); }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value, min, max) { return typeof value === 'string' && value.trim().length >= min && value.length <= max; }
function number(value, min, max) { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function integer(value, min, max) { return Number.isInteger(value) && number(value, min, max); }
function oneOf(value, choices) { return choices.indexOf(value) !== -1; }
function isoDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function stringArray(value, maxItems, maxLength) { return Array.isArray(value) && value.length <= maxItems && value.every(item => text(item, 0, maxLength)); }
function containsControl(value) { return Array.from(value).some(character => character.charCodeAt(0) < 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)); }
function active(epoch) { if (!state.consent || epoch !== state.epoch) throw cancelled(); }
function abortRequests(predicate) {
  Array.from(pending).forEach(entry => {
    if (!predicate || predicate(entry)) {
      entry.finish(cancelled());
      try { if (entry.task && typeof entry.task.abort === 'function') entry.task.abort(); } catch (_) { /* Already invalidated. */ }
    }
  });
}
function invalidate() {
  state.epoch += 1;
  recommendationSequence += 1;
  abortRequests();
  state.config = null;
  state.status = 'idle';
  state.error = '';
  state.location = null;
  state.locationLabel = '';
  state.results = null;
}
function setConsent(accepted) {
  assert(typeof accepted === 'boolean', '隐私同意状态无效。', 'INVALID_INPUT');
  if (accepted !== state.consent || !accepted) {
    state.consent = accepted;
    invalidate();
    if (!accepted) {
      state.filters = clone(DEFAULT_FILTERS);
      radiusExplicitlySelected = false;
    }
  }
}

// Restrict requests to this application's public API. Query keys never carry locations.
function validatePath(path) {
  assert(typeof path === 'string' && path.length <= 2048 && /^\/v1\/[A-Za-z0-9/-]+(?:\?[^#\s]*)?$/.test(path), '请求地址无效。', 'INVALID_PATH');
  const parts = path.split('?');
  const route = parts[0];
  assert(!route.includes('//') && !route.endsWith('/'), '请求地址无效。', 'INVALID_PATH');
  const staticRoutes = PUBLIC_PATHS.concat(['/v1/support-feedback', '/v1/favorites', '/v1/history', '/v1/private-feedback', '/v1/auth/phone/request-code', '/v1/auth/email/request-code', '/v1/auth/oauth/state', '/v1/auth/login', '/v1/auth/refresh', '/v1/auth/logout', '/v1/auth/identities', '/v1/auth/sessions', '/v1/account', '/v1/account/export', '/v1/account/exports/latest']);
  const dynamic = /^\/v1\/(?:favorites\/([0-9a-f-]+)(?:\/group)?|private-feedback\/([0-9a-f-]+)|auth\/(?:identities|sessions)\/([0-9a-f-]+)|account\/exports\/([0-9a-f-]+)(?:\/content)?)$/i.exec(route);
  assert(staticRoutes.includes(route) || (dynamic && UUID.test(dynamic.slice(1).find(Boolean))), '请求地址无效。', 'INVALID_PATH');
  if (parts[1]) {
    const seen = new Set();
    parts[1].split('&').forEach(pair => {
      const match = /^([A-Za-z]+)=([A-Za-z0-9_%.-]+)$/.exec(pair);
      assert(match && !seen.has(match[1]), '请求参数无效。', 'INVALID_PATH');
      seen.add(match[1]);
      const key = match[1];
      const value = match[2];
      const allowed = route === '/v1/auth/sessions' ? key === 'includePlatforms' && value === 'ALL'
        : ['/v1/favorites', '/v1/history', '/v1/private-feedback'].includes(route) &&
          ((key === 'limit' && /^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) ||
           (key === 'cursor' && /^[A-Za-z0-9_-]{1,1024}$/.test(value)) ||
           (route === '/v1/favorites' && key === 'group' && ['WANT_TO_GO', 'REGULAR'].includes(value)));
      assert(allowed, '请求参数无效。', 'INVALID_PATH');
    });
  }
  return route;
}
function request(path, options) { return executeRequest(path, options, false); }
function requestBytes(path, options) { return executeRequest(path, options, true); }
function executeRequest(path, options, binary) {
  options = options || {};
  if (!state.consent) return Promise.reject(failure('请先阅读并同意隐私政策。', 'CONSENT_REQUIRED'));
  let route;
  let method;
  let headers;
  try {
    route = validatePath(path);
    if (binary) {
      assert(/^\/v1\/account\/exports\/[0-9a-f-]+\/content$/i.test(route) && path === route && TOKEN.test(options.token || ''), '导出请求无效。', 'INVALID_PATH');
      assert(integer(options.maxBytes, 1, 10485760), '导出大小限制无效。', 'INVALID_INPUT');
    }
    method = options.method === undefined ? 'GET' : options.method;
    if (binary) assert(method === 'GET' && options.data === undefined, '导出请求无效。', 'INVALID_INPUT');
    assert(oneOf(method, ['GET', 'POST', 'DELETE', 'PATCH', 'PUT']), '请求方式无效。', 'INVALID_INPUT');
    assert(method !== 'GET' || options.data === undefined, '读取请求不得携带敏感参数。', 'INVALID_INPUT');
    headers = { [CONTRACT_HEADER]: '1', 'Content-Type': 'application/json' };
    if (options.token && !PUBLIC_PATHS.includes(route)) {
      assert(TOKEN.test(options.token), '登录状态无效，请重新登录。', 'INVALID_SESSION');
      headers.Authorization = `Bearer ${options.token}`;
    }
  } catch (error) { return Promise.reject(error); }
  const epoch = state.epoch;
  return new Promise((resolve, reject) => {
    const entry = { path: route, task: null, settled: false, finish: null };
    entry.finish = (error, value) => {
      if (entry.settled) return;
      entry.settled = true;
      pending.delete(entry);
      if (error) reject(error); else resolve(value);
    };
    pending.add(entry);
    try {
      assert(typeof wx !== 'undefined' && typeof wx.request === 'function', '网络服务暂不可用。', 'NETWORK_UNAVAILABLE');
      entry.task = wx.request({
        url: API_BASE + path, method, data: options.data, header: headers,
        timeout: binary ? 20000 : 15000, dataType: binary ? 'other' : 'json', responseType: binary ? 'arraybuffer' : 'text', enableCache: false,
        success(response) {
          if (entry.settled) return;
          try {
            active(epoch);
            assert(object(response) && Number.isInteger(response.statusCode), undefined, 'INVALID_RESPONSE');
            const header = response.header || {};
            const versions = Object.keys(header).filter(key => key.toLowerCase() === CONTRACT_HEADER.toLowerCase()).map(key => header[key]);
            if (versions.length !== 1 || versions[0] !== '1') {
              if (!(versions.length === 0 && [502, 503, 504].includes(response.statusCode))) {
                throw failure('服务版本不兼容，请更新小程序后重试。', 'CONTRACT_INCOMPATIBLE');
              }
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
              const status = response.statusCode;
              const message = status === 401 ? '登录已失效，请重新登录。'
                : status === 403 ? '当前操作暂未开放。' : status === 429 ? '操作较频繁，请稍后再试。'
                  : status >= 500 ? '服务暂时不可用，请稍后重试。' : '本次请求未能完成，请检查输入后重试。';
              throw failure(message, `HTTP_${status}`, status);
            }
            if (route === '/v1/support-feedback') assert(response.statusCode === 202, '反馈服务响应未通过校验。', 'INVALID_RESPONSE');
            if (binary) {
              const headers = {};
              Object.keys(header).forEach(key => { const lower = key.toLowerCase(); assert(headers[lower] === undefined); headers[lower] = String(header[key]); });
              assert(response.statusCode === 200 && !headers.location && response.data instanceof ArrayBuffer && response.data.byteLength <= options.maxBytes && response.data.byteLength > 0, '导出内容未通过传输校验。', 'INVALID_RESPONSE');
              entry.finish(null, { bytes: response.data, headers });
            } else entry.finish(null, response.data);
          } catch (error) { entry.finish(safeFailures.has(error) ? error : invalidResponse()); }
        },
        fail() { entry.finish(epoch !== state.epoch || !state.consent ? cancelled() : failure('网络连接失败，请检查网络后重试。', 'NETWORK_ERROR')); },
      });
    } catch (error) { entry.finish(safeFailures.has(error) ? error : failure('网络服务暂不可用。', 'NETWORK_UNAVAILABLE')); }
  }).then(value => { active(epoch); return value; });
}

function capabilities(value, keys, optionalKeys) {
  if (value === undefined) return Object.fromEntries(keys.map(key => [key, false]));
  assert(object(value));
  const result = {};
  keys.forEach(key => {
    if (value[key] === undefined && (optionalKeys || []).includes(key)) result[key] = false;
    else { assert(typeof value[key] === 'boolean'); result[key] = value[key]; }
  });
  return result;
}
function validateConfig(value) {
  assert(object(value));
  assert(text(value.coverageName, 1, 160) && oneOf(value.dataRightsMode, RIGHTS));
  ['aiEnabled', 'accountsEnabled', 'favoritesEnabled'].forEach(key => { assert(typeof value[key] === 'boolean'); });
  ['nearbyRestaurantCollectionEnabled', 'supportFeedbackEnabled'].forEach(key => { assert(value[key] === undefined || typeof value[key] === 'boolean'); });
  ['ruleVersion', 'promptVersion', 'modelVersion'].forEach(key => { assert(text(value[key], 1, 160)); });
  assert(typeof value.minimumSupportedVersion === 'string' && SEMVER.test(value.minimumSupportedVersion));
  assert(value.rulesConfigVersion === undefined || value.rulesConfigVersion === null || integer(value.rulesConfigVersion, 1, Number.MAX_SAFE_INTEGER));
  if (value.minimumSupportedVersions !== undefined) {
    assert(object(value.minimumSupportedVersions) && value.minimumSupportedVersions.android === value.minimumSupportedVersion);
    Object.keys(value.minimumSupportedVersions).forEach(key => { assert(['android', 'ios', 'miniprogram'].includes(key) && SEMVER.test(value.minimumSupportedVersions[key])); });
  }
  if (value.recommendationDefaults !== undefined) {
    const defaults = value.recommendationDefaults;
    assert(object(defaults) && defaults.areaCode === 'NATIONWIDE' && integer(defaults.defaultRadiusMeters, 200, 10000) && integer(defaults.maximumRadiusMeters, defaults.defaultRadiusMeters, 10000));
  }
  const config = clone(value);
  config.serviceCapabilities = capabilities(value.serviceCapabilities, ['recommendationsEnabled', 'groupRecommendationsEnabled', 'locationSearchEnabled', 'placeSearchEnabled'], ['recommendationsEnabled', 'groupRecommendationsEnabled', 'locationSearchEnabled', 'placeSearchEnabled']);
  assert(config.serviceCapabilities.groupRecommendationsEnabled === false);
  config.authCapabilities = capabilities(value.authCapabilities, AUTH_KEYS, ['dataExportEnabled', 'wechatMiniProgramEnabled']);
  config.persistenceCapabilities = capabilities(value.persistenceCapabilities, PERSISTENCE_KEYS);
  config.specialtyCapabilities = capabilities(value.specialtyCapabilities, SPECIALTY_KEYS);
  config.supportFeedbackEnabled = value.supportFeedbackEnabled === true;
  config.nearbyRestaurantCollectionEnabled = value.nearbyRestaurantCollectionEnabled === true;
  assert(config.persistenceCapabilities.favoritesEnabled === config.favoritesEnabled);
  if (!config.accountsEnabled) assert(!config.authCapabilities.accountsEnabled);
  if (config.dataRightsMode === 'LIVE_DISPLAY_ONLY') assert(PERSISTENCE_KEYS.every(key => !config.persistenceCapabilities[key]));
  return freeze(config);
}
function belowVersion(current, minimum) {
  const left = current.split('-')[0].split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}
async function refreshConfig() {
  if (!state.consent) throw failure('请先阅读并同意隐私政策。', 'CONSENT_REQUIRED');
  state.epoch += 1;
  recommendationSequence += 1;
  abortRequests();
  const epoch = state.epoch;
  state.config = null;
  state.results = null;
  state.status = 'loading';
  state.error = '';
  try {
    const config = validateConfig(await request('/v1/config'));
    active(epoch);
    const minimum = config.minimumSupportedVersions?.miniprogram || config.minimumSupportedVersion;
    if (belowVersion(VERSION, minimum)) throw failure('请更新小程序后继续使用，当前版本已不受支持。', 'UPDATE_REQUIRED');
    state.config = config;
    state.status = 'ready';
    if (!radiusExplicitlySelected && config.recommendationDefaults) state.filters.radiusMeters = config.recommendationDefaults.defaultRadiusMeters;
    return config;
  } catch (error) {
    active(epoch);
    const safe = safeFailures.has(error) ? error : invalidResponse();
    state.config = null;
    state.status = safe.code === 'UPDATE_REQUIRED' ? 'update-required' : 'error';
    state.error = safe.message;
    throw safe;
  }
}
function requireReady(capability) {
  assert(state.consent, '请先阅读并同意隐私政策。', 'CONSENT_REQUIRED');
  assert(state.status === 'ready' && state.config, '请先重新连接服务。', 'CONFIG_UNAVAILABLE');
  if (capability) assert(state.config.serviceCapabilities[capability] === true, '这项服务当前暂未开放。', 'CAPABILITY_UNAVAILABLE');
  return state.config;
}
function validLocation(value) {
  return object(value) && number(value.latitude, -90, 90) && number(value.longitude, -180, 180) && oneOf(value.crs, ['WGS84', 'GCJ02']) && (value.accuracyMeters === undefined || number(value.accuracyMeters, 0, 10000));
}
function locationValue(value) {
  assert(validLocation(value), '位置无效，请重新定位或手动选择地点。', 'INVALID_LOCATION');
  const copy = { latitude: value.latitude, longitude: value.longitude, crs: value.crs };
  if (value.accuracyMeters !== undefined) copy.accuracyMeters = value.accuracyMeters;
  return freeze(copy);
}
function clearRecommendation() {
  recommendationSequence += 1;
  abortRequests(entry => entry.path === '/v1/recommendations');
  state.results = null;
  state.error = '';
}
function setLocation(location, label) {
  assert(state.consent, '请先阅读并同意隐私政策。', 'CONSENT_REQUIRED');
  const validated = locationValue(location);
  assert(label === undefined || text(label, 0, 80), '地点名称过长，请重新选择。', 'INVALID_INPUT');
  clearRecommendation();
  abortRequests(entry => entry.path === '/v1/location-city');
  state.location = validated;
  state.locationLabel = label?.trim() || '当前位置';
}
function validateFilters(filters) {
  assert(object(filters) && Object.keys(filters).every(key => Object.keys(DEFAULT_FILTERS).includes(key)), '推荐条件无效。', 'INVALID_INPUT');
  assert(oneOf(filters.mealPeriod, ['BREAKFAST', 'LUNCH', 'DINNER']) && oneOf(filters.target, ['MEAL', 'MILK_TEA', 'COFFEE', 'DESSERT']), '推荐目标无效。', 'INVALID_INPUT');
  assert(oneOf(filters.decisionMode, ['QUICK', 'GUIDED']) && oneOf(filters.travelMode, ['WALK', 'BIKE', 'TRANSIT']) && oneOf(filters.explorationMode, ['SAFE', 'BALANCED', 'ADVENTUROUS']), '推荐条件无效。', 'INVALID_INPUT');
  assert(typeof filters.aiAssistanceEnabled === 'boolean' && (filters.budgetMaxYuan === null || integer(filters.budgetMaxYuan, 1, 2000)), '人均预算需在 1–2000 元之间。', 'INVALID_INPUT');
  assert(integer(filters.availableMinutes, 15, 240) && integer(filters.radiusMeters, 200, 10000), '请检查可用时间和搜索距离。', 'INVALID_INPUT');
  ['excludedCuisines', 'preferredCuisines'].forEach(key => { assert(Array.isArray(filters[key]) && filters[key].length <= 20 && filters[key].every(value => CUISINES.includes(value)) && new Set(filters[key]).size === filters[key].length, '菜系选项无效。', 'INVALID_INPUT'); });
  assert(!filters.preferredCuisines.some(value => filters.excludedCuisines.includes(value)), '偏好菜系和排除菜系不能重复。', 'INVALID_INPUT');
  assert(object(filters.preferenceVector) && Object.keys(filters.preferenceVector).length === 5 && Object.keys(DEFAULT_FILTERS.preferenceVector).every(key => integer(filters.preferenceVector[key], 0, 100)), '推荐偏好无效。', 'INVALID_INPUT');
  const weather = filters.weatherContext;
  assert(object(weather) && ((weather.kind === 'NONE' && Object.keys(weather).length === 1) || (weather.kind === 'USER_REPORTED' && Object.keys(weather).length === 2 && oneOf(weather.preference, ['MINIMIZE_EXPOSURE', 'WARMING', 'COOLING']))), '本次体感条件无效。', 'INVALID_INPUT');
}
function setFilters(partial) {
  assert(object(partial), '推荐条件无效。', 'INVALID_INPUT');
  const next = Object.assign({}, state.filters, partial);
  validateFilters(next);
  if (Object.keys(partial).includes('radiusMeters')) radiusExplicitlySelected = true;
  clearRecommendation();
  state.filters = clone(next);
}
async function searchLocations(keyword) {
  requireReady('locationSearchEnabled');
  assert(typeof keyword === 'string', '请输入地点名称。', 'INVALID_INPUT');
  const query = keyword.trim();
  assert(query.length >= 2 && query.length <= 80 && !containsControl(query) && !query.includes('|') && !/(?:^|\s)[+-]?\d{1,3}(?:\.\d+)?\s*[,，]\s*[+-]?\d{1,3}(?:\.\d+)?(?:\s|$)/.test(query) && !/(?:^|\D)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?:\D|$)/.test(query) && !/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/.test(query), '请输入 2–80 字的地点名称，不要输入坐标、手机号或邮箱。', 'INVALID_INPUT');
  const epoch = state.epoch;
  const result = await request('/v1/location-search', { method: 'POST', data: { query } });
  active(epoch);
  assert(object(result) && UUID.test(result.requestId) && /^[A-Z][A-Z0-9_]{1,31}$/.test(result.dataSource) && oneOf(result.dataMode, ['LIVE', 'DEMO']) && Array.isArray(result.results) && result.results.length <= 5);
  result.results.forEach((item, index) => { assert(object(item) && text(item.name, 1, 120) && (item.address === null || text(item.address, 0, 200)) && text(item.sourceLabel, 1, 80) && validLocation(item.location) && item.providerRank === index + 1); });
  return freeze(result);
}
async function cityFor(location) {
  requireReady('locationSearchEnabled');
  const coordinate = locationValue(location);
  const epoch = state.epoch;
  const result = await request('/v1/location-city', { method: 'POST', data: { location: { latitude: coordinate.latitude, longitude: coordinate.longitude, crs: coordinate.crs } } });
  active(epoch);
  assert(object(result) && Object.keys(result).length === 1 && (result.city === null || text(result.city, 1, 80)));
  return result.city;
}

function matchingProfile(profile, context) {
  if (!object(profile) || profile.target !== context.target || !text(profile.version, 1, 80)) return false;
  const expected = context.target === 'MEAL' ? `MEAL_${context.mealPeriod}` : context.target;
  const legacy = profile.family === 'MEAL_LEGACY' && context.target === 'MEAL' && context.mealPeriod === 'LUNCH' && context.weatherContext.kind === 'NONE';
  if (profile.family !== expected && !legacy) return false;
  const prefixes = { MEAL_LEGACY: 'meal-legacy', MEAL_BREAKFAST: 'meal-breakfast', MEAL_LUNCH: 'meal-lunch', MEAL_DINNER: 'meal-dinner', MILK_TEA: 'milk-tea', COFFEE: 'coffee', DESSERT: 'dessert' };
  return profile.providerCapabilityRequired === (context.target !== 'MEAL') && new RegExp(`^${prefixes[profile.family]}-v[1-9]\\d*$`).test(profile.version);
}
function matchingWeather(value, requestWeather) {
  if (!object(value) || !text(value.version, 1, 80)) return false;
  if (requestWeather.kind === 'NONE') return value.kind === 'NONE' && value.queryModifier === null && value.preference == null && /^weather-none-v[1-9]\d*$/.test(value.version);
  const modifiers = { MINIMIZE_EXPOSURE: 'MINIMIZE_OUTDOOR_EXPOSURE', WARMING: 'PREFER_WARMING_OPTIONS', COOLING: 'PREFER_COOLING_OPTIONS' };
  return value.kind === 'USER_REPORTED' && value.preference === requestWeather.preference && value.queryModifier === modifiers[requestWeather.preference] && /^user-reported-weather-v[1-9]\d*$/.test(value.version);
}
function validateRecommendation(value, context, config) {
  assert(object(value) && UUID.test(value.requestId) && isoDate(value.generatedAt) && value.coverage === 'NATIONWIDE' && value.dataRightsMode === config.dataRightsMode);
  const timestamp = Date.parse(value.generatedAt);
  assert(timestamp <= Date.now() + 60000 && Date.now() - timestamp < 2 * 60 * 60 * 1000);
  ['ruleVersion', 'promptVersion', 'modelVersion'].forEach(key => { assert(text(value[key], 1, 160)); });
  assert(value.rulesConfigVersion === undefined || value.rulesConfigVersion === null || integer(value.rulesConfigVersion, 1, Number.MAX_SAFE_INTEGER));
  assert(typeof value.aiFallbackUsed === 'boolean' && (value.notice === null || text(value.notice, 0, 500)));
  const profile = value.profile === undefined ? { target: 'MEAL', family: 'MEAL_LEGACY', version: 'meal-legacy-v1', providerCapabilityRequired: false } : value.profile;
  const weather = value.weatherApplication === undefined ? { kind: 'NONE', version: 'weather-none-v1', queryModifier: null } : value.weatherApplication;
  assert(matchingProfile(profile, context) && matchingWeather(weather, context.weatherContext));
  assert(Array.isArray(value.results) && value.results.length <= 3);
  if (!context.aiAssistanceEnabled) assert(value.aiFallbackUsed === false);
  const tokens = new Set();
  const exclusions = context.excludedCuisines.flatMap(cuisine => cuisine === '川湘菜' ? ['川湘菜', '川菜', '湘菜'] : [cuisine]);
  value.results.forEach((item, index) => {
    assert(object(item) && /^[A-Z][A-Z0-9_]{1,31}$/.test(item.provider) && typeof item.resultToken === 'string' && TOKEN.test(item.resultToken) && !tokens.has(item.resultToken));
    tokens.add(item.resultToken);
    assert(oneOf(item.dataMode, ['LIVE', 'DEMO']) && item.rank === index + 1 && text(item.name, 1, 120) && text(item.address, 0, 300));
    assert(object(item.actions) && Object.keys(item.actions).length === 4 && ['navigate', 'call', 'copyAddress', 'share'].every(key => typeof item.actions[key] === 'boolean'));
    assert(item.fitScore === null || number(item.fitScore, 0, 100));
    if (value.dataRightsMode === 'LIVE_DISPLAY_ONLY') assert(item.fitScore === null && item.actions.share === false);
    assert(item.sourceRating === null || number(item.sourceRating, 0, 5));
    assert(item.averageCostYuan === null || number(item.averageCostYuan, 0, Number.MAX_SAFE_INTEGER));
    assert(number(item.distanceMeters, 0, context.radiusMeters) && number(item.estimatedTravelMinutes, 0, Number.MAX_SAFE_INTEGER) && number(item.estimatedMealMinutes, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER));
    assert(oneOf(item.openStatus, ['OPEN', 'UNKNOWN']) && validLocation(item.location));
    assert(item.averageCostYuan === null || context.budgetMaxYuan === null || item.averageCostYuan <= context.budgetMaxYuan);
    assert(stringArray(item.tags, 20, 40) && item.tags.every(tag => tag.trim() && !exclusions.some(exclusion => tag.trim().toLowerCase().includes(exclusion))));
    assert(stringArray(item.warnings, 20, 200));
    assert(item.imageUrl === null || (typeof item.imageUrl === 'string' && !containsControl(item.imageUrl) && /^https:\/\/[A-Za-z0-9.-]+(?::443)?(?:[/?#][^\s]*)?$/i.test(item.imageUrl)));
    assert(item.phone === null || text(item.phone, 0, 100));
    assert(Array.isArray(item.reasons) && item.reasons.length >= 1 && item.reasons.length <= 4 && item.reasons.every(reason => object(reason) && oneOf(reason.code, ['TIME_FIT', 'BUDGET_FIT', 'DISTANCE_FIT', 'MEAL_FIT', 'QUALITY_SIGNAL', 'DIVERSITY']) && text(reason.text, 1, 120)));
    assert(oneOf(item.confidence, ['LOW', 'MEDIUM', 'HIGH']) && typeof item.aiAssisted === 'boolean' && text(item.sourceAttribution, 1, 100));
    if (!context.aiAssistanceEnabled) assert(item.aiAssisted === false);
  });
  // Keep the provider array in its original order, including when filtering in UI.
  return freeze(Object.assign({}, value, { profile, weatherApplication: weather }));
}
async function recommend() {
  const config = requireReady('recommendationsEnabled');
  const location = locationValue(state.location);
  validateFilters(state.filters);
  const context = clone(state.filters);
  const specialties = config.specialtyCapabilities;
  const targetKey = { MILK_TEA: 'milkTeaEnabled', COFFEE: 'coffeeEnabled', DESSERT: 'dessertEnabled' }[context.target];
  if (targetKey) assert(specialties[targetKey], '当前推荐目标暂未开放。', 'CAPABILITY_UNAVAILABLE');
  if (context.target === 'MEAL' && context.mealPeriod !== 'LUNCH') assert(specialties[context.mealPeriod === 'BREAKFAST' ? 'breakfastProfileEnabled' : 'dinnerProfileEnabled'], '当前餐段暂未开放。', 'CAPABILITY_UNAVAILABLE');
  if (context.weatherContext.kind === 'USER_REPORTED') assert(specialties.userReportedWeatherEnabled, '手动体感条件当前暂未开放。', 'CAPABILITY_UNAVAILABLE');
  const maximum = config.recommendationDefaults ? config.recommendationDefaults.maximumRadiusMeters : 10000;
  assert(context.radiusMeters <= maximum, '搜索距离超过当前服务范围，请调整距离。', 'INVALID_INPUT');
  context.aiAssistanceEnabled = context.aiAssistanceEnabled && config.aiEnabled && context.target === 'MEAL' && context.mealPeriod === 'LUNCH' && context.weatherContext.kind === 'NONE';
  if (config.dataRightsMode === 'LIVE_DISPLAY_ONLY') {
    context.preferredCuisines = [];
    context.preferenceVector = clone(DEFAULT_FILTERS.preferenceVector);
    context.explorationMode = 'BALANCED';
  }
  context.location = location;
  if (state.locationLabel.trim()) context.locationLabel = state.locationLabel.trim().slice(0, 80);
  context.partySize = 1;
  context.requestTime = new Date().toISOString();
  clearRecommendation();
  const sequence = recommendationSequence;
  const epoch = state.epoch;
  try {
    const value = await request('/v1/recommendations', { method: 'POST', data: context });
    active(epoch);
    if (sequence !== recommendationSequence || config !== state.config) throw cancelled();
    const result = validateRecommendation(value, context, config);
    state.results = result;
    return result;
  } catch (error) {
    active(epoch);
    if (sequence !== recommendationSequence) throw cancelled();
    const safe = safeFailures.has(error) ? error : invalidResponse();
    state.results = null;
    state.error = safe.message;
    throw safe;
  }
}

function recordEvent(index, type, expectedResponse) {
  const response = state.results;
  if (!state.consent || state.status !== 'ready' || !state.config?.serviceCapabilities.recommendationsEnabled || !response || response !== expectedResponse || !Number.isInteger(index) || !response.results[index] || !oneOf(type, ['IMPRESSION', 'DETAIL', 'NAVIGATION', 'CALL', 'REROLL'])) return Promise.resolve(false);
  const age = Date.now() - Date.parse(response.generatedAt);
  if (!Number.isFinite(age) || age < -60000 || age >= 7200000) return Promise.resolve(false);
  const epoch = state.epoch;
  const data = { requestId: response.requestId, resultToken: response.results[index].resultToken, type, occurredAt: new Date().toISOString() };
  return request('/v1/recommendation-events', { method: 'POST', data }).then(() => epoch === state.epoch && state.results === response, () => false);
}

module.exports = { VERSION, DEFAULT_FILTERS, state, setConsent, refreshConfig, request, requestBytes, searchLocations, cityFor, recommend, recordEvent, setLocation, setFilters, invalidate };
