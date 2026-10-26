#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { applyPatch, reversePatch, patchedPaths } = require('../server-patches/web-sessions.cjs');
const { applyDeployPatch, reverseDeployPatch, deployPatchedPaths } = require('../server-patches/web-deployment.cjs');

const webRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(webRoot, '../..');
const scratchRoot = path.join(repositoryRoot, '.codex-tmp');
const baselineFile = path.join(webRoot, 'server-patches/baseline.json');
const deployBaselineFile = path.join(webRoot, 'server-patches/deploy-baseline.json');
const migrationName = '0017_web_browser_sessions.sql';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function safeRelative(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe manifest path');
  }
  return name;
}

function plainFile(root, relative) {
  const absolute = path.join(root, safeRelative(relative));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(fs.realpathSync(root), fs.realpathSync(absolute))) {
    throw new Error(`Source must be a regular file inside the selected root: ${relative}`);
  }
  return fs.readFileSync(absolute);
}

function parseArgs(argv) {
  const options = { mode: 'web' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!['--source', '--output', '--mode', '--verify'].includes(arg) || !argv[index + 1]) {
      throw new Error('Usage: prepare-server-candidate.cjs --source <current-source-root> [--output <new .codex-tmp directory>] [--mode web|recovery], or --verify <candidate>');
    }
    const key = arg.slice(2);
    if (key !== 'mode' && options[key]) throw new Error(`Duplicate ${arg}`);
    options[key] = argv[++index];
  }
  return options;
}

