const fs = require('node:fs');
const path = require('node:path');
const { browserCopy } = require('./copy-adapter.cjs');

function decode(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[name]);
}

// WXML is XML-like, but expressions in quoted attributes may contain > and <.
// Parse only source controlled templates; content from API responses never
// passes through this compiler or becomes HTML.
function parseWxml(source, filename = 'template') {
  const root = { children: [] }, stack = [root];
  let cursor = 0;
  const fail = message => { throw new Error(`${filename}:${source.slice(0, cursor).split('\n').length}: ${message}`); };
  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end < 0) fail('Unclosed comment');
      cursor = end + 3;
      continue;
    }
    if (source[cursor] !== '<') {
      const end = source.indexOf('<', cursor);
      const text = source.slice(cursor, end < 0 ? source.length : end);
      if (text.trim()) stack.at(-1).children.push({ text: decode(text.replace(/\s+/g, ' ')) });
      cursor = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('</', cursor)) {
      const end = source.indexOf('>', cursor);
      if (end < 0) fail('Unclosed closing tag');
      const name = source.slice(cursor + 2, end).trim();
      if (stack.length === 1 || stack.at(-1).tag !== name) fail(`Unmatched closing tag ${name}`);
      stack.pop(); cursor = end + 1; continue;
    }
    cursor += 1;
    const tagMatch = /^[\w-]+/.exec(source.slice(cursor));
    if (!tagMatch) fail('Invalid tag');
    const tag = tagMatch[0]; cursor += tag.length;
    const node = { tag, attrs: {}, children: [] };
    let selfClosing = false, closed = false;
    while (cursor < source.length) {
      while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor += 1;
      if (source.startsWith('/>', cursor)) { cursor += 2; selfClosing = true; closed = true; break; }
      if (source[cursor] === '>') { cursor += 1; closed = true; break; }
      const match = /^[^\s=/>]+/.exec(source.slice(cursor));
      if (!match) fail('Invalid attribute');
      const name = match[0]; cursor += name.length;
      while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor += 1;
      let value = '';
      if (source[cursor] === '=') {
        cursor += 1;
        while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor += 1;
        const quote = source[cursor++];
        if (quote !== '"' && quote !== "'") fail(`Unquoted attribute ${name}`);
        const end = source.indexOf(quote, cursor);
        if (end < 0) fail(`Unclosed attribute ${name}`);
        value = decode(source.slice(cursor, end)); cursor = end + 1;
      }
      if (Object.hasOwn(node.attrs, name)) fail(`Duplicate attribute ${name}`);
      node.attrs[name] = value;
    }
    if (!closed) fail(`Unclosed tag ${tag}`);
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) fail(`Unclosed element ${stack.at(-1).tag}`);
  return root.children;
}

function expressionValue(value, objectExpression = false) {
  const matches = [...value.matchAll(/{{([\s\S]*?)}}/g)];
  if (!matches.length) return JSON.stringify(value);
  const whole = matches.length === 1 && matches[0][0] === value;
  const expression = match => objectExpression && whole ? `({${match[1]}})` : `(${match[1]})`;
  let body;
  if (whole) body = expression(matches[0]);
  else {
    let cursor = 0; const fragments = [];
    for (const match of matches) {
      fragments.push(JSON.stringify(value.slice(cursor, match.index)), `String(${expression(match)} ?? '')`);
      cursor = match.index + match[0].length;
    }
    fragments.push(JSON.stringify(value.slice(cursor)));
    body = fragments.join('+');
  }
  // Functions are emitted at build time. There is no eval/new Function in the
  // shipped runtime, so an API value cannot introduce executable expressions.
  const result = `function(scope){with(scope){return ${body};}}`;
  new Function(`return (${result});`); // Fail the build on invalid source syntax.
  return result;
}

function emitAst(nodes) {
  return `[${nodes.map(node => {
    if (Object.hasOwn(node, 'text')) return `{text:${expressionValue(node.text)}}`;
    const attrs = Object.entries(node.attrs).map(([name, value]) => `${JSON.stringify(name)}:${expressionValue(value, node.tag === 'template' && name === 'data')}`).join(',');
    return `{tag:${JSON.stringify(node.tag)},attrs:{${attrs}},children:${emitAst(node.children)}}`;
  }).join(',')}]`;
}

function adaptModule(source, filename) {
  let result = browserCopy(source, filename);
  if (filename === 'lib/account.js') {
    const replacements = [
      ["['ANDROID', 'MINIPROGRAM'].includes(item.platform)", "['ANDROID', 'MINIPROGRAM', 'WEB'].includes(item.platform)"],
      ["device: { installationId, label: '微信小程序', platform: 'MINIPROGRAM', appVersion: service.VERSION }", "device: { installationId, label: '吃什么网页版', platform: 'WEB', appVersion: service.VERSION }"],
      ["item.platform === 'MINIPROGRAM' ? '小程序' : 'Android'", "item.platform === 'WEB' ? '浏览器' : item.platform === 'MINIPROGRAM' ? '小程序' : 'Android'"],
      ['includePlatforms=ALL', 'includePlatforms=ALL_WITH_WEB'],
    ];
    for (const [before, after] of replacements) {
      if (!result.includes(before)) throw new Error(`Web account adapter no longer matches ${filename}`);
      // Both native login payload sites become WEB, although native login is
      // disabled by capability adaptation and wx.login also fails closed.
      result = result.replaceAll(before, after);
    }
  }
  if (filename === 'lib/service.js') {
    const before = "key === 'includePlatforms' && value === 'ALL'";
    if (result.split(before).length !== 2) throw new Error('Web session query adapter no longer matches source');
    result = result.replace(before, "key === 'includePlatforms' && ['ALL', 'ALL_WITH_WEB'].includes(value)");
  }
  if (filename === 'pages/takeout/index.js') {
    for (const before of ['    this.cleanup(this._processor?.clear());', '    this.cleanup(this._processor.dispose());']) {
      if (result.split(before).length !== 2) throw new Error('Takeout image release adapter no longer matches source');
      result = result.replace(before, `${before}\n    wx.releaseImageFiles();`);
    }
  }
  return result;
}

function compileCss(sourceRoot, filename, seen = new Set()) {
  if (seen.has(filename)) throw new Error(`Circular CSS import: ${filename}`);
  seen.add(filename);
  const absolute = path.resolve(sourceRoot, filename);
  if (!absolute.startsWith(path.resolve(sourceRoot) + path.sep)) throw new Error('CSS import escapes source root');
  let css = fs.readFileSync(absolute, 'utf8').replace(/@import\s+["']([^"']+)["'];?/g, (_, imported) => compileCss(sourceRoot, path.posix.normalize(path.posix.join(path.posix.dirname(filename), imported)), new Set(seen)));
  css = css.replace(/(^|[\s,>+~])page(?=\s*[{.#:[>+~\s,])/g, '$1body')
    .replace(/(^|[\s,>+~])image(?=[\s.{#:[>+~,])/g, '$1img')
    .replace(/(^|[\s,>+~])slider(?=[\s.{#:[>+~,])/g, '$1input[type="range"]')
    .replace(/(^|[\s,>+~])switch(?=[\s.{#:[>+~,])/g, '$1input[type="checkbox"]')
    .replace(/(-?[\d.]+)rpx\b/g, 'calc($1 * var(--rpx))')
    .replace(/100vh\b/g, '100dvh');
  return css;
}

module.exports = { parseWxml, emitAst, expressionValue, adaptModule, browserCopy, compileCss };
