'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../lib/decision/taste-profile');
const catalog = require('../lib/decision/catalog');
const core = require('../lib/decision/core');
const rawCatalog = require('../data/virtual-catalog.json');
const { createStore, STORAGE_KEY, PROFILE_TTL_MS, DRAFT_TTL_MS } = require('../lib/taste-profile');
const { createService } = require('../lib/decision/service');

// Independent synthetic audit. No wx session, real person, network or real
// preference evidence is used by these tests.
const copy = value => JSON.parse(JSON.stringify(value));
const declarations = changes => ({ likedGroups: ['hotpot'], avoidedGroups: [],
  budgetCents: null, maxSpicy: null, priority: 'taste', ...changes });
const known = value => ({ state: 'known', value, source: 'independent-audit-fixture', version: '1' });
const unknown = () => ({ state: 'unknown', source: 'independent-audit-fixture', version: '1' });

function tradeoffProblem(priority, changes = {}) {
  const problem = catalog.buildProblem({ ...model.compile(declarations({ priority, ...changes })), target: 'PACKAGE' });
  problem.candidates = [
    { id: 'cheap', name: 'Synthetic cheap option', facts: { priceCents: known(1000), distanceUnits: known(150), mealRole: known('main'),
      spicy: known(0), vegetarian: known(false), storeTypeGroup: known('quick'), storeTypeAffinity: known(0.5) } },
    { id: 'liked', name: 'Synthetic liked option', facts: { priceCents: known(3000), distanceUnits: known(900), mealRole: known('main'),
      spicy: known(0), vegetarian: known(false), storeTypeGroup: known('hotpot'), storeTypeAffinity: known(1) } },
  ];
  return problem;
}

test('audit: absent answers are not explicit empty lists or unlimited values', () => {
  assert.deepEqual(model.missingFields({}), ['likedGroups', 'avoidedGroups', 'budgetCents', 'maxSpicy', 'priority']);
  const empty = declarations({ likedGroups: [], priority: 'balanced' });
  assert.deepEqual(model.missingFields(empty), []);
  for (const field of model.FIELDS) {
    const partial = copy(empty);
    delete partial[field];
    assert.deepEqual(model.missingFields(partial), [field]);
    assert.throws(() => model.compile(partial), /偏好|选择/);
  }
  assert.equal(model.compile(empty).taste.weight, 0);
  assert.equal(catalog.assessProfile(empty).ready, true, 'Explicit price/distance balancing remains usable without category likes');
  assert.throws(() => model.normalizeAnswers({ likedGroups: null }));
  assert.throws(() => model.normalizeAnswers({ budgetCents: undefined }));
  assert.throws(() => model.normalizeAnswers({ maxSpicy: false }));
});

test('audit: conflicting declarations and non-taxonomy categories never become implicit defaults', () => {
  for (const value of [
    declarations({ avoidedGroups: ['hotpot'] }),
    declarations({ likedGroups: ['hotpot', 'hotpot'] }),
    declarations({ likedGroups: ['川渝火锅'] }),
    declarations({ likedGroups: [], priority: 'taste' }),
    declarations({ likedGroups: ['__proto__'] }),
    { ...declarations(), confidence: 0.99 },
  ]) assert.throws(() => model.compile(value));
  const allAvoided = declarations({ likedGroups: [], avoidedGroups: model.GROUPS.map(group => group.id), priority: 'balanced' });
  assert.throws(() => model.compile(allAvoided));
  const input = declarations({ likedGroups: ['quick', 'hotpot'] });
  const before = copy(input);
  const compiled = model.compile(input);
  compiled.taste.likedGroups.length = 0;
  assert.deepEqual(input, before, 'Compilation must not take ownership of mutable UI answers');
});

