const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const app = JSON.parse(read('app.json'));
const project = JSON.parse(read('project.config.json'));
const files = [];
function walk(folder) {
  for (const item of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const name = path.join(folder, item.name);
    if (item.isDirectory()) walk(name);
    else files.push(name);
  }
}
walk('');
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
for (const file of files.filter(name => /\.(js|wxml)$/.test(name) && !name.startsWith('tests') && !name.startsWith('scripts'))) {
  for (const match of read(file).matchAll(/(?:src|url)=["'](\/assets\/[^{}"']+)["']/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])), `Missing local asset ${match[1]}`);
  }
}
assert.deepEqual(app.requiredPrivateInfos, ['getLocation']);
assert.ok(!read('app.js').includes('wx.login'), 'No login before explicit user action');
console.log(`Checked ${app.pages.length} pages, ${files.length} files, JavaScript syntax and project configuration. DevTools compilation is a separate check.`);
