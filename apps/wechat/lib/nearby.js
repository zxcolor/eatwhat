// Dedicated, authorized nearby snapshots. Recommendation responses never enter this store.
const PREFIX = 'eatwhat.wechat.nearby.snapshot.v1.';
const ENABLED_KEY = 'eatwhat.wechat.nearby.enabled.v1';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 768 * 1024;
const RESERVED_BYTES = 64 * 1024;
const PLACE_FIELDS = ['provider', 'providerPlaceId', 'name', 'address', 'location', 'sourceRating', 'averageCostYuan', 'openStatus', 'tags', 'phone', 'sourceAttribution', 'dataMode'];
const SNAPSHOT_FIELDS = ['schemaVersion', 'startedAtMillis', 'updatedAtMillis', 'radiusMeters', 'retentionDays', 'status', 'pagesCollected', 'limited', 'restaurants', 'userLocation'];
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value, names) { return object(value) && Object.keys(value).length === names.length && Object.keys(value).every(name => names.includes(name)); }
function number(value, min, max) { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function text(value, min, max) { return typeof value === 'string' && value.trim().length >= min && value.length <= max; }
function coordinate(value) {
  return keys(value, ['latitude', 'longitude', 'crs']) && number(value.latitude, -90, 90) && number(value.longitude, -180, 180) && ['WGS84', 'GCJ02'].includes(value.crs);
}
function error(message, code) { const result = new Error(message); result.code = code; return result; }
function invalid() { return error('附近餐厅数据不符合约定，未保存该页。', 'INVALID_RESPONSE'); }
function expired(started, now) { return !Number.isSafeInteger(started) || started <= 0 || started > now || now - started >= RETENTION_MS; }
function utf8Size(value) { return encodeURIComponent(value).replace(/%[A-F\d]{2}/gi, 'x').length; }

// Same one-way WGS84 -> GCJ02 alignment as Android CoordinateCrsTransform.
function align(origin, target) {
  if (origin.crs === target) return origin;
  if (origin.crs !== 'WGS84' || target !== 'GCJ02') return null;
  const { latitude: lat, longitude: lon } = origin;
  if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) return { latitude: lat, longitude: lon, crs: target };
  const x = lon - 105;
  const y = lat - 35;
  const pi = Math.PI;
  const sin = Math.sin;
  let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += (20 * sin(6 * x * pi) + 20 * sin(2 * x * pi)) * 2 / 3;
  dLat += (20 * sin(y * pi) + 40 * sin(y / 3 * pi)) * 2 / 3;
  dLat += (160 * sin(y / 12 * pi) + 320 * sin(y * pi / 30)) * 2 / 3;
  let dLon = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLon += (20 * sin(6 * x * pi) + 20 * sin(2 * x * pi)) * 2 / 3;
  dLon += (20 * sin(x * pi) + 40 * sin(x / 3 * pi)) * 2 / 3;
  dLon += (150 * sin(x / 12 * pi) + 300 * sin(x / 30 * pi)) * 2 / 3;
  const radians = lat / 180 * pi;
  const magic = 1 - 0.006693421622965943 * sin(radians) ** 2;
  return {
    latitude: lat + dLat * 180 / (6378245 * (1 - 0.006693421622965943) / (magic * Math.sqrt(magic)) * pi),
    longitude: lon + dLon * 180 / (6378245 / Math.sqrt(magic) * Math.cos(radians) * pi), crs: target,
  };
}
function withinRadius(origin, place) {
  const aligned = align(origin, place.crs);
  if (!aligned) return false;
  const radians = value => value * Math.PI / 180;
  const lat1 = radians(aligned.latitude);
  const lat2 = radians(place.latitude);
  const a = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(radians(place.longitude - aligned.longitude) / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, a));
  const distance = 6371000 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
  return Number.isFinite(distance) && distance <= 3500;
}
function validRestaurant(place, origin) {
  return keys(place, PLACE_FIELDS) && typeof place.provider === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(place.provider) &&
    text(place.providerPlaceId, 1, 160) && text(place.name, 1, 160) && text(place.address, 0, 240) && coordinate(place.location) &&
    (place.sourceRating === null || number(place.sourceRating, 0, 5)) && (place.averageCostYuan === null || number(place.averageCostYuan, 0, 20000)) &&
    ['OPEN', 'CLOSED', 'UNKNOWN'].includes(place.openStatus) && Array.isArray(place.tags) && place.tags.length <= 20 && place.tags.every(tag => text(tag, 1, 80)) &&
    (place.phone === null || text(place.phone, 0, 160)) && text(place.sourceAttribution, 1, 80) && ['LIVE', 'DEMO'].includes(place.dataMode) && withinRadius(origin, place.location);
}
function validatePage(value, page, origin) {
  if (!keys(value, ['radiusMeters', 'retentionDays', 'page', 'nextPage', 'truncated', 'restaurants']) ||
    value.radiusMeters !== 3500 || value.retentionDays !== 90 || value.page !== page || ![1, 2].includes(page) ||
    !(value.nextPage === null || value.nextPage === 2 && page === 1) || typeof value.truncated !== 'boolean' ||
    value.truncated && !(page === 2 && value.nextPage === null) || !Array.isArray(value.restaurants) || value.restaurants.length > 25 ||
    !value.restaurants.every(place => validRestaurant(place, origin))) throw invalid();
  return JSON.parse(JSON.stringify(value));
}
function validSnapshot(value, now) {
  if (!keys(value, SNAPSHOT_FIELDS) || value.schemaVersion !== 1 || expired(value.startedAtMillis, now) ||
    !Number.isSafeInteger(value.updatedAtMillis) || value.updatedAtMillis < value.startedAtMillis || value.updatedAtMillis > now ||
    value.radiusMeters !== 3500 || value.retentionDays !== 90 || !['COLLECTING', 'COMPLETE', 'PARTIAL'].includes(value.status) ||
    !Number.isInteger(value.pagesCollected) || value.pagesCollected < 0 || value.pagesCollected > 2 || typeof value.limited !== 'boolean' ||
    !keys(value.userLocation, ['latitude', 'longitude', 'crs', 'accuracyMeters']) ||
    !coordinate({ latitude: value.userLocation.latitude, longitude: value.userLocation.longitude, crs: value.userLocation.crs }) ||
    !(value.userLocation.accuracyMeters === null || number(value.userLocation.accuracyMeters, Number.MIN_VALUE, Number.MAX_VALUE)) ||
    !Array.isArray(value.restaurants) || value.restaurants.length > value.pagesCollected * 25 ||
    !value.restaurants.every(place => validRestaurant(place, value.userLocation))) return false;
  return !(value.status === 'COMPLETE' && value.pagesCollected === 0) && !(value.limited && (value.status !== 'COMPLETE' || value.pagesCollected !== 2));
}

