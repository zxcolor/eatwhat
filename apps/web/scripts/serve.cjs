const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const defaultRoot = path.resolve(__dirname, '../dist');
const root = path.resolve(process.env.WEB_PREVIEW_ROOT || defaultRoot);
const packageRoot = path.resolve(__dirname, '../../../.codex-tmp/web-qa');
if (root !== defaultRoot && !root.startsWith(packageRoot + path.sep)) throw new Error('Preview root must be a built website package in this checkout');
const port = Number(process.env.WEB_PORT || 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.WEB_PREVIEW_CSP) res.setHeader('Content-Security-Policy', process.env.WEB_PREVIEW_CSP);
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/v1/')) {
    const queryFreeRoute = /\/(?:location-search|recommendations|restaurant-decision-pool|restaurant-route|takeout)(?:\/|$)/.test(url.pathname);
    if ((url.search && queryFreeRoute) || !['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD'].includes(req.method)) { res.writeHead(400); return res.end(); }
    const headers = { accept: req.headers.accept || 'application/json', 'user-agent': 'EatWhat-Web-Local-Preview/1' };
    for (const key of ['content-type', 'authorization', 'x-chishenme-contract-version', 'idempotency-key', 'content-length']) if (req.headers[key]) headers[key] = req.headers[key];
    const upstream = https.request({ hostname: 'api.eatwhat.pro', path: `${url.pathname.slice(4)}${url.search}`, method: req.method, headers, timeout: 45000 }, response => {
      res.writeHead(response.statusCode, Object.fromEntries(Object.entries(response.headers).filter(([key]) => ['content-type', 'x-chishenme-contract-version', 'retry-after', 'content-disposition'].includes(key))));
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/problem+json' }); res.end(JSON.stringify({ title: '暂时无法连接服务', status: 502 })); });
    upstream.on('timeout', () => upstream.destroy());
    req.on('aborted', () => upstream.destroy());
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 3 * 1024 * 1024) { upstream.destroy(); res.writeHead(413); res.end(); req.destroy(); } });
    req.pipe(upstream);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (_) { res.writeHead(400); return res.end(); }
  const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