test('audit: category taxonomy has exactly one assignment for every reviewed store label', () => {
  const mapping = new Map();
  for (const group of model.GROUPS) for (const category of group.categories) {
    assert.equal(mapping.has(category), false, `Duplicate taxonomy membership: ${category}`);
    mapping.set(category, group.id);
  }
  const reviewed = new Set(rawCatalog.restaurants.map(row => row.storeCategory.value));
  assert.deepEqual([...mapping.keys()].sort(), [...reviewed].sort());
  const options = model.compile(declarations({ likedGroups: ['hotpot'], avoidedGroups: ['grill'] }));
  const stores = new Map(rawCatalog.restaurants.map(row => [row.id, row]));
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    const problem = catalog.buildProblem({ ...options, target });
    for (const candidate of problem.candidates) {
      const store = stores.get(target === 'PACKAGE' ? candidate.metadata.restaurantId : candidate.id);
      const expectedGroup = mapping.get(store.storeCategory.value);
      assert.equal(candidate.facts.storeTypeGroup.value, expectedGroup);
      assert.equal(candidate.facts.storeTypeAffinity.value, expectedGroup === 'hotpot' ? 1 : 0.5);
    }
    assert.equal(problem.request.explicit_preferences.terms.filter(term => term.id === 'store_type_preference').length, 1);
  }
});

test('audit: declared taste/price priorities change an independently calculated exact tradeoff', () => {
  const taste = core.decide(tradeoffProblem('taste'), core.createSession(1), 'explicit');
  assert.equal(taste.selectedId, 'liked');
  assert.deepEqual(taste.utilities.cheap.score, ['19', '30']);
  assert.deepEqual(taste.utilities.liked.score, ['13', '15']);
  const price = core.decide(tradeoffProblem('price'), core.createSession(1), 'explicit');
  assert.equal(price.selectedId, 'cheap');
  assert.deepEqual(price.utilities.cheap.score, ['77', '100']);
  assert.deepEqual(price.utilities.liked.score, ['29', '50']);
});

test('audit: affinity cannot rescue excluded or unknown store categories', () => {
  const problem = tradeoffProblem('taste', { avoidedGroups: ['grill'] });
  problem.candidates.push({ ...copy(problem.candidates[1]), id: 'excluded', facts: {
    ...copy(problem.candidates[1].facts), storeTypeGroup: known('grill') } });
  problem.candidates.push({ ...copy(problem.candidates[1]), id: 'unknown', facts: {
    ...copy(problem.candidates[1].facts), storeTypeGroup: unknown(), storeTypeAffinity: unknown() } });
  const result = core.decide(problem, core.createSession(1), 'explicit');
  assert.equal(result.selectedId, 'liked');
  assert.deepEqual(result.rejected, ['excluded']);
  assert.deepEqual(result.unknown, ['unknown']);
  assert.equal(result.feasible.includes('excluded'), false);
  assert.equal(result.feasible.includes('unknown'), false);
});

test('audit: every priority has effective positive weights in both targets and no active semantic duplicates', () => {
  for (const priority of ['balanced', 'taste', 'price', 'distance']) {
    const profile = declarations({ priority });
    const assessment = catalog.assessProfile(profile);
    assert.equal(assessment.profileComplete, true);
    assert.equal(assessment.ready, true);
    for (const target of ['PACKAGE', 'RESTAURANT']) {
      assert.ok(assessment.counts[target].feasible > 0);
      const problem = catalog.buildProblem({ ...model.compile(profile), target });
      const terms = problem.request.explicit_preferences.terms.filter(term => term.enabled !== false && term.weight > 0);
      assert.ok(terms.length > 0);
      assert.ok(terms.some(term => term.attribute === 'priceCents' || term.attribute === 'distanceUnits'));
      const groups = terms.map(term => problem.attributes[term.attribute].semanticGroup);
      assert.equal(new Set(groups).size, groups.length);
      if (target === 'RESTAURANT') assert.equal(terms.some(term => term.attribute === 'mealRole'), false);
    }
  }
});

function localStore(initial) {
  let clock = 2000000000000;
  let saved = initial === undefined ? undefined : copy(initial);
  const calls = { reads: 0, writes: 0, removes: 0 };
  const failures = { read: false, write: false, remove: false };
  const storage = {
    getStorageSync(key) {
      assert.equal(key, STORAGE_KEY);
      calls.reads++;
      if (failures.read) throw new Error('Synthetic storage read failure');
      return saved === undefined ? undefined : copy(saved);
    },
    setStorageSync(key, value) {
      assert.equal(key, STORAGE_KEY);
      calls.writes++;
      if (failures.write) throw new Error('Synthetic storage write failure');
      saved = copy(value);
    },
    removeStorageSync(key) {
      assert.equal(key, STORAGE_KEY);
      calls.removes++;
      if (failures.remove) throw new Error('Synthetic storage remove failure');
      saved = undefined;
    },
  };
  const dependencies = { storage, now: () => clock };
  return { store: createStore(dependencies), failures, calls,
    advance: ms => { clock += ms; },
    saved: () => saved === undefined ? undefined : copy(saved),
    reload: () => createStore(dependencies) };
}

