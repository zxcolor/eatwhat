const fs = require('node:fs');
const path = require('node:path');

// JSON is the editable source. Native mini-program code loads these JS mirrors.
// This exporter never reparses the Markdown or renumbers stable menu IDs.
const DATA_DIR = path.resolve(__dirname, '../data');
const ARTIFACTS = ['canteen-menu', 'canteen-policy'].map(name => ({
  jsonPath: path.join(DATA_DIR, `${name}.json`),
  runtimePath: path.join(DATA_DIR, `${name}.js`),
}));

function serializeRuntime(value) {
  return `// Generated from the sibling JSON by scripts/build-canteen-data.cjs.\n// Edit the JSON source, then regenerate this file.\nmodule.exports = ${JSON.stringify(value, null, 2)};\n`;
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

module.exports = { ARTIFACTS, serializeRuntime, buildArtifacts };
