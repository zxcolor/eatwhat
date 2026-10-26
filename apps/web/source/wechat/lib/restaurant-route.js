const service = require('./service');
const PATH = '/v1/restaurant-decisions/route';
function invalid() { const error = new Error('路线信息不完整，请重试或打开微信地图。'); error.code = 'INVALID_ROUTE'; return error; }
function check(value) { if (!value) throw invalid(); }
function fields(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.keys(value).includes(key)); }
function number(value, maximum = 1000000) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum; }
function point(value) { return fields(value, ['latitude', 'longitude']) && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180; }
function coordinate(value, systems) { return fields(value, ['latitude', 'longitude', 'crs']) && point({ latitude: value.latitude, longitude: value.longitude }) && systems.includes(value.crs); }
function inline(value, maximum) { return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value && !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }); }
function closePoint(a, b) { return Math.abs(a.latitude - b.latitude) <= 0.00001 && Math.abs(a.longitude - b.longitude) <= 0.00001; }
function validateRoute(value, expected) {
  check(fields(value, ['provider', 'dataMode', 'generatedAt', 'travelMode', 'origin', 'destination', 'distanceMeters', 'durationSeconds', 'points', 'steps', 'sourceAttribution']));
  check(value.provider === 'AMAP' && value.dataMode === 'LIVE' && ['WALK', 'BIKE'].includes(value.travelMode) && value.travelMode === expected.travelMode);
  const generated = Date.parse(value.generatedAt);
  check(typeof value.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.generatedAt) && Number.isFinite(generated) && generated <= Date.now() + 60000 && generated > Date.now() - 120000);
  check(coordinate(value.origin, ['GCJ02']) && coordinate(value.destination, ['GCJ02']) && closePoint(value.destination, expected.destination));
  if (expected.origin.crs === 'GCJ02') check(closePoint(value.origin, expected.origin));
  check(number(value.distanceMeters) && number(value.durationSeconds, 7 * 86400) && inline(value.sourceAttribution, 160));
  check(Array.isArray(value.points) && value.points.length >= 2 && value.points.length <= 4096 && value.points.every(point));
  check(Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 256);
  let next = 0;
  value.steps.forEach(step => {
    check(fields(step, ['instruction', 'roadName', 'distanceMeters', 'startPointIndex', 'endPointIndex', 'action']));
    check(inline(step.instruction, 500) && (step.roadName === null || inline(step.roadName, 160)) && (step.action === null || inline(step.action, 80)) && number(step.distanceMeters));
    check(Number.isInteger(step.startPointIndex) && Number.isInteger(step.endPointIndex) && step.startPointIndex === next && step.endPointIndex > next && step.endPointIndex < value.points.length);
    next = step.endPointIndex + 1;
  });
  check(next === value.points.length);
  return value;
}
async function fetchRoute(input) {
  check(fields(input, ['requestId', 'resultToken', 'origin', 'destination', 'travelMode']) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId) && /^[A-Za-z0-9_-]{43}$/.test(input.resultToken));
  check(coordinate(input.origin, ['WGS84', 'GCJ02']) && coordinate(input.destination, ['GCJ02']) && ['WALK', 'BIKE'].includes(input.travelMode));
  const value = await service.request(PATH, { method: 'POST', data: input });
  return validateRoute(value, input);
}
function cancelRoute() { service.cancelRestaurantRoute(); }
function bounds(points) {
  const latitudes = points.map(item => item.latitude), longitudes = points.map(item => item.longitude);
  const south = Math.min(...latitudes), north = Math.max(...latitudes), west = Math.min(...longitudes), east = Math.max(...longitudes);
  return { center: { latitude: (south + north) / 2, longitude: (west + east) / 2 },
    includePoints: [{ latitude: south, longitude: west }, { latitude: north, longitude: east }] };
}
function distanceLabel(meters) { return meters < 1000 ? `${Math.round(meters)}米` : `${(meters / 1000).toFixed(1)}公里`; }
function durationLabel(seconds) { return seconds === 0 ? '0分钟' : seconds < 60 ? '不足1分钟' : `约${Math.ceil(seconds / 60)}分钟`; }
module.exports = { fetchRoute, cancelRoute, validateRoute, bounds, distanceLabel, durationLabel };
