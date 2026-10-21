'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createService } = require('../lib/decision/service');
const { createJournal } = require('../lib/decision/journal');
const { canonical } = require('../lib/decision/digest');
const catalog = require('../lib/decision/catalog');
const fullCatalog = require('../data/virtual-catalog.json');
const eventValue = (state) => ({ candidateId: state.current.id, revision: state.revision });
const source = 'qa';
const create = (extra = {}) => createService({ seed: 19, source, ...extra });

function publicAdapter() {
  const known = (value) => ({ state: 'known', value, source: 'synthetic-test', version: '1' });
  const rows = [
    { id: 'a', name: 'Virtual A', price: 1000, vegetarian: true, score: 1 },
    { id: 'b', name: 'Virtual B', price: 2000, vegetarian: true, score: 0.5 },
    { id: 'c', name: 'Virtual C', price: null, vegetarian: null, score: 0 },
  ];
  let contentVersion = 1;
  return {
    manifest: { source: 'synthetic-service-fixture', counts: { meals: rows.length } },
    changeContent() { contentVersion += 1; },
    buildProblem(options) {
      const conditions = [];
      if (options.budgetCents !== null) conditions.push({ id: 'budget', attribute: 'priceCents', op: 'lte', value: options.budgetCents });
      if (options.vegetarianOnly) conditions.push({ id: 'vegetarian', attribute: 'vegetarian', op: 'eq', value: true });
      const candidates = rows.map((row) => ({ id: row.id, name: row.name, facts: {
        priceCents: row.price === null ? { state: 'unknown', source: 'synthetic-test', version: '1' } : known(row.price),
        vegetarian: row.vegetarian === null ? { state: 'unknown', source: 'synthetic-test', version: '1' } : known(row.vegetarian),
        score: known(row.score),
      } }));
      return { schema_version: '2', dataset: { id: 'synthetic-service-fixture', version: String(contentVersion) },
        attributes: { score: { type: 'number' }, priceCents: { type: 'number' }, vegetarian: { type: 'boolean' } }, candidates,
        context: { mode: 'VIRTUAL', target: options.target, origin: options.origin },
        request: { conditions, explicit_preferences: { version: '2', terms: [
          { id: 'score', type: 'piecewise', attribute: 'score', weight: 1, knots: [[0, 0], [1, 1]] },
        ] } },
      };
    },
    getDisplay(id, target) {
      const row = rows.find((item) => item.id === id);
      if (!row) return null;
      return { id, target, name: `${row.name} content ${contentVersion}`, restaurantName: row.name, mealName: row.name,
        restaurantId: row.id, mealId: row.id, priceCents: row.price, priceLabel: '虚拟场景价',
        distanceUnits: 10, vegetarian: row.vegetarian, spicy: null, mealRole: 'main', storeCategory: null,
        mode: 'VIRTUAL', source: 'synthetic-service-fixture', version: String(contentVersion) };
    },
  };
}

test('browse previews keep counts honest without consuming recommendation or confirmation state', () => {
  const service = create({ catalog: publicAdapter() });
  const control = create({ catalog: publicAdapter() });
  for (const subject of [service, control]) subject.configure({ strategy: 'uniform', options: { budgetCents: 1500 } });
  const before = service.getDiagnostics();
  const preview = service.previewCandidates(3);
  assert.deepEqual(preview.counts, { total: 3, feasible: 1, unknown: 1, rejected: 1 });
  assert.deepEqual(preview.cards.map(item => item.id), ['a']);
  assert.equal(service.resolve('a', preview.cards[0].revision), null);
  assert.deepEqual(service.getDiagnostics(), before);
  assert.deepEqual(service.recommend(), control.recommend());
  assert.equal(service.previewCandidates(3).cards.length, 0);
  assert.equal(service.previewCandidates(3).counts.feasible, 1);
});

test('default single package is chosen from all 1092 reviewed virtual meals and carries virtual disclosures', () => {
  const service = create();
  const state = service.recommend();
  assert.equal(fullCatalog.meals.length, 1092);
  assert.equal(fullCatalog.restaurants.length, 363);
  assert.deepEqual(require('../data/virtual-catalog.js'), fullCatalog);
  assert.equal(state.target, 'PACKAGE');
  assert.equal(state.status, 'recommended');
  assert.equal(state.counts.total, fullCatalog.meals.length);
  assert.equal(state.counts.feasible, fullCatalog.meals.length);
  assert.equal(state.counts.remaining, fullCatalog.meals.length - 1);
  assert.ok(state.current && !Array.isArray(state.current));
  assert.ok(!Object.hasOwn(state, 'results'));
  const selected = fullCatalog.meals.find((meal) => meal.id === state.current.id);
  assert.ok(selected);
  assert.ok(fullCatalog.meals.findIndex((meal) => meal.id === state.current.id) > 3, 'Full-pool choice is beyond the first three source records');
  assert.equal(state.current.priceCents, selected.facts.priceCents.value);
  assert.match(state.current.disclosure, /虚拟/);
  assert.match(state.current.scoreMeaning, /不是满意度概率/);
  assert.equal(state.current.foodCategory, null);
  assert.equal(state.current.ingredients, null);
});

