const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const app = JSON.parse(read('app.json'));
const project = JSON.parse(read('project.config.json'));
execFileSync(process.execPath, [path.join(__dirname, 'build-virtual-catalog.cjs'), '--check'], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, 'build-canteen-data.cjs'), '--check'], { stdio: 'inherit' });
const files = [];
function walk(folder) {
  for (const item of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const name = path.join(folder, item.name);
    if (item.isDirectory()) walk(name);
    else files.push(name);
  }
}
walk('');
// The immutable upstream distribution is exempt only from house-style lint.
// Any byte change fails this pinned integrity check, and syntax is checked below.
const vendorRoot = 'lib/decision/vendor/';
const vendor = JSON.parse(read(`${vendorRoot}jsbi.metadata.json`));
assert.equal(vendor.name, 'jsbi');
assert.equal(vendor.version, '4.3.2');
assert.equal(vendor.modifications, 'none');
const vendorPins = {
  'jsbi.js': 'b952fc88337eae5d90b397da4251e207d816056ea4c574df576f17e68626dd94',
  LICENSE: '9568a2b155e66ac3e0ba1fd80b52b827b9460e6cf6f233125e7cbca8e206ddc3',
};
assert.deepEqual(vendor.sha256, vendorPins);
for (const [file, hash] of Object.entries(vendorPins)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, vendorRoot, file))).digest('hex'), hash, `Unreviewed vendor modification: ${file}`);
}
assert.doesNotMatch(read(`${vendorRoot}jsbi.js`), /\beval\s*\(|\bnew\s+Function\s*\(/, 'No dynamic code compilation in the arithmetic runtime');
assert.equal(project.compileType, 'miniprogram');
assert.equal(project.setting.urlCheck, true, 'Keep production domain validation enabled');
assert.ok(!project.cloudfunctionRoot, 'Use the existing Alibaba Cloud API');
for (const file of files) {
  if (/\.(js|cjs)$/.test(file)) new vm.Script(read(file), { filename: file });
  if (/\.json$/.test(file)) JSON.parse(read(file));
}
for (const page of app.pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(path.join(root, `${page}.${ext}`)), `${page}.${ext} is required`);
}
for (const file of files.filter(name => name.endsWith('.json') && !name.startsWith('tests'))) {
  const config = JSON.parse(read(file));
  for (const component of Object.values(config.usingComponents || {})) {
    if (!component.startsWith('/')) continue;
    const base = component.slice(1);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(path.join(root, `${base}.${ext}`)), `${file}: ${base}.${ext} is required`);
    assert.equal(JSON.parse(read(`${base}.json`)).component, true, `${base} must declare a native component`);
  }
}
for (const file of files.filter(name => /\.(js|wxml)$/.test(name) && !name.startsWith('tests') && !name.startsWith('scripts'))) {
  for (const match of read(file).matchAll(/(?:src|url)=["'](\/assets\/[^{}"']+)["']/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])), `Missing local asset ${match[1]}`);
  }
}
assert.deepEqual(app.requiredPrivateInfos, ['getLocation']);
assert.ok(!read('app.js').includes('wx.login'), 'No login before explicit user action');
console.log(`Checked ${app.pages.length} pages, ${files.length} files, JavaScript syntax and project configuration. DevTools compilation is a separate check.`);
