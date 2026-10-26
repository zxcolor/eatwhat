// biome-ignore lint/suspicious/noRedundantUseStrict: WeChat loads this as CommonJS, not an ES module.
'use strict';

/** Public-table research math, not an event/session protocol or a truth model.
 * planFeedback(input, strategy): input contains candidateOrder, eligibleIds,
 * anchorId (optional, must equal the lexicographic declared-utility maximizer),
 * declaredUtilities, models:[{id,prior,utilities}], responseModel:{errorRate,
 * tieMargin,skipRate,cannotJudgeRate}, queryCost, epsilon. Optional completeIds
 * excludes candidates with incomplete display facts; optional queryBudget is 0/1.
 * Strategies: static, bayes_no_query, active_voi, constrained,
 * constrained_no_query, constrained_fixed, anchored_active, anchored_fixed.
 * The alias fixed means anchored_fixed. All numeric outputs are reduced string
 * pairs. No-query anchored policies retain the exact original candidate ID.
 * applyAnswer(plan,label) recomputes a pure mathematical branch; it never binds
 * a user event, spends a persisted budget, or treats choice/reroll as an answer.
 * signalCostGate freezes an existing anchored q/g; signalCohortValue reports
 * the R7 cohort expression. evidenceBounds and sunkCostLedger implement R8
 * conditional bounds and separate incremental versus already-paid costs.
 * All outputs are JSON data and explicitly assumption-only, never real evidence.
 */
const { Fraction } = require('./rational');
const { canonical } = require('./digest');
const F = Fraction.from;
const Z = F(0);
const O = F(1);
const LABELS = Object.freeze(['prefer_left', 'prefer_right', 'tie', 'skip', 'cannot_judge']);
const STRATEGIES = Object.freeze(['static', 'bayes_no_query', 'active_voi', 'constrained',
  'constrained_no_query', 'constrained_fixed', 'anchored_active', 'anchored_fixed']);