function createNearby(options = {}) {
  const platform = () => options.platform || wx;
  const service = options.service || require('./service');
  const now = options.now || Date.now;
  const listeners = new Set();
  const cancellers = new Set();
  const state = { phase: 'IDLE', attempt: 0, count: 0, message: '', failure: null, location: null, limited: false, enabled: false, available: false };
  let foreground = false;
  let firstOpening = true;
  let started = 0;
  let attempted = false;
  let generation = 0;
  let sessionKey = null;
  let operation = null;
  function publish(values) { Object.assign(state, values); listeners.forEach(listener => { try { listener(state); } catch (_) { /* A view cannot interrupt storage cleanup. */ } }); }
  function reset() { publish({ phase: 'IDLE', attempt: 0, count: 0, message: '', failure: null, location: null, limited: false }); }
  function available() { return service.state.consent && service.state.status === 'ready' && service.state.config?.nearbyRestaurantCollectionEnabled === true; }
  function enabled() { try { return service.state.consent && platform().getStorageSync(ENABLED_KEY) === true; } catch (_) { return false; } }
  function storageInfo() {
    const value = platform().getStorageInfoSync();
    if (!object(value) || !Array.isArray(value.keys) || !value.keys.every(key => typeof key === 'string')) throw error('本机缓存暂不可用，请重试。', 'STORAGE_UNAVAILABLE');
    return value;
  }
  function rawRead(key) { const raw = platform().getStorageSync(key); return typeof raw === 'string' && utf8Size(raw) <= MAX_SNAPSHOT_BYTES ? JSON.parse(raw) : null; }
  function write(key, value) {
    const raw = JSON.stringify(value);
    const bytes = utf8Size(raw);
    const info = storageInfo();
    const old = platform().getStorageSync(key);
    const oldBytes = typeof old === 'string' ? utf8Size(old) : 0;
    if (bytes > MAX_SNAPSHOT_BYTES || !number(info.currentSize, 0, Number.MAX_SAFE_INTEGER) || !number(info.limitSize, 1, Number.MAX_SAFE_INTEGER) ||
      bytes > oldBytes && info.currentSize * 1024 - oldBytes + bytes + RESERVED_BYTES > info.limitSize * 1024) throw error('本机缓存空间不足，请先清除餐厅缓存再重试。', 'STORAGE_FULL');
    try { platform().setStorageSync(key, raw); }
    catch (_) { throw error('本机缓存保存失败，已保存的记录仍保留。请清理空间后重试。', 'STORAGE_UNAVAILABLE'); }
  }
  function listSnapshots() {
    try {
      const values = [];
      for (const key of storageInfo().keys.filter(key => key.startsWith(PREFIX))) {
        let value;
        try { value = rawRead(key); } catch (_) { value = null; }
        if (!service.state.consent || !validSnapshot(value, now()) || !/^\d{1,19}$/.test(key.slice(PREFIX.length))) platform().removeStorageSync(key);
        else {
          if (value.status === 'COLLECTING' && key !== sessionKey) { value.status = 'PARTIAL'; write(key, value); }
          values.push({ id: key.slice(PREFIX.length), ...value });
        }
      }
      return values.sort((a, b) => b.startedAtMillis - a.startedAtMillis);
    } catch (_) { throw error('本机餐厅缓存暂时无法读取或清理，请重试。', 'STORAGE_UNAVAILABLE'); }
  }
  function finish(key, complete, limited = false) {
    if (!key) return;
    const value = rawRead(key);
    if (!value) return; // Clear/withdrawal must never resurrect a deleted snapshot.
    if (expired(value.startedAtMillis, now())) { platform().removeStorageSync(key); return; }
    write(key, { ...value, status: complete ? 'COMPLETE' : 'PARTIAL', limited, updatedAtMillis: now() });
  }
  function cancel() {
    generation += 1;
    cancellers.forEach(cancelPending => { cancelPending(); });
    cancellers.clear();
    try { finish(sessionKey, false); } catch (_) { /* A readable COLLECTING file becomes PARTIAL on the next read. */ }
    sessionKey = null;
    operation = null;
  }
  function current(token, epoch) {
    if (token !== generation || epoch !== service.state.epoch || !foreground || !available() || !enabled()) throw error('本次收集已停止。', 'CANCELLED');
  }
  function waitFor(delay) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cancellers.delete(cancelPending); resolve(); }, delay);
      function cancelPending() { clearTimeout(timer); reject(error('本次收集已停止。', 'CANCELLED')); }
      cancellers.add(cancelPending);
    });
  }
  function locateOnce() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => done(error('定位超时，请重试。', 'LOCATION_UNAVAILABLE')), 15000);
      function done(problem, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancellers.delete(cancelPending);
        if (problem) reject(problem); else resolve(value);
      }
      function cancelPending() { done(error('本次收集已停止。', 'CANCELLED')); }
      cancellers.add(cancelPending);
      try {
        platform().getLocation({
          type: 'wgs84',
          success(value) {
            const origin = { latitude: value.latitude, longitude: value.longitude, crs: 'WGS84' };
            if (!coordinate(origin)) return done(error('定位结果不可用，请重试。', 'LOCATION_UNAVAILABLE'));
            origin.accuracyMeters = number(value.accuracy, Number.MIN_VALUE, Number.MAX_VALUE) ? value.accuracy : null;
            done(null, origin);
          },
          fail(value) {
            const denied = /auth deny|auth denied|authorize|permission|privacy/i.test(value?.errMsg || '');
            done(error(denied ? '定位未获授权。你仍可手动选择地点。' : '暂时无法定位，请稍后重试。', denied ? 'PERMISSION_DENIED' : 'LOCATION_UNAVAILABLE'));
          },
        });
      } catch (_) { done(error('当前环境无法定位。', 'LOCATION_UNAVAILABLE')); }
    });
  }
  async function collect(token, epoch) {
    let key = null;
    let complete = false;
    let limited = false;
    try {
      let origin;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        current(token, epoch);
        publish({ phase: 'LOCATING', attempt, message: '', failure: null });
        try { origin = await locateOnce(); break; }
        catch (problem) {
          current(token, epoch);
          if (problem.code === 'PERMISSION_DENIED' || attempt === 6) throw problem;
          await waitFor(options.retryDelayMs === undefined ? 1000 : options.retryDelayMs);
        }
      }
      current(token, epoch);
      listSnapshots();
      let timestamp = started;
      const keysInUse = new Set(storageInfo().keys);
      while (keysInUse.has(PREFIX + timestamp)) timestamp += 1;
      key = PREFIX + timestamp;
      // No user data is written until consent, capability, foreground and location all hold.
      write(key, { schemaVersion: 1, startedAtMillis: started, updatedAtMillis: now(), radiusMeters: 3500, retentionDays: 90, status: 'COLLECTING', pagesCollected: 0, limited: false, restaurants: [], userLocation: origin });
      sessionKey = key;
      publish({ phase: 'COLLECTING', location: origin, count: 0 });
      const requestOrigin = { latitude: origin.latitude, longitude: origin.longitude, crs: origin.crs };
      for (let page = 1; page <= 2;) {
        current(token, epoch);
        const response = await service.request('/v1/restaurants/nearby', { method: 'POST', data: { location: requestOrigin, page } });
        current(token, epoch);
        const value = validatePage(response, page, origin);
        const snapshot = rawRead(key);
        if (!snapshot || expired(snapshot.startedAtMillis, now())) throw error('本次缓存已清除或到期。', 'CANCELLED');
        const combined = new Map(snapshot.restaurants.map(place => [`${place.provider}\u0000${place.providerPlaceId}`, place]));
        value.restaurants.forEach(place => { combined.set(`${place.provider}\u0000${place.providerPlaceId}`, place); });
        write(key, { ...snapshot, updatedAtMillis: now(), pagesCollected: page, restaurants: Array.from(combined.values()) });
        publish({ count: combined.size });
        if (value.nextPage === null) { complete = true; limited = value.truncated; break; }
        page = value.nextPage;
      }
      current(token, epoch);
      finish(key, complete, limited);
      publish({ phase: 'DONE', limited, message: limited ? '已保存本次两页餐厅，供应商返回了截断标记。' : '本次附近餐厅已保存到本机。' });
    } catch (problem) {
      if (token === generation && foreground && problem.code === 'CANCELLED') publish({ phase: 'DONE', location: null, message: '' });
      if (token === generation && foreground && problem.code !== 'CANCELLED') publish({
        phase: problem.code === 'PERMISSION_DENIED' ? 'PERMISSION' : 'FAILED', failure: problem.code || 'COLLECTION_FAILED',
        message: ['STORAGE_FULL', 'STORAGE_UNAVAILABLE', 'PERMISSION_DENIED', 'LOCATION_UNAVAILABLE', 'INVALID_RESPONSE'].includes(problem.code)
          ? problem.message : '附近餐厅暂未全部保存，已获取的页仍保留。请稍后重试。',
      });
    } finally {
      if (token === generation) {
        try { if (!complete) finish(key, false); } catch (_) { /* Preserve the last successfully committed page. */ }
        sessionKey = null;
        operation = null;
      }
    }
  }
  function start() {
    if (!foreground || !available() || !enabled() || operation) return Promise.resolve();
    attempted = true;
    const token = ++generation;
    const epoch = service.state.epoch;
    operation = collect(token, epoch);
    return operation;
  }
  async function syncCapabilities() {
    publish({ available: available(), enabled: enabled() });
    if (!state.available || !state.enabled) {
      const phase = state.phase;
      cancel();
      if (phase === 'COLLECTING') publish({ phase: 'DONE', location: null });
      else if (phase === 'LOCATING' || phase === 'PERMISSION') { attempted = false; reset(); }
      return;
    }
    if (!foreground || attempted && state.phase !== 'PERMISSION') return;
    const token = generation;
    const epoch = service.state.epoch;
    let granted = false;
    try {
      granted = await new Promise(resolve => {
        platform().getSetting({ success: value => resolve(value.authSetting?.['scope.userLocation'] === true), fail: () => resolve(false) });
      });
    } catch (_) { granted = false; }
    try { current(token, epoch); } catch (_) { return; }
    if (attempted && state.phase !== 'PERMISSION') return;
    attempted = true;
    if (granted) return start();
    publish({ phase: 'PERMISSION', message: '允许定位后，每次打开可保存一份附近餐厅与本次定位记录。' });
  }
  function open(launchTimestamp) {
    if (foreground) return Promise.resolve();
    foreground = true;
    if (state.phase !== 'PERMISSION') {
      const time = firstOpening && Number.isSafeInteger(launchTimestamp) && launchTimestamp > 0 && launchTimestamp <= now() ? launchTimestamp : now();
      started = time;
      firstOpening = false;
      attempted = false;
      reset();
    }
    try { listSnapshots(); } catch (problem) { publish({ message: problem.message }); }
    return syncCapabilities();
  }
  function stop() { foreground = false; cancel(); publish({ location: null }); }
  function clear() {
    cancel();
    attempted = true;
    try {
      let failed = false;
      storageInfo().keys.filter(key => key.startsWith(PREFIX)).forEach(key => {
        try { platform().removeStorageSync(key); } catch (_) { failed = true; }
      });
      if (failed) throw error('缓存清理未完成。', 'STORAGE_UNAVAILABLE');
    }
    catch (_) { throw error('餐厅缓存清除失败，请重试。', 'STORAGE_UNAVAILABLE'); }
    publish({ phase: 'DONE', count: 0, location: null, limited: false, message: '餐厅缓存与定位记录已清除，下次打开时重新收集。' });
  }
  function withdraw() {
    stop();
    let failed = false;
    try { clear(); } catch (_) { failed = true; }
    try { platform().removeStorageSync(ENABLED_KEY); } catch (_) { failed = true; }
    publish({ enabled: false, available: false });
    reset();
    if (failed) throw error('缓存清理未完成，请重新尝试清除本机数据。', 'STORAGE_UNAVAILABLE');
  }
  function setEnabled(value) {
    if (typeof value !== 'boolean' || value && !service.state.consent) throw error('请先阅读并同意隐私说明。', 'CONSENT_REQUIRED');
    if (value) platform().setStorageSync(ENABLED_KEY, true);
    else { cancel(); platform().removeStorageSync(ENABLED_KEY); reset(); }
    publish({ enabled: value });
    return syncCapabilities();
  }
  function retry() {
    if (!foreground || !available() || !enabled()) return Promise.resolve();
    cancel();
    reset();
    return start(); // Called only by an explicit page action; wx owns its permission prompt.
  }
  function dismissReminder() { cancel(); attempted = true; publish({ phase: 'DONE', failure: null, message: '', location: null }); }
  return { state, open, syncCapabilities, stop, clear, withdraw, setEnabled, retry, dismissReminder, listSnapshots, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
module.exports = { ...createNearby(), createNearby, validatePage, withinRadius, PREFIX, ENABLED_KEY, RETENTION_MS, MAX_SNAPSHOT_BYTES };
