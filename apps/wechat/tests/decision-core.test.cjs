'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../lib/decision/core');
const D = require('../lib/decision/digest');
const JSBI = require('../lib/decision/vendor/jsbi');
const { Fraction: F } = require('../lib/decision/rational');
const copy = (value) => JSON.parse(JSON.stringify(value));
const pair = (n, d = 1) => [String(n), String(d)];
const known = (value) => ({ state: 'known', value, source: 'synthetic-hand-case', version: '1' });
const absent = (state = 'unknown') => ({ state, source: 'synthetic-hand-case', version: '1' });
const piecewise = (id = 'x-score', attribute = 'x', options = {}) => ({ id, type: 'piecewise', attribute,
  weight: 1, unknownUtility: 0, notApplicableUtility: 0, knots: [[0, 0], [1, 1]], ...options });
function numericProblem(values = [0, 1]) {
  return { schema_version: '2', attributes: { x: { type: 'number', unit: 'unit', roles: ['hard', 'soft'] } },
    candidates: values.map((value, index) => ({ id: String.fromCharCode(97 + index), name: `Virtual ${index}`, facts: { x: known(value) } })),
    request: { conditions: [], explicit_preferences: { version: '2', terms: [piecewise()] } } };
}
const decide = (problem, strategy = 'explicit', session = C.createSession(7), temperature = 1) => C.decide(problem, session, strategy, temperature);

