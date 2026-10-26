// Researched reference recipes are not verified recipes from these stalls.
const menu = require('../data/canteen-menu');
const reference = require('../data/canteen-attributes');
const STAPLE_LABELS = Object.freeze({ RICE: '米饭', NOODLES: '面条', RICE_NOODLES: '米线',
  RICE_ROLL: '肠粉', DUMPLINGS: '水饺', WONTON: '馄饨／扁食', FLATBREAD: '饼',
  TANGYUAN: '汤圆', MIXED: '自选主食', NONE: '无固定主食' });
const TEMPERATURE_LABELS = Object.freeze({ HOT: '热食', ROOM: '常温', MIXED: '冷热搭配' });
const SPICY_LABELS = Object.freeze({ 0: '不辣', 1: '微微辣', 3: '中辣', 4: '麻辣', 6: '特辣Ultra' });
const attributes = new Map(reference.schemaVersion === 1 && reference.menuVersion === menu.version && Array.isArray(reference.items)
  ? reference.items.map(item => [item.itemId, item]) : []);
const FILTER_OPTIONS = Object.freeze({
  stapleType: [{ value: null, label: '不限主食' }, ...Object.keys(STAPLE_LABELS).map(value => ({ value, label: STAPLE_LABELS[value] }))],
  hasSoup: [{ value: null, label: '汤汁不限' }, { value: true, label: '带汤' }, { value: false, label: '不带汤' }],
  temperature: [{ value: null, label: '温度不限' }, ...Object.keys(TEMPERATURE_LABELS).map(value => ({ value, label: TEMPERATURE_LABELS[value] }))],
});
function getAttributes(itemId) {
  const value = attributes.get(itemId);
  if (!value || !Object.keys(STAPLE_LABELS).includes(value.stapleType) ||
    !['LIGHT', 'HEAVY'].includes(value.flavor) || !Number.isInteger(value.spicyLevel) ||
    !Object.keys(SPICY_LABELS).includes(String(value.spicyLevel)) ||
    typeof value.hasSoup !== 'boolean' || !Object.keys(TEMPERATURE_LABELS).includes(value.temperature) ||
    !Array.isArray(value.sourceIds) || !value.sourceIds.length || value.sourceIds.some(id => typeof id !== 'string')) return null;
  return { ...value, sourceIds: [...value.sourceIds] };
}
function labels(itemId) {
  const value = getAttributes(itemId);
  return value ? [STAPLE_LABELS[value.stapleType], value.flavor === 'LIGHT' ? '清淡' : '重口味',
    SPICY_LABELS[value.spicyLevel], value.hasSoup ? '带汤' : '不带汤', TEMPERATURE_LABELS[value.temperature]] : [];
}
module.exports = { STAPLE_LABELS, TEMPERATURE_LABELS, SPICY_LABELS, FILTER_OPTIONS, getAttributes, labels };