test('full catalog budget, vegetarian and spicy hard constraints exclude unknown facts', () => {
  const service = create();
  service.configure({ options: { budgetCents: 2000, vegetarianOnly: true, maxSpicy: 1 } });
  const state = service.recommend();
  const expected = { feasible: [], unknown: [], rejected: [] };
  for (const meal of fullCatalog.meals) {
    const tests = [
      [meal.facts.priceCents, (value) => value <= 2000],
      [meal.facts.vegetarian, (value) => value === true],
      [meal.facts.spicy, (value) => value <= 1],
    ];
    const verdicts = tests.map(([fact, predicate]) => fact.state === 'known' ? predicate(fact.value) : null);
    const kind = verdicts.includes(false) ? 'rejected' : verdicts.includes(null) ? 'unknown' : 'feasible';
    expected[kind].push(meal.id);
  }
  assert.equal(state.counts.total, 1092);
  for (const kind of ['feasible', 'unknown', 'rejected']) assert.equal(state.counts[kind], expected[kind].length);
  assert.ok(expected.unknown.length > 0);
  assert.ok(expected.feasible.includes(state.current.id));
  assert.equal(state.current.vegetarian, true);
  assert.ok(state.current.priceCents <= 2000 && state.current.spicy <= 1);
});

test('restaurant target scans all restaurants and one actual virtual meal witnesses every hard condition', () => {
  const service = create();
  service.configure({ target: 'RESTAURANT', options: { budgetCents: 2000, vegetarianOnly: true, maxSpicy: 1 } });
  const state = service.recommend();
  assert.equal(state.target, 'RESTAURANT');
  assert.equal(state.counts.total, fullCatalog.restaurants.length);
  assert.ok(fullCatalog.restaurants.some((row) => row.id === state.current.id));
  const witness = fullCatalog.meals.find((row) => row.id === state.current.witnessMealId);
  assert.ok(witness);
  assert.equal(witness.restaurantId, state.current.id);
  assert.equal(witness.facts.vegetarian.state, 'known');
  assert.equal(witness.facts.vegetarian.value, true);
  assert.equal(witness.facts.spicy.state, 'known');
  assert.ok(witness.facts.spicy.value <= 1 && witness.facts.priceCents.value <= 2000);
  assert.equal(state.current.priceCents, witness.facts.priceCents.value);
});

test('repeat recommend is idempotent and rerolls do not repeat any card', () => {
  const service = create();
  const first = service.recommend();
  const before = service.getDiagnostics().events;
  assert.deepEqual(service.recommend(), first);
  assert.deepEqual(service.getDiagnostics().events, before);
  const seen = new Set([first.current.id]);
  for (let i = 0; i < 3; i += 1) {
    const state = service.recommend({ reroll: true });
    assert.equal(state.counts.remaining, 1090 - i);
    assert.ok(!seen.has(state.current.id));
    seen.add(state.current.id);
  }
  const events = service.getDiagnostics().events.events;
  assert.equal(events.filter((event) => event.type === 'reroll').length, 3);
  assert.ok(events.filter((event) => event.type === 'reroll').every((event) => /not_pairwise_preference/.test(event.payload.meaning)));
});

test('unknown hard price/vegetarian stay unresolved, and exhausting known cards does not pretend complete rejection', () => {
  const service = create({ catalog: publicAdapter() });
  service.configure({ options: { budgetCents: 2500, vegetarianOnly: true } });
  const first = service.recommend();
  assert.deepEqual(first.counts, { total: 3, feasible: 2, unknown: 1, rejected: 0, remaining: 1 });
  assert.equal(first.current.id, 'a');
  assert.equal(service.recommend({ reroll: true }).current.id, 'b');
  const end = service.recommend({ reroll: true });
  assert.equal(end.status, 'needs_information');
  assert.equal(end.current, null);
  assert.equal(end.counts.unknown, 1);
});

