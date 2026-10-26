#!/usr/bin/env node
'use strict';

// This program only reads local baseline copies and writes a fresh candidate.
// It never connects to a server, reloads Nginx, or replaces a live config.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repoRoot = path.resolve(__dirname, '../../..');
const scratchRoot = path.join(repoRoot, '.codex-tmp');
const CA_BUNDLE = '/etc/pki/tls/certs/ca-bundle.crt';
// Captured read-only on 2026-10-26. A changed server config requires a new review.
const BASELINE = Object.freeze({
  web: 'd9cf55e3fd2ed96da702405ba3dbda07f9ee0a8658f7225a4b7513f45f75f719',
  api: 'c46efa0823141c33c09e80f254a1b8aac5e07746f7c334af55de41ad7510fc67',
});
const REAL_IP_INSERT = `
    # Only the same-host HTTPS frontend may supply the visitor address.
    # Public clients cannot override their rate-limit identity with XFF.
    set_real_ip_from 127.0.0.1;
    real_ip_header X-Forwarded-For;
    real_ip_recursive on;
`;
const CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://store.is.autonavi.com https://aos-comment.amap.com; font-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'";
const HANDLERS = [
  'takeout_decision_too_large', 'takeout_route_not_found', 'takeout_method_not_allowed',
  'takeout_upload_timeout', 'takeout_payload_too_large', 'takeout_rate_limited',
  'takeout_proxy_unavailable', 'restaurant_pool_unavailable',
  'restaurant_route_unavailable', 'restaurant_route_invalid',
];
const HASH = value => crypto.createHash('sha256').update(value).digest('hex');

function requireOnce(text, needle, label = needle) {
  if (text.split(needle).length !== 2) throw new Error(`Expected exactly one ${label}`);
}
function replaceOnce(text, before, after, label) { requireOnce(text, before, label); return text.replace(before, after); }
function required(text, needle, label) { if (!text.includes(needle)) throw new Error(`Missing ${label || needle}`); }
function forbidden(text, regex, label) { if (regex.test(text)) throw new Error(`Unexpected ${label}`); }

