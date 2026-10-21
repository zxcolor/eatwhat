const catalog = require('../../data/virtual-catalog.js');

const FACT_VERSION = catalog.sourceManifest.sourceVersion;
const OPTION_KEYS = ['target', 'origin', 'budgetCents', 'maxDistanceUnits', 'vegetarianOnly', 'maxSpicy', 'preferMain', 'weights', 'taste'];
const restaurants = new Map(catalog.restaurants.map(row => [row.id, row]));
const mealsByRestaurant = new Map();
for (const row of catalog.meals) {
  if (!mealsByRestaurant.has(row.restaurantId)) mealsByRestaurant.set(row.restaurantId, []);
  mealsByRestaurant.get(row.restaurantId).push(row);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
freeze(catalog);

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid virtual decision options: ${message}`);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeOptions(options) {
  const value = options === undefined ? {} : options;
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  requireValue(Object.keys(value).every(key => OPTION_KEYS.includes(key)), 'unknown field');
  const result = { target: 'PACKAGE', origin: { x: 500, y: 500 }, budgetCents: null,
    maxDistanceUnits: null, vegetarianOnly: false, maxSpicy: null, preferMain: true, taste: null,
    ...value, weights: { price: 1, distance: 1, main: 1, ...value.weights } };
  requireValue(result.target === 'PACKAGE' || result.target === 'RESTAURANT', 'target');
  requireValue(result.origin && typeof result.origin === 'object' && !Array.isArray(result.origin)
    && Object.keys(result.origin).sort().join(',') === 'x,y', 'origin');
  for (const key of ['x', 'y']) requireValue(finite(result.origin[key]) && result.origin[key] >= 0 && result.origin[key] <= 1000, `origin.${key}`);
  requireValue(result.budgetCents === null || (Number.isSafeInteger(result.budgetCents) && result.budgetCents >= 0), 'budgetCents');
  requireValue(result.maxDistanceUnits === null || (finite(result.maxDistanceUnits) && result.maxDistanceUnits >= 0), 'maxDistanceUnits');
  requireValue(typeof result.vegetarianOnly === 'boolean' && typeof result.preferMain === 'boolean', 'boolean preference');
  requireValue(result.maxSpicy === null || (Number.isInteger(result.maxSpicy) && result.maxSpicy >= 0 && result.maxSpicy <= 5), 'maxSpicy');
  if (value.weights !== undefined) requireValue(value.weights && typeof value.weights === 'object' && !Array.isArray(value.weights), 'weights');
  requireValue(Object.keys(result.weights).every(key => ['price', 'distance', 'main'].includes(key)), 'weight field');
  for (const key of ['price', 'distance', 'main']) requireValue(finite(result.weights[key]) && result.weights[key] >= 0, `weights.${key}`);
  if (result.taste !== null) result.taste = require('./taste-profile').normalizeTaste(result.taste);
  result.origin = { x: result.origin.x, y: result.origin.y };
  return result;
}

function known(value, source) {
  return { state: 'known', value, source, version: FACT_VERSION };
}

function unknown(source) {
  return { state: 'unknown', source, version: FACT_VERSION };
}

function distanceTo(restaurant, origin) {
  return Math.hypot(restaurant.x - origin.x, restaurant.y - origin.y);
}

function hardConditions(options) {
  const conditions = [];
  if (options.budgetCents !== null) conditions.push({ id: 'budget', attribute: 'priceCents', op: 'lte', value: options.budgetCents });
  if (options.maxDistanceUnits !== null) conditions.push({ id: 'distance', attribute: 'distanceUnits', op: 'lte', value: options.maxDistanceUnits });
  if (options.vegetarianOnly) conditions.push({ id: 'vegetarian', attribute: 'vegetarian', op: 'eq', value: true });
  if (options.maxSpicy !== null) conditions.push({ id: 'spicy', attribute: 'spicy', op: 'lte', value: options.maxSpicy });
  return conditions;
}

function classifyMeal(meal, distance, conditions) {
  let insufficient = false;
  for (const condition of conditions) {
    const item = condition.attribute === 'distanceUnits' ? known(distance, 'synthetic_euclidean_distance') : meal.facts[condition.attribute];
    if (item?.state !== 'known') {
      insufficient = true;
    } else if (condition.op === 'lte' ? item.value > condition.value : item.value !== condition.value) {
      return 'violated';
    }
  }
  return insufficient ? 'insufficient' : 'satisfied';
}

function byKnownPriceThenId(left, right) {
  const a = left.facts.priceCents;
  const b = right.facts.priceCents;
  if (a.state !== b.state) return a.state === 'known' ? -1 : 1;
  if (a.state === 'known' && a.value !== b.value) return a.value - b.value;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function vegetarianAvailability(meals) {
  const source = 'exists_known_vegetarian_eligible_virtual_meal';
  if (meals.some(row => row.facts.vegetarian.state === 'known' && row.facts.vegetarian.value === true)) return known(true, source);
  if (meals.length > 0 && meals.every(row => row.facts.vegetarian.state === 'known')) return known(false, source);
  return unknown(source);
}

function scalar(item) {
  return item && item.state === 'known' ? item.value : null;
}

function displayFor(restaurant, meal, target, distance, facts, eligibleMealCount, unresolvedMealCount) {
  const price = scalar(facts.priceCents);
  const unknownFields = Object.entries(facts).filter(([, value]) => value.state !== 'known').map(([key]) => key);
  return { id: target === 'PACKAGE' ? meal.id : restaurant.id, target,
    name: target === 'PACKAGE' ? meal.name : restaurant.name,
    restaurantId: restaurant.id, restaurantName: restaurant.name,
    mealId: meal ? meal.id : null, mealName: meal ? meal.name : null,
    witnessMealId: target === 'RESTAURANT' && meal ? meal.id : null,
    storeCategory: scalar(restaurant.storeCategory),
    priceCents: price, priceBasis: 'virtual_final_scene_price',
    priceLabel: price === null ? '虚拟套餐价未知' : target === 'RESTAURANT' ? '本次条件下最低已知虚拟套餐价' : '虚拟场景价',
    distanceUnits: distance, distanceBasis: 'synthetic_euclidean_distance',
    spicy: scalar(facts.spicy), vegetarian: scalar(facts.vegetarian), mealRole: scalar(facts.mealRole),
    vegetarianBasis: target === 'RESTAURANT' ? 'exists_known_vegetarian_eligible_virtual_meal' : 'synthetic_meal_attribute',
    witnessVegetarian: meal ? scalar(meal.facts.vegetarian) : null,
    foodCategory: null, ingredients: null, actualMealRole: null,
    unknownFields: [...new Set([...unknownFields, 'foodCategory', 'ingredients', 'actualMealRole'])],
    eligibleMealCount, unresolvedMealCount,
    mode: 'VIRTUAL', coordinateSystem: catalog.coordinateSystem, position: { x: restaurant.x, y: restaurant.y },
    source: target === 'PACKAGE' ? meal.source : restaurant.source, version: FACT_VERSION,
    auditCodes: meal ? [...meal.auditCodes] : [], evidenceScope: 'virtual_scene_only' };
}

function buildProblem(options) {
  const settings = normalizeOptions(options);
  const conditions = hardConditions(settings);
  const candidates = [];
  const displayById = {};
  if (settings.target === 'PACKAGE') {
    for (const meal of catalog.meals) {
      const restaurant = restaurants.get(meal.restaurantId);
      const distance = distanceTo(restaurant, settings.origin);
      const facts = { priceCents: clone(meal.facts.priceCents),
        distanceUnits: known(distance, 'synthetic_euclidean_distance'),
        vegetarian: clone(meal.facts.vegetarian), spicy: clone(meal.facts.spicy), mealRole: clone(meal.facts.mealRole) };
      candidates.push({ id: meal.id, name: meal.name, facts,
        metadata: { restaurantId: restaurant.id, familyId: meal.familyId } });
      displayById[meal.id] = displayFor(restaurant, meal, settings.target, distance, facts, null, null);
    }
  } else {
    for (const restaurant of catalog.restaurants) {
      const distance = distanceTo(restaurant, settings.origin);
      const feasible = [];
      let unresolved = 0;
      for (const meal of mealsByRestaurant.get(restaurant.id) || []) {
        const status = classifyMeal(meal, distance, conditions);
        if (status === 'satisfied') feasible.push(meal);
        if (status === 'insufficient') unresolved++;
      }
      feasible.sort(byKnownPriceThenId);
      const witness = feasible[0] || null;
      const absent = () => unknown('no_confirmed_single_meal_witness');
      const facts = { priceCents: witness && witness.facts.priceCents.state === 'known'
        ? known(witness.facts.priceCents.value, 'minimum_known_eligible_virtual_meal_price') : absent(),
      distanceUnits: known(distance, 'synthetic_euclidean_distance'),
      vegetarian: witness ? vegetarianAvailability(feasible) : absent(),
      spicy: witness ? clone(witness.facts.spicy) : absent(),
      mealRole: witness ? clone(witness.facts.mealRole) : absent(),
      singleMealEligible: witness ? known(true, 'same_meal_satisfies_all_enabled_hard_conditions')
        : unresolved > 0 ? unknown('potential_single_meal_has_unknown_hard_facts')
          : known(false, 'every_meal_violates_an_enabled_hard_condition_or_pool_empty') };
      candidates.push({ id: restaurant.id, name: restaurant.name, facts,
        metadata: { witnessMealId: witness ? witness.id : null, familyId: restaurant.familyId,
          eligibleMealCount: feasible.length, unresolvedMealCount: unresolved } });
      displayById[restaurant.id] = displayFor(restaurant, witness, settings.target, distance, facts, feasible.length, unresolved);
    }
    conditions.push({ id: 'same_meal', attribute: 'singleMealEligible', op: 'eq', value: true });
  }
  const terms = [
    { id: 'price', type: 'piecewise', attribute: 'priceCents', weight: settings.weights.price, knots: [[0, 1], [5000, 0]] },
    { id: 'distance', type: 'piecewise', attribute: 'distanceUnits', weight: settings.weights.distance, knots: [[0, 1], [1500, 0]] },
  ];
  if (settings.target === 'PACKAGE' && settings.preferMain) terms.push({ id: 'main', type: 'match', attribute: 'mealRole', weight: settings.weights.main, op: 'eq', value: 'main' });
  const attributes = { priceCents: { type: 'number', semanticGroup: 'price' },
    distanceUnits: { type: 'number', semanticGroup: 'distance' },
    vegetarian: { type: 'boolean', semanticGroup: 'vegetarian' },
    spicy: { type: 'number', semanticGroup: 'spicy' },
    mealRole: { type: 'string', semanticGroup: 'meal_role' } };
  if (settings.target === 'RESTAURANT') attributes.singleMealEligible = { type: 'boolean', semanticGroup: 'single_meal_eligibility' };
  if (settings.taste !== null) {
    const model = require('./taste-profile');
    const groupByCategory = new Map(model.GROUPS.flatMap(group => group.categories.map(category => [category, group.id])));
    for (const candidate of candidates) {
      const restaurant = restaurants.get(settings.target === 'PACKAGE' ? candidate.metadata.restaurantId : candidate.id);
      const group = restaurant.storeCategory.state === 'known' ? groupByCategory.get(restaurant.storeCategory.value) : null;
      // Category membership is an explicit UI taxonomy; affinity is the user's
      // stated configuration, never a learned food fact or satisfaction score.
      candidate.facts.storeTypeGroup = group
        ? { state: 'known', value: group, source: 'declared_store_category_grouping', version: model.LEGACY_POLICY_VERSION }
        : { state: 'unknown', source: 'unmapped_or_unknown_store_category', version: model.LEGACY_POLICY_VERSION };
      candidate.facts.storeTypeAffinity = group
        ? { state: 'known', value: settings.taste.likedGroups.includes(group) ? 1 : 0.5,
          source: 'user_declared_store_type_preference', version: model.LEGACY_POLICY_VERSION }
        : { state: 'unknown', source: 'unmapped_or_unknown_store_category', version: model.LEGACY_POLICY_VERSION };
    }
    attributes.storeTypeGroup = { type: 'string', semanticGroup: 'store_type_exclusion', roles: ['hard'] };
    attributes.storeTypeAffinity = { type: 'number', semanticGroup: 'store_type_preference', roles: ['soft'] };
    if (settings.taste.avoidedGroups.length) conditions.push({ id: 'avoided_store_types', attribute: 'storeTypeGroup', op: 'in',
      value: model.GROUPS.filter(group => !settings.taste.avoidedGroups.includes(group.id)).map(group => group.id) });
    terms.push({ id: 'store_type_preference', type: 'piecewise', attribute: 'storeTypeAffinity', weight: settings.taste.weight,
      knots: [[0, 0], [1, 1]], unknownUtility: 0.5, origin: 'user_declared', scope: 'virtual_store_type_only' });
  }
  return { schema_version: 2,
    dataset: { id: 'r9a-reviewed-virtual-catalog', version: catalog.catalogVersion, source: catalog.sourceManifest.sourceSha256 },
    attributes, candidates,
    request: { conditions, explicit_preferences: { version: '2', terms } },
    context: { mode: 'VIRTUAL', target: settings.target, origin: settings.origin }, displayById };
}

function getDisplay(candidateId, target, problem) {
  if (typeof candidateId !== 'string' || (target !== 'PACKAGE' && target !== 'RESTAURANT')) return null;
  const current = problem || buildProblem({ target });
  if (current.context?.mode !== 'VIRTUAL' || current.context.target !== target) return null;
  const display = current.displayById?.[candidateId];
  return display ? clone(display) : null;
}

function assessProfile(input) {
  // Declaration completeness is separate from catalog-supported precision.
  // Price/distance differences do not establish a user's slider preferences.
  return require('./taste-profile').assessAnswers(input);
}

module.exports = { buildProblem, getDisplay, assessProfile, manifest: catalog.sourceManifest };
