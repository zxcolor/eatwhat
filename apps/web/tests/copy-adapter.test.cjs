const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { browserCopy } = require('../scripts/copy-adapter.cjs');
const root = path.join(__dirname, '../source/wechat');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const adapted = name => browserCopy(read(name), name);

test('unscoped and unrelated source is unchanged rather than broadly replacing platform names', () => {
  const text = "微信账号 · 小程序 · ANDROID · MINIPROGRAM · label: '微信小程序' · 打开微信地图";
  assert.equal(browserCopy(text), text);
  assert.equal(browserCopy(text, 'lib/unrelated.js'), text);
});

test('account device and identity semantics stay available for the separate protocol adapter', () => {
  const source = read('lib/account.js'), result = browserCopy(source, 'lib/account.js');
  for (const literal of ["item.maskedValue === '微信账号'", "label: '微信小程序', platform: 'MINIPROGRAM'", "item.platform === 'MINIPROGRAM' ? '小程序' : 'Android'", "WECHAT: '微信', QQ: 'QQ'"]) {
    assert.ok(result.includes(literal), literal);
  }
  assert.match(result, /浏览器不支持小程序微信登录，请使用手机号或邮箱。/);
  assert.equal((result.match(/platform: 'MINIPROGRAM'/g) || []).length, (source.match(/platform: 'MINIPROGRAM'/g) || []).length);
});

test('account copy describes actual foreground-only browser sessions and unavailable native login', () => {
  const page = adapted('pages/account/index.wxml');
  assert.match(page, /本次网页前台会话期间有效/);
  assert.match(page, /网页切到后台、刷新、关闭或登录过期/);
  assert.match(page, /浏览器登录方式/);
  assert.match(page, /请使用手机号或已绑定邮箱/);
  assert.doesNotMatch(page, /当前服务尚未开放微信小程序登录/);
  assert.match(adapted('pages/account/index.js'), /这将立即结束本次浏览器登录/);
});

test('privacy copy accurately describes same-origin API, SVG route view, external AMap and memory images', () => {
  const page = adapted('pages/privacy/index.wxml');
  assert.match(page, /HTTPS 访问 eatwhat\.pro\/api，由同源代理转发至自有 API 服务器 api\.eatwhat\.pro/);
  assert.match(page, /示意图不含地图底图/);
  assert.match(page, /将所选餐厅的名称和目的地位置交给高德/);
  assert.doesNotMatch(page, /名称、地址和目的地位置/);
  assert.match(page, /不调用小程序微信登录或原生QQ登录/);
  assert.match(page, /已有账号绑定的微信、QQ身份/);
  assert.match(page, /浏览器内存中生成有大小限制的图片副本/);
  assert.match(page, /不写入浏览器持久存储/);
  assert.match(page, /浏览器位置权限/);
  assert.doesNotMatch(page, /小程序地图组件|交给微信地图|不使用微信云开发|微信快捷登录仅在服务开放/);
  // Preserve upstream data rights, menu facts, attribution and retention claims.
  for (const fragment of ['不编造餐厅补足', '最长两小时', '历史记录最多30条、最长90天', '回执有效期10分钟', '不代表小米侧零留存', '服务器不持久保存图片']) assert.ok(page.includes(fragment), fragment);
});

test('route actions and accessible labels consistently name web route view and AMap', () => {
  for (const name of ['pages/detail/index.wxml', 'pages/results/index.wxml']) {
    const page = adapted(name);
    assert.match(page, /网页内查看路线/); assert.match(page, /打开高德地图/); assert.match(page, /在高德地图查看/);
    assert.doesNotMatch(page, /打开微信地图|在微信地图|小程序内查看/);
  }
  const route = adapted('pages/route/index.wxml');
  assert.match(route, /路线示意和分步说明/); assert.match(route, /不含地图底图/);
  assert.match(route, /点击路段可在示意图中查看/);
});

test('settings, permission and image errors give browser-specific recovery instructions', () => {
  assert.match(adapted('pages/settings/index.wxml'), /吃什么 · 网页版/);
  assert.match(adapted('pages/settings/index.wxml'), /当前浏览器/);
  assert.match(adapted('pages/nearby/index.wxml'), /查看浏览器权限设置方法/);
  assert.match(adapted('pages/location/index.js'), /浏览器网站权限/);
  for (const name of ['pages/takeout/index.js', 'lib/takeout-images.js', 'lib/random.js', 'lib/restaurant-navigation.js']) {
    assert.doesNotMatch(adapted(name), /更新微信|当前微信|微信照片隐私授权|微信的位置与隐私设置/);
  }
  assert.doesNotMatch(adapted('lib/service.js'), /更新小程序|重新进入小程序/);
});

test('known copy adapts Windows path separators and is idempotent', () => {
  const text = read('pages/settings/index.wxml');
  assert.equal(browserCopy(text, 'pages\\settings\\index.wxml'), browserCopy(text, 'pages/settings/index.wxml'));
  const privacy = adapted('pages/privacy/index.wxml');
  assert.equal(browserCopy(privacy, 'pages/privacy/index.wxml'), privacy);
});

test('all adapted JavaScript remains parseable and source files remain byte-identical', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '../manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const filename of walk(root).filter(filename => filename.endsWith('.js'))) {
    const relative = path.relative(root, filename).replaceAll(path.sep, '/');
    const source = fs.readFileSync(filename, 'utf8');
    new vm.Script(browserCopy(source, relative), { filename: relative });
  }
  for (const file of manifest.files) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file.path))).digest('hex');
    assert.equal(digest, file.sha256, file.path);
  }
});