function verifyCandidate(candidate) {
  const root = fs.realpathSync(candidate);
  if (!inside(fs.realpathSync(scratchRoot), root)) throw new Error('Candidate must stay inside this checkout .codex-tmp');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'candidate-manifest.json'), 'utf8'));
  const baselineBytes = fs.readFileSync(baselineFile);
  const baseline = JSON.parse(baselineBytes);
  const deployBaselineBytes = fs.readFileSync(deployBaselineFile);
  const deployBaseline = JSON.parse(deployBaselineBytes);
  if (manifest.formatVersion !== 1 || !['web', 'recovery'].includes(manifest.mode) || manifest.baselineManifestSha256 !== digest(baselineBytes) || manifest.deploymentBaselineSha256 !== digest(deployBaselineBytes)) throw new Error('Candidate provenance does not match this baseline');
  for (const input of manifest.patchInputs) {
    if (digest(plainFile(webRoot, input.path)) !== input.sha256) throw new Error(`Patch input drift: ${input.path}`);
  }
  const originals = new Map([...baseline.files, ...baseline.validationFiles, ...deployBaseline.files, ...deployBaseline.helpers].map(file => [file.path, file]));
  const additions = new Map([
    [`apps/api/migrations/${migrationName}`, path.join(webRoot, 'server-migrations', migrationName)],
    ['infra/postgres/verify-web-browser-sessions.sql', path.join(webRoot, 'server-patches/verify-web-browser-sessions.sql')],
  ]);
  if (manifest.mode === 'web') additions.set('apps/api/src/auth/web-browser-sessions.test.ts', path.join(webRoot, 'server-patches/web-browser-sessions.test.ts'));
  const expectedNames = new Set([...originals.keys(), ...additions.keys()]);
  if (manifest.files.length !== expectedNames.size || new Set(manifest.files.map(file => file.path)).size !== expectedNames.size) throw new Error('Candidate manifest membership changed');
  for (const file of manifest.files) {
    if (!expectedNames.has(file.path)) throw new Error(`Unexpected candidate member: ${file.path}`);
    const bytes = plainFile(root, file.path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Candidate drift: ${file.path}`);
    const original = originals.get(file.path);
    if (original) {
      const restored = deployPatchedPaths.includes(file.path)
        ? Buffer.from(reverseDeployPatch(file.path, bytes.toString('utf8')))
        : manifest.mode === 'web' && patchedPaths.includes(file.path)
          ? Buffer.from(reversePatch(file.path, bytes.toString('utf8'))) : bytes;
      if (digest(restored) !== original.sha256) throw new Error(`Candidate no longer derives from the pinned source: ${file.path}`);
    } else if (digest(fs.readFileSync(additions.get(file.path))) !== file.sha256) throw new Error(`Candidate addition drift: ${file.path}`);
  }
  for (const tree of ['apps/api/src', 'apps/api/scripts', 'apps/api/migrations', 'packages/contracts/src']) {
    if (!fs.existsSync(path.join(root, tree))) continue;
    for (const entry of fs.readdirSync(path.join(root, tree), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() && !entry.isDirectory()) throw new Error('Candidate source tree contains a nonregular entry');
      if (entry.isFile()) {
        const relative = path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
        if (!expectedNames.has(relative)) throw new Error(`Unlisted source file: ${relative}`);
      }
    }
  }
  return { candidate: root, mode: manifest.mode, files: manifest.files.length, migrations: 17, verified: true };
}

function prepareCandidate(options) {
  if (!options.source || !['web', 'recovery'].includes(options.mode)) throw new Error('A source root and web/recovery mode are required');
  const sourceRoot = fs.realpathSync(options.source);
  const output = path.resolve(options.output || path.join(scratchRoot, `web-server-${options.mode}-${crypto.randomUUID()}`));
  if (!inside(scratchRoot, output) || inside(sourceRoot, output) || output === sourceRoot) throw new Error('Output must be a separate, new directory inside this checkout .codex-tmp');
  if (fs.existsSync(output)) throw new Error('Output already exists; never overwrite a candidate');
  fs.mkdirSync(scratchRoot, { recursive: true });
  // Resolve every existing ancestor before writing, so a junction cannot redirect output.
  let ancestor = path.dirname(output);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolvedAncestor = fs.realpathSync(ancestor);
  if (resolvedAncestor !== fs.realpathSync(scratchRoot) && !inside(fs.realpathSync(scratchRoot), resolvedAncestor)) throw new Error('Output ancestor escapes scratch root');

  const baselineBytes = fs.readFileSync(baselineFile);
  const baseline = JSON.parse(baselineBytes);
  const deployBaselineBytes = fs.readFileSync(deployBaselineFile);
  const deployBaseline = JSON.parse(deployBaselineBytes);
  if (baseline.formatVersion !== 1 || baseline.files.length !== 210) throw new Error('Unexpected server baseline');
  if (deployBaseline.formatVersion !== 1 || deployBaseline.files.length !== 34 || deployBaseline.release !== baseline.release) throw new Error('Unexpected deployment baseline');
  const inputs = [...baseline.files, ...baseline.validationFiles, ...deployBaseline.files, ...deployBaseline.helpers];
  const staged = new Map();
  for (const input of inputs) {
    if (staged.has(input.path)) throw new Error(`Duplicate input ${input.path}`);
    const bytes = plainFile(sourceRoot, input.path);
    if (bytes.length !== input.bytes || digest(bytes) !== input.sha256) throw new Error(`Pinned baseline drift: ${input.path}`);
    staged.set(input.path, bytes);
  }
  const changes = [];
  if (options.mode === 'web') {
    for (const relative of patchedPaths) {
      const before = staged.get(relative);
      if (!before) throw new Error(`Patch target is not in the pinned inputs: ${relative}`);
      const after = Buffer.from(applyPatch(relative, before.toString('utf8')));
      staged.set(relative, after);
      changes.push({ path: relative, before: digest(before), after: digest(after) });
    }
    staged.set('apps/api/src/auth/web-browser-sessions.test.ts', fs.readFileSync(path.join(webRoot, 'server-patches/web-browser-sessions.test.ts')));
  }
  for (const relative of deployPatchedPaths) {
    const before = staged.get(relative);
    if (!before) throw new Error(`Deployment patch target is not pinned: ${relative}`);
    const after = Buffer.from(applyDeployPatch(relative, before.toString('utf8')));
    staged.set(relative, after);
    changes.push({ path: relative, before: digest(before), after: digest(after) });
  }
  staged.set(`apps/api/migrations/${migrationName}`, fs.readFileSync(path.join(webRoot, 'server-migrations', migrationName)));
  staged.set('infra/postgres/verify-web-browser-sessions.sql', fs.readFileSync(path.join(webRoot, 'server-patches/verify-web-browser-sessions.sql')));
  const migrations = [...staged.keys()].filter(relative => relative.startsWith('apps/api/migrations/')).sort();
  if (migrations.length !== 17 || migrations.some((relative, index) => !path.basename(relative).startsWith(`${String(index + 1).padStart(4, '0')}_`))) throw new Error('Candidate migration plan must remain continuous from 0001 through 0017');

  const patchFiles = ['server-patches/web-sessions.cjs', 'server-patches/web-browser-sessions.test.ts', 'server-patches/web-deployment.cjs', 'server-patches/web-cutover-function.sh', 'server-patches/web-bundle-gates.ps1', 'server-patches/verify-web-browser-sessions.sql', `server-migrations/${migrationName}`];
  const manifest = {
    formatVersion: 1, mode: options.mode, baselineRelease: baseline.release, baselineImage: baseline.image,
    baselineManifestSha256: digest(baselineBytes), baselineFileCount: baseline.files.length,
    deploymentBaselineSha256: digest(deployBaselineBytes),
    patchInputs: patchFiles.map(relative => ({ path: relative, sha256: digest(fs.readFileSync(path.join(webRoot, relative))) })),
    changes,
    files: [...staged].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([relative, bytes]) => ({ path: relative, sha256: digest(bytes), bytes: bytes.length })),
    verification: 'Prepared only; dependency installation, tests, build, database migration and deployment are separate gates.',
  };
  // No mutation occurs until every source and patch precondition above succeeds.
  fs.mkdirSync(output, { recursive: true });
  for (const [relative, bytes] of staged) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  fs.writeFileSync(path.join(output, 'candidate-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return verifyCandidate(output);
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(options.verify ? verifyCandidate(options.verify) : prepareCandidate(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { prepareCandidate, verifyCandidate, parseArgs };