test('invalid weights and configuration reject atomically without resetting history or visible card', () => {
  const service = create();
  service.recommend();
  for (const weights of [null, 3, [], 'weights', { price: NaN }, { unknown: 1 }, { price: -1 }]) {
    const before = service.getState();
    const events = service.getDiagnostics().events;
    assert.throws(() => service.configure({ options: { weights } }));
    assert.deepEqual(service.getState(), before);
    assert.deepEqual(service.getDiagnostics().events, events);
  }
  for (const patch of [{ target: 'LIVE' }, { origin: { x: -1 } }, { options: { budgetCents: 1.5 } }, { options: { unknown: true } },
    { options: { target: 'RESTAURANT' } }, { options: { origin: { x: 0, y: 0 } } }]) {
    const before = service.getState();
    assert.throws(() => service.configure(patch));
    assert.deepEqual(service.getState(), before);
  }
});

test('choice requires current rendered revision, repeated calls are idempotent, and revoke preserves originals', () => {
  const service = create({ catalog: publicAdapter() });
  const state = service.recommend();
  const value = eventValue(state);
  const before = service.getDiagnostics().events;
  assert.throws(() => service.confirm(value), /render/);
  assert.deepEqual(service.getDiagnostics().events, before);
  service.markRendered(value);
  const rendered = service.getDiagnostics().events;
  service.markRendered(value);
  assert.deepEqual(service.getDiagnostics().events, rendered);
  const confirmed = service.confirm(value);
  assert.deepEqual(service.confirm(value), confirmed);
  const originalId = confirmed.receipt.eventId;
  const originalEvent = service.getDiagnostics().events.events.find((event) => event.id === originalId);
  service.revokeReceipt();
  const revoked = service.getDiagnostics().events;
  assert.deepEqual(revoked.events.find((event) => event.id === originalId), originalEvent);
  assert.ok(!revoked.activeChoiceIds.includes(originalId));
  assert.equal(revoked.events.filter((event) => event.type === 'revoke').length, 1);
  service.revokeReceipt();
  assert.deepEqual(service.getDiagnostics().events, revoked);
  const second = service.confirm(value);
  assert.notEqual(second.receipt.eventId, originalId);
  assert.deepEqual(service.getDiagnostics().events.activeChoiceIds, [second.receipt.eventId]);
  service.recommend({ reroll: true });
  assert.equal(service.resolve(value.candidateId, value.revision), null);
  assert.throws(() => service.confirm(value), /更新/);
  assert.throws(() => service.markRendered(value), /更新/);
});

test('content-only changes invalidate old bindings but keep same-session no-replacement history', () => {
  const adapter = publicAdapter();
  const service = create({ catalog: adapter });
  const first = service.recommend();
  const oldValue = eventValue(first);
  service.markRendered(oldValue);
  const before = service.getDiagnostics();
  adapter.changeContent();
  service.configure({});
  assert.equal(service.resolve(oldValue.candidateId, oldValue.revision), null);
  assert.throws(() => service.confirm(oldValue), /更新/);
  assert.notEqual(service.getDiagnostics().inputDigest, before.inputDigest);
  const refreshed = service.recommend();
  assert.equal(refreshed.current.id, 'a', 'The visible card is refreshed in place with a new revision');
  assert.notEqual(refreshed.revision, oldValue.revision);
  assert.throws(() => service.confirm(eventValue(refreshed)), /render/);
  const next = service.recommend({ reroll: true });
  assert.equal(next.current.id, 'b', 'Content revision must preserve a in seen history on the next draw');
  assert.equal(service.getDiagnostics().semanticDigest, before.semanticDigest);
  assert.equal(next.counts.remaining, 1);
});

test('semantic configuration change invalidates current revision and starts a fresh feasible session', () => {
  const service = create({ catalog: publicAdapter() });
  const first = service.recommend();
  service.recommend({ reroll: true });
  service.configure({ options: { budgetCents: 1500 } });
  assert.equal(service.resolve(first.current.id, first.revision), null);
  assert.equal(service.recommend().current.id, 'a');
  assert.ok(service.getDiagnostics().events.events.some((event) => event.type === 'context_closed'));
});

test('QA source stays separate, evidence absent and all inference/training/pair-question switches remain off', () => {
  const service = create({ catalog: publicAdapter() });
  const state = service.recommend();
  service.markRendered(eventValue(state)); service.confirm(eventValue(state));
  service.recommend({ reroll: true });
  const diagnostics = service.getDiagnostics();
  assert.equal(diagnostics.events.source, 'qa');
  assert.equal(diagnostics.events.memoryOnly, true);
  assert.equal(diagnostics.events.researchEligible, false);
  assert.ok(diagnostics.events.events.every((event) => event.source === 'qa' && event.researchEligible === false));
  assert.equal(diagnostics.policy.learningEnabled, false);
  assert.equal(diagnostics.policy.activeQuestionsEnabled, false);
  assert.equal(diagnostics.policy.questionsPublished, 0);
  assert.equal(diagnostics.policy.signalAcquisitions, 0);
  assert.deepEqual(diagnostics.policy.paidCost, ['0', '1']);
  assert.equal(diagnostics.evidence.status, 'evidence_insufficient');
  assert.ok(!diagnostics.events.events.some((event) => /prefer_left|prefer_right|answer|train/.test(event.type)));
  assert.equal(create({ source: 'interaction', catalog: publicAdapter() }).getDiagnostics().events.source, 'interaction');
});

