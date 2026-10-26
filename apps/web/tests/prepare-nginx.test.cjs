const assert = require('node:assert/strict');
const test = require('node:test');
const { BASELINE, CA_BUNDLE, CSP, REAL_IP_INSERT, HANDLERS, HASH, locationBlock,
  patchApi, patchWeb, prepareFromBuffers, parseArgs } = require('../scripts/prepare-nginx.cjs');

// Synthetic configuration fixtures validate transformations, not live Nginx
// behavior. The CLI only accepts the independently captured production hashes.
const WEB = `server
{
    listen 80;
    server_name eatwhat.pro;
    location / { return 301 https://eatwhat.pro$request_uri; }
}
server
{
    listen 443 ssl;
    http2 on;
    server_name eatwhat.pro;
    root /www/wwwroot/eatwhat.pro/current;
    index index.html;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
    location ^~ /_next/static/ {
        try_files $uri =404;
        expires 1y;
    }
    location ~* \\.(?:css|js|png|svg)$ {
        try_files $uri =404;
        expires 7d;
    }
    location / {
        try_files $uri $uri/ $uri.html =404;
    }
    error_page 404 /404.html;
    access_log /www/wwwlogs/eatwhat.pro.log;
    error_log /www/wwwlogs/eatwhat.pro.error.log warn;
}
`;
function sensitiveApiLocation(route) {
  const screenshot = route === 'takeout/extractions';
  return `    location = /v1/${route} {
        client_max_body_size ${screenshot ? '3m' : '128k'};
        client_body_buffer_size ${screenshot ? '3m' : '128k'};
        client_body_in_file_only off;
        ${screenshot ? 'limit_req zone=chi_takeout_upload_ip_eatwhat burst=3 nodelay;\n        limit_conn chi_takeout_upload_total_eatwhat 2;\n        limit_req_status 429;\n        limit_conn_status 429;' : ''}
        if ($request_method != POST) { return 405; }
        ${route === 'restaurant-decisions/route' ? 'if ($args != "") { return 400; }\n        if ($request_uri != "/v1/restaurant-decisions/route") { return 404; }' : ''}
        access_log off;
        error_log /dev/null crit;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_cache off;
        proxy_max_temp_file_size 0;
        proxy_intercept_errors off;
        proxy_pass http://127.0.0.1:13001;
    }`;
}
function handler(name) {
  return `    location @${name} {
        access_log off;
        error_log /dev/null crit;
        add_header Cache-Control "no-store" always;
        add_header X-ChiShenMe-Contract-Version "1" always;
        add_header X-Request-Id $request_id always;
        return 413 '{"requestId":"$request_id","code":"SYNTHETIC_ERROR","message":"quoted } { braces"}';
    }`;
}
const API = `limit_req_zone $binary_remote_addr zone=chi_takeout_upload_ip_eatwhat:1m rate=4r/m;
limit_conn_zone $server_name zone=chi_takeout_upload_total_eatwhat:64k;
server
{
    listen 80;
    server_name api.eatwhat.pro;
}
server
{
    listen 443 ssl;
    http2 on;
    server_name api.eatwhat.pro;
${['takeout/extractions', 'takeout/decisions', 'restaurant-decisions/pool', 'restaurant-decisions/route'].map(sensitiveApiLocation).join('\n')}
${HANDLERS.map(handler).join('\n')}
    location ^~ /v1/ {
        if ($uri ~* "^/v1/takeout(/|$)") { return 404; }
        if ($uri ~* "^/v1/restaurant-decisions(/|$)") { return 404; }
        proxy_pass http://127.0.0.1:13001;
    }
}
`;
const prepareFixture = (web = WEB, api = API) => prepareFromBuffers(Buffer.from(web), Buffer.from(api), { web: HASH(web), api: HASH(api) });

test('baseline hashes are required and drift fails before generating any candidate', () => {
  assert.throws(() => prepareFromBuffers(Buffer.from(WEB), Buffer.from(API)), /baseline hash mismatch/);
  assert.throws(() => prepareFromBuffers(Buffer.from(WEB), Buffer.from(API), {}), /Missing explicit baseline hashes/);
  assert.throws(() => prepareFromBuffers(Buffer.from(WEB + '\n'), Buffer.from(API), { web: HASH(WEB), api: HASH(API) }), /baseline hash mismatch/);
  assert.equal(BASELINE.web.length, 64); assert.equal(BASELINE.api.length, 64);
});

