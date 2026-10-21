const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_SHA256 = 'f0314203be1fa95e01078db915cf631caf16190db44fa75a389a1e933c3c2321';
const SOURCE_VERSION = 'round9-a-v2';
const SCHEMA_VERSION = 'eatwhat-virtual-catalog-v1';
const EXPORT_VERSION = 'r9a-public-projection-v1';
const OUTPUT_PATH = path.resolve(__dirname, '../data/virtual-catalog.json');
const RUNTIME_PATH = path.resolve(__dirname, '../data/virtual-catalog.js');
const COORDINATES = 'virtual-square-0-1000';
const VIRTUAL_MEAL_NAME = / · (虚拟原型|模拟变体 [1-3])(（素食待确认）)?$/;
const FACT_KEYS = ['priceCents', 'spicy', 'vegetarian', 'mealRole', 'foodCategory', 'ingredients', 'actualMealRole'];
const ATTRIBUTE_BASES = new Set(['synthetic', 'synthetic_from_store_category', 'unknown',
  'unknown_due_multi_use', 'unknown_due_title_conflict', 'unknown_due_title_role_tension']);
const SHARED_CODES = new Set(['source_store_category_only', 'composition_unverified',
  'synthetic_role_not_real_fact']);
const UNITS = { coordinates: 'virtual_unit', distance: 'virtual_unit', priceCents: 'CNY_cent', spicy: 'ordinal_0_3' };
const SCOPE = { allEntitiesVirtual: true, coordinatesAreGeographic: false,
  priceIsVirtualScenePrice: true, storeCategoryIsFoodCategory: false,
  actualCompositionKnown: false, modelWeightsIncluded: false, feedbackIncluded: false };
const EXCLUDED_IDS = ['vm-S076-P03-0', 'vm-S076-P03-1', 'vm-S076-P03-2', 'vm-S076-P03-3'];

