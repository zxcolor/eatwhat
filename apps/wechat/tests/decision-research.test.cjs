'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Fraction: F } = require('../lib/decision/rational');
const R = require('../lib/decision/research');
const q = (n, d = 1) => [String(n), String(d)];
const copy = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
  return { candidateOrder: ['a', 'b'], eligibleIds: ['a', 'b'], anchorId: 'a',
    declaredUtilities: { a: 1, b: q(15, 16) },
    models: [{ id: 'h0', prior: q(1, 2), utilities: { a: 1, b: 0 } },
      { id: 'h1', prior: q(1, 2), utilities: { a: 0, b: 1 } }],
    responseModel: { errorRate: 0, tieMargin: 0, skipRate: 0, cannotJudgeRate: 0 },
    queryCost: q(1, 50), epsilon: q(1, 10) };
}
const equalFraction = (actual, expected) => assert.deepEqual(actual, expected);

// Independent native-BigInt arithmetic oracle; production uses JSBI only.
function ref(n, d = 1n) {
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n;
  let b = d;
  while (b) { const next = a % b; a = b; b = next; }
  return [n / a, d / a];
}
const refPair = (pair) => pair.map(String);
const add = (a, b) => ref(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const mul = (a, b) => ref(a[0] * b[0], a[1] * b[1]);
const cmp = (a, b) => a[0] * b[1] < b[0] * a[1] ? -1 : a[0] * b[1] > b[0] * a[1] ? 1 : 0;

test('fraction arithmetic matches an independent integer oracle over signs and unequal denominators', () => {
  for (let i = -48; i <= 48; i += 1) {
    const a = ref(BigInt(i * 1234567), BigInt(Math.abs(i) + 3));
    const b = ref(BigInt(i * i + 7), BigInt(Math.abs(i) + 11));
    const left = F.from(refPair(a));
    const right = F.from(refPair(b));
    equalFraction(left.add(right).toPair(), refPair(add(a, b)));
    equalFraction(left.sub(right).toPair(), refPair(add(a, [-b[0], b[1]])));
    equalFraction(left.mul(right).toPair(), refPair(mul(a, b)));
    equalFraction(left.div(right).toPair(), refPair(mul(a, ref(b[1], b[0]))));
    assert.equal(left.cmp(right), cmp(a, b));
    equalFraction(left.neg().toPair(), refPair([-a[0], a[1]]));
  }
});

test('fraction binary64 preservation includes subnormal, rounding ties and overflow boundaries', () => {
  equalFraction(F.from(0.1).toPair(), q('3602879701896397', '36028797018963968'));
  for (const value of [0, 0.1, -0.1, Math.PI, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, 2 ** -1022]) {
    assert.equal(F.from(value).toNumber(), value);
  }
  const halfSubnormal = q(1, (2n ** 1075n).toString());
  assert.equal(F.from(halfSubnormal).toNumber(), 0);
  assert.equal(F.from(q(3, (2n ** 1075n).toString())).toNumber(), 2 * Number.MIN_VALUE);
  assert.equal(F.from(q(2n ** 53n + 1n, 2n ** 53n)).toNumber(), 1);
  assert.equal(F.from(q(2n ** 53n + 3n, 2n ** 53n)).toNumber(), 1 + 2 ** -51);
  const giant = `1${'0'.repeat(1000)}`;
  assert.equal(F.from([giant, giant]).toNumber(), 1);
  assert.equal(F.from([giant, '1']).toNumber(), Infinity);
  assert.equal(F.from(['1', giant]).toNumber(), 0);
});

test('fraction rejects ambiguous/nonfinite values, zero divisors and mutation', () => {
  for (const value of [NaN, Infinity, true, null, '0.1', ['01', '2'], ['-0', '1'], ['1', '0'], ['1', '-2'], ['1', '1', '2']]) {
    assert.throws(() => F.from(value));
  }
  assert.throws(() => F.from(['1'.repeat(65537), '1']));
  assert.throws(() => F.from(1).div(0));
  const value = F.from(q(2, 3));
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value._n));
  assert.throws(() => { value._n[0] = 99; });
  const pair = value.toPair(); pair[0] = '99';
  equalFraction(value.toPair(), q(2, 3));
});