function fillDraft(store, answers = declarations()) {
  store.start();
  for (const field of ['likedGroups', 'avoidedGroups', 'budgetCents', 'maxSpicy', 'priority']) {
    store.answer(field, answers[field], store.getState().revision);
  }
  return store.getState();
}

function completeStore(harness, answers = declarations()) {
  const draft = fillDraft(harness.store, answers);
  harness.store.confirm(draft.revision);
  return harness.store.getProfile();
}

test('audit: persistence requires Start and explicit revision-bound confirmation', () => {
  const h = localStore();
  assert.equal(h.store.load().ready, false);
  assert.equal(h.calls.writes, 0, 'Reading the landing page must not imply storage consent');
  assert.throws(() => h.store.answer('likedGroups', ['hotpot'], 0));
  const draft = fillDraft(h.store);
  assert.equal(h.store.isReady(), false, 'Complete answers alone are still unconfirmed');
  assert.equal(h.store.getProfile(), null);
  assert.throws(() => h.store.confirm(draft.revision - 1), error => error.code === 'STALE_TASTE_PROFILE');
  assert.equal(h.store.isReady(), false);
  h.store.confirm(draft.revision);
  assert.equal(h.store.isReady(), true);
  const persisted = h.saved();
  const writes = h.calls.writes;
  h.advance(1000);
  h.store.confirm(draft.revision);
  assert.equal(h.calls.writes, writes, 'Duplicate confirmation must not renew retention or duplicate writes');
  assert.deepEqual(h.saved(), persisted);
  const profile = h.store.getProfile();
  profile.likedGroups.length = 0;
  assert.deepEqual(h.store.getProfile(), declarations());
  const reloaded = h.reload();
  assert.equal(reloaded.load().ready, true);
  assert.deepEqual(reloaded.getProfile(), declarations());
});

test('audit: stale answers and conflicting edits preserve the exact previous draft', () => {
  const h = localStore();
  fillDraft(h.store);
  const prior = h.store.getState();
  const saved = h.saved();
  assert.throws(() => h.store.answer('likedGroups', ['quick'], prior.revision - 1), error => error.code === 'STALE_TASTE_PROFILE');
  assert.deepEqual(h.store.getState().answers, prior.answers);
  assert.deepEqual(h.saved(), saved);
  assert.throws(() => h.store.answer('avoidedGroups', ['hotpot'], prior.revision));
  assert.deepEqual(h.store.getState().answers, prior.answers);
  assert.equal(h.store.getState().revision, prior.revision);
  assert.deepEqual(h.saved(), saved);
});

test('audit: editing preserves the previous stored profile but blocks its use and does not renew its lifetime', () => {
  const h = localStore();
  const original = completeStore(h);
  const originalConfirmedAt = h.saved().active.confirmedAt;
  h.advance(PROFILE_TTL_MS - 24 * 60 * 60 * 1000);
  const edit = h.store.beginEdit();
  h.store.answer('priority', 'price', edit.revision);
  assert.equal(h.store.getState().editing, true);
  assert.equal(h.store.isReady(), false);
  assert.equal(h.store.getProfile(), null);
  assert.deepEqual(h.saved().active.answers, original);
  assert.equal(h.saved().active.confirmedAt, originalConfirmedAt);
  const reloaded = h.reload();
  assert.equal(reloaded.load().ready, false);
  assert.equal(reloaded.getState().answers.priority, 'price');
  assert.equal(reloaded.getProfile(), null);
  h.advance(24 * 60 * 60 * 1000);
  assert.equal(h.store.isReady(), false, 'At exactly 90 days, active declarations expire despite a fresh edit');
  assert.equal(h.store.getProfile(), null);
  assert.equal(h.store.getState().started, true, 'The independently fresh draft may still be completed');
  assert.equal(h.store.getState().answers.priority, 'price');
});

test('audit: seven-day edit expiry cannot resurrect a superseded active approval', () => {
  const h = localStore();
  completeStore(h);
  const edit = h.store.beginEdit();
  h.store.answer('priority', 'price', edit.revision);
  h.advance(DRAFT_TTL_MS);
  const state = h.store.getState();
  assert.equal(state.started, false);
  assert.equal(state.editing, false);
  assert.equal(state.ready, false);
  assert.deepEqual(state.answers, {});
  assert.equal(h.store.getProfile(), null);
  assert.equal(h.reload().load().ready, false);
});

