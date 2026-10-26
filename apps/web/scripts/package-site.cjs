const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function packageSite(destination) {
  const dist = path.join(root, 'dist');
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'build-manifest.json'), 'utf8'));
  for (const file of manifest.files) {
    const absolute = path.resolve(dist, file.path);
    if (!absolute.startsWith(dist + path.sep) || sha(fs.readFileSync(absolute)) !== file.sha256) throw new Error('Build manifest does not match output');
  }
  const revision = sha(JSON.stringify(manifest.files)).slice(0, 12);
  const assetDirectory = `web-${revision}`;
  const output = path.resolve(destination || path.join(repo, '.codex-tmp/web-qa', assetDirectory));
  const scratch = path.join(repo, '.codex-tmp') + path.sep;
  if (!output.startsWith(scratch)) throw new Error('Website package must stay in this checkout scratch directory');
  if (fs.existsSync(output)) throw new Error('Refusing to replace an existing release package');
  fs.mkdirSync(path.join(output, assetDirectory), { recursive: true });
  const packagedFiles = [];
  for (const file of manifest.files) {
    if (file.path === 'index.html') continue;
    const target = path.join(output, assetDirectory, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let bytes = fs.readFileSync(path.join(dist, file.path));
    if (file.path === 'mini.js') {
      const source = bytes.toString('utf8');
      if (source.split('window.EW_MINI={modules:').length !== 2) throw new Error('Unknown bundle format');
      bytes = Buffer.from(source.replace('window.EW_MINI={modules:', `window.EW_MINI={assetBase:"/${assetDirectory}/",modules:`));
    }
    fs.writeFileSync(target, bytes);
    packagedFiles.push({ path: `${assetDirectory}/${file.path}`, sha256: sha(bytes) });
  }
  let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  for (const file of packagedFiles.filter(file => !file.path.includes('/assets/'))) {
    const name = file.path.slice(assetDirectory.length + 1);
    html = html.replace(new RegExp(`"\\./${name.replaceAll('.', '\\.')}\\?v=[a-f0-9]+"`, 'g'), `"/${file.path}?v=${file.sha256.slice(0, 12)}"`);
  }
  fs.writeFileSync(path.join(output, 'index.html'), html);
  const payload = {
    formatVersion: 1, sourceVersion: manifest.sourceVersion, revision, assetDirectory,
    files: [{ path: 'index.html', sha256: sha(html) }, ...packagedFiles],
  };
  fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ output, revision, assetDirectory, files: payload.files.length }));
  return payload;
}
if (require.main === module) packageSite(process.argv[2]);
module.exports = { packageSite };