const FLAGS = Object.freeze({ assumptionOnly: true, externalAuthenticityVerified: false, realExecution: false, eventBound: false });
// biome-ignore lint/suspicious/noPrototypeBuiltins: Avoid requiring ES2022 Object.hasOwn in the WeChat runtime.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = (value) => JSON.parse(JSON.stringify(value));
const sum = (values) => values.reduce((total, value) => total.add(value), Z);
const wireMap = (values) => {
  const output = Object.create(null);
  Object.keys(values).forEach((key) => { output[key] = values[key].toPair(); });
  return output;
};
function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function ids(value, name, allowEmpty) {
  if (!Array.isArray(value) || value.length > 16 || (!allowEmpty && value.length === 0) ||
      value.some((id) => typeof id !== 'string' || !id || id.length > 128) || new Set(value).size !== value.length) {
    throw new TypeError(`${name} must contain unique nonempty IDs (at most 16)`);
  }
  return value.slice();
}
function fraction(value, name, minimum, maximum) {
  const result = F(value);
  if ((minimum !== undefined && result.cmp(minimum) < 0) || (maximum !== undefined && result.cmp(maximum) > 0)) {
    throw new RangeError(`${name} is outside its allowed interval`);
  }
  return result;
}
function table(value, names, name) {
  record(value, name);
  const result = Object.create(null);
  names.forEach((id) => {
    if (!own(value, id)) throw new TypeError(`${name} is missing candidate ${id}`);
    result[id] = fraction(value[id], name, Z, O);
  });
  return result;
}
function best(values, order) {
  let selected = null;
  order.forEach((id) => {
    if (own(values, id) && (selected === null || values[id].cmp(values[selected]) > 0)) selected = id;
  });
  return selected;
}
function means(models, belief, eligible) {
  const values = Object.create(null);
  eligible.forEach((id) => { values[id] = sum(models.map((model) => belief[model.id].mul(model.utilities[id]))); });
  return values;
}
function normalize(input) {
  record(input, 'input');
  const candidateOrder = ids(input.candidateOrder, 'candidateOrder', true);
  const eligibleInput = ids(input.eligibleIds, 'eligibleIds', true);
  if (eligibleInput.some((id) => !candidateOrder.includes(id))) throw new TypeError('eligibleIds must be in candidateOrder');
  const eligible = candidateOrder.filter((id) => eligibleInput.includes(id));
  const completeInput = input.completeIds === undefined ? eligible : ids(input.completeIds, 'completeIds', true);
  if (completeInput.some((id) => !eligible.includes(id))) throw new TypeError('completeIds must be eligible');
  const complete = candidateOrder.filter((id) => completeInput.includes(id));
  const declared = table(input.declaredUtilities, eligible, 'declaredUtilities');
  const anchor = best(declared, eligible.slice().sort());
  if (input.anchorId !== undefined && input.anchorId !== anchor) throw new TypeError('anchorId must be the exact declared-utility maximizer');
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 16) throw new TypeError('Expected 1 to 16 models');
  ids(input.models.map((model) => record(model, 'model').id), 'model IDs');
  const models = input.models.map((model) => ({ id: model.id, prior: fraction(model.prior, 'prior', Z),
    utilities: table(model.utilities, eligible, 'model utilities') }));
  const total = sum(models.map((model) => model.prior));
  if (total.cmp(Z) === 0) throw new RangeError('At least one model must have positive prior');
  const belief = Object.create(null);
  models.forEach((model) => { belief[model.id] = model.prior.div(total); });
  const response = record(input.responseModel, 'responseModel');
  const channel = {};
  ['errorRate', 'tieMargin', 'skipRate', 'cannotJudgeRate'].forEach((key) => {
    channel[key] = fraction(response[key], key, Z, O);
  });
  if (channel.skipRate.add(channel.cannotJudgeRate).cmp(O) > 0) throw new RangeError('skipRate + cannotJudgeRate exceeds one');
  const cost = fraction(input.queryCost, 'queryCost', Z);
  const epsilon = fraction(input.epsilon, 'epsilon', Z);
  const queryBudget = input.queryBudget === undefined ? 1 : input.queryBudget;
  if (queryBudget !== 0 && queryBudget !== 1) throw new RangeError('queryBudget must be 0 or 1');
  const snapshot = { candidateOrder, eligibleIds: eligible, completeIds: complete, anchorId: anchor,
    declaredUtilities: wireMap(declared), models: models.map((model) => ({ id: model.id,
      prior: belief[model.id].toPair(), utilities: wireMap(model.utilities) })),
    responseModel: wireMap(channel), queryCost: cost.toPair(), epsilon: epsilon.toPair(), queryBudget };
  return { candidateOrder, eligible, complete, declared, anchor, models, belief, channel, cost, epsilon, queryBudget, snapshot };
}
function certificate(tree, selected, paid, applicable) {
  if (selected === null || tree.anchor === null) return { applicable: false, selectedId: null, netLoss: null, margin: null, passed: null };
  const loss = tree.declared[tree.anchor].sub(tree.declared[selected]);
  const net = loss.add(paid);
  return { applicable, anchorId: tree.anchor, selectedId: selected, declaredLoss: loss.toPair(),
    paidCost: paid.toPair(), netLoss: net.toPair(), epsilon: tree.epsilon.toPair(),
    margin: tree.epsilon.sub(net).toPair(), passed: applicable ? net.cmp(tree.epsilon) <= 0 : null };
}
function branch(tree, left, right, label, allowed, anchored, constrained) {
  const likelihoods = Object.create(null);
  const joint = Object.create(null);
  const available = O.sub(tree.channel.skipRate).sub(tree.channel.cannotJudgeRate);
  tree.models.forEach((model) => {
    const difference = model.utilities[left].sub(model.utilities[right]);
    const predicted = difference.cmp(tree.channel.tieMargin) > 0 ? 'prefer_left' :
      difference.cmp(tree.channel.tieMargin.neg()) < 0 ? 'prefer_right' : 'tie';
    const likelihood = label === 'skip' ? tree.channel.skipRate : label === 'cannot_judge' ? tree.channel.cannotJudgeRate :
      available.mul(label === predicted ? O.sub(tree.channel.errorRate) : tree.channel.errorRate.div(2));
    likelihoods[model.id] = likelihood;
    joint[model.id] = tree.belief[model.id].mul(likelihood);
  });
  const mass = sum(Object.keys(joint).map((id) => joint[id]));
  const informative = label !== 'skip' && label !== 'cannot_judge';
  const after = Object.create(null);
  tree.models.forEach((model) => { after[model.id] = informative && mass.cmp(Z) > 0 ? joint[model.id].div(mass) : tree.belief[model.id]; });
  const values = means(tree.models, after, tree.eligible);
  let selected = best(values, allowed);
  let gate = null;
  if (anchored) {
    const challenger = left === tree.anchor ? right : left;
    const supports = (challenger === left && label === 'prefer_left') || (challenger === right && label === 'prefer_right');
    const positiveMass = mass.cmp(Z) > 0;
    const strictlyBetter = values[challenger].cmp(values[tree.anchor]) > 0;
    const budgetPassed = tree.declared[tree.anchor].sub(tree.declared[challenger]).add(tree.cost).cmp(tree.epsilon) <= 0;
    const switchAllowed = supports && positiveMass && strictlyBetter && budgetPassed;
    selected = switchAllowed ? challenger : tree.anchor;
    gate = { labelSupportsChallenger: supports, positiveModelMass: positiveMass, posteriorStrictlyBetter: strictlyBetter,
      budgetPassed, hardFeasible: tree.eligible.includes(challenger) && tree.eligible.includes(tree.anchor),
      eligibleToSwitch: switchAllowed, anchorId: tree.anchor, challengerId: challenger };
  }
  const contribution = sum(tree.models.map((model) => joint[model.id].mul(model.utilities[selected])));
  return { label, probability: mass.toPair(), likelihoods: wireMap(likelihoods), posterior: wireMap(after),
    expectedUtilities: wireMap(values), selectedId: selected, value: values[selected].toPair(), contribution: contribution.toPair(),
    updateStatus: informative ? (mass.cmp(Z) > 0 ? 'updated' : 'zero_likelihood_conflict') : `${label}_no_update`,
    evidenceGate: gate, budgetCertificate: certificate(tree, selected, tree.cost, constrained || anchored) };
}