test('large derived rational scores round-trip beyond the external-research 4096-digit legacy limit', () => {
  const denominator = `1${'0'.repeat(5000)}1`;
  const derived = F.from(['1', denominator]);
  equalFraction(F.from(JSON.parse(JSON.stringify(derived.toPair()))).toPair(), ['1', denominator]);
  const expected = ref(BigInt(denominator) + 3n, 3n * BigInt(denominator));
  equalFraction(derived.add(q(1, 3)).toPair(), refPair(expected));
  assert.ok(derived.cmp(0) > 0);
  assert.equal(derived.toNumber(), 0); // Display underflow does not destroy exact support.
});

test('vendored JSBI has pinned hashes and arithmetic works without a native BigInt global', () => {
  const directory = path.resolve(__dirname, '../lib/decision');
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'vendor/jsbi.metadata.json'), 'utf8'));
  assert.equal(metadata.version, '4.3.2');
  for (const [name, digest] of Object.entries(metadata.sha256)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'vendor', name))).digest('hex'), digest);
  }
  const cache = new Map();
  const load = (filename) => {
    if (cache.has(filename)) return cache.get(filename);
    const source = fs.readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /\b\d+n\b/);
    const module = { exports: {} };
    const context = vm.createContext({ module, exports: module.exports, BigInt: undefined,
      require: (request) => load(path.resolve(path.dirname(filename), `${request}.js`)) });
    vm.runInContext(source, context, { filename });
    cache.set(filename, module.exports);
    return module.exports;
  };
  const portable = load(path.join(directory, 'rational.js')).Fraction;
  assert.equal(portable.from(['1', '3']).add(['1', '6']).toNumber(), 0.5);
  assert.equal(portable.from(Number.MIN_VALUE).toNumber(), Number.MIN_VALUE);
});

test('R4 exact noisy five-label likelihoods and posterior obey Bayes including skip/cannot', () => {
  const input = fixture();
  input.responseModel = { errorRate: q(1, 5), tieMargin: 0, skipRate: q(1, 10), cannotJudgeRate: q(1, 10) };
  const plan = R.planFeedback(input, 'active_voi');
  const rows = plan.question.branches;
  equalFraction(rows.prefer_left.probability, q(9, 25));
  equalFraction(rows.prefer_right.probability, q(9, 25));
  equalFraction(rows.tie.probability, q(2, 25));
  equalFraction(rows.skip.probability, q(1, 10));
  equalFraction(rows.cannot_judge.probability, q(1, 10));
  assert.deepEqual(rows.prefer_right.posterior, { h0: q(1, 9), h1: q(8, 9) });
  assert.deepEqual(rows.skip.posterior, plan.prior);
  assert.deepEqual(rows.cannot_judge.posterior, plan.prior);
  equalFraction(plan.expectedNetValue, q(19, 25));
  equalFraction(plan.question.netGain, q(13, 50));
});

test('R4 skip and impossible labels retain belief; zero prior is never revived', () => {
  const plan = R.planFeedback(fixture(), 'active_voi');
  for (const label of ['tie', 'skip', 'cannot_judge']) {
    const answer = R.applyAnswer(plan, label);
    assert.deepEqual(answer.posterior, plan.prior);
    equalFraction(answer.probability, q(0));
    assert.equal(answer.updateStatus, label === 'tie' ? 'zero_likelihood_conflict' : `${label}_no_update`);
  }
  const input = fixture();
  input.models.push({ id: 'zero', prior: 0, utilities: { a: q(1, 3), b: q(2, 3) } });
  const extended = R.planFeedback(input, 'active_voi');
  for (const label of R.LABELS) equalFraction(extended.question.branches[label].posterior.zero, q(0));
  assert.throws(() => R.applyAnswer(plan, 'reroll'));
  assert.throws(() => R.applyAnswer(plan, 'choice'));
  assert.equal(R.applyAnswer(plan, 'prefer_right').eventBound, false);
});