test('audit: Start creates a fresh draft in one call after the previous unconfirmed draft expires', () => {
  const h = localStore();
  h.store.start();
  h.store.answer('likedGroups', ['hotpot'], h.store.getState().revision);
  h.advance(DRAFT_TTL_MS);
  const fresh = h.store.start();
  assert.equal(fresh.started, true);
  assert.equal(fresh.ready, false);
  assert.deepEqual(fresh.answers, {});
});

test('audit: a failed first confirmation cannot enable recommendations', () => {
  const h = localStore();
  const draft = fillDraft(h.store);
  h.failures.write = true;
  assert.throws(() => h.store.confirm(draft.revision), error => error.code === 'TASTE_STORAGE_ERROR');
  assert.equal(h.store.isReady(), false);
  assert.equal(h.store.getProfile(), null);
  assert.equal(h.saved().active, null);
  h.failures.write = false;
  h.store.confirm(draft.revision);
  assert.equal(h.store.isReady(), true);
});

test('audit: revoke survives either independent storage failure and never revives in-process after both fail', () => {
  for (const failed of ['write', 'remove']) {
    const h = localStore();
    completeStore(h);
    h.failures[failed] = true;
    h.store.clear();
    assert.equal(h.store.isReady(), false);
    const fresh = h.reload();
    assert.equal(fresh.load().ready, false, `${failed} failure must still leave durable revocation`);
  }
  const h = localStore();
  completeStore(h);
  h.failures.write = true;
  h.failures.remove = true;
  assert.throws(() => h.store.clear(), /清除失败.*旧记录可能仍存在/);
  assert.equal(h.store.isReady(), false);
  assert.equal(h.store.load().ready, false);
  assert.equal(h.store.getProfile(), null);
  h.failures.write = false;
  h.failures.remove = false;
  h.store.clear();
  assert.equal(h.reload().load().ready, false);
});

test('audit: malformed, future and unsupported persisted profiles cannot create readiness', () => {
  const source = localStore();
  completeStore(source);
  const valid = source.saved();
  const variants = [
    { ...copy(valid), schemaVersion: 999 },
    { ...copy(valid), policyVersion: 'unreviewed-future-policy' },
    { ...copy(valid), active: { ...copy(valid.active), confirmedRevision: valid.active.revision - 1 } },
    { ...copy(valid), active: { ...copy(valid.active), confirmedAt: 3000000000000 } },
    { ...copy(valid), active: { ...copy(valid.active), answers: { likedGroups: ['hotpot'] } } },
    { ...copy(valid), evidenceConfidence: 1 },
  ];
  for (const saved of variants) {
    const h = localStore(saved);
    assert.equal(h.store.load().ready, false);
    assert.equal(h.store.getProfile(), null);
  }
  const h = localStore(valid);
  h.failures.read = true;
  assert.equal(h.store.load().ready, false);
  assert.equal(h.store.getProfile(), null);
});

test('audit: complete declarations with zero feasible choices remain a data/constraint state', () => {
  for (const [allowed, expected] of [['grill', 'needs_information'], ['southern', 'no_feasible_candidates']]) {
    const answers = declarations({ likedGroups: [allowed],
      avoidedGroups: model.GROUPS.filter(group => group.id !== allowed).map(group => group.id),
      budgetCents: 2000, maxSpicy: 0 });
    const assessment = catalog.assessProfile(answers);
    assert.equal(assessment.profileComplete, true);
    assert.deepEqual(assessment.missingFields, []);
    assert.equal(assessment.ready, false);
    assert.equal(assessment.status, expected);
    for (const target of ['PACKAGE', 'RESTAURANT']) assert.equal(assessment.counts[target].feasible, 0);
    const h = localStore();
    const draft = fillDraft(h.store, answers);
    assert.throws(() => h.store.confirm(draft.revision), /资料不足|没有符合条件/);
    assert.equal(h.store.isReady(), false);
    assert.deepEqual(h.store.getState().missingFields, []);
  }
});