function planFeedback(input, requestedStrategy) {
  const aliases = { fixed: 'anchored_fixed', anchored_fixed_with_stop: 'anchored_fixed',
    constrained_active: 'constrained', static_explicit: 'static', fixed_pair_with_stop: 'constrained_fixed' };
  const strategy = own(aliases, requestedStrategy) ? aliases[requestedStrategy] : requestedStrategy;
  if (!STRATEGIES.includes(strategy)) throw new TypeError('Unknown feedback strategy');
  const tree = normalize(input);
  const anchored = strategy.indexOf('anchored_') === 0;
  const constrained = strategy.indexOf('constrained') === 0;
  const allowed = (paid) => tree.eligible.filter((id) => !constrained && !anchored ||
    tree.declared[tree.anchor].sub(tree.declared[id]).add(paid).cmp(tree.epsilon) <= 0);
  const noQueryAllowed = anchored ? (tree.anchor === null ? [] : [tree.anchor]) : allowed(Z);
  const afterAllowed = allowed(tree.cost);
  const values = means(tree.models, tree.belief, tree.eligible);
  const selected = strategy === 'static' || anchored ? tree.anchor : best(values, noQueryAllowed);
  const baseline = selected === null ? null : values[selected];
  const questions = [];
  const pairs = [];
  if (anchored) {
    if (tree.complete.includes(tree.anchor)) tree.complete.forEach((id) => { if (id !== tree.anchor) pairs.push([tree.anchor, id]); });
  } else {
    tree.complete.forEach((left, index) => { tree.complete.slice(index + 1).forEach((right) => { pairs.push([left, right]); }); });
  }
  let reason = selected === null ? 'no_feasible' : 'no_query_strategy';
  const canAsk = !['static', 'bayes_no_query', 'constrained_no_query'].includes(strategy);
  if (selected !== null && canAsk) {
    if (!tree.queryBudget) reason = 'query_budget_zero';
    else if (!pairs.length) reason = 'no_complete_question';
    else if (!afterAllowed.length || ((anchored || constrained) && tree.cost.cmp(tree.epsilon) > 0)) reason = 'query_cost_exceeds_budget';
    else {
      pairs.forEach(([left, right]) => {
        const branches = {};
        LABELS.forEach((label) => { branches[label] = branch(tree, left, right, label, afterAllowed, anchored, constrained); });
        const expected = sum(LABELS.map((label) => F(branches[label].contribution)));
        questions.push({ leftId: left, rightId: right, anchorId: anchored ? tree.anchor : null,
          challengerId: anchored ? right : null, branches, expectedValue: expected.toPair(),
          expectedNetValue: expected.sub(tree.cost).toPair(), grossGain: expected.sub(baseline).toPair(),
          netGain: expected.sub(baseline).sub(tree.cost).toPair() });
      });
      reason = 'nonpositive_net_gain';
    }
  }
  let bestQuestion = null;
  questions.forEach((question) => {
    if (!bestQuestion || (!['anchored_fixed', 'constrained_fixed'].includes(strategy) && F(question.netGain).cmp(bestQuestion.netGain) > 0)) bestQuestion = question;
  });
  const question = bestQuestion && F(bestQuestion.netGain).cmp(Z) > 0 ? bestQuestion : null;
  if (question) reason = 'positive_net_gain';
  return clone(Object.assign({ version: 'research-math-v1', strategy, input: tree.snapshot,
    action: question ? 'ask' : 'stop', reason, selectedId: selected, anchorId: tree.anchor,
    baselineValue: baseline?.toPair() ?? null, expectedNetValue: question ? question.expectedNetValue : baseline?.toPair() ?? null,
    queryCost: (question ? tree.cost : Z).toPair(), epsilon: tree.epsilon.toPair(),
    prior: wireMap(tree.belief), expectedUtilities: wireMap(values),
    allowedNoQueryIds: noQueryAllowed, allowedAfterQueryIds: afterAllowed,
    budgetCertificate: certificate(tree, selected, Z, anchored || constrained),
    question, bestQuestion, questions }, FLAGS));
}

