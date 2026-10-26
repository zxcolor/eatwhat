'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applyPatch, reversePatch } = require('../server-patches/web-sessions.cjs');
const { parseArgs } = require('../scripts/prepare-server-candidate.cjs');

test('WEB contract patch is exact and preserves platform-specific OAuth literals', () => {
  const source = [
    'device: z.enum(["ANDROID", "MINIPROGRAM"])',
    'session: z.enum(["ANDROID", "MINIPROGRAM"])',
    'native: z.literal("ANDROID"), wechat: z.literal("MINIPROGRAM")',
    '/** New clients opt in; absent preserves Android-only v1 clients. */',
    'includePlatforms: z.literal("ALL").optional()',
  ].join('\n');
  const result = applyPatch('packages/contracts/src/index.ts', source);
  assert.match(result, /ALL_WITH_WEB/);
  assert.equal(result.split('"WEB"').length - 1, 2);
  assert.ok(result.includes('native: z.literal("ANDROID"), wechat: z.literal("MINIPROGRAM")'));
  assert.equal(reversePatch('packages/contracts/src/index.ts', result), source);
  assert.throws(() => applyPatch('packages/contracts/src/index.ts', `${source}\nz.enum(["ANDROID", "MINIPROGRAM"])`), /expected 2 matches, got 3/);
  assert.throws(() => applyPatch('packages/contracts/src/index.ts', result), /does not match/);
});

test('server candidate baseline is separate from main and pins every live runtime input', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '../server-patches/baseline.json'), 'utf8'));
  assert.equal(baseline.files.length, 210);
  assert.equal(new Set(baseline.files.map(file => file.path)).size, 210);
  assert.equal(baseline.files.filter(file => file.path.startsWith('apps/api/migrations/')).length, 16);
  for (const file of baseline.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(file.bytes > 0);
    assert.ok(!file.path.split('/').includes('..'));
    assert.ok(!/(?:^|\/)(?:\.env|node_modules|dist|deployment\.env)(?:$|\/)/.test(file.path));
  }
  assert.ok(!baseline.files.some(file => file.path.includes('0017_')));
});

test('candidate command parser rejects unknown and duplicate source arguments', () => {
  assert.throws(() => parseArgs(['--source', 'one', '--source', 'two']), /Duplicate/);
  assert.throws(() => parseArgs(['--source']), /Usage/);
  assert.throws(() => parseArgs(['--unsafe', 'one']), /Usage/);
});