test('audit: direct service configuration cannot bypass absent onboarding confirmation', () => {
  const h = localStore();
  const service = createService({ seed: 1, source: 'qa', requireProfile: true,
    canUseProfile: () => h.store.isReady() });
  h.store.load();
  service.configure({ options: model.compile(declarations()) });
  assert.equal(service.getState().profileReady, false);
  for (const options of [{}, { reroll: true }]) {
    assert.throws(() => service.recommend(options), error => error.code === 'PREFERENCES_REQUIRED');
  }
  assert.equal(service.resolve('any-id', 0), null);
  service.setProfile(declarations());
  assert.equal(service.getState().profileReady, false, 'Supplying declared answers is not evidence of persisted confirmation');
  assert.throws(() => service.recommend(), error => error.code === 'PREFERENCES_REQUIRED');
});

test('audit: expiry while a card is open blocks resolve, confirmation and repeat recommendation', () => {
  const h = localStore();
  completeStore(h);
  const service = createService({ seed: 1, source: 'qa', requireProfile: true,
    canUseProfile: () => h.store.isReady() });
  service.setProfile(h.store.getProfile());
  const chosen = service.recommend();
  const event = { candidateId: chosen.current.id, revision: chosen.revision };
  service.markRendered(event);
  assert.equal(service.resolve(event.candidateId, event.revision).id, chosen.current.id);
  h.advance(PROFILE_TTL_MS);
  assert.equal(service.resolve(event.candidateId, event.revision), null);
  assert.throws(() => service.markRendered(event));
  assert.throws(() => service.confirm(event));
  assert.throws(() => service.recommend(), error => error.code === 'PREFERENCES_REQUIRED');
  assert.equal(service.getState().current, null);
  assert.equal(service.getState().receipt, null);
  assert.equal(service.getState().profileReady, false);
});

test('audit: beginning an edit invalidates the old rendered recommendation until explicit reconfirmation', () => {
  const h = localStore();
  completeStore(h);
  const service = createService({ seed: 1, source: 'qa', requireProfile: true,
    canUseProfile: () => h.store.isReady() });
  service.setProfile(h.store.getProfile());
  const chosen = service.recommend();
  const event = { candidateId: chosen.current.id, revision: chosen.revision };
  service.markRendered(event);
  const edit = h.store.beginEdit();
  assert.equal(h.store.assess().ready, true, 'A sufficient draft still requires explicit reconfirmation');
  assert.equal(h.store.isReady(), false);
  assert.equal(service.resolve(event.candidateId, event.revision), null);
  assert.throws(() => service.confirm(event));
  assert.throws(() => service.recommend(), error => error.code === 'PREFERENCES_REQUIRED');
  assert.equal(service.getState().current, null);
  h.store.confirm(edit.revision);
  service.setProfile(h.store.getProfile());
  assert.equal(service.getState().profileReady, true);
  assert.equal(service.recommend().status, 'recommended');
  assert.equal(service.resolve(event.candidateId, event.revision), null, 'Reconfirmation does not revive a stale event');
});

test('audit: revocation invalidates a rendered card even if the profile store cannot remove its old record', () => {
  const h = localStore();
  completeStore(h);
  const service = createService({ seed: 1, source: 'qa', requireProfile: true,
    canUseProfile: () => h.store.isReady() });
  service.setProfile(h.store.getProfile());
  const chosen = service.recommend();
  const event = { candidateId: chosen.current.id, revision: chosen.revision };
  service.markRendered(event);
  h.failures.write = true;
  h.failures.remove = true;
  assert.throws(() => h.store.clear());
  assert.throws(() => service.confirm(event));
  assert.equal(service.resolve(event.candidateId, event.revision), null);
  assert.equal(service.getState().profileReady, false);
  assert.throws(() => service.recommend({ reroll: true }), error => error.code === 'PREFERENCES_REQUIRED');
});

