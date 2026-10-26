const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { verifySnapshot } = require('../scripts/build.cjs');

test('a valid hash list cannot authorize unlisted source modules or missing members', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eatwhat-web-source-test-'));
  const source = 'module.exports = { public: true };';
  fs.writeFileSync(path.join(directory, 'known.js'), source);
  const manifest = { files: [{ path: 'known.js', sha256: crypto.createHash('sha256').update(source).digest('hex') }] };
  assert.doesNotThrow(() => verifySnapshot(directory, manifest));
  fs.writeFileSync(path.join(directory, 'unlisted.js'), 'module.exports = "not reviewed";');
  assert.throws(() => verifySnapshot(directory, manifest), /membership/);
  fs.unlinkSync(path.join(directory, 'unlisted.js'));
  assert.throws(() => verifySnapshot(directory, { files: [...manifest.files, { path: 'missing.js', sha256: '0'.repeat(64) }] }), /membership/);
  assert.throws(() => verifySnapshot(directory, { files: [...manifest.files, ...manifest.files] }), /membership/);
  fs.writeFileSync(path.join(directory, 'known.js'), `${source}\nchanged`);
  assert.throws(() => verifySnapshot(directory, manifest), /snapshot changed/);
});