test('journal rejects conflicting retries and preserves its append-only event hash chain', () => {
  const journal = createJournal('qa');
  const snapshot = { candidateId: 'a', revision: 1, facts: { price: 1000 } };
  const prepared = journal.prepare('prepare', snapshot);
  assert.deepEqual(journal.prepare('prepare', snapshot), prepared);
  const before = journal.exportState();
  assert.throws(() => journal.prepare('prepare', { ...snapshot, facts: { price: 2000 } }), /Conflicting/);
  assert.deepEqual(journal.exportState(), before);
  assert.throws(() => journal.rendered('render', { ...prepared.binding, contentDigest: 'tampered' }), /current/);
  assert.throws(() => journal.choose('choose', prepared.binding), /render/);
  journal.rendered('render', prepared.binding);
  journal.choose('choose', prepared.binding);
  const events = journal.exportState().events;
  assert.equal(events[0].previousDigest, null);
  const crypto = require('node:crypto');
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(events[i].previousDigest, crypto.createHash('sha256').update(canonical(events[i - 1])).digest('hex'));
  }
  journal.nextEpoch('new context');
  assert.throws(() => journal.choose('old-epoch', prepared.binding), /current/);
});

test('retrying a revoked older choice cannot overwrite the latest active choice guard', () => {
  const journal = createJournal('qa');
  const { binding } = journal.prepare('prepare', { candidateId: 'a', revision: 1 });
  journal.rendered('render', binding);
  const first = journal.choose('first', binding);
  journal.revoke('undo-first', first.id);
  const second = journal.choose('second', binding);
  const beforeRetry = journal.exportState();
  assert.deepEqual(journal.choose('first', binding), first);
  assert.deepEqual(journal.exportState(), beforeRetry);
  assert.throws(() => journal.choose('third', binding), /active choice/);
  assert.deepEqual(journal.exportState().activeChoiceIds, [second.id]);
});

test('isolated service loads only local modules and executes with all network/storage interfaces blocked', () => {
  const root = path.resolve(__dirname, '..');
  const cache = new Map();
  let calls = 0;
  const blocked = () => { calls += 1; throw new Error('External interface accessed'); };
  const context = vm.createContext({ fetch: blocked, XMLHttpRequest: blocked, WebSocket: blocked,
    wx: new Proxy({}, { get: blocked }), localStorage: new Proxy({}, { get: blocked }),
    sessionStorage: new Proxy({}, { get: blocked }) });
  const load = (filename) => {
    const resolved = path.resolve(filename);
    assert.ok(resolved.startsWith(`${root}${path.sep}`));
    if (cache.has(resolved)) return cache.get(resolved);
    const content = fs.readFileSync(resolved, 'utf8');
    if (resolved.endsWith('.json')) {
      context.jsonText = content;
      const data = vm.runInContext('JSON.parse(jsonText)', context);
      delete context.jsonText; cache.set(resolved, data); return data;
    }
    const module = { exports: {} };
    const requireLocal = (request) => {
      assert.ok(request.startsWith('.'), `Nonlocal dependency rejected: ${request}`);
      const next = path.resolve(path.dirname(resolved), request);
      return load(path.extname(next) ? next : `${next}.js`);
    };
    const run = vm.runInContext(`(function(require,module,exports){${content}\n})`, context, { filename: resolved });
    run(requireLocal, module, module.exports); cache.set(resolved, module.exports); return module.exports;
  };
  const isolated = load(path.join(root, 'lib/decision/service.js')).createService({ seed: 19, source: 'qa' });
  const state = isolated.recommend();
  isolated.markRendered(eventValue(state)); isolated.confirm(eventValue(state)); isolated.revokeReceipt();
  assert.equal(isolated.getDiagnostics().events.memoryOnly, true);
  assert.equal(calls, 0);
  assert.ok(cache.has(path.join(root, 'data/virtual-catalog.js')));
  assert.ok(![...cache.keys()].some((filename) => filename === path.join(root, 'lib/service.js')));
});

test('catalog adapter itself remains a local public projection without mutating the imported source', () => {
  const before = canonical(fullCatalog);
  const problem = catalog.buildProblem({ target: 'PACKAGE', budgetCents: 1000 });
  problem.candidates[0].facts.priceCents.value = 0;
  assert.equal(canonical(fullCatalog), before);
  assert.ok(fullCatalog.meals.every((meal) => !Object.hasOwn(meal, 'truth')));
});
