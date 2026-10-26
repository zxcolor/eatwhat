/* EatWhat browser host for the versioned Mini Program source snapshot. */
(() => {
  'use strict';
  const bundle = window.EW_MINI;
  if (!bundle) throw new Error('EatWhat source bundle is missing');
  const moduleCache = new Map();
  const definitions = new Map();
  const instanceByNode = new WeakMap();
  const dirty = new Set();
  const callbacks = [];
  let defining = '', appInstance = null, scheduled = false, flushing = false;
  let stack = [], nextPageId = 0, background = false, pendingBack = null;
  let appRoot, nav, navTitle, backButton, activeStyle;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const camel = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const normalize = value => {
    const parts = [];
    for (const piece of value.replace(/\\/g, '/').split('/')) {
      if (piece === '..') parts.pop();
      else if (piece && piece !== '.') parts.push(piece);
    }
    return parts.join('/');
  };
  function modulePath(path, from = '') {
    const root = path.startsWith('.') ? `${from.slice(0, from.lastIndexOf('/') + 1)}${path}` : path;
    const result = normalize(root);
    for (const candidate of [result, `${result}.js`, `${result}.json`, `${result}/index.js`]) {
      if (own(bundle.modules, candidate)) return candidate;
    }
    throw new Error(`Unknown application module: ${result}`);
  }
  function requireModule(path, from) {
    const id = modulePath(path, from);
    if (moduleCache.has(id)) return moduleCache.get(id).exports;
    const module = { exports: {} };
    moduleCache.set(id, module);
    const previous = defining;
    defining = id.replace(/\.js$/, '');
    try {
      const factory = bundle.modules[id];
      if (typeof factory === 'function') factory(request => requireModule(request, id), module, module.exports);
      else module.exports = factory;
    } catch (error) {
      moduleCache.delete(id);
      throw error;
    } finally { defining = previous; }
    return module.exports;
  }
  function scopeOf(data, parent) {
    const target = Object.assign(Object.create(parent || null), data || {});
    return new Proxy(target, {
      has: (_, key) => key !== Symbol.unscopables,
      get: (object, key) => key === Symbol.unscopables ? undefined : key in object ? object[key] : globalThis[key],
    });
  }
  function valueOf(value, scope) {
    if (typeof value !== 'function') return value;
    try { return value(scope); }
    catch (error) {
      // WXML renders missing nested data as empty until it arrives. Do not
      // surface source/API/user text in diagnostic logging.
      if (error instanceof TypeError || error instanceof ReferenceError) return undefined;
      throw error;
    }
  }
  function stringOf(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  function setPath(target, path, value) {
    const pieces = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    if (pieces.some(piece => ['__proto__', 'prototype', 'constructor'].includes(piece))) return;
    let cursor = target;
    for (let index = 0; index < pieces.length - 1; index += 1) {
      const piece = pieces[index];
      if (cursor[piece] === null || typeof cursor[piece] !== 'object') cursor[piece] = /^\d+$/.test(pieces[index + 1]) ? [] : {};
      cursor = cursor[piece];
    }
    cursor[pieces[pieces.length - 1]] = value;
  }
  function getPath(target, path) { return path.split('.').reduce((value, key) => value?.[key], target); }
  function reportFailure() { window.dispatchEvent(new CustomEvent('eatwhat:runtime-error')); }
  function invoke(instance, method, ...args) {
    const callback = typeof method === 'function' ? method : instance?.[method];
    if (typeof callback !== 'function') return undefined;
    try {
      const result = callback.apply(instance, args);
      if (result?.catch) result.catch(reportFailure);
      return result;
    } catch (_) { reportFailure(); return undefined; }
  }
  function schedule(instance, callback) {
    if (!instance._destroyed) dirty.add(instance);
    if (typeof callback === 'function') callbacks.push({ instance, callback });
    if (!scheduled && !flushing) { scheduled = true; queueMicrotask(flush); }
  }
  function flush() {
    if (flushing) return;
    scheduled = false;
    flushing = true;
    let passes = 0;
    try {
      while (dirty.size && passes++ < 80) {
        const batch = [...dirty];
        dirty.clear();
        for (const instance of batch) if (!instance._destroyed && instance._root) renderInstance(instance);
      }
      const ready = callbacks.splice(0);
      for (const { instance, callback } of ready) if (!instance._destroyed) invoke(instance, callback);
    } finally {
      flushing = false;
      if ((dirty.size || callbacks.length) && !scheduled) { scheduled = true; queueMicrotask(flush); }
    }
  }
  function observerCalls(instance, changed) {
    if (!changed.size) return;
    const observers = instance._definition.observers || {};
    for (const [fields, observer] of Object.entries(observers)) {
      const paths = fields.split(',').map(field => field.trim());
      if (paths.some(path => path === '**' || [...changed].some(key => path === key || path.startsWith(`${key}.`) || key.startsWith(`${path}.`) || (path.endsWith('.**') && key.startsWith(path.slice(0, -2)))))) {
        invoke(instance, observer, ...paths.map(path => getPath(instance.data, path)));
      }
    }
  }
  function createInstance(path, kind, root, parent) {
    requireModule(`${path}.js`);
    const definition = definitions.get(path);
    if (!definition) throw new Error(`Missing page/component definition: ${path}`);
    const instance = {
      _path: path, _kind: kind, _definition: definition, _root: root, _parent: parent,
      _records: [], _children: new Set(), _destroyed: false, _ready: false,
      route: path, data: clone(definition.data || {}), properties: {},
      setData(patch, callback) {
        if (this._destroyed || !patch || typeof patch !== 'object') return;
        const changed = new Set();
        for (const [key, value] of Object.entries(patch)) {
          if (getPath(this.data, key) !== value) changed.add(key);
          setPath(this.data, key, value);
        }
        schedule(this, callback);
        observerCalls(this, changed);
      },
      triggerEvent(name, detail = {}, options = {}) {
        this._root.dispatchEvent(new CustomEvent(`mini:${name}`, { detail, bubbles: options.bubbles === true, composed: options.composed === true }));
      },
      createSelectorQuery() { return createQuery(this); },
      selectComponent(selector) { return instanceByNode.get((this._queryRoot || this._root).querySelector(selector)) || null; },
      selectAllComponents(selector) { return [...(this._queryRoot || this._root).querySelectorAll(selector)].map(node => instanceByNode.get(node)).filter(Boolean); },
      getTabBar() { return null; },
    };
    const methods = kind === 'component' ? definition.methods || {} : definition;
    for (const [key, method] of Object.entries(methods)) if (typeof method === 'function') instance[key] = method.bind(instance);
    for (const [key, property] of Object.entries(definition.properties || {})) {
      const descriptor = property && typeof property === 'object' ? property : { type: property };
      const fallback = descriptor.type === Boolean ? false : descriptor.type === String ? '' : descriptor.type === Number ? 0 : null;
      instance.properties[key] = clone(own(descriptor, 'value') ? descriptor.value : fallback);
      instance.data[key] = instance.properties[key];
    }
    if (parent) parent._children.add(instance);
    return instance;
  }
  function updateProperties(instance, attributes, initial = false) {
    const changed = new Set();
    for (const [key, descriptor] of Object.entries(instance._definition.properties || {})) {
      const name = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      if (!own(attributes, name) && !own(attributes, key)) continue;
      let value = own(attributes, name) ? attributes[name] : attributes[key];
      const type = typeof descriptor === 'function' ? descriptor : descriptor?.type;
      if (type === Boolean) value = value === '' || value === true || value === 'true';
      if (type === Number) value = Number(value);
      if (type === String) value = stringOf(value);
      const previous = instance.properties[key];
      if (!Object.is(previous, value)) {
        instance.properties[key] = value;
        instance.data[key] = value;
        changed.add(key);
        if (!initial && descriptor?.observer) invoke(instance, descriptor.observer, value, previous, [key]);
      }
    }
    if (!initial) observerCalls(instance, changed);
    if (changed.size) schedule(instance);
  }
  function templatesFor(nodes, result = {}) {
    for (const node of nodes || []) {
      if (node.tag === 'template' && typeof node.attrs?.name === 'string') result[node.attrs.name] = node.children || [];
      templatesFor(node.children, result);
    }
    return result;
  }
  function compileView(nodes, scope, owner, path = 'root', templates, skipLoop = false) {
    const output = [];
    let chain = null;
    (nodes || []).forEach((node, index) => {
      const key = `${path}.${index}`;
      if (own(node, 'text')) {
        const text = stringOf(valueOf(node.text, scope));
        if (text.trim()) chain = null;
        output.push({ kind: 'text', key, text });
        return;
      }
      const attributes = node.attrs || {};
      if (own(attributes, 'wx:for') && !skipLoop) {
        chain = null;
        const list = valueOf(attributes['wx:for'], scope) || [];
        const entries = Array.isArray(list) ? list.map((item, itemIndex) => [itemIndex, item]) : Object.entries(list);
        for (const [itemIndex, item] of entries) {
          const loopScope = scopeOf({ [attributes['wx:for-item'] || 'item']: item, [attributes['wx:for-index'] || 'index']: itemIndex }, scope);
          const declared = valueOf(attributes['wx:key'], loopScope);
          const itemKey = declared === '*this' ? item : declared && typeof item === 'object' ? item?.[declared] : itemIndex;
          output.push(...compileView([node], loopScope, owner, `${key}:${stringOf(itemKey ?? itemIndex)}`, templates, true));
        }
        return;
      }
      if (own(attributes, 'wx:if')) {
        chain = Boolean(valueOf(attributes['wx:if'], scope));
        if (!chain) return;
      } else if (own(attributes, 'wx:elif')) {
        if (chain === true) return;
        chain = Boolean(valueOf(attributes['wx:elif'], scope));
        if (!chain) return;
      } else if (own(attributes, 'wx:else')) {
        if (chain === true) return;
        chain = true;
      } else chain = null;
      if (node.tag === 'template') {
        if (attributes.name) return;
        const name = valueOf(attributes.is, scope);
        const data = valueOf(attributes.data, scope);
        output.push(...compileView(templates[name], scopeOf(data, scope), owner, `${key}:${name}`, templates));
        return;
      }
      if (node.tag === 'block') {
        output.push(...compileView(node.children, scope, owner, key, templates));
        return;
      }
      const attrs = {}, events = {};
      for (const [name, value] of Object.entries(attributes)) {
        if (name.startsWith('wx:')) continue;
        const event = /^(bind|catch):?(.+)$/.exec(name);
        if (event) events[event[2]] = { method: valueOf(value, scope), catch: event[1] === 'catch' };
        else attrs[name] = valueOf(value, scope);
      }
      const configured = (bundle.configs[owner._path] || bundle.configs[`${owner._path}.json`] || {}).usingComponents || {};
      const component = configured[node.tag];
      const componentPath = component ? normalize(component.startsWith('/') ? component : `${owner._path.slice(0, owner._path.lastIndexOf('/') + 1)}${component}`) : null;
      output.push({ kind: component ? 'component' : 'element', key, tag: node.tag, attrs, events, componentPath, owner,
        children: component ? [] : compileView(node.children, scope, owner, key, templates) });
    });
    return output;
  }
  function renderInstance(instance) {
    const template = bundle.templates[instance._path] || [];
    instance._templates ||= templatesFor(template);
    const tree = compileView(template, scopeOf(instance.data), instance, 'root', instance._templates);
    // page-meta may itself leave a conditional tree. Re-derive the lock from
    // this render instead of leaving an orphaned body's overflow:hidden.
    if (instance._kind === 'page' && stack.at(-1) === instance) document.body.style.overflow = '';
    instance._records = patchChildren(instance._content || instance._root, instance._records, tree);
    if (instance._kind === 'page' && stack.at(-1) === instance) {
      const dark = instance.data.themeClass === 'theme-dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    }
    if (!instance._ready) {
      instance._ready = true;
      callbacks.push({ instance, callback: () => {
        if (instance._kind === 'component') invoke(instance, instance._definition.lifetimes?.ready);
        else invoke(instance, 'onReady');
      } });
    }
  }
  function htmlTag(tag) {
    return ({ image: 'img', slider: 'input', switch: 'input', checkbox: 'input', map: 'div', 'page-meta': 'span' })[tag] || tag;
  }
  function createRecord(vnode) {
    if (vnode.kind === 'text') return { vnode, el: document.createTextNode(vnode.text), children: [] };
    const el = document.createElement(htmlTag(vnode.tag));
    const record = { vnode: null, el, children: [], listeners: new Map(), attrs: {}, pointer: null };
    el.__miniRecord = record;
    if (['slider', 'switch', 'checkbox'].includes(vnode.tag)) el.type = vnode.tag === 'slider' ? 'range' : 'checkbox';
    if (vnode.tag === 'switch') el.setAttribute('role', 'switch');
    if (vnode.tag === 'button') el.type = 'button';
    if (vnode.tag === 'canvas') {
      el.createImage = () => new Image();
      el.requestAnimationFrame = callback => requestAnimationFrame(callback);
      el.cancelAnimationFrame = handle => cancelAnimationFrame(handle);
    }
    if (vnode.tag === 'picker') {
      record.content = document.createElement('span');
      record.content.className = 'ew-picker-content';
      record.select = document.createElement('select');
      record.select.className = 'ew-picker-select';
      el.append(record.content, record.select);
      record.select.addEventListener('change', event => emit(record, 'change', event, { value: Number(record.select.value) }));
    }
    if (vnode.kind === 'component') {
      const shadow = el.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = componentBase + (bundle.styles[vnode.componentPath] || bundle.styles[`${vnode.componentPath}.wxss`] || '');
      const content = document.createElement('div');
      content.className = 'ew-component-root';
      shadow.append(style, content);
      record.instance = createInstance(vnode.componentPath, 'component', el, vnode.owner);
      record.instance._content = content;
      record.instance._queryRoot = shadow;
      instanceByNode.set(el, record.instance);
    }
    patchRecord(record, vnode);
    if (record.instance) {
      invoke(record.instance, record.instance._definition.lifetimes?.created);
      invoke(record.instance, record.instance._definition.lifetimes?.attached);
      schedule(record.instance);
    }
    return record;
  }
  function patchChildren(parent, old, children) {
    const lookup = new Map(old.map(record => [record.vnode.key, record]));
    const result = [];
    for (const vnode of children) {
      let record = lookup.get(vnode.key);
      if (record && (record.vnode.kind !== vnode.kind || record.vnode.tag !== vnode.tag || record.vnode.componentPath !== vnode.componentPath)) {
        disposeRecord(record);
        lookup.delete(vnode.key);
        record = null;
      }
      if (record) { lookup.delete(vnode.key); patchRecord(record, vnode); }
      else record = createRecord(vnode);
      result.push(record);
    }
    for (const record of lookup.values()) disposeRecord(record);
    let cursor = parent.firstChild;
    for (const record of result) {
      if (record.el !== cursor) parent.insertBefore(record.el, cursor);
      cursor = record.el.nextSibling;
    }
    return result;
  }
  function disposeRecord(record) {
    if (record.instance) destroyInstance(record.instance);
    for (const child of record.children) disposeRecord(child);
    if (record.cleanupMap) record.cleanupMap();
    record.el.remove();
  }
  function destroyInstance(instance) {
    if (instance._destroyed) return;
    if (instance._kind === 'component') invoke(instance, instance._definition.lifetimes?.detached);
    else invoke(instance, 'onUnload');
    instance._destroyed = true;
    dirty.delete(instance);
    for (const record of instance._records) disposeRecord(record);
    instance._parent?._children.delete(instance);
    instance._root.remove();
  }
  function patchRecord(record, vnode) {
    if (vnode.kind === 'text') { if (record.el.nodeValue !== vnode.text) record.el.nodeValue = vnode.text; record.vnode = vnode; return; }
    const initial = !record.vnode;
    record.vnode = vnode;
    updateAttributes(record);
    updateEvents(record);
    if (record.instance) updateProperties(record.instance, vnode.attrs, initial);
    else record.children = patchChildren(record.content || record.el, record.children, vnode.children);
    if (vnode.tag === 'picker') updatePicker(record);
    if (vnode.tag === 'map') updateMap(record);
    if (vnode.tag === 'swiper') updateSwiper(record);
  }
  const reservedAttrs = new Set(['hover-class', 'hover-start-time', 'hover-stay-time', 'range', 'range-key', 'mode', 'activeColor', 'backgroundColor', 'block-color', 'block-size', 'show-value', 'page-style', 'scroll-y', 'scroll-x', 'enhanced', 'show-scrollbar', 'scroll-with-animation', 'indicator-dots', 'circular', 'duration', 'current', 'loading', 'markers', 'polyline', 'include-points', 'latitude', 'longitude', 'scale', 'show-location', 'show-compass', 'show-scale', 'enable-zoom', 'enable-scroll', 'enable-poi']);
  function safeImageUrl(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return '';
    if (/^blob:https?:\/\//i.test(value) || /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
    try {
      if (value.startsWith('/assets/')) return new URL(`${bundle.assetBase || '/'}${value.slice(1)}`, location.href || 'https://eatwhat.pro/').href;
      const url = new URL(value, location.href || 'https://eatwhat.pro/');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return value;
    } catch (_) { return ''; }
  }
  function updateAttributes(record) {
    const { el, vnode } = record;
    const next = vnode.attrs;
    el.__miniDataset = {};
    for (const name of Object.keys(record.attrs)) if (!own(next, name) && !reservedAttrs.has(name)) el.removeAttribute(name);
    for (const [rawName, value] of Object.entries(next)) {
      if (rawName.startsWith('data-')) el.__miniDataset[camel(rawName.slice(5))] = value;
      const name = rawName === 'aria-role' ? 'role' : rawName;
      if (reservedAttrs.has(name)) continue;
      // Only compiled bind/catch handlers are executable. Never create an
      // inline DOM handler even if an unexpected attribute reaches the AST.
      if (/^on/i.test(name) || name === 'srcdoc') continue;
      if (record.instance && own(record.instance._definition.properties || {}, camel(name))) continue;
      if (name === 'src' && vnode.tag === 'image') {
        const safe = safeImageUrl(value);
        if (safe) { if (el.getAttribute('src') !== safe) el.setAttribute('src', safe); }
        else el.removeAttribute('src');
      } else if (['disabled', 'checked', 'multiple', 'selected', 'hidden'].includes(name)) {
        const enabled = value === true || value === '' || value === 'true';
        if (el[name] !== enabled) el[name] = enabled;
        if (enabled) el.setAttribute(name, ''); else el.removeAttribute(name);
      } else if (name === 'value' && ['input', 'textarea', 'slider', 'switch', 'checkbox'].includes(vnode.tag)) {
        const formatted = stringOf(value);
        if (el.value !== formatted) el.value = formatted;
      } else if (name === 'style') {
        if (el.getAttribute('style') !== stringOf(value)) el.setAttribute('style', stringOf(value));
      } else if (name === 'type' && (vnode.tag !== 'input' || value === 'number')) {
        if (vnode.tag === 'input' && value === 'number') { el.type = 'text'; el.inputMode = 'numeric'; }
      } else if (value === undefined || value === null || value === false && !name.startsWith('aria-')) el.removeAttribute(name);
      else if (el.getAttribute(name) !== stringOf(value)) el.setAttribute(name, stringOf(value));
    }
    if (vnode.tag === 'image') { el.alt = next['aria-label'] || ''; el.draggable = false; el.style.objectFit = next.mode === 'aspectFill' ? 'cover' : 'contain'; }
    if (vnode.tag === 'slider' || vnode.tag === 'switch' || vnode.tag === 'checkbox') el.style.accentColor = next.activeColor || next.color || '#b94a29';
    if (vnode.tag === 'scroll-view') {
      el.style.overflowY = next['scroll-y'] !== false && own(next, 'scroll-y') ? 'auto' : '';
      el.style.overflowX = next['scroll-x'] !== false && own(next, 'scroll-x') ? 'auto' : '';
      if (Number.isFinite(next['scroll-top']) && el.scrollTop !== next['scroll-top']) el.scrollTop = next['scroll-top'];
    }
    if (next.loading !== undefined) el.setAttribute('aria-busy', String(Boolean(next.loading)));
    if (vnode.tag === 'page-meta') { el.hidden = true; if (stack.at(-1) === vnode.owner) document.body.style.overflow = /overflow\s*:\s*hidden/.test(next['page-style'] || '') ? 'hidden' : ''; }
    if (next['aria-role'] === 'slider' && vnode.owner._kind === 'component') {
      el.tabIndex = next.disabled ? -1 : 0;
      el.setAttribute('aria-valuemin', vnode.owner.properties.min);
      el.setAttribute('aria-valuemax', vnode.owner.properties.max);
      el.setAttribute('aria-valuenow', vnode.owner.data.displayValue);
      el.setAttribute('aria-valuetext', vnode.owner.data.displayLabel);
    }
    record.attrs = { ...next };
  }
  function targetData(element) { return { id: element?.id || '', dataset: element?.__miniDataset || {} }; }
  function point(event) { return { identifier: event.pointerId || 1, clientX: event.clientX || 0, clientY: event.clientY || 0, pageX: event.pageX || 0, pageY: event.pageY || 0 }; }
  function miniEvent(record, name, original, detail = {}) {
    const touch = original && 'pointerId' in original ? point(original) : null;
    return {
      type: name, timeStamp: original?.timeStamp || performance.now(),
      target: targetData(original?.target || record.el), currentTarget: targetData(record.el),
      detail, touches: touch && !['touchend', 'touchcancel'].includes(name) ? [touch] : [], changedTouches: touch ? [touch] : [],
      preventDefault: () => original?.preventDefault(), stopPropagation: () => original?.stopPropagation(),
    };
  }
  function emit(record, name, event, detail = {}) {
    const descriptor = record.vnode.events[name];
    if (!descriptor || record.vnode.owner._destroyed || record.el.disabled) return;
    if (descriptor.catch) { event?.stopPropagation(); if (event?.cancelable && name.startsWith('touch')) event.preventDefault(); }
    invoke(record.vnode.owner, descriptor.method, miniEvent(record, name, event, detail));
  }
  function listen(record, name, callback, options) {
    if (record.listeners.has(name)) return;
    record.listeners.set(name, callback);
    record.el.addEventListener(name, callback, options);
  }
  function updateEvents(record) {
    const { el, vnode } = record;
    if (vnode.kind === 'component') {
      for (const name of Object.keys(vnode.events)) listen(record, `mini:${name}`, event => emit(record, name, event, event.detail));
      return;
    }
    for (const name of Object.keys(vnode.events)) {
      if (name === 'tap') listen(record, 'click', event => {
        if (record.suppressClickUntil > performance.now()) { event.preventDefault(); event.stopPropagation(); return; }
        emit(record, 'tap', event, { x: event.clientX, y: event.clientY + window.scrollY });
      });
      else if (name === 'input') listen(record, 'input', event => emit(record, 'input', event, { value: el.value, cursor: el.selectionStart }));
      else if (name === 'changing') listen(record, 'input', event => emit(record, 'changing', event, { value: Number(el.value) }));
      else if (name === 'change' && vnode.tag !== 'picker' && vnode.tag !== 'swiper') listen(record, 'change', event => {
        const value = vnode.tag === 'checkbox-group' ? [...el.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value)
          : vnode.tag === 'switch' ? el.checked : vnode.tag === 'slider' ? Number(el.value) : el.value;
        emit(record, 'change', event, { value });
      });
      else if (name === 'confirm') listen(record, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); emit(record, 'confirm', event, { value: el.value }); } });
      else if (name === 'error') listen(record, 'error', event => emit(record, 'error', event, { errMsg: '资源暂不可用' }));
      else if (name === 'load') listen(record, 'load', event => emit(record, 'load', event, { width: el.naturalWidth, height: el.naturalHeight }));
    }
    if (Object.keys(vnode.events).some(name => name.startsWith('touch'))) {
      el.style.touchAction = vnode.events.touchmove ? 'pan-y' : 'manipulation';
      listen(record, 'pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary || el.disabled) return;
        record.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        try { el.setPointerCapture(event.pointerId); } catch (_) { /* May be a synthetic event. */ }
        emit(record, 'touchstart', event);
      });
      listen(record, 'pointermove', event => {
        if (!record.pointer || event.pointerId !== record.pointer.id) return;
        if (Math.hypot(event.clientX - record.pointer.x, event.clientY - record.pointer.y) > 6) record.pointer.moved = true;
        emit(record, 'touchmove', event);
      }, { passive: false });
      const end = (event, cancelled) => {
        if (!record.pointer || event.pointerId !== record.pointer.id) return;
        if (record.pointer.moved) record.suppressClickUntil = performance.now() + 350;
        record.pointer = null;
        emit(record, cancelled ? 'touchcancel' : 'touchend', event);
        try { el.releasePointerCapture(event.pointerId); } catch (_) { /* Pointer already released. */ }
      };
      listen(record, 'pointerup', event => end(event, false));
      listen(record, 'pointercancel', event => end(event, true));
      listen(record, 'lostpointercapture', event => { if (record.pointer) end(event, true); });
    }
    if (vnode.attrs['aria-role'] === 'slider') listen(record, 'keydown', event => keyboardSlider(record, event));
    if (vnode.attrs['hover-class'] && vnode.attrs['hover-class'] !== 'none') {
      listen(record, 'pointerdown', () => el.classList.add(...String(record.vnode.attrs['hover-class']).split(/\s+/).filter(Boolean)));
      const clear = () => el.classList.remove(...String(record.vnode.attrs['hover-class']).split(/\s+/).filter(Boolean));
      listen(record, 'pointerup', clear); listen(record, 'pointercancel', clear); listen(record, 'pointerleave', clear);
    }
    if (vnode.events.tap && !['button', 'input', 'select', 'textarea', 'label'].includes(vnode.tag)) {
      el.tabIndex = vnode.attrs.disabled ? -1 : 0;
      if (!vnode.attrs.role && !vnode.attrs['aria-role']) el.setAttribute('role', 'button');
      listen(record, 'keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); el.click(); } });
    }
  }
  function keyboardSlider(record, event) {
    const owner = record.vnode.owner;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || owner.data.controlDisabled) return;
    event.preventDefault();
    const { min = 0, max = 100, step = 1 } = owner.properties;
    const before = Number(owner.data.displayValue || 0);
    const value = event.key === 'Home' ? min : event.key === 'End' ? max : Math.min(max, Math.max(min, before + (['ArrowRight', 'ArrowUp'].includes(event.key) ? step : -step)));
    const rect = (owner._queryRoot || owner._root).querySelector('.taste-travel')?.getBoundingClientRect();
    if (!rect?.width) return;
    // Route keyboard changes through the same verified gesture/commit path.
    const startX = rect.left + (before - min) / (max - min) * rect.width;
    const endX = rect.left + (value - min) / (max - min) * rect.width;
    const synthetic = (x, end) => ({ touches: end ? [] : [{ identifier: -1, clientX: x, clientY: rect.top, pageX: x + window.scrollX, pageY: rect.top + window.scrollY }], changedTouches: [{ identifier: -1, clientX: x, clientY: rect.top, pageX: x + window.scrollX, pageY: rect.top + window.scrollY }], timeStamp: performance.now() });
    invoke(owner, 'touchStart', synthetic(startX, false));
    // A one-step move in a narrow control can be under its intentional drag threshold.
    if (Math.abs(endX - startX) < 7) invoke(owner, 'touchMove', synthetic(startX + (value >= before ? 8 : -8), false));
    invoke(owner, 'touchMove', synthetic(endX, false));
    invoke(owner, 'touchEnd', synthetic(endX, true));
  }
  function updatePicker(record) {
    const attributes = record.vnode.attrs;
    const range = Array.isArray(attributes.range) ? attributes.range : [];
    const labelKey = attributes['range-key'];
    const labels = range.map(item => stringOf(labelKey ? item?.[labelKey] : item));
    const signature = JSON.stringify(labels);
    if (record.optionSignature !== signature) {
      record.select.replaceChildren(...labels.map((label, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = label; return option; }));
      record.optionSignature = signature;
    }
    record.select.value = String(Number(attributes.value) || 0);
    record.select.disabled = Boolean(attributes.disabled);
    record.select.setAttribute('aria-label', attributes['aria-label'] || '选择选项');
  }
  function updateMap(record) {
    record.el.__miniMapProps = record.vnode.attrs;
    if (typeof window.EWRenderMap === 'function') record.el.classList.remove('ew-native-map');
    else record.el.classList.add('ew-native-map');
    const signature = JSON.stringify(record.vnode.attrs);
    if (signature === record.mapSignature) return;
    record.mapSignature = signature;
    if (typeof window.EWRenderMap === 'function') {
      if (record.cleanupMap) record.cleanupMap();
      record.cleanupMap = window.EWRenderMap(record.el, record.vnode.attrs, (name, detail) => emit(record, name, null, detail));
    } else {
      record.el.textContent = '路线地图正在准备，请查看下方分步说明。';
      queueMicrotask(() => emit(record, 'error', null, { errMsg: '浏览器地图暂不可用' }));
    }
  }
  function updateSwiper(record) {
    const { el, vnode } = record;
    const current = Number(vnode.attrs.current) || 0;
    if (record.swiperCurrent !== current) { el.scrollLeft = current * el.clientWidth; record.swiperCurrent = current; }
    listen(record, 'scroll', event => {
      clearTimeout(record.swiperTimer);
      record.swiperTimer = setTimeout(() => {
        const position = el.clientWidth ? Math.round(el.scrollLeft / el.clientWidth) : 0;
        if (position !== record.swiperCurrent) { record.swiperCurrent = position; emit(record, 'change', event, { current: position, source: 'touch' }); }
      }, 90);
    });
  }
  function createQuery(instance) {
    const requests = [];
    let root = instance?._queryRoot || instance?._root || document;
    const query = {
      in(owner) { root = owner?._queryRoot || owner?._root || root; return query; },
      select(selector) { return selection(selector, false); },
      selectAll(selector) { return selection(selector, true); },
      selectViewport() { return selection(null, false); },
      exec(callback) {
        queueMicrotask(() => {
          flush();
          const results = requests.map(request => {
            const elements = request.selector === null ? [null] : [...root.querySelectorAll(request.selector)];
            const values = elements.map(element => {
              if (request.kind === 'scroll') return { scrollLeft: element ? element.scrollLeft : window.scrollX, scrollTop: element ? element.scrollTop : window.scrollY };
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              if (request.kind === 'fields') return { ...(request.options.node ? { node: element } : {}), ...(request.options.size ? { width: rect.width, height: rect.height } : {}), ...(request.options.rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : {}) };
              return { id: element.id, dataset: element.__miniDataset || {}, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
            });
            const result = request.all ? values : values[0] || null;
            request.callback?.(result);
            return result;
          });
          callback?.(results);
        });
        return query;
      },
    };
    function selection(selector, all) {
      const queue = (kind, options, callback) => { requests.push({ selector, all, kind, options, callback }); return query; };
      return {
        boundingClientRect: callback => queue('rect', {}, callback),
        scrollOffset: callback => queue('scroll', {}, callback),
        fields: (options, callback) => queue('fields', options, callback),
      };
    }
    return query;
  }
  function lifecycle(instance, phase) {
    if (!instance || instance._destroyed) return;
    invoke(instance, phase === 'show' ? 'onShow' : phase === 'hide' ? 'onHide' : 'onResize', phase === 'resize' ? { size: { windowWidth: appRoot.clientWidth, windowHeight: innerHeight } } : undefined);
    const visit = parent => { for (const child of [...parent._children]) { invoke(child, child._definition.pageLifetimes?.[phase]); visit(child); } };
    visit(instance);
  }
  function parseRoute(url) {
    const parsed = new URL(url.replace(/^#/, ''), 'https://eatwhat.pro/');
    const route = parsed.pathname.replace(/^\//, '').replace(/\.html$/, '');
    if (!bundle.appConfig.pages.includes(route)) throw new Error('Unknown application route');
    return { route, options: Object.fromEntries(parsed.searchParams), url: `/${route}${parsed.search}` };
  }
  function pageStyle(page) {
    activeStyle.textContent = bundle.styles[page._path] || bundle.styles[`${page._path}.wxss`] || '';
    const config = bundle.configs[page._path] || bundle.configs[`${page._path}.json`] || {};
    runtime.setTitle(config.navigationBarTitleText || '吃什么');
    backButton.hidden = stack.length < 2 && [bundle.appConfig.pages[0], 'pages/index/index'].includes(page.route);
    backButton.setAttribute('aria-label', stack.length > 1 ? '返回上一页' : '返回首页');
    document.body.style.overflow = '';
  }
  function mountPage(parsed) {
    const root = document.createElement('main');
    root.className = 'ew-page-host';
    root.setAttribute('data-route', parsed.route);
    appRoot.append(root);
    const page = createInstance(parsed.route, 'page', root, null);
    page.options = parsed.options;
    page._url = parsed.url;
    page._pageId = ++nextPageId;
    stack.push(page);
    pageStyle(page);
    invoke(page, 'onLoad', parsed.options);
    lifecycle(page, 'show');
    schedule(page);
    flush();
    window.scrollTo(0, 0);
    return page;
  }
  function navigate(url, mode = 'navigateTo', historyAction = true) {
    const parsed = parseRoute(url);
    const previous = stack.at(-1);
    if (previous) { previous._scrollTop = window.scrollY; lifecycle(previous, 'hide'); previous._root.hidden = true; }
    if (['reLaunch', 'reset'].includes(mode)) {
      for (const page of stack) destroyInstance(page);
      stack = [];
    } else if (['redirectTo', 'replace'].includes(mode) && previous) { destroyInstance(previous); stack.pop(); }
    const page = mountPage(parsed);
    if (historyAction) {
      const method = ['navigateTo', 'push'].includes(mode) && previous ? 'pushState' : 'replaceState';
      history[method]({ eatwhatPage: page._pageId }, '', `#${parsed.url}`);
    }
    window.dispatchEvent(new CustomEvent('eatwhat:navigate', { detail: { route: parsed.route } }));
    return page;
  }
  function showExisting(page) {
    const previous = stack.at(-1);
    if (previous !== page) lifecycle(previous, 'hide');
    while (stack.length && stack.at(-1) !== page) destroyInstance(stack.pop());
    page._root.hidden = false;
    pageStyle(page);
    lifecycle(page, 'show');
    schedule(page);
    flush();
    window.scrollTo(0, page._scrollTop || 0);
  }
  function back(delta = 1) {
    if (pendingBack) return pendingBack.promise;
    const count = Math.max(1, Math.floor(Number(delta) || 1));
    const target = stack[Math.max(0, stack.length - 1 - count)];
    if (!target || target === stack.at(-1)) return navigate('/pages/index/index', 'reLaunch');
    const operation = {};
    operation.promise = new Promise((resolve, reject) => { operation.resolve = resolve; operation.reject = reject; });
    pendingBack = operation;
    try { history.go(-Math.min(count, stack.length - 1)); }
    catch (error) { pendingBack = null; operation.reject(error); }
    return operation.promise;
  }
  const runtime = {
    navigate, back, currentPages: () => stack.slice(), app: () => appInstance,
    setTitle(value) { const title = typeof value === 'object' ? value.title : value; navTitle.textContent = title || '吃什么'; document.title = `${title || '吃什么'} · eatwhat.pro`; },
    setNavColor(value, backgroundColor) {
      const options = typeof value === 'object' ? value : { frontColor: value, backgroundColor };
      if (options.backgroundColor?.startsWith('#')) nav.style.backgroundColor = options.backgroundColor;
      if (options.frontColor) nav.style.color = options.frontColor;
    },
    query: selector => stack.at(-1)?._root.querySelector(selector),
    createSelectorQuery: () => createQuery(stack.at(-1)),
    require: requireModule, flush,
  };
  window.EWRuntime = runtime;
  window.getApp = () => appInstance;
  window.getCurrentPages = runtime.currentPages;
  window.Page = definition => definitions.set(defining, definition);
  window.Component = definition => definitions.set(defining, definition);
  window.App = definition => { appInstance = definition; };
  const componentBase = ':host{display:block;font:inherit;color:inherit} .ew-component-root{display:contents} view,scroll-view,swiper,swiper-item{display:block} text{display:inline} *,*::before,*::after{box-sizing:border-box} button,input,textarea,select{font:inherit}button{cursor:pointer;border:0}button:disabled{cursor:default} img{max-width:100%}input[type=range]{width:100%;margin:12px 0;accent-color:#b94a29}input[type=checkbox]{width:22px;height:22px;accent-color:#b94a29} [hidden]{display:none!important} .taste-control{touch-action:pan-y;outline-offset:6px} .taste-control:focus-visible{outline:2px solid #b94a29}';
  function boot() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    appRoot = document.getElementById('ew-app') || document.getElementById('app') || document.createElement('div');
    appRoot.id = 'ew-app';
    if (!appRoot.isConnected) document.body.append(appRoot);
    nav = document.createElement('header');
    nav.className = 'ew-navigation';
    backButton = document.createElement('button');
    backButton.className = 'ew-back';
    backButton.type = 'button';
    backButton.textContent = '‹';
    backButton.addEventListener('click', () => runtime.back());
    navTitle = document.createElement('div');
    navTitle.className = 'ew-navigation-title';
    const home = document.createElement('button');
    home.className = 'ew-home';
    home.type = 'button';
    home.textContent = '⌂';
    home.setAttribute('aria-label', '返回首页');
    home.addEventListener('click', () => runtime.navigate('/pages/index/index', 'reLaunch'));
    nav.append(backButton, navTitle, home);
    document.body.insertBefore(nav, appRoot);
    const style = document.createElement('style');
    style.dataset.eatwhat = 'app';
    style.textContent = bundle.styles.app || bundle.styles['app.wxss'] || '';
    activeStyle = document.createElement('style');
    activeStyle.dataset.eatwhat = 'page';
    document.head.append(style, activeStyle);
    if (typeof window.installPlatform !== 'function') throw new Error('Browser platform adapter is missing');
    window.installPlatform(runtime);
    requireModule('app.js');
    invoke(appInstance, 'onLaunch', {});
    let route = `/${bundle.appConfig.pages[0]}`;
    try { if (location.hash) route = parseRoute(location.hash.slice(1)).url; } catch (_) { /* Old or unknown links open the entry page. */ }
    navigate(route, 'reLaunch');
    invoke(appInstance, 'onShow', {});
    window.addEventListener('popstate', event => {
      const existing = stack.find(page => page._pageId === event.state?.eatwhatPage);
      if (existing) showExisting(existing);
      else {
        try { navigate(location.hash.slice(1) || `/${bundle.appConfig.pages[0]}`, 'reLaunch', false); }
        catch (_) { navigate(`/${bundle.appConfig.pages[0]}`, 'reLaunch'); }
      }
      if (pendingBack) { const operation = pendingBack; pendingBack = null; operation.resolve(stack.at(-1)); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !background) { background = true; lifecycle(stack.at(-1), 'hide'); invoke(appInstance, 'onHide'); }
      else if (!document.hidden && background) { background = false; invoke(appInstance, 'onShow', {}); lifecycle(stack.at(-1), 'show'); }
    });
    window.addEventListener('pagehide', () => { if (!background) { background = true; lifecycle(stack.at(-1), 'hide'); invoke(appInstance, 'onHide'); } });
    window.addEventListener('pageshow', () => { if (background && !document.hidden) { background = false; invoke(appInstance, 'onShow', {}); lifecycle(stack.at(-1), 'show'); } });
    window.addEventListener('resize', () => lifecycle(stack.at(-1), 'resize'));
    window.addEventListener('scroll', () => invoke(stack.at(-1), 'onPageScroll', { scrollTop: window.scrollY }), { passive: true });
    window.dispatchEvent(new CustomEvent('eatwhat:ready'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
