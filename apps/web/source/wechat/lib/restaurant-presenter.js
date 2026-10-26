// Display and navigation bindings for transient, server-validated restaurants.
// No menu, dish, provider identifier, coordinate or result token enters page data.
const RESULT_TTL_MS = 2 * 60 * 60 * 1000;
const SELECTION_TTL_MS = 60 * 1000;
const OPEN_LABELS = { OPEN: '营业中', CLOSED: '已休息', UNKNOWN: '营业状态未知' };
const pendingSelections = new Map();
let nextSelection = 0;

function available(state, pool = false) {
  const capability = pool ? 'restaurantDecisionPoolEnabled' : 'recommendationsEnabled';
  return !!(state?.consent && state.status === 'ready' && state.config?.serviceCapabilities?.[capability] === true);
}

function hasLocation(state) {
  const location = state?.location;
  return !!(location && ['GCJ02', 'WGS84'].includes(location.crs) && Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) && Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180);
}

function currentResponse(state, expected = state.results, now = Date.now()) {
  const pool = !!expected?.pool;
  if (!available(state, pool) || !hasLocation(state) || !expected || state.results !== expected ||
    !['LIVE_DISPLAY_ONLY', 'LICENSED_ENRICHMENT'].includes(expected.dataRightsMode) ||
    (pool ? expected.dataRightsMode !== 'LIVE_DISPLAY_ONLY' : expected.dataRightsMode !== state.config.dataRightsMode)) return null;
  const timestamp = Date.parse(expected.generatedAt);
  const age = now - timestamp;
  if (!Number.isFinite(timestamp) || age < -60000 || age >= RESULT_TTL_MS) return null;
  if (!Array.isArray(expected.results) || expected.results.length > (pool ? 1 : 3) ||
    expected.results.some(result => result?.dataMode !== 'LIVE' || result.provider === 'DEMO')) return null;
  return expected;
}

function inline(value) { return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : ''; }

function imageUrl(value) {
  if (typeof value !== 'string' || Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code >= 127 && code <= 159;
  })) return '';
  return /^https:\/\/[A-Za-z0-9.-]+(?::443)?(?:[/?#][^\s]*)?$/i.test(value) ? value : '';
}

function phoneNumber(value) {
  const text = inline(value);
  if (!/^[+\d\s()（）-]+$/.test(text)) return '';
  const normalized = text.replace(/[\s()（）-]/g, '');
  return /^\+?\d{5,20}$/.test(normalized) ? normalized : '';
}

function mapCoordinate(location) {
  return !!(location && location.crs === 'GCJ02' && Number.isFinite(location.latitude) && Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180);
}

function actionsFor(result) {
  const actions = result?.actions || {};
  const canNavigate = actions.navigate === true && mapCoordinate(result.location) && !!(inline(result.name) || inline(result.address));
  const canCall = actions.call === true && !!phoneNumber(result.phone);
  const canCopy = actions.copyAddress === true && !!inline(result.address);
  const messages = [];
  if (!actions.navigate || !actions.call || !actions.copyAddress) messages.push('当前数据来源尚未开放部分操作。');
  if (actions.navigate && !canNavigate) messages.push('地图信息不完整，暂时无法导航。');
  if (actions.call && !canCall) messages.push('联系电话未知。');
  if (actions.copyAddress && !canCopy) messages.push('餐厅地址未知。');
  return { canNavigate, canCall, canCopy, actionNotice: messages.join(' ') };
}

function presentRestaurant(result, index) {
  return {
    index, name: inline(result.name),
    // Only the backend's restaurant image field is used; no dish art or
    // synthesized provider/photo lookup can substitute for a missing image.
    imageUrl: imageUrl(result.imageUrl),
    address: inline(result.address) || '地址未知',
    price: Number.isFinite(result.averageCostYuan) ? `约 ¥${result.averageCostYuan} / 人` : '人均未知',
    distance: !Number.isFinite(result.distanceMeters) ? '距离未知' : result.distanceMeters < 1000 ? `约 ${Math.round(result.distanceMeters)} 米` : `约 ${(result.distanceMeters / 1000).toFixed(1)} 公里`,
    travel: Number.isFinite(result.estimatedTravelMinutes) ? `预计 ${Math.ceil(result.estimatedTravelMinutes)} 分钟` : '出行时间未知',
    phone: inline(result.phone) || '电话未知',
    openLabel: OPEN_LABELS[result.openStatus] || OPEN_LABELS.UNKNOWN,
    openTone: result.openStatus === 'OPEN' ? 'open' : result.openStatus === 'CLOSED' ? 'closed' : 'unknown',
    tags: result.tags.map(inline),
    reasons: result.reasons.map(reason => ({ code: reason.code, text: inline(reason.text) })),
    warnings: result.warnings.map(inline),
    sourceAttribution: inline(result.sourceAttribution),
  };
}

function selectionFor(response, index, epoch, tasteRevision) {
  const now = Date.now();
  for (const [key, selection] of pendingSelections) if (selection.expiresAt <= now) discardSelection(key);
  const result = response?.results?.[index];
  const expiresAt = Math.min(now + SELECTION_TTL_MS, Date.parse(response?.generatedAt) + RESULT_TTL_MS);
  if (!Number.isInteger(index) || !result || result.dataMode !== 'LIVE' || result.provider === 'DEMO' ||
    !Number.isFinite(expiresAt) || expiresAt <= now || Date.parse(response.generatedAt) > now + 60000) return null;
  const key = String(++nextSelection);
  // A short local reference binds navigation to the exact response, never to
  // whichever restaurant later happens to occupy the same result index.
  const timer = setTimeout(() => pendingSelections.delete(key), Math.max(1, expiresAt - now));
  pendingSelections.set(key, { response, index, epoch, tasteRevision, expiresAt, timer });
  if (pendingSelections.size > 8) discardSelection(pendingSelections.keys().next().value);
  return key;
}

function takeSelection(key) {
  if (typeof key !== 'string' || !/^\d+$/.test(key)) return null;
  const selection = pendingSelections.get(key) || null;
  discardSelection(key);
  return selection && selection.expiresAt > Date.now() ? selection : null;
}

function discardSelection(key) {
  const selection = pendingSelections.get(key);
  if (selection) clearTimeout(selection.timer);
  pendingSelections.delete(key);
}

module.exports = { RESULT_TTL_MS, SELECTION_TTL_MS, available, hasLocation, currentResponse, inline, imageUrl, phoneNumber, mapCoordinate,
  actionsFor, presentRestaurant, selectionFor, takeSelection, discardSelection };