test('R4 tie margin is closed, and information with no decision benefit has zero VOI', () => {
  const input = fixture(); input.responseModel.tieMargin = 1;
  const plan = R.planFeedback(input, 'active_voi');
  assert.equal(plan.action, 'stop');
  equalFraction(plan.bestQuestion.branches.tie.probability, q(1));
  input.responseModel.tieMargin = 0;
  input.models[1].utilities = { a: q(3, 4), b: q(1, 2) };
  equalFraction(R.planFeedback(input, 'active_voi').bestQuestion.grossGain, q(0));
});

test('R5 noiseless hand tree satisfies every legal leaf including zero-mass fallback', () => {
  const input = fixture();
  const plan = R.planFeedback(input, 'constrained');
  assert.equal(plan.action, 'ask');
  equalFraction(plan.baselineValue, q(1, 2));
  equalFraction(plan.expectedNetValue, q(49, 50));
  const right = plan.question.branches.prefer_right;
  assert.equal(right.selectedId, 'b');
  equalFraction(right.budgetCertificate.netLoss, q(33, 400));
  equalFraction(right.budgetCertificate.margin, q(7, 400));
  for (const label of R.LABELS) assert.equal(plan.question.branches[label].budgetCertificate.passed, true);
  input.epsilon = q(1, 50);
  const narrow = R.planFeedback(input, 'constrained');
  assert.equal(narrow.action, 'stop');
  equalFraction(narrow.bestQuestion.expectedNetValue, q(12, 25));
  assert.ok(Object.values(narrow.bestQuestion.branches).every((leaf) => leaf.selectedId === 'a'));
});

test('R5 optimum agrees with independent enumeration of all 32 terminal policies', () => {
  // Joint masses from the hand channel: left/right 1/2, all other labels zero.
  // Enumerate all five-leaf maps independently of production branch selection.
  let maximum = ref(1n, 2n); // stop
  for (let mask = 0; mask < 32; mask += 1) {
    const actions = R.LABELS.map((_, index) => mask & (1 << index) ? 'b' : 'a');
    const value = add(add(ref(-1n, 50n), actions[0] === 'a' ? ref(1n, 2n) : ref(0n)),
      actions[1] === 'b' ? ref(1n, 2n) : ref(0n));
    if (cmp(value, maximum) > 0) maximum = value;
  }
  equalFraction(R.planFeedback(fixture(), 'constrained').expectedNetValue, refPair(maximum));
});

test('R6 retains the original ID without a query and never substitutes a third candidate', () => {
  const input = fixture();
  input.models[0].prior = q(1, 10); input.models[1].prior = q(9, 10);
  input.queryBudget = 0;
  assert.equal(R.planFeedback(input, 'anchored_active').selectedId, 'a');
  assert.equal(R.planFeedback(input, 'bayes_no_query').selectedId, 'b');
  input.queryBudget = 1;
  const plan = R.planFeedback(input, 'anchored_active');
  assert.equal(plan.action, 'ask');
  for (const label of ['prefer_left', 'tie', 'skip', 'cannot_judge']) assert.equal(R.applyAnswer(plan, label).selectedId, 'a');
  assert.equal(R.applyAnswer(plan, 'prefer_right').selectedId, 'b');
});