test('portable SHA-256 equals Node crypto for published vectors, block boundaries and Unicode', () => {
  const values = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65),
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '吃什么 🍜 𠮷', '\ud800', '\udfff', 'a'.repeat(10000)];
  values.forEach((value) => { assert.equal(D.sha256(value), crypto.createHash('sha256').update(value, 'utf8').digest('hex')); });
  assert.equal(D.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('canonical JSON sorts keys, preserves data and rejects non-JSON/sparse input', () => {
  assert.equal(D.canonical({ z: [true, null, '中'], a: { b: 2, a: 1 } }), '{"a":{"a":1,"b":2},"z":[true,null,"中"]}');
  assert.equal(D.digest({ b: 2, a: 1 }), crypto.createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
  for (const value of [NaN, Infinity, undefined, () => 1, { x: undefined }, new Array(2)]) assert.throws(() => D.canonical(value));
  const frozen = D.freeze({ one: [{ two: 2 }] });
  assert.ok(Object.isFrozen(frozen.one[0]));
  assert.throws(() => { frozen.one[0].two = 3; });
});

test('JSBI distribution contains no dynamic eval or function-constructor path', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../lib/decision/vendor/jsbi.js'), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(|\bFunction\s*\(|\b(?:setTimeout|setInterval)\s*\(/);
  assert.doesNotMatch(source, /\b(?:importScripts|fetch|XMLHttpRequest|WebSocket)\b/);
});

test('exact R3 ordering distinguishes a float display tie and consumes no random word', () => {
  const problem = numericProblem([0, 1]);
  problem.request.explicit_preferences.terms = [piecewise('tiny', 'x', { knots: [[0, 0.5], [2 ** 53, 1]] })];
  const session = C.createSession(7);
  let words = 0; session.word = () => { words += 1; return 0; };
  const first = decide(problem, 'explicit', session);
  assert.equal(first.selectedId, 'b');
  assert.deepEqual(first.utilities.b.score, pair(2n ** 53n + 1n, 2n ** 54n));
  assert.equal(F.from(first.utilities.a.score).toNumber(), F.from(first.utilities.b.score).toNumber());
  assert.equal(decide(problem, 'explicit', session).selectedId, 'a');
  assert.equal(decide(problem, 'explicit', session).status, 'exhausted');
  assert.equal(words, 0);
});

test('piecewise uses exact finite interpolation with endpoint clipping and enormous spans', () => {
  const problem = numericProblem([-2, 0, 0.5, 1, 2]);
  let result = decide(problem);
  assert.deepEqual(Object.values(result.utilities).map((row) => row.score), [pair(0), pair(0), pair(1, 2), pair(1), pair(1)]);
  problem.candidates = [{ id: 'x', name: 'Virtual midpoint', facts: { x: known(0) } }];
  problem.request.explicit_preferences.terms[0].knots = [[-1e308, 0], [1e308, 1]];
  result = decide(problem);
  assert.deepEqual(result.utilities.x.score, pair(1, 2));
});

test('fixed denominator preserves unknown/NA configured fallbacks and zero-total-weight semantics', () => {
  const problem = numericProblem([0]);
  problem.attributes.y = { type: 'number' };
  problem.candidates[0].facts = { x: absent(), y: known(0.75) };
  problem.request.explicit_preferences.terms = [piecewise('x-score', 'x', { weight: 2, unknownUtility: 0.25, notApplicableUtility: 0.75 }), piecewise('y-score', 'y')];
  const result = decide(problem);
  assert.deepEqual(result.utilities.a.score, pair(5, 12));
  assert.deepEqual(result.utilities.a.weightSum, pair(3));
  problem.candidates[0].facts.x = absent('not_applicable');
  assert.deepEqual(decide(problem).utilities.a.score, pair(3, 4));
  problem.request.explicit_preferences.terms.forEach((term) => { term.weight = 0; });
  assert.deepEqual(decide(problem).utilities.a.score, pair(0));
});

test('all_match priority is FALSE then UNKNOWN then NOT_APPLICABLE then TRUE', () => {
  const problem = numericProblem([]);
  problem.attributes = { left: { type: 'boolean' }, right: { type: 'boolean' } };
  problem.candidates = [
    { id: 'false-unknown', name: 'Virtual', facts: { left: known(false), right: absent() } },
    { id: 'unknown-na', name: 'Virtual', facts: { left: absent(), right: absent('not_applicable') } },
    { id: 'true-na', name: 'Virtual', facts: { left: known(true), right: absent('not_applicable') } },
    { id: 'true', name: 'Virtual', facts: { left: known(true), right: known(true) } },
  ];
  problem.request.explicit_preferences.terms = [{ id: 'joint', type: 'all_match', weight: 1,
    trueUtility: 0.5, falseUtility: 0.125, unknownUtility: 0.25, notApplicableUtility: 0.75,
    clauses: [{ attribute: 'left', op: 'eq', value: true }, { attribute: 'right', op: 'eq', value: true }] }];
  const result = decide(problem);
  assert.deepEqual(result.utilities['false-unknown'].score, pair(1, 8));
  assert.deepEqual(result.utilities['unknown-na'].score, pair(1, 4));
  assert.deepEqual(result.utilities['true-na'].score, pair(3, 4));
  assert.deepEqual(result.utilities.true.score, pair(1, 2));
});

test('all_match numeric interval is closed and category target must be nonempty', () => {
  const problem = numericProblem([0, 1, 2]);
  problem.attributes.tags = { type: 'string_set', values: ['one', 'two'] };
  problem.candidates.forEach((candidate) => { candidate.facts.tags = known(['one']); });
  problem.request.explicit_preferences.terms = [{ id: 'joint', type: 'all_match', weight: 1,
    clauses: [{ attribute: 'x', op: 'in_range', unit: 'unit', lower: 0, upper: 1 }, { attribute: 'tags', op: 'contains_all', value: ['one'] }] }];
  const result = decide(problem);
  assert.deepEqual(result.utilities.a.score, pair(1));
  assert.deepEqual(result.utilities.b.score, pair(1));
  assert.deepEqual(result.utilities.c.score, pair(0));
  problem.request.explicit_preferences.terms[0].clauses[1].value = [];
  assert.throws(() => C.validate(problem));
});

test('known zero, false and empty categories remain known; hard unknown is never rescued by soft score', () => {
  const problem = numericProblem([0, 1, 1, 1]);
  problem.attributes.safe = { type: 'boolean' }; problem.attributes.tags = { type: 'string_set', values: ['x'] };
  problem.request.conditions = [{ id: 'safe', attribute: 'safe', op: 'eq', value: false }, { id: 'tags', attribute: 'tags', op: 'contains_all', value: [] }];
  problem.candidates[0].facts.safe = known(false);
  problem.candidates[1].facts.safe = absent();
  problem.candidates[2].facts.safe = absent('not_applicable');
  problem.candidates[3].facts.safe = known(true);
  problem.candidates.forEach((candidate) => { candidate.facts.tags = known([]); });
  const result = decide(problem);
  assert.equal(result.selectedId, 'a');
  assert.deepEqual(result.feasible, ['a']);
  assert.deepEqual(result.unknown, ['b', 'c']);
  assert.deepEqual(result.rejected, ['d']);
  assert.deepEqual(result.utilities.a.score, pair(0));
});

test('missing-input precedence and static contradictions remain distinct from unknown facts', () => {
  const problem = numericProblem([0]);
  problem.candidates[0].facts.x = absent();
  problem.request.conditions = [{ id: 'low', attribute: 'x', op: 'gte', value: 40 }, { id: 'high', attribute: 'x', op: 'lte', value: 20 }];
  assert.equal(decide(problem).status, 'no_feasible_candidate');
  assert.deepEqual(decide(problem).contradictions, ['x']);
  problem.attributes.flag = { type: 'boolean' };
  problem.request.conditions.push({ id: 'missing', attribute: 'flag', op: 'eq' });
  assert.equal(decide(problem).status, 'missing_input');
  problem.request.conditions = [{ id: 'known-required', attribute: 'x', op: 'gte', value: 0 }];
  assert.equal(decide(problem).status, 'needs_information');
});

test('semantic resets ignore display/provenance, candidate order and equivalent set/term/condition order', () => {
  const problem = numericProblem([0, 1]);
  problem.attributes.tags = { type: 'string_set', values: ['x', 'y'] };
  problem.attributes.y = { type: 'number' };
  problem.candidates.forEach((candidate) => { candidate.facts.tags = known(['x', 'y']); candidate.facts.y = known(0); });
  problem.request.conditions = [{ id: 'tags', attribute: 'tags', op: 'contains_all', value: ['x', 'y'] }, { id: 'x', attribute: 'x', op: 'gte', value: 0 }];
  problem.request.explicit_preferences.terms.push(piecewise('y-score', 'y'));
  const original = C.semanticSignature(problem, 'explicit', 1);
  const reordered = copy(problem);
  reordered.candidates.reverse(); reordered.candidates[0].name = 'Renamed';
  reordered.candidates[0].facts.x.source = 'new-source'; reordered.candidates[0].facts.x.version = '2';
  reordered.candidates.forEach((candidate) => { candidate.facts.tags.value.reverse(); });
  reordered.request.conditions.reverse(); reordered.request.conditions[1].value.reverse();
  reordered.request.explicit_preferences.terms.reverse();
  assert.equal(C.semanticSignature(reordered, 'explicit', 1), original);
  reordered.candidates[0].facts.x.value = 0.5;
  assert.notEqual(C.semanticSignature(reordered, 'explicit', 1), original);
  const session = C.createSession(1); decide(problem, 'explicit', session);
  const before = [...session.seen];
  assert.throws(() => decide(reordered, 'explicit', session), /reset/);
  assert.deepEqual([...session.seen], before);
  assert.equal(decide(reordered, 'explicit', C.createSession(1)).status, 'recommended');
});

test('invalid configuration rejects atomically before sampling including disabled and zero-weight terms', () => {
  for (const mutate of [
    (term) => { term.enabled = false; term.unknownUtility = 2; },
    (term) => { term.weight = 0; term.notApplicableUtility = NaN; },
    (term) => { term.knots = [[0, 0], [0, 1]]; },
    (term) => { term.weight = 1000001; },
    (term) => { term.enabled = 'false'; },
    (term) => { term.unit = 'seconds'; },
  ]) {
    const problem = numericProblem(); mutate(problem.request.explicit_preferences.terms[0]);
    const session = C.createSession(3); let words = 0; session.word = () => { words += 1; return 0; };
    assert.throws(() => decide(problem, 'weighted', session));
    assert.equal(session.signature, null); assert.equal(session.seen.size, 0); assert.equal(words, 0);
  }
  const problem = numericProblem();
  problem.request.conditions = [{ id: 'unit', attribute: 'x', op: 'lte', value: 1, unit: 'seconds' }];
  assert.throws(() => C.validate(problem));
});

test('positive terms cannot double count an attribute or semantic group, including inside one conjunction', () => {
  const problem = numericProblem();
  problem.request.explicit_preferences.terms.push(piecewise('duplicate'));
  assert.throws(() => C.validate(problem));
  problem.request.explicit_preferences.terms[1].weight = 0;
  assert.doesNotThrow(() => C.validate(problem));
  problem.attributes = { a: { type: 'boolean', semanticGroup: 'same' }, b: { type: 'boolean', semanticGroup: 'same' } };
  problem.candidates = [{ id: 'a', name: 'Virtual', facts: { a: known(true), b: known(true) } }];
  problem.request.explicit_preferences.terms = [{ id: 'conjunction', type: 'all_match', weight: 1, clauses: [{ attribute: 'a', op: 'eq', value: true }, { attribute: 'b', op: 'eq', value: true }] }];
  assert.throws(() => C.validate(problem));
});

test('prototype-shaped candidate IDs stay data and never corrupt selected IDs or seen state', () => {
  const problem = numericProblem([1, 0]);
  problem.candidates[0].id = '__proto__'; problem.candidates[1].id = 'constructor';
  const result = decide(problem);
  assert.equal(result.selectedId, '__proto__');
  assert.deepEqual(result.feasible, ['__proto__', 'constructor']);
  assert.ok(Object.hasOwn(result.utilities, '__proto__'));
  assert.deepEqual(Object.getOwnPropertyDescriptor(result.utilities, '__proto__').value.score, pair(1));
  const attrProblem = JSON.parse('{"schema_version":"2","attributes":{"__proto__":{"type":"number"}},"candidates":[{"id":"a","name":"Virtual","facts":{"__proto__":{"state":"known","value":0,"source":"synthetic","version":"1"}}}],"request":{"conditions":[{"id":"c","attribute":"__proto__","op":"eq","value":0}],"explicit_preferences":{"version":"2","terms":[]}}}');
  assert.equal(decide(attrProblem).selectedId, 'a');
  const missingInherited = numericProblem([0]);
  missingInherited.attributes.constructor = { type: 'number' };
  missingInherited.request.explicit_preferences.terms = [piecewise('missing', 'constructor', { unknownUtility: 1, notApplicableUtility: 0 })];
  assert.deepEqual(decide(missingInherited).utilities.a.score, pair(1));
});

test('uniform mass is exact and every binary64 softmax support item stays reachable', () => {
  const distribution = C.exactDistribution({ a: F.from(0), b: F.from(0), c: F.from(0) }, 'uniform', 1);
  Object.values(distribution).forEach((value) => { assert.deepEqual(value.toPair(), pair(1, 3)); });
  assert.equal(C.sample(distribution, () => 0), 'a');
  assert.equal(C.sample(distribution, () => 1), 'b');
  assert.equal(C.sample(distribution, () => 2), 'c');
  const denominator = 2n ** 1074n;
  const tiny = { a: F.from(pair(1, denominator)), b: F.from(pair(denominator - 1n, denominator)) };
  assert.equal(C.sample(tiny, () => 0), 'a');
  let index = 0;
  assert.equal(C.sample(tiny, () => ++index === 34 ? 1 : 0), 'b');
  assert.equal(index, 34);
  const weighted = C.exactDistribution({ a: F.from(0), b: F.from(1) }, 'weighted', 1);
  assert.equal(weighted.a.add(weighted.b).cmp(1), 0);
  assert.ok(weighted.a.cmp(0) > 0 && weighted.b.cmp(0) > 0);
});

test('softmax underflow and invalid random words reject without silently dropping support', () => {
  const problem = numericProblem([0, 1]);
  const session = C.createSession(9); let words = 0; session.word = () => { words += 1; return 0; };
  assert.throws(() => decide(problem, 'weighted', session, 1e-10), /underflow/);
  assert.equal(session.signature, null); assert.equal(session.seen.size, 0); assert.equal(words, 0);
  assert.throws(() => C.randomBelow(JSBI.BigInt(4), () => -1), /random word/);
  assert.throws(() => C.randomBelow(JSBI.BigInt(4), () => 0.5), /random word/);
  const left = C.seededWords(7), right = C.seededWords(7);
  assert.deepEqual(Array.from({ length: 20 }, left), Array.from({ length: 20 }, right));
});
