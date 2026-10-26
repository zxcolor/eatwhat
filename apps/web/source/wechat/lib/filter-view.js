const catalog = require('./decision/catalog');
const core = require('./decision/core');
const { canonical } = require('./decision/digest');

const SPICY_CHOICES = [
  { value: null, label: '不限辣度' }, { value: 0, label: '不辣' },
  { value: 1, label: '微辣以内' }, { value: 2, label: '中辣以内' },
  { value: 3, label: '辣一点也可以' },
];
const PRIORITY_LABELS = { price: '价格', distance: '虚拟距离', main: '模拟正餐' };
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function money(cents) { return (cents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'); }

function createFilterDraft(state) {
  const options = state.options;
  return copy({
    budgetCents: options.budgetCents, maxDistanceUnits: options.maxDistanceUnits,
    maxSpicy: options.maxSpicy, vegetarianOnly: options.vegetarianOnly,
    preferMain: options.preferMain, weights: options.weights,
  });
}
function filterStateKey(state) {
  return canonical({ target: state.target, origin: state.origin, options: state.options, revision: state.revision });
}
function filterBounds(state) {
  return {
    budgetMax: Math.max(100, Math.ceil((state.options.budgetCents || 0) / 1000) * 10),
    distanceMax: Math.max(1500, Math.ceil((state.options.maxDistanceUnits || 0) / 100) * 100),
  };
}
function range(value, maximum, text) {
  const current = value === null ? maximum : value;
  return { value: current, maximum, unlimited: value === null, text,
    bubblePercent: Math.max(14, Math.min(86, current / maximum * 100)) };
}

function presentFilters(state, draft, bounds = filterBounds(state)) {
  const budgetText = draft.budgetCents === null ? '不限预算' : `${money(draft.budgetCents)} 元内`;
  const distanceText = draft.maxDistanceUnits === null ? '不限距离' : `${draft.maxDistanceUnits} 虚拟单位内`;
  const spicyChoices = SPICY_CHOICES.map((option, index) => ({ ...option, index, selected: option.value === draft.maxSpicy }));
  // Preserve a supported existing value outside the regular UI choices on open.
  if (!spicyChoices.some(option => option.selected) && Number.isInteger(draft.maxSpicy)) {
    spicyChoices.push({ value: draft.maxSpicy, label: `模拟辣度 ${draft.maxSpicy} 以内`, index: spicyChoices.length, selected: true });
  }
  const summary = [
    { id: 'budget', label: budgetText }, { id: 'distance', label: distanceText },
    { id: 'spicy', label: spicyChoices.find(option => option.selected)?.label || '辣度未知' },
  ];
  if (draft.vegetarianOnly) summary.push({ id: 'vegetarian', label: '仅模拟素食' });
  if (state.target === 'PACKAGE' && draft.preferMain) summary.push({ id: 'main', label: '优先模拟正餐' });
  const priorities = Object.keys(PRIORITY_LABELS)
    .filter(key => key !== 'main' || state.target === 'PACKAGE')
    .map(key => ({ key, label: PRIORITY_LABELS[key], value: draft.weights[key],
      inactive: key === 'main' && !draft.preferMain,
      description: key === 'main' && !draft.preferMain ? '正餐优先未开启' : draft.weights[key] === 0 ? '不参考'
        : draft.weights[key] === 6 ? '很在意' : `${draft.weights[key]} / 6` }));
  return {
    target: state.target, targetUnit: state.target === 'PACKAGE' ? '份套餐' : '家餐厅',
    originLabel: state.origin.label,
    budget: range(draft.budgetCents === null ? null : draft.budgetCents / 100, bounds.budgetMax, budgetText),
    distance: range(draft.maxDistanceUnits, bounds.distanceMax, distanceText),
    spicyChoices, vegetarianOnly: draft.vegetarianOnly, preferMain: draft.preferMain, priorities, summary,
  };
}

function evaluateFilters(state, draft) {
  // A preview has no service/session/journal dependency and never chooses a result.
  // Taste is read from the opening state, and is deliberately absent from the draft.
  const problem = catalog.buildProblem({ target: state.target,
    origin: { x: state.origin.x, y: state.origin.y }, ...copy(draft), taste: copy(state.options.taste) });
  core.validate(problem);
  const conditions = problem.request.conditions.filter(condition => condition.enabled !== false);
  const contradictory = core.conflicts(problem).length > 0;
  const counts = { total: problem.candidates.length, feasible: 0, unknown: 0, rejected: 0 };
  for (const candidate of problem.candidates) {
    const verdicts = conditions.map(condition => core.evaluate(candidate, condition).verdict);
    if (contradictory || verdicts.includes('violated')) counts.rejected += 1;
    else if (verdicts.includes('insufficient')) counts.unknown += 1;
    else counts.feasible += 1;
  }
  return counts;
}

module.exports = { createFilterDraft, filterStateKey, filterBounds, presentFilters, evaluateFilters };