function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  assert.ok(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Non-JSON value');
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function identifier(value, pattern, label) {
  assert.equal(typeof value, 'string', label);
  assert.match(value, pattern, label);
  return value;
}

function fact(value, source) {
  return value === null
    ? { state: 'unknown', source, version: SOURCE_VERSION }
    : { state: 'known', value, source, version: SOURCE_VERSION };
}

function cents(value) {
  if (value === null) return null;
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Invalid virtual price');
  const amount = Math.round(value * 100);
  assert.ok(Number.isSafeInteger(amount) && Math.abs(amount / 100 - value) <= 1e-8, 'Price must resolve to whole cents');
  return amount;
}

function checkedAttribute(meal, field, valid) {
  const value = meal[field];
  const basis = meal.audit.attribute_basis[field];
  assert.ok(ATTRIBUTE_BASES.has(basis), `Unknown audit basis: ${field}`);
  assert.ok(value === null || valid(value), `Invalid ${field}`);
  assert.equal(basis.startsWith('unknown'), value === null, `Contradictory ${field} basis`);
  return fact(value, basis);
}

function assertKeys(value, expected, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

function countFacts(meals) {
  const unknown = Object.fromEntries(FACT_KEYS.map(key => [key, 0]));
  const roles = { main: 0, snack: 0, drink: 0, unknown: 0 };
  for (const meal of meals) {
    for (const key of FACT_KEYS) if (meal.facts[key].state === 'unknown') unknown[key]++;
    roles[meal.facts.mealRole.state === 'known' ? meal.facts.mealRole.value : 'unknown']++;
  }
  return { restaurants: 363, meals: meals.length, families: 121, excludedMeals: 4, roles, unknown };
}

function projectCatalog(input) {
  assert.equal(input.schema_version, 'round9-reviewed-catalog-v1');
  assert.equal(input.catalog_version, SOURCE_VERSION);
  assert.equal(input.audit_schema_version, 'round9-catalog-audit-v1');
  assert.equal(input.scope.all_entities_virtual, true);
  assert.equal(input.scope.real_world_execution_authorized, false);
  assert.equal(input.restaurants.length, 363);
  assert.equal(input.meals.length, 1096);
  const restaurants = input.restaurants.map(row => {
    identifier(row.id, /^vr-S\d{3}-[0-2]$/, 'Virtual restaurant ID');
    identifier(row.family_id, /^family-S\d{3}$/, 'Family ID');
    assert.equal(row.is_virtual, true);
    assert.equal(row.coordinate_system, COORDINATES);
    assert.ok(typeof row.x === 'number' && Number.isFinite(row.x) && row.x >= 0 && row.x <= 1000);
    assert.ok(typeof row.y === 'number' && Number.isFinite(row.y) && row.y >= 0 && row.y <= 1000);
    assert.equal(typeof row.category, 'string');
    assert.ok(row.category.length > 0);
    assert.equal(typeof row.name, 'string');
    assert.ok(row.name.startsWith('虚拟·') && row.provenance.generated_fields.includes('name'));
    assert.ok(row.provenance.generated_fields.includes('x') && row.provenance.generated_fields.includes('y'));
    return { id: row.id, name: row.name, familyId: row.family_id, x: row.x, y: row.y,
      storeCategory: fact(row.category, 'source_store_primary_category'),
      source: 'synthetic_virtual_restaurant', version: SOURCE_VERSION };
  }).sort(byId);
  const restaurantById = new Map(restaurants.map(row => [row.id, row]));
  assert.equal(restaurantById.size, restaurants.length, 'Duplicate restaurant IDs');
  const excluded = [];
  const seen = new Set();
  const meals = [];
  for (const row of input.meals) {
    identifier(row.id, /^vm-S\d{3}-P\d{2}-[0-3]$/, 'Virtual meal ID');
    assert.ok(!seen.has(row.id), 'Duplicate meal ID');
    seen.add(row.id);
    assert.equal(row.is_virtual, true);
    assert.equal(row.price_status, 'virtual_final_scene_price');
    assert.equal(row.audit.schema_version, 'round9-catalog-audit-v1');
    assert.equal(typeof row.audit.collection_eligible, 'boolean');
    const restaurant = restaurantById.get(row.restaurant_id);
    assert.ok(restaurant && restaurant.familyId === row.family_id, 'Meal restaurant/family mismatch');
    assert.equal(row.store_category, restaurant.storeCategory.value, 'Store category mismatch');
    assert.equal(row.category, row.store_category, 'Food and store category must remain separate');
    assert.equal(row.food_category, null, 'Unknown food category must not become known');
    assert.equal(row.ingredients, null, 'Unknown ingredients must not become known');
    assert.equal(row.actual_meal_role, null, 'Virtual role must not become actual role');
    const codes = [...new Set(row.audit.flags.map(flag => flag.code))].sort();
    const multi = codes.includes('multi_use_not_single_meal') || codes.includes('multi_person_not_single_meal');
    assert.equal(row.audit.collection_eligible, !multi, 'Collection eligibility contradicts reviewed offer unit');
    if (!row.audit.collection_eligible) {
      assert.equal(row.meal_role, null, 'A non-single offer cannot have a single-meal role');
      excluded.push({ id: row.id, reason: codes.includes('multi_use_not_single_meal') ? 'multi_use_offer' : 'multi_person_offer' });
      continue;
    }
    assert.ok(!['whole_multi_use_pass', 'named_multi_person_offer'].includes(row.audit.price_reference.unit), 'Excluded offer unit');
    if (codes.includes('synthetic_vegetarian_title_conflict')) {
      assert.equal(row.vegetarian, null, 'Reviewed vegetarian conflict must remain unknown');
      assert.equal(row.audit.attribute_basis.vegetarian, 'unknown_due_title_conflict');
    }
    const facts = {
      priceCents: fact(cents(row.price_yuan), row.price_yuan === null ? 'unknown' : 'virtual_final_scene_price'),
      spicy: checkedAttribute(row, 'spicy', value => Number.isInteger(value) && value >= 0 && value <= 3),
      vegetarian: checkedAttribute(row, 'vegetarian', value => typeof value === 'boolean'),
      mealRole: checkedAttribute(row, 'meal_role', value => ['main', 'snack', 'drink'].includes(value)),
      foodCategory: fact(null, 'unverified_food_category'),
      ingredients: fact(null, 'unverified_composition'),
      actualMealRole: fact(null, 'unverified_actual_meal_role'),
    };
    // R9A intentionally preserves the offer title, with an explicit virtual-scene suffix.
    const name = row.audit.display_name;
    assert.equal(name, row.name, 'Use the reviewed display name');
    assert.ok(typeof name === 'string' && VIRTUAL_MEAL_NAME.test(name), 'Reviewed meal must be explicitly virtual');
    meals.push({ id: row.id, restaurantId: row.restaurant_id, familyId: row.family_id, name, facts,
      priceBasis: 'virtual_final_scene_price',
      source: 'reviewed_virtual_meal', version: SOURCE_VERSION,
      auditCodes: codes.filter(code => !SHARED_CODES.has(code)) });
  }
  meals.sort(byId);
  excluded.sort(byId);
  assert.equal(meals.length, 1092);
  assert.equal(excluded.length, 4);
  assert.deepEqual(excluded.map(row => row.id), EXCLUDED_IDS);
  assert.equal(new Set(restaurants.map(row => row.familyId)).size, 121);
  const payload = { restaurants, meals };
  const catalog = {
    schemaVersion: SCHEMA_VERSION, catalogVersion: EXPORT_VERSION, mode: 'VIRTUAL',
    coordinateSystem: COORDINATES,
    units: { ...UNITS }, scope: { ...SCOPE },
    sourceManifest: { sourceArtifact: 'Algorithm/data/round9/catalog.reviewed.json',
      sourceSha256: SOURCE_SHA256, sourceVersion: SOURCE_VERSION,
      sourceCounts: { restaurants: 363, meals: 1096, families: 121 },
      exporterVersion: EXPORT_VERSION, exporterSha256: sha256(fs.readFileSync(__filename)),
      payloadSha256: sha256(canonical(payload)),
      counts: countFacts(meals), excludedMeals: excluded },
    ...payload,
  };
  validateCatalog(catalog);
  return catalog;
}

function validateCatalog(catalog) {
  assertKeys(catalog, ['schemaVersion', 'catalogVersion', 'mode', 'coordinateSystem', 'units', 'scope', 'sourceManifest', 'restaurants', 'meals'], 'Public catalog allowlist');
  assert.equal(catalog.schemaVersion, SCHEMA_VERSION);
  assert.equal(catalog.catalogVersion, EXPORT_VERSION);
  assert.equal(catalog.mode, 'VIRTUAL');
  assert.equal(catalog.coordinateSystem, COORDINATES);
  assert.deepEqual(catalog.units, UNITS);
  assert.deepEqual(catalog.scope, SCOPE);
  assertKeys(catalog.sourceManifest, ['sourceArtifact', 'sourceSha256', 'sourceVersion', 'sourceCounts',
    'exporterVersion', 'exporterSha256', 'payloadSha256', 'counts', 'excludedMeals'], 'Manifest allowlist');
  assert.equal(catalog.sourceManifest.sourceArtifact, 'Algorithm/data/round9/catalog.reviewed.json');
  assert.equal(catalog.sourceManifest.sourceSha256, SOURCE_SHA256);
  assert.equal(catalog.sourceManifest.sourceVersion, SOURCE_VERSION);
  assert.deepEqual(catalog.sourceManifest.sourceCounts, { restaurants: 363, meals: 1096, families: 121 });
  assert.equal(catalog.sourceManifest.exporterVersion, EXPORT_VERSION);
  assert.equal(catalog.sourceManifest.exporterSha256, sha256(fs.readFileSync(__filename)), 'Exporter digest');
  assert.equal(catalog.restaurants.length, 363);
  assert.equal(catalog.meals.length, 1092);
  assert.equal(catalog.sourceManifest.excludedMeals.length, 4);
  assert.deepEqual(catalog.sourceManifest.excludedMeals, EXCLUDED_IDS.map(id => ({ id, reason: 'multi_use_offer' })));
  const restaurantIds = new Set();
  const restaurants = new Map();
  for (const row of catalog.restaurants) {
    assertKeys(row, ['id', 'name', 'familyId', 'x', 'y', 'storeCategory', 'source', 'version'], 'Restaurant allowlist');
    assert.ok(!restaurantIds.has(row.id), 'Duplicate restaurant ID');
    restaurantIds.add(row.id);
    restaurants.set(row.id, row);
    identifier(row.id, /^vr-S\d{3}-[0-2]$/, 'Virtual restaurant ID');
    identifier(row.familyId, /^family-S\d{3}$/, 'Family ID');
    assert.equal(row.version, SOURCE_VERSION);
    assert.equal(row.source, 'synthetic_virtual_restaurant');
    assert.ok(typeof row.name === 'string' && row.name.startsWith('虚拟·'));
    assertKeys(row.storeCategory, ['state', 'value', 'source', 'version'], 'Store category fact');
    assert.equal(row.storeCategory.state, 'known');
    assert.ok(typeof row.storeCategory.value === 'string' && row.storeCategory.value.length > 0);
    assert.equal(row.storeCategory.source, 'source_store_primary_category');
    assert.equal(row.storeCategory.version, SOURCE_VERSION);
    assert.ok(Number.isFinite(row.x) && row.x >= 0 && row.x <= 1000);
    assert.ok(Number.isFinite(row.y) && row.y >= 0 && row.y <= 1000);
  }
  assert.equal(new Set(catalog.restaurants.map(row => row.familyId)).size, 121);
  assert.deepEqual(catalog.restaurants.map(row => row.id), [...restaurantIds].sort());
  const mealIds = new Set();
  for (const row of catalog.meals) {
    assertKeys(row, ['id', 'restaurantId', 'familyId', 'name', 'facts', 'source', 'version', 'auditCodes', 'priceBasis'], 'Meal allowlist');
    assert.ok(!mealIds.has(row.id) && restaurantIds.has(row.restaurantId), 'Meal identity/reference');
    mealIds.add(row.id);
    identifier(row.id, /^vm-S\d{3}-P\d{2}-[0-3]$/, 'Virtual meal ID');
    assert.equal(row.familyId, restaurants.get(row.restaurantId).familyId, 'Meal family mismatch');
    assert.equal(row.version, SOURCE_VERSION);
    assert.equal(row.source, 'reviewed_virtual_meal');
    assert.equal(row.priceBasis, 'virtual_final_scene_price');
    assert.ok(typeof row.name === 'string' && VIRTUAL_MEAL_NAME.test(row.name));
    assertKeys(row.facts, FACT_KEYS, 'Fact allowlist');
    for (const item of Object.values(row.facts)) {
      assert.ok(item.state === 'known' || item.state === 'unknown', 'Fact state');
      assertKeys(item, item.state === 'known' ? ['state', 'value', 'source', 'version'] : ['state', 'source', 'version'], 'Fact fields');
      assert.equal(item.version, SOURCE_VERSION);
      assert.ok(typeof item.source === 'string' && item.source.length > 0);
      if (item.state === 'known') assert.notEqual(item.value, null, 'Known null');
    }
    for (const key of ['foodCategory', 'ingredients', 'actualMealRole']) assert.equal(row.facts[key].state, 'unknown');
    if (row.facts.priceCents.state === 'known') assert.ok(Number.isSafeInteger(row.facts.priceCents.value) && row.facts.priceCents.value >= 0);
    if (row.facts.vegetarian.state === 'known') assert.equal(typeof row.facts.vegetarian.value, 'boolean');
    if (row.facts.spicy.state === 'known') assert.ok(Number.isInteger(row.facts.spicy.value) && row.facts.spicy.value >= 0 && row.facts.spicy.value <= 3);
    if (row.facts.mealRole.state === 'known') assert.ok(['main', 'snack', 'drink'].includes(row.facts.mealRole.value));
    for (const key of ['spicy', 'vegetarian', 'mealRole']) {
      const item = row.facts[key];
      assert.ok(ATTRIBUTE_BASES.has(item.source), `Unknown ${key} audit basis`);
      assert.equal(item.source.startsWith('unknown'), item.state === 'unknown', `Contradictory ${key} basis`);
    }
    assert.ok(Array.isArray(row.auditCodes) && row.auditCodes.every(code => typeof code === 'string' && /^[a-z_]+$/.test(code)));
    assert.deepEqual(row.auditCodes, [...new Set(row.auditCodes)].sort());
    assert.ok(!row.auditCodes.includes('multi_use_not_single_meal') && !row.auditCodes.includes('multi_person_not_single_meal'));
    if (row.auditCodes.includes('synthetic_vegetarian_title_conflict')) assert.equal(row.facts.vegetarian.state, 'unknown');
  }
  assert.deepEqual(catalog.meals.map(row => row.id), [...mealIds].sort());
  for (const row of catalog.sourceManifest.excludedMeals) assert.ok(!mealIds.has(row.id));
  assert.deepEqual(catalog.sourceManifest.counts, countFacts(catalog.meals));
  assert.equal(catalog.sourceManifest.payloadSha256, sha256(canonical({ restaurants: catalog.restaurants, meals: catalog.meals })), 'Payload digest');
  return catalog;
}

function serialize(catalog) {
  return `${canonical(catalog)}\n`;
}

function serializeRuntime(catalog) {
  return `module.exports = ${canonical(catalog)};\n`;
}

function validateArtifacts(catalog, jsonBytes, runtimeBytes) {
  validateCatalog(catalog);
  assert.deepEqual(Buffer.from(jsonBytes), Buffer.from(serialize(catalog)), 'Committed JSON export differs from deterministic bytes');
  assert.deepEqual(Buffer.from(runtimeBytes), Buffer.from(serializeRuntime(catalog)), 'Committed runtime JS differs from deterministic bytes');
  return catalog;
}

function buildFromSource(sourcePath) {
  const bytes = fs.readFileSync(sourcePath);
  assert.equal(sha256(bytes), SOURCE_SHA256, 'Use the pinned R9A-v2 reviewed catalog, not an earlier or modified source');
  return projectCatalog(JSON.parse(bytes.toString('utf8')));
}

function main(args) {
  const flags = new Set();
  let sourcePath;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--source') {
      assert.ok(!sourcePath && args[index + 1] && !args[index + 1].startsWith('--'), 'Provide one --source file');
      sourcePath = args[++index];
    } else {
      assert.ok(['--check', '--dry-run'].includes(arg) && !flags.has(arg), `Unknown or repeated option: ${arg}`);
      flags.add(arg);
    }
  }
  assert.ok(sourcePath || flags.has('--check'), 'Usage: node build-virtual-catalog.cjs --source <reviewed.json> [--check|--dry-run], or --check');
  const catalog = sourcePath ? buildFromSource(sourcePath) : validateCatalog(JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')));
  const output = serialize(catalog);
  const runtime = serializeRuntime(catalog);
  if (flags.has('--check')) validateArtifacts(catalog, fs.readFileSync(OUTPUT_PATH), fs.readFileSync(RUNTIME_PATH));
  else if (!flags.has('--dry-run')) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, output, 'utf8');
    fs.writeFileSync(RUNTIME_PATH, runtime, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ check: flags.has('--check'), written: !flags.has('--check') && !flags.has('--dry-run'),
    bytes: Buffer.byteLength(output), sha256: sha256(output), payloadSha256: catalog.sourceManifest.payloadSha256,
    runtimeBytes: Buffer.byteLength(runtime), runtimeSha256: sha256(runtime),
    counts: catalog.sourceManifest.counts, sample: flags.has('--dry-run') ? catalog.meals[0] : undefined })}\n`);
}

module.exports = { SOURCE_SHA256, SOURCE_VERSION, SCHEMA_VERSION, EXPORT_VERSION, OUTPUT_PATH, RUNTIME_PATH,
  canonical, sha256, projectCatalog, validateCatalog, serialize, serializeRuntime, validateArtifacts, buildFromSource };
if (require.main === module) main(process.argv.slice(2));
