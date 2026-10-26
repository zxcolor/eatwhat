const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseWxml, emitAst } = require('../scripts/compiler.cjs');

// A small deterministic DOM double exercises host semantics. It does not
// substitute for browser rendering, pointer, permissions, or device acceptance.
class EventDouble {
  constructor(type, options = {}) { Object.assign(this, { type, bubbles: false, cancelable: true, timeStamp: 1, ...options }); }
  stopPropagation() { this.stopped = true; }
  preventDefault() { this.defaultPrevented = true; }
}
class NodeDouble {
  constructor(tag, document, text) {
    this.tagName = tag; this.ownerDocument = document; this.parentNode = null; this.childNodes = [];
    this.nodeValue = text; this.attrs = {}; this.style = {}; this.dataset = {}; this.listeners = new Map();
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.scrollLeft = 0; this.scrollTop = 0; this.clientWidth = 375; this.clientHeight = 700;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  set className(value) { this.attrs.class = value; }
  get className() { return this.attrs.class || ''; }
  set id(value) { this.attrs.id = value; }
  get id() { return this.attrs.id || ''; }
  get isConnected() { return this === this.ownerDocument || Boolean(this.parentNode?.isConnected) || Boolean(this.host?.isConnected); }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { if (!this.parentNode) return null; return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.remove();
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    if (index < 0) throw new Error('Invalid insertion point');
    this.childNodes.splice(index, 0, node); node.parentNode = this; return node;
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
  replaceChildren(...nodes) { for (const child of [...this.childNodes]) child.remove(); this.append(...nodes); }
  set textContent(value) {
    if (this.tagName === '#text') this.nodeValue = String(value);
    else this.replaceChildren(this.ownerDocument.createTextNode(String(value)));
  }
  get textContent() { return this.tagName === '#text' ? this.nodeValue : this.childNodes.map(node => node.textContent).join(''); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(name, handler) { const entries = this.listeners.get(name) || []; entries.push(handler); this.listeners.set(name, entries); }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const handler of this.listeners.get(event.type) || []) handler(event);
    if (event.bubbles && !event.stopped) this.parentNode?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  click() { this.dispatchEvent(new EventDouble('click', { bubbles: true })); }
  focus() { this.ownerDocument.activeElement = this; }
  attachShadow() { this.shadowRoot = new NodeDouble('#shadow', this.ownerDocument); this.shadowRoot.host = this; return this.shadowRoot; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 44, width: 300, height: 44 }; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector === 'input[type="checkbox"]:checked') return this.tagName === 'input' && this.type === 'checkbox' && this.checked;
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    return this.childNodes.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class DocumentDouble extends NodeDouble {
  constructor() {
    super('#document', null); this.ownerDocument = this; this.readyState = 'complete'; this.hidden = false;
    this.documentElement = new NodeDouble('html', this);
    this.head = new NodeDouble('head', this); this.body = new NodeDouble('body', this);
    this.append(this.documentElement); this.documentElement.append(this.head, this.body);
  }
  createElement(tag) { return new NodeDouble(tag, this); }
  createTextNode(value) { return new NodeDouble('#text', this, String(value)); }
  getElementById(id) { return this.querySelector(`#${id}`); }
}
const settle = async context => { for (let count = 0; count < 8; count += 1) { await Promise.resolve(); context.EWRuntime.flush(); } };
function harness({ modules = {}, templates = {}, configs = {}, pages = ['pages/start/index', 'pages/next/index'] } = {}) {
  const document = new DocumentDouble();
  const events = new NodeDouble('#window', document);
  const context = {
    document, URL, URLSearchParams, console, CustomEvent: EventDouble, performance: { now: () => 10 },
    setTimeout: () => 1, clearTimeout() {}, queueMicrotask, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    Image: class {}, innerHeight: 748, innerWidth: 375, scrollX: 0, scrollY: 0,
    location: { hash: '' }, addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
  };
  context.scrollTo = (x, y) => { context.scrollX = x; context.scrollY = y; };
  const entries = []; let position = -1;
  context.history = {
    replaceState(state, _, hash) { if (position < 0) position = 0; entries[position] = { state, hash }; context.location.hash = hash; },
    pushState(state, _, hash) { position += 1; entries.splice(position); entries[position] = { state, hash }; context.location.hash = hash; },
    go(delta) { position = Math.max(0, position + delta); const entry = entries[position]; context.location.hash = entry.hash; events.dispatchEvent(new EventDouble('popstate', { state: entry.state })); },
  };
  context.window = context; context.globalThis = context;
  vm.createContext(context);
  const factories = { 'app.js': 'App({onLaunch(){this.launches=1},onShow(){this.shows=(this.shows||0)+1},onHide(){this.hides=(this.hides||0)+1}})',
    'pages/start/index.js': 'Page({data:{},onShow(){this.shows=(this.shows||0)+1},onHide(){this.hides=(this.hides||0)+1}})',
    'pages/next/index.js': 'Page({data:{}})', ...modules };
  context.EW_MINI = { modules: {}, templates: {}, configs, styles: {}, appConfig: { pages } };
  for (const [id, source] of Object.entries(factories)) context.EW_MINI.modules[id] = vm.runInContext(`(function(require,module,exports){${source}\n})`, context);
  for (const [id, source] of Object.entries(templates)) context.EW_MINI.templates[id] = vm.runInContext(emitAst(parseWxml(source)), context);
  context.installPlatform = () => { context.wx = { nextTick: callback => queueMicrotask(callback) }; };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../runtime/render.js'), 'utf8'), context, { filename: 'render.js' });
  return context;
}

test('keyed updates preserve input nodes, focus, order, and literal untrusted text', async () => {
  const context = harness({
    modules: { 'pages/start/index.js': 'Page({data:{value:"start",items:[{id:"a",label:"A"},{id:"b",label:"B"}],show:true},edit(e){this.setData({value:e.detail.value})}})' },
    templates: { 'pages/start/index': '<input id="input" value="{{value}}" bindinput="edit"/><view wx:for="{{items}}" wx:key="id" id="{{item.id}}">{{item.label}}</view><view wx:if="{{show}}" id="yes">yes</view><view wx:else id="no">no</view>' },
  });
  await settle(context);
  const page = context.EWRuntime.currentPages()[0], input = context.document.getElementById('input');
  const first = context.document.getElementById('a');
  input.focus(); input.value = 'typed'; input.selectionStart = 3;
  input.dispatchEvent(new EventDouble('input'));
  page.setData({ items: [{ id: 'b', label: '<script>no()</script>' }, { id: 'a', label: 'updated' }], show: false });
  await settle(context);
  assert.equal(context.document.getElementById('input'), input);
  assert.equal(context.document.activeElement, input);
  assert.equal(input.value, 'typed');
  assert.equal(context.document.getElementById('a'), first);
  assert.equal(first.textContent, 'updated');
  assert.equal(context.document.getElementById('b').textContent, '<script>no()</script>');
  assert.equal(context.document.querySelector('script'), null);
  assert.equal(context.document.getElementById('yes'), null);
  assert.equal(context.document.getElementById('no').textContent, 'no');
  assert.deepEqual(page._root.childNodes.filter(node => node.tagName === 'view').map(node => node.id), ['b', 'a', 'no']);
});

test('component properties, observers, ready, navigation hide/show and DOM callbacks stay ordered', async () => {
  const context = harness({
    modules: {
      'pages/start/index.js': 'Page({data:{count:1}})',
      'components/counter/index.js': 'Component({properties:{count:{type:Number,value:0}},data:{},observers:{count(value){this.observed=value}},lifetimes:{attached(){this.attachedCount=(this.attachedCount||0)+1;this.atAttachment=this.properties.count},ready(){this.wasReady=true}},pageLifetimes:{show(){this.shown=(this.shown||0)+1},hide(){this.hidden=(this.hidden||0)+1}}})',
    },
    configs: { 'pages/start/index': { usingComponents: { counter: '/components/counter/index' } } },
    templates: { 'pages/start/index': '<counter id="counter" count="{{count}}"/>', 'components/counter/index': '<view id="count">{{count}}</view>', 'pages/next/index': '<view>next</view>' },
  });
  await settle(context);
  const page = context.EWRuntime.currentPages()[0], component = page.selectComponent('#counter');
  assert.equal(component.atAttachment, 1); assert.equal(component.wasReady, true);
  let textAtCallback;
  page.setData({ count: 2 }, () => { textAtCallback = component._queryRoot.querySelector('#count').textContent; });
  await settle(context);
  assert.equal(component.observed, 2); assert.equal(textAtCallback, '2');
  context.EWRuntime.navigate('/pages/next/index', 'navigateTo');
  assert.equal(component.hidden, 1);
  context.EWRuntime.back(); await settle(context);
  assert.equal(page.selectComponent('#counter'), component);
  assert.equal(component.shown, 1);
  assert.equal(component.attachedCount, 1);
  context.document.hidden = true; context.document.dispatchEvent(new EventDouble('visibilitychange'));
  assert.equal(context.EWRuntime.app().hides, 1);
  context.document.hidden = false; context.document.dispatchEvent(new EventDouble('visibilitychange'));
  assert.equal(context.EWRuntime.app().shows, 2);
});

test('named templates and nested keyed loops keep independent scope', async () => {
  const context = harness({
    modules: { 'pages/start/index.js': 'Page({data:{title:"outer",rows:[{id:"x",values:[1,2]},{id:"y",values:[3]}]}})' },
    templates: { 'pages/start/index': '<template name="row"><view>{{label}}:{{Math.max(2, value)}}{{missing?.value}}</view></template><block wx:for="{{rows}}" wx:key="id" wx:for-item="row"><template wx:for="{{row.values}}" wx:key="*this" is="row" data="{{label:row.id,value:item}}"/></block>' },
  });
  await settle(context);
  assert.equal(context.EWRuntime.currentPages()[0]._root.textContent, 'x:2x:2y:3');
});

test('actual taste-slider source commits pointer and keyboard changes without remounting', async () => {
  const source = name => fs.readFileSync(path.join(__dirname, '../source/wechat', name), 'utf8');
  const context = harness({
    modules: {
      'pages/start/index.js': 'Page({data:{value:0,revision:1},commit(event){this.committed=event.detail;this.setData({value:event.detail.value,revision:this.data.revision+1})}})',
      'components/taste-slider/index.js': source('components/taste-slider/index.js'),
      'lib/decision-motion.js': source('lib/decision-motion.js'),
    },
    configs: { 'pages/start/index': { usingComponents: { 'taste-slider': '/components/taste-slider/index' } } },
    templates: {
      'pages/start/index': '<taste-slider id="taste" field="spicyLevel" value="{{value}}" revision="{{revision}}" min="{{0}}" max="{{4}}" step="{{1}}" bind:commit="commit"/>',
      'components/taste-slider/index': source('components/taste-slider/index.wxml'),
    },
  });
  await settle(context);
  const page = context.EWRuntime.currentPages()[0], component = page.selectComponent('#taste');
  const control = component._queryRoot.querySelector('.taste-control');
  const pointer = (name, x) => control.dispatchEvent(new EventDouble(name, { pointerId: 3, button: 0, isPrimary: true, clientX: x, clientY: 5, pageX: x, pageY: 5 }));
  pointer('pointerdown', 0); await settle(context);
  pointer('pointermove', 150); await settle(context);
  pointer('pointerup', 150); await settle(context);
  assert.equal(page.committed.value, 2); assert.equal(page.committed.dragged, true);
  assert.equal(component._queryRoot.querySelector('.taste-control'), control);
  control.dispatchEvent(new EventDouble('keydown', { key: 'ArrowRight' })); await settle(context);
  assert.equal(page.committed.value, 3);
  assert.equal(page.selectComponent('#taste'), component);
});

test('pickers and checkbox groups pass Mini Program values rather than HTML events', async () => {
  const context = harness({
    modules: { 'pages/start/index.js': 'Page({data:{options:[{label:"全部"},{label:"档口"}]},pick(e){this.picked=e.detail.value},check(e){this.checked=e.detail.value}})' },
    templates: { 'pages/start/index': '<picker id="picker" range="{{options}}" range-key="label" value="{{0}}" bindchange="pick"><view>全部</view></picker><checkbox-group id="checks" bindchange="check"><checkbox value="a" checked="{{true}}"/><checkbox value="b"/></checkbox-group>' },
  });
  await settle(context);
  const page = context.EWRuntime.currentPages()[0];
  const select = context.document.getElementById('picker').querySelector('select');
  select.value = '1'; select.dispatchEvent(new EventDouble('change'));
  assert.equal(page.picked, 1);
  const group = context.document.getElementById('checks'), checks = group.querySelectorAll('input');
  checks[1].checked = true; checks[1].dispatchEvent(new EventDouble('change', { bubbles: true }));
  assert.deepEqual(Array.from(page.checked), ['a', 'b']);
});

test('dynamic image URLs cannot become script handlers and removed page metadata releases scroll', async () => {
  const context = harness({
    modules: { 'pages/start/index.js': 'Page({data:{source:"javascript:alert(1)",locked:true,semantics:"checkbox"}})' },
    templates: { 'pages/start/index': '<page-meta wx:if="{{locked}}" page-style="overflow:hidden;"/><image id="image" src="{{source}}" onerror="alert(1)"/><button id="semantic" aria-role="{{semantics}}">label</button><switch id="switch" checked="{{true}}"/>' },
  });
  await settle(context);
  const page = context.EWRuntime.currentPages()[0];
  const image = context.document.getElementById('image');
  assert.equal(image.getAttribute('src'), null);
  assert.equal(image.getAttribute('onerror'), null);
  assert.equal(context.document.getElementById('semantic').getAttribute('role'), 'checkbox');
  assert.equal(context.document.getElementById('switch').getAttribute('role'), 'switch');
  assert.equal(context.document.body.style.overflow, 'hidden');
  context.EW_MINI.assetBase = '/web-release/';
  page.setData({ source: '/assets/meal-placeholder.svg', locked: false });
  await settle(context);
  assert.equal(image.getAttribute('src'), 'https://eatwhat.pro/web-release/assets/meal-placeholder.svg');
  assert.equal(context.document.body.style.overflow, '');
});

test('root home has one home action, and installed map renderer does not inherit placeholder styling', async () => {
  const context = harness({
    pages: ['pages/start/index', 'pages/index/index'],
    modules: { 'pages/index/index.js': 'Page({data:{revision:1}})' },
    templates: { 'pages/index/index': '<map id="route" class="route-map" scale="{{revision}}"/>' },
  });
  context.EWRenderMap = element => { element.textContent = 'actual route geometry'; };
  context.EWRuntime.navigate('/pages/index/index', 'reLaunch');
  await settle(context);
  assert.equal(context.document.querySelector('.ew-back').hidden, true);
  const map = context.document.getElementById('route');
  assert.equal(map.classList.contains('ew-native-map'), false);
  assert.equal(map.textContent, 'actual route geometry');
});