function applyAnswer(plan, label) {
  if (!LABELS.includes(label)) throw new TypeError('Only the five explicit pair-answer labels are legal');
  record(plan, 'plan');
  if (plan.version !== 'research-math-v1') throw new TypeError('Unknown plan version');
  const fresh = planFeedback(plan.input, plan.strategy);
  if (canonical(plan) !== canonical(fresh)) throw new TypeError('Plan content changed; recompute and explicitly accept a new plan');
  if (fresh.action !== 'ask' || plan.action !== 'ask' || !plan.question ||
      fresh.question.leftId !== plan.question.leftId || fresh.question.rightId !== plan.question.rightId) {
    throw new TypeError('Answer requires the same mathematically planned pair');
  }
  return clone(Object.assign({ version: 'research-math-answer-v1', strategy: fresh.strategy,
    question: { leftId: fresh.question.leftId, rightId: fresh.question.rightId },
    queryCost: fresh.queryCost }, fresh.question.branches[label], FLAGS));
}

function signalCostGate(plan, signalCost) {
  const k = fraction(signalCost, 'signalCost', Z);
  record(plan, 'plan');
  if (!['anchored_active', 'anchored_fixed'].includes(plan.strategy)) throw new TypeError('Signal gate requires a fixed anchored policy');
  const fresh = planFeedback(plan.input, plan.strategy);
  if (canonical(plan) !== canonical(fresh)) throw new TypeError('Plan content changed; signal gate cannot replace the fixed question or policy');
  const epsilon = F(fresh.epsilon);
  let maximum = null;
  if (fresh.question) LABELS.forEach((label) => {
    const loss = F(fresh.question.branches[label].budgetCertificate.netLoss);
    if (maximum === null || loss.cmp(maximum) > 0) maximum = loss;
  });
  const allowed = fresh.action === 'ask' && k.cmp(epsilon) <= 0 && k.add(maximum).cmp(epsilon) <= 0;
  return clone(Object.assign({ version: 'research-signal-gate-v1', allowed, originalAction: fresh.action,
    signalCost: k.toPair(), epsilon: epsilon.toPair(), maxOriginalNetLoss: maximum?.toPair() ?? null,
    margin: maximum && epsilon.sub(k).sub(maximum).toPair(),
    reason: fresh.action !== 'ask' ? 'original_policy_stops' : allowed ? 'fixed_policy_within_budget' : 'signal_cost_exceeds_budget',
    question: fresh.question }, FLAGS));
}

