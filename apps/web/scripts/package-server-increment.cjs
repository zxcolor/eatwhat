#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyCandidate } = require('./prepare-server-candidate.cjs');
const root = path.resolve(__dirname, '../../..');
const scratch = path.join(root, '.codex-tmp');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runtimeToSource = name => {
  const [kind, ...parts] = name.split('/');
  const prefix = { api: 'apps/api/dist', contracts: 'packages/contracts/dist', migrations: 'apps/api/migrations' }[kind];
  if (!prefix || parts.some(part => !part || part === '..')) throw new Error('Invalid runtime member');
  return path.join(prefix, ...parts);
};

function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--candidate', '--recovery', '--deploy', '--runtime-manifest', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('Pass --candidate, --recovery, --deploy, --runtime-manifest and --output');
    options[args[i].slice(2)] = path.resolve(args[i + 1]);
  }
  for (const key of ['candidate', 'recovery', 'deploy', 'runtime-manifest', 'output']) if (!options[key]) throw new Error(`Missing ${key}`);
  const relative = path.relative(scratch, options.output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(options.output)) throw new Error('Output must be a new directory inside this checkout .codex-tmp');
  verifyCandidate(options.candidate);
  verifyCandidate(options.recovery);
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '../server-patches/baseline.json')));
  const runtime = JSON.parse(fs.readFileSync(options['runtime-manifest']));
  if (runtime.image !== baseline.image || runtime.release !== baseline.release) throw new Error('Runtime audit belongs to another base image');
  // The controller's inferred return declaration includes the new platform enum;
  // its executable JS and source map must remain byte-identical to production.
  const approved = [...['api/auth/auth.repository', 'api/auth/auth.service', 'contracts/index'].flatMap(name => ['.js', '.d.ts', '.js.map'].map(ext => name + ext)), 'api/auth/auth.controller.d.ts'];
  for (const file of runtime.files) {
    const bytes = fs.readFileSync(path.join(options.recovery, runtimeToSource(file.path)));
    if (hash(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error(`Recovery compilation differs from active image: ${file.path}`);
    const candidateBytes = fs.readFileSync(path.join(options.candidate, runtimeToSource(file.path)));
    if (!approved.includes(file.path) && hash(candidateBytes) !== file.sha256) throw new Error(`Unapproved compiler output changed: ${file.path}`);
  }
  const migration = '0017_web_browser_sessions.sql';
  const candidateManifest = fs.readFileSync(path.join(options.candidate, 'candidate-manifest.json'));
  const recoveryManifest = fs.readFileSync(path.join(options.recovery, 'candidate-manifest.json'));
  const entries = [
    { mode: 'web', directory: options.candidate, manifest: candidateManifest },
    { mode: 'recovery', directory: options.recovery, manifest: recoveryManifest },
  ];
  fs.mkdirSync(options.output);
  const archives = [];
  function archive(label, directory, names) {
    const fileList = path.join(options.output, `${label}-members.txt`);
    fs.writeFileSync(fileList, `${names.join('\n')}\n`);
    const target = path.join(options.output, `${label}.tar.gz`);
    execFileSync('tar.exe', ['-czf', target, '-C', directory, '-T', fileList], { windowsHide: true, stdio: 'pipe' });
    const bytes = fs.readFileSync(target);
    archives.push({ name: path.basename(target), sha256: hash(bytes), bytes: bytes.length, members: names });
  }
  const plan = {
    formatVersion: 1, baselineRelease: baseline.release, baselineImage: baseline.image,
    baselineTag: 'chi-shen-me-api:source-preference-ai-853f06b',
    contractRuntimeDirectory: '/app/node_modules/.pnpm/@chi-shen-me+contracts@file+packages+contracts/node_modules/@chi-shen-me/contracts/dist',
    baseRuntime: runtime.files, comparedRecoveryRuntimeFiles: runtime.files.length,
    expectedPostgres: 'b94b0124ae9301c2d399e04e32b247b0930aaed93cef3e45cb025eda2cb029f5',
    expectedActiveEnvSha256: '49b9d57b64d2a56daf213f221b09ed1db024ea5e582980620d0750651b9deb71',
    entries: [], archives,
  };
  for (const entry of entries) {
    const manifestHash = hash(entry.manifest);
    const release = `20261026-web${entry.mode === 'recovery' ? '-recovery' : ''}-${manifestHash.slice(0, 12)}`;
    const imageTag = `chi-shen-me-api:${release}`;
    const sourceMembers = [...baseline.files.map(file => file.path), `apps/api/migrations/${migration}`];
    archive(`${entry.mode}-source`, entry.directory, sourceMembers);
    const overlay = path.join(options.output, `${entry.mode}-overlay`);
    fs.mkdirSync(overlay);
    const overlayMembers = ['Dockerfile'];
    const overrides = [];
    for (const name of entry.mode === 'web' ? approved : []) {
      const bytes = fs.readFileSync(path.join(entry.directory, runtimeToSource(name)));
      const target = path.join(overlay, 'files', name);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
      overlayMembers.push(`files/${name}`); overrides.push({ path: name, sha256: hash(bytes), bytes: bytes.length });
    }
    const migrationBytes = fs.readFileSync(path.join(entry.directory, 'apps/api/migrations', migration));
    fs.mkdirSync(path.join(overlay, 'files/migrations'), { recursive: true });
    fs.writeFileSync(path.join(overlay, 'files/migrations', migration), migrationBytes);
    overlayMembers.push(`files/migrations/${migration}`);
    overrides.push({ path: `migrations/${migration}`, sha256: hash(migrationBytes), bytes: migrationBytes.length });
    let dockerfile = `FROM ${plan.baselineTag}\n`;
    if (entry.mode === 'web') dockerfile += `COPY --chown=node:node files/api/auth/ /app/dist/auth/\nCOPY --chown=node:node files/contracts/ ${plan.contractRuntimeDirectory}/\n`;
    dockerfile += `COPY --chown=node:node files/migrations/${migration} /app/migrations/${migration}\nLABEL pro.eatwhat.web.base-image="${baseline.image}" pro.eatwhat.web.manifest="${manifestHash}"\nUSER node\n`;
    fs.writeFileSync(path.join(overlay, 'Dockerfile'), dockerfile);
    archive(`${entry.mode}-overlay`, overlay, overlayMembers);
    plan.entries.push({ mode: entry.mode, release, imageTag, sourceManifestSha256: manifestHash, overrides });
    fs.writeFileSync(path.join(options.output, `${entry.mode}-candidate-manifest.json`), entry.manifest);
  }
  const deployFiles = fs.readdirSync(options.deploy, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.relative(options.deploy, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
  if (deployFiles.includes('deployment.env') || deployFiles.length !== 36 || !deployFiles.includes('SHA256SUMS')) throw new Error('Unexpected deployment payload');
  archive('deploy', options.deploy, deployFiles);
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  fs.writeFileSync(path.join(options.output, 'preparation-plan.json'), planText);
  console.log(JSON.stringify({ output: options.output, planSha256: hash(Buffer.from(planText)), entries: plan.entries.map(({ mode, release, imageTag }) => ({ mode, release, imageTag })), archives: archives.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) }));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
