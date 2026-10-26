// Device-local declarations shared by the questionnaire and canteen flow.
// These fields do not imply restaurant-level dish attributes.
const SCHEMA_VERSION = 3;
const POLICY_VERSION = 'explicit-taste-five-levels-binary-flavor-v3';
const FIELDS = Object.freeze(['spicyLevel', 'flavorIntensity']);
const SPICY_LEVELS = Object.freeze(['不辣', '微微辣', '中辣', '麻辣', '特辣Ultra']);
// Preserve the API v1 seven-level meanings; UI positions are not wire values.
const SPICY_VALUES = Object.freeze([0, 1, 3, 4, 6]);
const DEFAULT_SPICY_LEVEL = 0;
const DEFAULT_FLAVOR_INTENSITY = null;
function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_TASTE_PROFILE';
  throw error;
}
function normalizeAnswers(input = {}) {
  if (input === null || typeof input !== 'object' || Object.prototype.toString.call(input) !== '[object Object]'
    || Object.keys(input).some(key => !FIELDS.includes(key))) invalid('偏好格式无效。');
  const answers = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (key === 'spicyLevel') {
      if (!Number.isInteger(value) || !SPICY_VALUES.includes(value)) invalid('请选择有效的辣度档位。');
    } else if (value !== 0 && value !== 100) invalid('请选择清淡或重口味。');
    answers[key] = value;
  }
  return answers;
}
function missingFields(input) {
  const answers = normalizeAnswers(input);
  return FIELDS.filter(key => !Object.keys(answers).includes(key));
}
function assessAnswers(input = {}) {
  const answers = normalizeAnswers(input);
  const missing = missingFields(answers);
  const complete = missing.length === 0;
  return { profileComplete: complete, personalizedReady: false, ready: complete,
    status: complete ? 'ready' : 'incomplete', missingFields: missing, signals: [], counts: {},
    limitations: ['辣度与口味轻重会完整保存；餐厅数据不包含对应菜品属性，不据此精细匹配。'],
    message: complete ? '口味已填写，确认后即可进入。' : '请拖动辣度滑条，并选择清淡或重口味。' };
}
module.exports = { SCHEMA_VERSION, POLICY_VERSION, FIELDS, SPICY_LEVELS, SPICY_VALUES,
  DEFAULT_SPICY_LEVEL, DEFAULT_FLAVOR_INTENSITY, normalizeAnswers, missingFields, assessAnswers };