function signalCohortValue(input) {
  record(input, 'signal cohort');
  if (!Array.isArray(input.cohort) || !input.cohort.length) throw new TypeError('A nonempty cohort is required');
  const alpha = fraction(input.alpha, 'alpha', Z, O);
  const beta = fraction(input.beta, 'beta', Z, O);
  const k = fraction(input.signalCost, 'signalCost', Z);
  const rows = input.cohort.map((row) => {
    record(row, 'cohort row');
    if (typeof row.gatePassed !== 'boolean') throw new TypeError('gatePassed must be explicit');
    return { weight: fraction(row.weight, 'weight', Z), delta: F(row.delta), gatePassed: row.gatePassed };
  });
  const total = sum(rows.map((row) => row.weight));
  if (total.cmp(Z) <= 0) throw new RangeError('Cohort has no positive mass');
  let positive = Z;
  let negative = Z;
  let passed = Z;
  rows.forEach((row) => {
    if (!row.gatePassed) return;
    const weight = row.weight.div(total);
    passed = passed.add(weight);
    if (row.delta.cmp(Z) > 0) positive = positive.add(weight.mul(row.delta));
    else negative = negative.add(weight.mul(row.delta.neg()));
  });
  const cost = k.mul(passed);
  return clone(Object.assign({ positiveMassValue: positive.toPair(), negativeMassValue: negative.toPair(),
    gatedPopulationMass: passed.toPair(), signalCost: cost.toPair(),
    expectedIncrement: alpha.mul(positive).sub(beta.mul(negative)).sub(cost).toPair(),
    paidOracle: positive.sub(cost).toPair(), freeOracle: positive.toPair() }, FLAGS));
}

/** Evidence is explicitly supplied, never looked up or trusted by this module.
 * {kind:'rectangle',p:[lo,hi],d:[lo,hi],c:[lo,hi]} or
 * {kind:'finite_joint',tuples:[{p,d,c}]} plus sources:[nonempty IDs],
 * calibrationRefs:[nonempty IDs], binding, utilityUnit, costUnit, timeScope.
 * context must match binding/unit/time; stale:true or revoked:true invalidates.
 * Binding equality is only a caller-provided consistency check, not a hash or
 * authenticity check. Empty evidence is evidence_insufficient with null bounds.
 */
function evidenceBounds(evidence, context) {
  const result = (status, extra) => clone(Object.assign({ version: 'research-evidence-bounds-v1', status,
    lower: null, upper: null, lowerWitness: null, upperWitness: null }, FLAGS, extra || {}));
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return result('evidence_insufficient');
  if (evidence.revoked === true || evidence.stale === true) return result('stale');
  if (!context || typeof context !== 'object' || !context.binding || !evidence.binding) return result('evidence_insufficient');
  if (evidence.binding !== context.binding) return result('stale');
  if (typeof evidence.utilityUnit !== 'string' || !evidence.utilityUnit || evidence.utilityUnit !== evidence.costUnit ||
      evidence.utilityUnit !== context.utilityUnit || !evidence.timeScope || evidence.timeScope !== context.timeScope) return result('unit_time_inapplicable');
  const references = (value) => Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string' && id.length > 0);
  if (!references(evidence.sources) || !references(evidence.calibrationRefs)) return result('evidence_insufficient');
  if (evidence.setInterpretation !== undefined && !['exact_set', 'outer_envelope'].includes(evidence.setInterpretation)) return result('invalid');
  try {
    let points;
    const point = (value) => ({ p: fraction(value.p, 'p', Z, O), d: fraction(value.d, 'd', O.neg(), O), c: fraction(value.c, 'c', Z) });
    if (evidence.kind === 'rectangle') {
      const range = (key, low, high) => {
        const value = evidence[key];
        if (!Array.isArray(value) || value.length !== 2 || value.some((item) => item === null)) throw new TypeError('Missing range');
        const pair = [fraction(value[0], key, low, high), fraction(value[1], key, low, high)];
        if (pair[0].cmp(pair[1]) > 0) throw new RangeError('Reversed range');
        return pair;
      };
      if (['p', 'd', 'c'].some((key) => evidence[key] === null || evidence[key] === undefined ||
          (Array.isArray(evidence[key]) && evidence[key].some((value) => value === null)))) return result('evidence_insufficient');
      const p = range('p', Z, O);
      const d = range('d', O.neg(), O);
      const c = range('c', Z);
      points = [];
      for (const pv of p) for (const dv of d) for (const cv of c) points.push({ p: pv, d: dv, c: cv });
    } else if (evidence.kind === 'finite_joint') {
      if (!Array.isArray(evidence.tuples) || !evidence.tuples.length) return result('evidence_insufficient');
      if (evidence.tuples.length > 4096) return result('invalid');
      if (evidence.tuples.some((row) => row && ['p', 'd', 'c'].some((key) => row[key] === null))) return result('evidence_insufficient');
      points = evidence.tuples.map((row) => {
        record(row, 'tuple');
        if (Object.keys(row).sort().join(',') !== 'c,d,p') throw new TypeError('Finite joint tuples may only contain p,d,c');
        return point(row);
      });
    } else return result('invalid');
    let lower = null;
    let upper = null;
    let lowerWitness;
    let upperWitness;
    points.forEach((row) => {
      const delta = row.p.mul(row.d).sub(row.c);
      if (lower === null || delta.cmp(lower) < 0) { lower = delta; lowerWitness = wireMap(row); }
      if (upper === null || delta.cmp(upper) > 0) { upper = delta; upperWitness = wireMap(row); }
    });
    return result(lower.cmp(Z) > 0 ? 'conditional_strict_positive' : upper.cmp(Z) <= 0 ? 'conditional_no_strict_gain' : 'undetermined',
      { lower: lower.toPair(), upper: upper.toPair(), lowerWitness, upperWitness,
        kind: evidence.kind, setInterpretation: evidence.setInterpretation === 'outer_envelope' ? 'outer_envelope' : 'exact_set',
        sharpnessScope: evidence.setInterpretation === 'outer_envelope' ? 'supplied_outer_envelope_only' : 'supplied_set_only' });
  } catch {
    return result('invalid');
  }
}

