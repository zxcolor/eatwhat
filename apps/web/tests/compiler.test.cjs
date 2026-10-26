const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { parseWxml, emitAst, adaptModule } = require('../scripts/compiler.cjs');
test('conditions, comparison operators, objects and nested loops remain typed', () => {
  const source = `<view wx:if="{{count > 0}}" data-count="{{count}}"><text wx:for="{{items}}" wx:key="id">{{item.name}} &amp; {{count}}</text><template is="card" data="{{card:item,selected:true}}"/></view>`;
  const nodes = vm.runInNewContext(`(${emitAst(parseWxml(source))})`);
  assert.equal(nodes[0].attrs['wx:if']({ count: 2 }), true);
  assert.equal(nodes[0].attrs['data-count']({ count: 2 }), 2);
  assert.equal(nodes[0].children[0].children[0].text({ item: { name: '<script>' }, count: 2 }), '<script> & 2');
  assert.equal(nodes[0].children[1].attrs.data({ item: { id: 'a' } }).card.id, 'a');
});
test('malformed templates fail build instead of silently omitting content', () => {
  assert.throws(() => parseWxml('<view><text></view>'), /Unmatched/);
  assert.throws(() => parseWxml('<view foo="x" foo="y"/>'), /Duplicate/);
  assert.throws(() => parseWxml('<view'), /Unclosed/);
});
test('web account uses the WEB contract and accepts all supported device labels', () => {
  const source = fs.readFileSync(path.join(__dirname, '../source/wechat/lib/account.js'), 'utf8');
  const adapted = adaptModule(source, 'lib/account.js');
  assert.match(adapted, /label: '吃什么网页版', platform: 'WEB'/);
  assert.match(adapted, /'ANDROID', 'MINIPROGRAM', 'WEB'/);
  assert.doesNotMatch(adapted, /label: '微信小程序', platform: 'MINIPROGRAM'/);
  assert.throws(() => adaptModule('module.exports = {};', 'lib/account.js'), /no longer matches/);
});