test('audit: this-meal budget/spice overrides are explicit while category exclusions remain profile controlled', () => {
  const h = localStore();
  const answers = declarations({ avoidedGroups: ['grill'], budgetCents: 3000, maxSpicy: 1 });
  completeStore(h, answers);
  const service = createService({ seed: 1, source: 'qa', requireProfile: true,
    canUseProfile: () => h.store.isReady() });
  service.setProfile(h.store.getProfile());
  const configured = service.configure({ options: { budgetCents: null, maxSpicy: null } });
  assert.equal(configured.options.budgetCents, null);
  assert.equal(configured.options.maxSpicy, null);
  assert.deepEqual(h.store.getProfile(), answers, 'A one-meal override never changes the saved declaration');
  assert.throws(() => service.configure({ options: { taste: null } }));
  assert.throws(() => service.configure({ options: { taste: model.compile(declarations()).taste } }));
  assert.deepEqual(service.getState().options.taste.avoidedGroups, ['grill']);
  const reset = service.reset();
  assert.equal(reset.profileReady, true);
  assert.equal(reset.options.budgetCents, 3000);
  assert.equal(reset.options.maxSpicy, 1);
  assert.deepEqual(reset.options.taste.avoidedGroups, ['grill']);
  const diagnostics = service.getDiagnostics();
  assert.equal(diagnostics.policy.learningEnabled, false);
  assert.equal(diagnostics.policy.activeQuestionsEnabled, false);
  assert.equal(diagnostics.evidence.status, 'evidence_insufficient');
  service.setProfile(null);
  assert.equal(service.getState().profileReady, false);
  assert.throws(() => service.recommend(), error => error.code === 'PREFERENCES_REQUIRED');
});

function cancellingCatalog() {
  const raw = {
    catalogVersion: 'independent-gate-fixture-v1',
    sourceManifest: { sourceVersion: 'independent-gate-fixture-v1', sourceSha256: 'synthetic-only' },
    restaurants: [
      { id: 'near', name: 'Synthetic nearby store', familyId: 'near', x: 500, y: 500, storeCategory: known('中式快餐') },
      { id: 'cheap', name: 'Synthetic cheaper store', familyId: 'cheap', x: 800, y: 500, storeCategory: known('中式快餐') },
    ],
    meals: [
      { id: 'near-meal', name: 'Synthetic nearby meal', restaurantId: 'near', familyId: 'near', auditCodes: [],
        facts: { priceCents: known(3000), spicy: known(0), vegetarian: known(false), mealRole: known('main') } },
      { id: 'cheap-meal', name: 'Synthetic cheaper meal', restaurantId: 'cheap', familyId: 'cheap', auditCodes: [],
        facts: { priceCents: known(2000), spicy: known(0), vegetarian: known(false), mealRole: known('main') } },
    ],
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/decision/catalog'), 'utf8'), {
    module,
    require(name) {
      if (name === '../../data/virtual-catalog.js') return copy(raw);
      if (name === './taste-profile') return model;
      if (name === './core') return core;
      throw new Error(`Unexpected audit fixture dependency: ${name}`);
    },
  });
  return module.exports;
}

test('audit: completed answers with individually varying but exactly cancelling preferences stay gated', () => {
  const adapter = cancellingCatalog();
  const balanced = declarations({ likedGroups: [], priority: 'balanced' });
  // Near: price utility2/5 + distance1 =7/5. Cheap: price3/5 +
  // distance4/5 =7/5. Equal weights cancel exactly in both target modes.
  const tied = adapter.assessProfile(balanced);
  assert.equal(tied.profileComplete, true);
  assert.equal(tied.ready, false);
  assert.equal(tied.personalizedReady, false);
  assert.equal(tied.status, 'needs_preference');
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    assert.equal(tied.counts[target].feasible, 2);
    assert.equal(tied.targetReadiness[target].scoreDiscriminates, false);
    assert.equal(tied.targetReadiness[target].constrainedSingleton, false);
  }
  const discriminated = adapter.assessProfile({ ...balanced, priority: 'price' });
  assert.equal(discriminated.ready, true);
  for (const target of ['PACKAGE', 'RESTAURANT']) assert.equal(discriminated.targetReadiness[target].scoreDiscriminates, true);
});

test('audit: a declared budget resolving the same tie to one feasible candidate is sufficient', () => {
  const adapter = cancellingCatalog();
  const result = adapter.assessProfile(declarations({ likedGroups: [], priority: 'balanced', budgetCents: 2000 }));
  assert.equal(result.ready, true);
  for (const target of ['PACKAGE', 'RESTAURANT']) {
    assert.equal(result.counts[target].feasible, 1);
    assert.equal(result.counts[target].rejected, 1);
    assert.equal(result.targetReadiness[target].scoreDiscriminates, false);
    assert.equal(result.targetReadiness[target].constrainedSingleton, true);
    assert.ok(result.targetReadiness[target].supportedSignals.includes('budgetCents'));
  }
});
