const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseWxml, emitAst } = require('./compiler.cjs');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
for (const dir of ['scripts', 'runtime']) {
  for (const file of walk(path.join(root, dir)).filter(file => /\.(cjs|js)$/.test(file))) {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) { process.stderr.write(check.stderr); process.exit(1); }
  }
}
let count = 0;
for (const file of walk(path.join(root, 'source/wechat')).filter(file => file.endsWith('.wxml'))) {
  new vm.Script(`(${emitAst(parseWxml(fs.readFileSync(file, 'utf8'), file))})`); count++;
}
console.log(`WEB_CHECK_OK ${count} templates`);