test('API config mutation is exclusively a narrow loopback real-IP trust insertion', () => {
  const { api } = prepareFixture();
  assert.equal(api.replace(REAL_IP_INSERT, ''), API);
  assert.equal((api.match(/set_real_ip_from/g) || []).length, 1);
  assert.match(api, /set_real_ip_from 127\.0\.0\.1;/);
  assert.match(api, /real_ip_header X-Forwarded-For;\n    real_ip_recursive on;/);
  for (const route of ['takeout/extractions', 'takeout/decisions', 'restaurant-decisions/pool', 'restaurant-decisions/route']) {
    assert.equal(locationBlock(api, `= /v1/${route}`), locationBlock(API, `= /v1/${route}`));
  }
  for (const name of HANDLERS) assert.equal(locationBlock(api, `@${name}`), locationBlock(API, `@${name}`));
});

test('generator rejects an API baseline that has weakened upload, canonical, transient or contract gates', () => {
  for (const [before, after] of [
    ['rate=4r/m;', 'rate=40r/m;'],
    ['limit_conn chi_takeout_upload_total_eatwhat 2;', 'limit_conn chi_takeout_upload_total_eatwhat 20;'],
    ['client_max_body_size 3m;', 'client_max_body_size 30m;'],
    ['client_max_body_size 128k;', 'client_max_body_size 1m;'],
    ['proxy_request_buffering off;', 'proxy_request_buffering on;'],
    ['proxy_max_temp_file_size 0;', 'proxy_max_temp_file_size 1g;'],
    ['if ($args != "") { return 400; }', ''],
    ['if ($request_uri != "/v1/restaurant-decisions/route") { return 404; }', ''],
    ['add_header X-ChiShenMe-Contract-Version "1" always;', ''],
  ]) assert.throws(() => patchApi(API.replace(before, after)), /Missing/, before);
  assert.throws(() => patchApi(API + '\nset_real_ip_from 0.0.0.0/0;'), /pre-existing API real-IP/);
});

test('website forwards the raw URI through fixed verified loopback TLS without prefix normalization', () => {
  const { web } = prepareFixture();
  assert.match(web, /map \$request_uri \$eatwhat_web_api_uri/);
  assert.match(web, /~\^\/api\(\?<eatwhat_web_raw_v1>\/v1\/\.\*\)\$ \$eatwhat_web_raw_v1;/);
  const proxyBlocks = ['= /api/v1/takeout/extractions', '= /api/v1/takeout/decisions', '= /api/v1/restaurant-decisions/pool', '= /api/v1/restaurant-decisions/route', '^~ /api/v1/'];
  for (const name of proxyBlocks) {
    const block = locationBlock(web, name);
    assert.match(block, /proxy_pass https:\/\/127\.0\.0\.1:443\$eatwhat_web_api_uri;/);
    assert.match(block, /proxy_ssl_verify on;/); assert.match(block, /proxy_ssl_name api\.eatwhat\.pro;/);
    assert.match(block, /proxy_ssl_server_name on;/); assert.ok(block.includes(`proxy_ssl_trusted_certificate ${CA_BUNDLE};`));
    assert.match(block, /proxy_set_header Host api\.eatwhat\.pro;/);
    assert.match(block, /proxy_set_header X-Forwarded-For \$remote_addr;/);
    assert.doesNotMatch(block, /\$proxy_add_x_forwarded_for|\$http_x_forwarded_for|rewrite /);
    assert.match(block, /proxy_next_upstream off;/); assert.match(block, /proxy_intercept_errors off;/);
  }
  assert.doesNotMatch(web, /proxy_pass http:\/\/127\.0\.0\.1:13001/);
});