test('R6 fixed pair stop differs from active search, with deterministic ordered ties', () => {
  const input = fixture();
  input.candidateOrder = ['a', 'b', 'c']; input.eligibleIds = input.candidateOrder.slice();
  input.declaredUtilities = { a: 1, b: 1, c: 1 };
  input.models[0].utilities = { a: 1, b: 1, c: 0 };
  input.models[1].utilities = { a: 0, b: 0, c: 1 };
  const fixed = R.planFeedback(input, 'fixed');
  const active = R.planFeedback(input, 'anchored_active');
  assert.equal(fixed.action, 'stop');
  assert.equal(fixed.bestQuestion.rightId, 'b');
  assert.equal(active.action, 'ask');
  assert.equal(active.question.rightId, 'c');
  input.candidateOrder.reverse();
  assert.equal(R.planFeedback(input, 'static').selectedId, 'a');
  assert.throws(() => R.planFeedback({ ...input, anchorId: 'c' }, 'static'));
});

test('R6 direct support still requires strict posterior improvement and positive mass', () => {
  const input = fixture();
  input.models[0].prior = q(9, 10); input.models[1].prior = q(1, 10);
  input.responseModel.errorRate = 1;
  input.queryCost = 0;
  const plan = R.planFeedback(input, 'anchored_active');
  const leaf = plan.bestQuestion.branches.prefer_right;
  equalFraction(leaf.probability, q(9, 20));
  assert.equal(leaf.evidenceGate.labelSupportsChallenger, true);
  assert.equal(leaf.evidenceGate.posteriorStrictlyBetter, false);
  assert.equal(leaf.selectedId, 'a');
  assert.equal(plan.action, 'stop');
});

test('R6 zero epsilon/cost permits a query when declared utilities tie', () => {
  const input = fixture(); input.declaredUtilities.b = 1; input.queryCost = 0; input.epsilon = 0;
  assert.equal(R.planFeedback(input, 'anchored_active').action, 'ask');
  input.completeIds = ['b'];
  assert.equal(R.planFeedback(input, 'anchored_active').reason, 'no_complete_question');
});

test('public tables are copied, validated and hard-eligible IDs alone may be selected', () => {
  const input = fixture(); const before = copy(input);
  const plan = R.planFeedback(input, 'anchored_active');
  assert.deepEqual(input, before);
  const answer = R.applyAnswer(plan, 'prefer_right');
  assert.equal(answer.realExecution, false);
  input.models[0].utilities.a = 0;
  assert.equal(plan.input.models[0].utilities.a[0], '1');
  const restricted = fixture(); restricted.eligibleIds = ['a'];
  assert.equal(R.planFeedback(restricted, 'active_voi').selectedId, 'a');
  restricted.eligibleIds = []; restricted.anchorId = null;
  assert.equal(R.planFeedback(restricted, 'active_voi').reason, 'no_feasible');
  for (const mutate of [
    (value) => { value.models[0].utilities.a = 2; },
    (value) => { value.models.forEach((model) => { model.prior = 0; }); },
    (value) => { value.responseModel.skipRate = 1; value.responseModel.cannotJudgeRate = 1; },
    (value) => { value.eligibleIds = ['missing']; },
    (value) => { value.completeIds = ['missing']; },
    (value) => { value.queryCost = -1; },
  ]) { const bad = fixture(); mutate(bad); assert.throws(() => R.planFeedback(bad, 'active_voi')); }
});

test('R7 fixed-policy signal-cost gate uses all legal leaves and a closed budget boundary', () => {
  const plan = R.planFeedback(fixture(), 'anchored_active');
  const boundary = R.signalCostGate(plan, q(7, 400));
  assert.equal(boundary.allowed, true);
  equalFraction(boundary.maxOriginalNetLoss, q(33, 400));
  equalFraction(boundary.margin, q(0));
  assert.equal(R.signalCostGate(plan, q(17501, 1000000)).allowed, false);
  assert.equal(R.signalCostGate(plan, q(1, 200)).allowed, true);
  assert.equal(R.signalCostGate(plan, q(1, 50)).allowed, false);
  assert.deepEqual(boundary.question, plan.question);
  const stopped = fixture(); stopped.queryBudget = 0;
  assert.equal(R.signalCostGate(R.planFeedback(stopped, 'anchored_active'), 0).allowed, false);
});

