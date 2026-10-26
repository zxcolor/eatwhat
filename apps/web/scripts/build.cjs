const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { parseWxml, emitAst, adaptModule, browserCopy, compileCss } = require('./compiler.cjs');
const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'source/wechat');
const finalOutput = path.join(root, 'dist');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error(`Build input must be a regular file or directory: ${file}`);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
function verifySnapshot(directory, manifest) {
  const actual = walk(directory).map(file => path.relative(directory, file).replaceAll(path.sep, '/')).sort();
  const expected = manifest.files.map(entry => entry.path).sort();
  if (new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Source snapshot membership changed');
  for (const entry of manifest.files) {
    if (sha(fs.readFileSync(path.join(directory, entry.path))) !== entry.sha256) throw new Error(`Source snapshot changed: ${entry.path}`);
  }
}
function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'source/manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  verifySnapshot(sourceRoot, manifest);
  const modules = [], templates = [], configs = {}, styles = {};
  const sourceFiles = walk(sourceRoot).sort();
  const requiredJson = new Set();
  for (const file of sourceFiles.filter(file => file.endsWith('.js'))) {
    const relative = path.relative(sourceRoot, file).replaceAll(path.sep, '/');
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\(['"](\.[^'"]+\.json)['"]\)/g)) requiredJson.add(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
  }
  for (const file of sourceFiles) {
    const relative = path.relative(sourceRoot, file).replaceAll(path.sep, '/');
    if (file.endsWith('.js')) modules.push(`${JSON.stringify(relative)}:function(require,module,exports){\n${adaptModule(fs.readFileSync(file, 'utf8'), relative)}\n}`);
    if (file.endsWith('.wxml')) templates.push(`${JSON.stringify(relative.slice(0, -5))}:${emitAst(parseWxml(browserCopy(fs.readFileSync(file, 'utf8'), relative), relative))}`);
    if (file.endsWith('.json')) {
      const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (/^(?:app|theme)\.json$/.test(relative) || /^(?:pages|components)\//.test(relative)) configs[relative.slice(0, -5)] = json;
      // Data already has the original Mini Program JS mirror. Shipping that
      // same catalog again as an unused module and config triples its payload.
      if (requiredJson.has(relative)) modules.push(`${JSON.stringify(relative)}:function(require,module,exports){module.exports=${JSON.stringify(json)};}`);
    }
    if (file.endsWith('.wxss')) styles[relative.slice(0, -5)] = compileCss(sourceRoot, relative);
  }
  const bundle = `/* Generated from the immutable WeChat source snapshot. */\nwindow.EW_MINI={modules:{${modules.join(',\n')}},templates:{${templates.join(',\n')}},configs:${JSON.stringify(configs)},styles:${JSON.stringify(styles)},appConfig:${JSON.stringify(configs.app)}};\n`;
  new vm.Script(bundle, { filename: 'mini.js' });
  for (const route of configs.app.pages) {
    if (!fs.existsSync(path.join(sourceRoot, `${route}.js`))) throw new Error(`Missing page ${route}`);
  }
  const scratchRoot = path.resolve(root, '../../.codex-tmp');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const output = fs.mkdtempSync(path.join(scratchRoot, 'web-build-'));
  const revision = sha(bundle).slice(0, 12);
  fs.writeFileSync(path.join(output, 'mini.js'), bundle);
  fs.cpSync(path.join(sourceRoot, 'assets'), path.join(output, 'assets'), { recursive: true });
  for (const name of ['platform.js', 'render.js', 'map.js', 'base.css', 'map.css']) {
    const runtimeFile = path.join(root, 'runtime', name);
    if (!fs.existsSync(runtimeFile)) throw new Error(`Missing browser runtime ${name}`);
    fs.copyFileSync(runtimeFile, path.join(output, name));
  }
  let index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const name of ['mini.js', 'platform.js', 'render.js', 'map.js', 'base.css', 'map.css']) {
    index = index.replaceAll(`"./${name}"`, `"./${name}?v=${sha(fs.readFileSync(path.join(output, name))).slice(0, 12)}"`);
  }
  fs.writeFileSync(path.join(output, 'index.html'), index);
  const files = walk(output).filter(file => !file.endsWith('build-manifest.json')).map(file => ({ path: path.relative(output, file).replaceAll(path.sep, '/'), sha256: sha(fs.readFileSync(file)) }));
  fs.writeFileSync(path.join(output, 'build-manifest.json'), JSON.stringify({ sourceVersion: manifest.version, revision, routes: configs.app.pages, files }, null, 2));
  // Build into a new directory so stale debug or cached files can never become
  // members of a new release. Preserve old generated output in ignored scratch.
  if (fs.existsSync(finalOutput)) {
    if (fs.lstatSync(finalOutput).isSymbolicLink() || path.dirname(fs.realpathSync(finalOutput)) !== fs.realpathSync(root)) throw new Error('Refusing to move output outside the website workspace');
    const previous = path.join(scratchRoot, `web-build-previous-${crypto.randomUUID()}`);
    if (!path.resolve(previous).startsWith(scratchRoot + path.sep)) throw new Error('Previous build destination escaped scratch');
    fs.renameSync(finalOutput, previous);
  }
  if (!fs.realpathSync(output).startsWith(fs.realpathSync(scratchRoot) + path.sep)) throw new Error('Build stage escaped scratch');
  fs.renameSync(output, finalOutput);
  console.log(`WEB_BUILD_OK ${configs.app.pages.length} pages, ${templates.length - configs.app.pages.length} components, source ${manifest.version}, ${revision}`);
}
if (require.main === module) build();
module.exports = { build, verifySnapshot };