test('web proxy adds no separate limiter and retains bounded in-memory request/response handling', () => {
  const { web } = prepareFixture();
  const screenshot = locationBlock(web, '= /api/v1/takeout/extractions');
  assert.match(screenshot, /client_max_body_size 3m;/); assert.match(screenshot, /client_body_buffer_size 3m;/);
  assert.doesNotMatch(web, /\blimit_req_zone\b|\blimit_conn_zone\b|\blimit_req zone=/);
  for (const name of ['= /api/v1/takeout/extractions', '= /api/v1/takeout/decisions', '= /api/v1/restaurant-decisions/pool', '= /api/v1/restaurant-decisions/route', '^~ /api/v1/']) {
    const block = locationBlock(web, name);
    for (const directive of ['client_body_in_file_only off;', 'access_log off;', 'error_log /dev/null crit;',
      'proxy_request_buffering off;', 'proxy_buffering off;', 'proxy_cache off;', 'proxy_store off;', 'proxy_max_temp_file_size 0;', 'proxy_ignore_headers X-Accel-Buffering;', 'proxy_http_version 1.1;']) assert.ok(block.includes(directive), `${name}: ${directive}`);
    if (name !== '= /api/v1/takeout/extractions') assert.match(block, /client_max_body_size 128k;/);
  }
  assert.doesNotMatch(web, /access_log \/www\/wwwlogs\/eatwhat\.pro\.log|error_log \/www\/wwwlogs\/eatwhat\.pro\.error\.log/);
});

test('local API errors copy upstream JSON contract handlers rather than becoming website HTML', () => {
  const { web } = prepareFixture();
  for (const name of HANDLERS) assert.equal(locationBlock(web, `@${name}`), locationBlock(API, `@${name}`));
  assert.match(locationBlock(web, '= /api/v1/takeout/extractions'), /error_page 413 = @takeout_payload_too_large;/);
  assert.match(locationBlock(web, '= /api/v1/restaurant-decisions/route'), /error_page 502 503 504 = @restaurant_route_unavailable;/);
  for (const name of ['= /api', '^~ /api/']) {
    const block = locationBlock(web, name); assert.match(block, /return 404;/); assert.match(block, /error_page 404 = @takeout_route_not_found;/); assert.doesNotMatch(block, /proxy_pass/);
  }
});

test('CSP applies to the new app document and legacy asset/legal routing remains exact', () => {
  const { web } = prepareFixture();
  const document = locationBlock(web, '= /index.html');
  assert.ok(document.includes(CSP)); assert.doesNotMatch(CSP, /unsafe-eval/); assert.match(CSP, /script-src 'self';/); assert.match(CSP, /connect-src 'self';/);
  assert.match(CSP, /https:\/\/store\.is\.autonavi\.com https:\/\/aos-comment\.amap\.com/);
  assert.match(document, /geolocation=\(self\)/); assert.match(document, /Cache-Control "no-store"/);
  assert.equal(locationBlock(web, '^~ /_next/static/'), locationBlock(WEB, '^~ /_next/static/'));
  assert.equal(web.includes('    location / {\n        try_files $uri $uri/ $uri.html =404;\n    }'), true);
  assert.match(web, /return 301 https:\/\/eatwhat\.pro\$request_uri/);
  assert.equal((web.match(/add_header Content-Security-Policy/g) || []).length, 1);
});

test('duplicate or already-patched source stops instead of layering another adapter', () => {
  assert.throws(() => patchApi(API.replace('    server_name api.eatwhat.pro;\n', '    server_name api.eatwhat.pro;\n    set_real_ip_from 127.0.0.1;\n')), /real-IP/);
  assert.throws(() => patchWeb(WEB + '\nlocation /api/ {}', API), /pre-existing/);
  assert.throws(() => patchWeb(WEB.replace('    location ^~ /_next/static/ {', '    location ^~ /_next/static/ {\n    location ^~ /_next/static/ {'), API), /exactly one/);
  const once = prepareFixture(); assert.throws(() => patchWeb(once.web, API), /pre-existing/);
});

test('brace extraction ignores quoted JSON and comments, rejects truncated blocks', () => {
  const text = '    location @fixture {\n        # } ignored\n        return 400 \'{"text":"} {"}\';\n    }\ntrailing';
  assert.equal(locationBlock(text, '@fixture'), text.slice(0, -9));
  assert.throws(() => locationBlock('    location @fixture {\n', '@fixture'), /Unterminated/);
});

test('CLI accepts only explicit source/output or verification with no duplicate flags', () => {
  assert.deepEqual(parseArgs(['--source', 'source', '--output', 'output']), { source: 'source', output: 'output' });
  assert.deepEqual(parseArgs(['--verify', 'candidate']), { verify: 'candidate' });
  for (const args of [[], ['--source', 'x'], ['--verify', 'x', '--output', 'y'], ['--verify', 'a', '--verify', 'b'], ['--exec', 'ssh']]) assert.throws(() => parseArgs(args));
});