test('R7 rejects a changed input that would silently replace the frozen question or five-leaf policy', () => {
  const input = fixture();
  input.candidateOrder = ['a', 'b', 'c']; input.eligibleIds = ['a', 'b', 'c'];
  input.declaredUtilities = { a: 1, b: 1, c: 1 };
  input.models[0].utilities = { a: 1, b: 0, c: 0 };
  input.models[1].utilities = { a: 0, b: 1, c: 0 };
  const plan = R.planFeedback(input, 'anchored_active');
  assert.equal(plan.question.rightId, 'b');
  const changed = copy(plan);
  changed.input.models[1].utilities.b = q(0);
  changed.input.models[1].utilities.c = q(1);
  assert.equal(R.planFeedback(changed.input, changed.strategy).question.rightId, 'c');
  assert.throws(() => R.signalCostGate(changed, 0), /Plan content changed/);
  const forgedLeaf = copy(plan);
  forgedLeaf.question.branches.prefer_right.selectedId = 'a';
  assert.throws(() => R.signalCostGate(forgedLeaf, 0), /Plan content changed/);
  assert.throws(() => R.applyAnswer(forgedLeaf, 'prefer_right'), /Plan content changed/);
  const changedPrior = copy(plan);
  changedPrior.input.models[0].prior = q(9, 10);
  changedPrior.input.models[1].prior = q(1, 10);
  assert.equal(R.planFeedback(changedPrior.input, changedPrior.strategy).question.rightId, 'b');
  assert.throws(() => R.applyAnswer(changedPrior, 'prefer_right'), /Plan content changed/);
  assert.equal(R.signalCostGate(copy(plan), 0).allowed, true);
  assert.equal(R.applyAnswer(copy(plan), 'prefer_right').selectedId, 'b');
});

test('R7 cohort formula separates paid/free oracle and preserves tiny rational signs', () => {
  const input = { alpha: q(4, 5), beta: q(1, 5), signalCost: q(1, 200),
    cohort: [{ weight: 1, delta: q(2, 25), gatePassed: true }, { weight: 1, delta: q(-3, 25), gatePassed: true }] };
  const result = R.signalCohortValue(input);
  equalFraction(result.expectedIncrement, q(3, 200));
  equalFraction(result.paidOracle, q(7, 200));
  equalFraction(result.freeOracle, q(1, 25));
  const tiny = R.signalCohortValue({ alpha: 1, beta: 0, signalCost: 0,
    cohort: [{ weight: 1, delta: q(1, `1${'0'.repeat(50)}`), gatePassed: true }] });
  equalFraction(tiny.expectedIncrement, q(1, `1${'0'.repeat(50)}`));
  input.cohort[1].gatePassed = false;
  equalFraction(R.signalCohortValue(input).signalCost, q(1, 400));
});

const context = { binding: 'synthetic-context-v1', utilityUnit: 'utility', timeScope: 'one-decision' };
function evidence(p, d, c) {
  return { kind: 'rectangle', p, d, c, sources: ['synthetic-source'], calibrationRefs: ['synthetic-assumption'],
    binding: context.binding, utilityUnit: 'utility', costUnit: 'utility', timeScope: context.timeScope };
}
test('R8 rectangle bounds use all bilinear corners including negative d', () => {
  const result = R.evidenceBounds(evidence([q(1, 4), q(3, 4)], [q(-4, 5), q(-1, 5)], [q(1, 100), q(1, 50)]), context);
  equalFraction(result.lower, q(-31, 50));
  equalFraction(result.upper, q(-3, 50));
  equalFraction(result.lowerWitness.p, q(3, 4));
  equalFraction(result.upperWitness.p, q(1, 4));
  assert.equal(result.status, 'conditional_no_strict_gain');
  assert.equal(result.externalAuthenticityVerified, false);
});

