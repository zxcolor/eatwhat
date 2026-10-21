const fs = require('node:fs');
const path = require('node:path');

// JSON is the editable source. Native mini-program code loads these JS mirrors.
// This exporter never reparses the Markdown or renumbers stable menu IDs.
const DATA_DIR = path.resolve(__dirname, '../data');
const SERVER_CATALOG_PATH = path.resolve(__dirname, '../../../packages/contracts/src/canteen-catalog.ts');
const ARTIFACTS = ['canteen-menu', 'canteen-policy', 'canteen-taste-policy', 'canteen-history-catalogs'].map(name => ({
  jsonPath: path.join(DATA_DIR, `${name}.json`),
  runtimePath: path.join(DATA_DIR, `${name}.js`),
}));

function serializeRuntime(value) {
  return `// Generated from the sibling JSON by scripts/build-canteen-data.cjs.\n// Edit the JSON source, then regenerate this file.\nmodule.exports = ${JSON.stringify(value, null, 2)};\n`;
}

function serializeServerCatalog(menu, policy) {
  const allowed = new Set(policy.items.filter(entry => entry.defaultCandidate === true).map(entry => entry.itemId));
  const stalls = new Map(menu.stalls.map(stall => [stall.id, stall.name]));
  const value = { version: menu.version, items: menu.items.filter(item => allowed.has(item.id)).map(item => ({
    id: item.id, name: item.name, stallName: stalls.get(item.stallId), category: item.category,
    priceText: item.originalPriceText, spicyLevel: null, flavorIntensity: null,
  })) };
  return `// Generated from apps/wechat/data/canteen-menu.json and canteen-policy.json.\n// Public menu data only; never populate missing taste facts from dish names.\nexport interface CanteenModelItem { readonly id: string; readonly name: string; readonly stallName: string; readonly category: string | null; readonly priceText: string; readonly spicyLevel: null; readonly flavorIntensity: null; }\nexport const CANTEEN_SERVER_CATALOG: { readonly version: string; readonly items: readonly CanteenModelItem[] } = ${JSON.stringify(value, null, 2)};\n`;
}

function buildArtifacts({ check = false } = {}) {
  for (const artifact of ARTIFACTS) {
    const value = JSON.parse(fs.readFileSync(artifact.jsonPath, 'utf8'));
    const expected = serializeRuntime(value);
    if (check) {
      const actual = fs.readFileSync(artifact.runtimePath, 'utf8');
      if (actual.replace(/\r\n/g, '\n') !== expected) {
        throw new Error(`${path.basename(artifact.runtimePath)} is stale; run node apps/wechat/scripts/build-canteen-data.cjs`);
      }
    } else {
      fs.writeFileSync(artifact.runtimePath, expected, 'utf8');
    }
  }
  const server = serializeServerCatalog(
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'canteen-menu.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'canteen-policy.json'), 'utf8')));
  if (check) {
    if (fs.readFileSync(SERVER_CATALOG_PATH, 'utf8').replace(/\r\n/g, '\n') !== server) throw new Error('Server canteen catalog is stale; regenerate canteen data.');
  } else fs.writeFileSync(SERVER_CATALOG_PATH, server, 'utf8');
  return ARTIFACTS;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check') || args.length > 1) {
    throw new Error('Usage: node apps/wechat/scripts/build-canteen-data.cjs [--check]');
  }
  buildArtifacts({ check: args.includes('--check') });
  console.log(args.includes('--check') ? 'Canteen data mirrors verified.' : 'Canteen data mirrors generated.');
}

module.exports = { ARTIFACTS, serializeRuntime, serializeServerCatalog, buildArtifacts };