function locationBlock(text, name) {
  const marker = `    location ${name} {`;
  requireOnce(text, marker, `location ${name}`);
  const start = text.indexOf(marker), open = start + marker.length - 1;
  let depth = 0, quote = '', escaped = false, comment = false;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (comment) { if (char === '\n') comment = false; continue; }
    if (escaped) { escaped = false; continue; }
    if (quote) { if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') { comment = true; continue; }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`Unterminated location ${name}`);
}

function verifyApiGates(api) {
  required(api, 'limit_req_zone $binary_remote_addr zone=chi_takeout_upload_ip_eatwhat:1m rate=4r/m;');
  required(api, 'limit_conn_zone $server_name zone=chi_takeout_upload_total_eatwhat:64k;');
  const extraction = locationBlock(api, '= /v1/takeout/extractions');
  for (const value of ['client_max_body_size 3m;', 'client_body_buffer_size 3m;',
    'limit_req zone=chi_takeout_upload_ip_eatwhat burst=3 nodelay;',
    'limit_conn chi_takeout_upload_total_eatwhat 2;', 'limit_req_status 429;', 'limit_conn_status 429;']) required(extraction, value);
  for (const route of ['takeout/extractions', 'takeout/decisions', 'restaurant-decisions/pool', 'restaurant-decisions/route']) {
    const block = locationBlock(api, `= /v1/${route}`);
    for (const value of ['client_body_in_file_only off;', 'access_log off;', 'error_log /dev/null crit;',
      'proxy_request_buffering off;', 'proxy_buffering off;', 'proxy_cache off;', 'proxy_max_temp_file_size 0;',
      'proxy_intercept_errors off;', 'if ($request_method != POST) { return 405; }']) required(block, value, `${route}: ${value}`);
    if (route !== 'takeout/extractions') required(block, 'client_max_body_size 128k;');
  }
  const route = locationBlock(api, '= /v1/restaurant-decisions/route');
  required(route, 'if ($args != "") { return 400; }');
  required(route, 'if ($request_uri != "/v1/restaurant-decisions/route") { return 404; }');
  const fallback = locationBlock(api, '^~ /v1/');
  required(fallback, 'if ($uri ~* "^/v1/takeout(/|$)") { return 404; }');
  required(fallback, 'if ($uri ~* "^/v1/restaurant-decisions(/|$)") { return 404; }');
  for (const name of HANDLERS) {
    const block = locationBlock(api, `@${name}`);
    for (const value of ['access_log off;', 'error_log /dev/null crit;', 'add_header Cache-Control "no-store" always;',
      'add_header X-ChiShenMe-Contract-Version "1" always;', 'add_header X-Request-Id $request_id always;']) required(block, value, `${name}: ${value}`);
  }
  forbidden(api, /\b(?:set_real_ip_from|real_ip_header|real_ip_recursive)\b/, 'pre-existing API real-IP rules');
}

function patchApi(api) {
  verifyApiGates(api);
  const anchor = '    listen 443 ssl;\n    http2 on;\n    server_name api.eatwhat.pro;\n';
  return replaceOnce(api, anchor, anchor + REAL_IP_INSERT, 'HTTPS API server anchor');
}

function proxyLocation(name, { body = '128k', seconds = 25, payload = 'takeout_decision_too_large', unavailable = 'web_api_unavailable', timeout = 'web_api_timeout' } = {}) {
  return `    location ${name} {
        client_max_body_size ${body};
        client_body_buffer_size ${body};
        client_body_in_file_only off;
        client_body_timeout 15s;
        access_log off;
        error_log /dev/null crit;
        error_page 404 = @takeout_route_not_found;
        error_page 408 = @${timeout};
        error_page 413 = @${payload};
        error_page 502 503 504 = @${unavailable};
        if ($eatwhat_web_api_uri = "") { return 404; }
        # Preserve the original encoded URI and query. A prefix proxy_pass
        # would normalize them and defeat the API's canonical-route checks.
        proxy_pass https://127.0.0.1:443$eatwhat_web_api_uri;
        proxy_ssl_server_name on;
        proxy_ssl_name api.eatwhat.pro;
        proxy_ssl_verify on;
        proxy_ssl_verify_depth 4;
        proxy_ssl_trusted_certificate ${CA_BUNDLE};
        proxy_http_version 1.1;
        proxy_set_header Host api.eatwhat.pro;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host api.eatwhat.pro;
        proxy_set_header Forwarded "";
        proxy_set_header Cookie "";
        proxy_set_header Connection "";
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_cache off;
        proxy_store off;
        proxy_max_temp_file_size 0;
        proxy_ignore_headers X-Accel-Buffering;
        proxy_intercept_errors off;
        proxy_redirect off;
        proxy_connect_timeout 3s;
        proxy_send_timeout ${seconds}s;
        proxy_read_timeout ${seconds}s;
        proxy_next_upstream off;
    }`;
}
function safeError(name, status, code, message) {
  return `    location @${name} {
        default_type application/json;
        access_log off;
        error_log /dev/null crit;
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
        add_header Cache-Control "no-store" always;
        add_header X-ChiShenMe-Contract-Version "1" always;
        add_header X-Request-Id $request_id always;
        return ${status} '{"requestId":"$request_id","code":"${code}","message":"${message}"}';
    }`;
}
function patchWeb(web, api) {
  forbidden(web, /\blocation[^\n]*\/api(?:\/|\s)|\beatwhat_web_api_uri\b|Content-Security-Policy|location\s*=\s*\/index\.html/, 'pre-existing web API/CSP adapter');
  required(web, '    root /www/wwwroot/eatwhat.pro/current;');
  let result = replaceOnce(web,
    '    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;',
    '    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(self), payment=()" always;',
    'website Permissions-Policy');
  result = replaceOnce(result, '    access_log /www/wwwlogs/eatwhat.pro.log;', '    # API URLs and errors must never enter the website logs.\n    access_log off;', 'website access log');
  result = replaceOnce(result, '    error_log /www/wwwlogs/eatwhat.pro.error.log warn;', '    error_log /dev/null crit;', 'website error log');
  const pieces = [
    `    # Only the new application document gets this CSP. Existing legal,
    # support and download documents retain their original static behavior.
    location = /index.html {
        try_files $uri =404;
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(self), payment=()" always;
        add_header Cache-Control "no-store" always;
        add_header Content-Security-Policy "${CSP}" always;
    }`,
    proxyLocation('= /api/v1/takeout/extractions', { body: '3m', seconds: 45, payload: 'takeout_payload_too_large', timeout: 'takeout_upload_timeout', unavailable: 'takeout_proxy_unavailable' }),
    proxyLocation('= /api/v1/takeout/decisions', { unavailable: 'takeout_proxy_unavailable' }),
    proxyLocation('= /api/v1/restaurant-decisions/pool', { unavailable: 'restaurant_pool_unavailable' }),
    proxyLocation('= /api/v1/restaurant-decisions/route', { unavailable: 'restaurant_route_unavailable' }),
    proxyLocation('^~ /api/v1/'),
    `    location = /api {
        access_log off;
        error_log /dev/null crit;
        error_page 404 = @takeout_route_not_found;
        return 404;
    }

    location ^~ /api/ {
        access_log off;
        error_log /dev/null crit;
        error_page 404 = @takeout_route_not_found;
        return 404;
    }`,
    // Exact copies preserve status codes, no-store, request/contract headers,
    // upload error wording and Retry-After without changing upstream handlers.
    ...HANDLERS.map(name => locationBlock(api, `@${name}`)),
    safeError('web_api_unavailable', 503, 'SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试'),
    safeError('web_api_timeout', 408, 'REQUEST_TIMEOUT', '请求上传超时，请重试'),
  ];
  const anchor = '    location ^~ /_next/static/ {';
  result = replaceOnce(result, anchor, pieces.join('\n\n') + '\n\n' + anchor, 'legacy asset location');
  const map = `# The map strips only /api, retaining the original raw path and query.
# The upstream authority is fixed; this variable can never choose a host.
map $request_uri $eatwhat_web_api_uri {
    default "";
    ~^/api(?<eatwhat_web_raw_v1>/v1/.*)$ $eatwhat_web_raw_v1;
}

`;
  return map + result;
}

function prepareFromBuffers(webBytes, apiBytes, expected = BASELINE) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.web) || !/^[a-f0-9]{64}$/.test(expected.api)) throw new Error('Missing explicit baseline hashes');
  if (HASH(webBytes) !== expected.web || HASH(apiBytes) !== expected.api) throw new Error('Nginx baseline hash mismatch; stop and review the current server config');
  const web = webBytes.toString('utf8'), api = apiBytes.toString('utf8');
  if (!Buffer.from(web).equals(Buffer.from(webBytes)) || !Buffer.from(api).equals(Buffer.from(apiBytes))) throw new Error('Baseline is not UTF-8');
  const candidateApi = patchApi(api), candidateWeb = patchWeb(web, api);
  // The API's existing zones, route/size/rate/canonical checks, logging and
  // upstream forwarding must remain byte-for-byte identical.
  if (candidateApi.replace(REAL_IP_INSERT, '') !== api) throw new Error('API adapter changed an existing rule');
  return { web: candidateWeb, api: candidateApi, sourceHashes: { web: expected.web, api: expected.api } };
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function readRegular(root, filename) {
  const file = path.join(root, filename), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(fs.realpathSync(root), fs.realpathSync(file))) throw new Error(`Expected regular local file: ${filename}`);
  return fs.readFileSync(file);
}
function writeCandidate(source, output) {
  const sourceRoot = fs.realpathSync(source), destination = path.resolve(output);
  const base = fs.realpathSync(scratchRoot), parent = fs.realpathSync(path.dirname(destination));
  if (parent !== base && !inside(base, parent) || !inside(base, destination)) throw new Error('Output must be a new directory inside this checkout .codex-tmp');
  if (fs.existsSync(destination)) throw new Error('Refusing to overwrite an existing candidate');
  const webBytes = readRegular(sourceRoot, 'eatwhat.pro.conf'), apiBytes = readRegular(sourceRoot, 'api.eatwhat.pro.conf');
  const result = prepareFromBuffers(webBytes, apiBytes);
  const contents = { 'eatwhat.pro.conf': Buffer.from(result.web), 'api.eatwhat.pro.conf': Buffer.from(result.api),
    'original-eatwhat.pro.conf': webBytes, 'original-api.eatwhat.pro.conf': apiBytes };
  const manifest = { formatVersion: 1, kind: 'eatwhat-web-nginx-candidate', sourceHashes: result.sourceHashes,
    generatorSha256: HASH(fs.readFileSync(__filename)), caBundle: CA_BUNDLE,
    upstream: { address: '127.0.0.1:443', host: 'api.eatwhat.pro', tlsVerify: true, preserveRawUri: true },
    apiMutation: 'Add only loopback real-IP trust to the existing HTTPS API server; retain every existing API rule.',
    files: Object.entries(contents).map(([filename, bytes]) => ({ path: filename, sha256: HASH(bytes) })),
    requiresBeforeInstall: ['Re-read both live config hashes and match sourceHashes', 'Verify the loopback TLS chain with the recorded system CA', 'Run nginx -t for the complete candidate config', 'Back up both live configs and install/rollback them as one operation'],
  };
  fs.mkdirSync(destination);
  for (const [filename, bytes] of Object.entries(contents)) fs.writeFileSync(path.join(destination, filename), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(destination, 'nginx-candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { candidate: destination, ...manifest };
}
function verifyCandidate(candidate) {
  const root = fs.realpathSync(candidate);
  if (!inside(fs.realpathSync(scratchRoot), root)) throw new Error('Candidate must stay inside this checkout .codex-tmp');
  const manifest = JSON.parse(readRegular(root, 'nginx-candidate-manifest.json'));
  if (manifest.formatVersion !== 1 || manifest.kind !== 'eatwhat-web-nginx-candidate' ||
    manifest.generatorSha256 !== HASH(fs.readFileSync(__filename)) || manifest.caBundle !== CA_BUNDLE ||
    manifest.sourceHashes?.web !== BASELINE.web || manifest.sourceHashes?.api !== BASELINE.api) throw new Error('Candidate provenance mismatch');
  const expectedNames = ['eatwhat.pro.conf', 'api.eatwhat.pro.conf', 'original-eatwhat.pro.conf', 'original-api.eatwhat.pro.conf'];
  if (!Array.isArray(manifest.files) || manifest.files.length !== expectedNames.length || new Set(manifest.files.map(file => file.path)).size !== expectedNames.length) throw new Error('Candidate file list mismatch');
  for (const name of expectedNames) {
    const entry = manifest.files.find(file => file.path === name);
    if (!entry || HASH(readRegular(root, name)) !== entry.sha256) throw new Error(`Candidate file hash mismatch: ${name}`);
  }
  const expected = prepareFromBuffers(readRegular(root, 'original-eatwhat.pro.conf'), readRegular(root, 'original-api.eatwhat.pro.conf'));
  if (!readRegular(root, 'eatwhat.pro.conf').equals(Buffer.from(expected.web)) || !readRegular(root, 'api.eatwhat.pro.conf').equals(Buffer.from(expected.api))) throw new Error('Candidate is not the exact reviewed transformation');
  return { candidate: root, sourceHashes: manifest.sourceHashes, files: manifest.files };
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--source', '--output', '--verify'].includes(argv[index]) || !argv[index + 1] || result[argv[index].slice(2)]) throw new Error('Usage: prepare-nginx.cjs --source <local config copies> --output <new .codex-tmp directory>, or --verify <candidate>');
    result[argv[index].slice(2)] = argv[index + 1];
  }
  if (result.verify ? result.source || result.output : !result.source || !result.output) throw new Error('Choose generation or verification only');
  return result;
}
if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.verify ? verifyCandidate(options.verify) : writeCandidate(options.source, options.output);
    process.stdout.write(JSON.stringify({ result: options.verify ? 'NGINX_CANDIDATE_VERIFIED' : 'NGINX_CANDIDATE_PREPARED', ...result }, null, 2) + '\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { BASELINE, CA_BUNDLE, CSP, REAL_IP_INSERT, HANDLERS, HASH, locationBlock, verifyApiGates, patchApi, patchWeb, prepareFromBuffers, writeCandidate, verifyCandidate, parseArgs };