test('R8 finite-joint dependence is preserved without invented Cartesian combinations', () => {
  const source = evidence(null, null, null); source.kind = 'finite_joint';
  source.tuples = [{ p: q(1, 4), d: q(1, 25), c: q(1, 50) }, { p: q(3, 4), d: q(3, 25), c: q(1, 50) }];
  const aligned = R.evidenceBounds(source, context);
  equalFraction(aligned.lower, q(-1, 100));
  assert.equal(aligned.status, 'undetermined');
  source.tuples[0].d = q(3, 25); source.tuples[1].d = q(1, 25);
  const opposed = R.evidenceBounds(source, context);
  equalFraction(opposed.lower, q(1, 100));
  equalFraction(opposed.upper, q(1, 100));
  assert.equal(opposed.status, 'conditional_strict_positive');
  source.tuples[0].probability = q(1, 2);
  assert.equal(R.evidenceBounds(source, context).status, 'invalid');
});

test('R8 exact zero, tiny positive, insufficient, stale and unit failures stay distinct', () => {
  const zero = evidence([0, 1], [0, 1], [0, 0]);
  assert.equal(R.evidenceBounds(zero, context).status, 'undetermined');
  zero.d = [0, 0];
  assert.equal(R.evidenceBounds(zero, context).status, 'conditional_no_strict_gain');
  const positive = evidence([1, 1], [q(1, `1${'0'.repeat(50)}`), q(1, `1${'0'.repeat(50)}`)], [0, 0]);
  assert.equal(R.evidenceBounds(positive, context).status, 'conditional_strict_positive');
  for (const patch of [{ sources: [] }, { calibrationRefs: [] }, { p: null }, { p: [null, null] }]) {
    const result = R.evidenceBounds({ ...positive, ...patch }, context);
    assert.equal(result.status, 'evidence_insufficient'); assert.equal(result.lower, null);
  }
  assert.equal(R.evidenceBounds({}, context).status, 'evidence_insufficient');
  assert.equal(R.evidenceBounds({ ...positive, binding: 'changed' }, context).status, 'stale');
  assert.equal(R.evidenceBounds({ ...positive, revoked: true }, context).status, 'stale');
  assert.equal(R.evidenceBounds({ ...positive, costUnit: 'seconds' }, context).status, 'unit_time_inapplicable');
  assert.equal(R.evidenceBounds({ ...positive, timeScope: 'tomorrow' }, context).status, 'unit_time_inapplicable');
  assert.equal(R.evidenceBounds({ ...positive, p: [1, 0] }, context).status, 'invalid');
});

test('R8 sunk-cost ledger retains incremental value and checks all five leaves with cU+kU', () => {
  const input = { incrementalBounds: [q(2, 25), q(2, 25)], sunkCostBounds: [q(1, 200), q(1, 200)],
    budget: { anchorUtility: 1, selectedUtilities: [1, q(15, 16), 1, 1, 1], epsilon: q(1, 10), queryCostUpper: q(1, 50) } };
  const result = R.sunkCostLedger(input);
  equalFraction(result.incrementalBounds[0], q(2, 25));
  equalFraction(result.fullPathExecuteBounds[0], q(3, 40));
  equalFraction(result.fullPathStopBounds[0], q(-1, 200));
  equalFraction(result.budgetCertificate.leaves[1].netLossUpper, q(7, 80));
  assert.equal(result.budgetCertificate.passed, true);
  input.budget.queryCostUpper = q(1, 25);
  assert.equal(R.sunkCostLedger(input).budgetCertificate.passed, false);
  delete input.sunkCostBounds;
  const unknown = R.sunkCostLedger(input);
  assert.equal(unknown.fullPathExecuteBounds, null);
  assert.equal(unknown.fullPathStopBounds, null);
  assert.equal(unknown.budgetCertificate.passed, null);
  assert.equal(unknown.budgetCertificate.status, 'unknown_sunk_cost');
  assert.equal(R.sunkCostLedger({ incrementalBounds: null, sunkCostBounds: [0, 0] }).opportunity, false);
});