/** Already-paid k is included in full-path accounting, never subtracted twice
 * from incremental continuation value. Missing k stays unknown, not zero.
 * Optional budget: {anchorUtility,selectedUtilities:[five legal leaves],
 * epsilon,queryCostUpper}; all five leaves including zero-mass ones are checked.
 */
function sunkCostLedger(input) {
  record(input, 'ledger');
  const interval = (value, name, nonnegative) => {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${name} must be an interval`);
    const low = fraction(value[0], name, nonnegative ? Z : undefined);
    const high = fraction(value[1], name, nonnegative ? Z : undefined);
    if (low.cmp(high) > 0) throw new RangeError(`Reversed ${name}`);
    return [low, high];
  };
  const delta = interval(input.incrementalBounds, 'incrementalBounds', false);
  const sunk = interval(input.sunkCostBounds, 'sunkCostBounds', true);
  const output = Object.assign({ incrementalBounds: delta?.map((value) => value.toPair()) ?? null,
    fullPathExecuteBounds: null, fullPathStopBounds: null, budgetCertificate: null,
    sunkCostKnown: sunk !== null, opportunity: delta !== null }, FLAGS);
  if (sunk) {
    output.fullPathStopBounds = [sunk[1].neg().toPair(), sunk[0].neg().toPair()];
    if (delta) output.fullPathExecuteBounds = [delta[0].sub(sunk[1]).toPair(), delta[1].sub(sunk[0]).toPair()];
  }
  if (input.budget !== undefined) {
    const budget = record(input.budget, 'budget');
    if (!Array.isArray(budget.selectedUtilities) || budget.selectedUtilities.length !== LABELS.length) throw new TypeError('Budget must include all five legal leaves');
    const anchor = fraction(budget.anchorUtility, 'anchorUtility', Z, O);
    const epsilon = fraction(budget.epsilon, 'epsilon', Z);
    const costUpper = fraction(budget.queryCostUpper, 'queryCostUpper', Z);
    const leaves = budget.selectedUtilities.map((value, index) => {
      const selected = fraction(value, 'selectedUtility', Z, O);
      if (selected.cmp(anchor) > 0) throw new RangeError('Declared anchor must maximize utility');
      const loss = sunk ? anchor.sub(selected).add(costUpper).add(sunk[1]) : null;
      return { label: LABELS[index], netLossUpper: loss?.toPair() ?? null,
        marginLower: loss && epsilon.sub(loss).toPair(), passed: loss && loss.cmp(epsilon) <= 0 };
    });
    output.budgetCertificate = { status: sunk ? 'evaluated' : 'unknown_sunk_cost',
      passed: sunk ? leaves.every((leaf) => leaf.passed) : null, leaves };
  }
  return clone(output);
}

module.exports = { LABELS, STRATEGIES, planFeedback, applyAnswer, signalCostGate, signalCohortValue, evidenceBounds, sunkCostLedger };
