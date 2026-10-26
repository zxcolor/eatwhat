#!/usr/bin/env bash
set -euo pipefail

# Run on the existing website host, only after the WEB API candidate is ready.
# Arguments are already verified, unpacked immutable payload/config directories.
[[ $# -eq 3 ]] || { echo 'usage: deploy-site.sh <payload> <nginx-candidate> <release-id>' >&2; exit 2; }
payload=$(readlink -f -- "$1")
configs=$(readlink -f -- "$2")
release=$3
[[ "$release" =~ ^202[0-9]{5}-web-[a-f0-9]{12}$ ]] || { echo 'invalid release id' >&2; exit 2; }
[[ "$payload" == /root/eatwhat-web-candidates/* && "$configs" == /root/eatwhat-web-candidates/* ]] || { echo 'candidate must be under the controlled upload directory' >&2; exit 2; }
site_root=/www/wwwroot/eatwhat.pro
vhosts=/www/server/panel/vhost/nginx
nginx_bin=/www/server/nginx/sbin/nginx
[[ -x "$nginx_bin" ]] || { echo 'expected Nginx binary is missing' >&2; exit 2; }
previous=$(readlink -f -- "$site_root/current")
[[ "$previous" == "$site_root/releases/"* && -f "$previous/index.html" ]] || { echo 'active website root is unexpected' >&2; exit 2; }
candidate="$site_root/releases/$release"
backup="/root/eatwhat-backups/before-$release"
[[ ! -e "$candidate" && ! -L "$candidate" && ! -e "$backup" ]] || { echo 'refusing to replace a release or backup' >&2; exit 2; }

# Share the API's established mutation lock, then serialize website releases.
# Do not create or replace the API lock file under a different identity.
mutation_lock=/run/lock/chi-shen-me/mutation.lock
[[ -f "$mutation_lock" && ! -L "$mutation_lock" && $(stat -c %u "$mutation_lock") == 0 ]] || { echo 'controlled API mutation lock missing' >&2; exit 2; }
exec 8<>"$mutation_lock"
flock -n 8 || { echo 'another deployment mutation is running' >&2; exit 2; }
exec 9>/run/lock/eatwhat-website-release.lock
flock -n 9 || { echo 'another website release is running' >&2; exit 2; }

python3 - "$payload" "$configs" "$vhosts" <<'PY'
import hashlib,json,os,sys
payload,configs,vhosts=sys.argv[1:]
def digest(p):
    with open(p,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
def check_members(root, manifest, field='files'):
    expected=set()
    for item in manifest[field]:
        name=item['path']; target=os.path.realpath(os.path.join(root,name))
        if name.startswith('/') or '..' in name.split('/') or not target.startswith(root+'/') or os.path.islink(os.path.join(root,name)):
            raise SystemExit('unsafe payload member')
        if digest(target)!=item['sha256']: raise SystemExit('candidate hash mismatch: '+name)
        expected.add(name)
    actual=set()
    for parent, dirs, files in os.walk(root):
        for name in dirs+files:
            if os.path.islink(os.path.join(parent,name)): raise SystemExit('symlink in candidate')
        for name in files: actual.add(os.path.relpath(os.path.join(parent,name),root))
    return actual,expected
with open(payload+'/release-manifest.json') as f: site=json.load(f)
actual,expected=check_members(payload,site)
if actual!=expected|{'release-manifest.json'}: raise SystemExit('unexpected website payload member')
with open(configs+'/nginx-candidate-manifest.json') as f: config=json.load(f)
check_members(configs,config)
for key,name in [('web','eatwhat.pro.conf'),('api','api.eatwhat.pro.conf')]:
    if digest(vhosts+'/'+name)!=config['sourceHashes'][key]: raise SystemExit('live Nginx configuration changed: '+name)
if not os.path.isfile(config['caBundle']): raise SystemExit('system CA bundle missing')
print('WEB_PAYLOAD_AND_CONFIG_HASHES=OK')
PY

curl --fail --silent --show-error --resolve api.eatwhat.pro:443:127.0.0.1 \
  --cacert /etc/pki/tls/certs/ca-bundle.crt https://api.eatwhat.pro/health/ready >/dev/null
install -d -m 700 "$backup" "$backup/vhosts"
cp -a -- "$vhosts/eatwhat.pro.conf" "$backup/eatwhat.pro.conf"
cp -a -- "$vhosts/api.eatwhat.pro.conf" "$backup/api.eatwhat.pro.conf"
printf '%s\n' "$previous" >"$backup/previous-root"
tar -czf "$backup/site.tar.gz" -C "$previous" .
chmod 600 "$backup/site.tar.gz"

# Validate the complete Nginx configuration with only the two candidate vhosts
# substituted. The active files and running workers are unchanged here.
for original in "$vhosts"/*.conf; do
  name=$(basename "$original")
  case "$name" in
    eatwhat.pro.conf|api.eatwhat.pro.conf) cp -- "$configs/$name" "$backup/vhosts/$name" ;;
    *) ln -s -- "$original" "$backup/vhosts/$name" ;;
  esac
done
# Nginx resolves relative include files beside the selected -c configuration.
for shared in /www/server/nginx/conf/*; do
  name=$(basename "$shared")
  [[ "$name" != nginx.conf && ! -e "$backup/$name" ]] || continue
  ln -s -- "$shared" "$backup/$name"
done
python3 - "$backup" <<'PY'
import sys
root=sys.argv[1]
with open('/www/server/nginx/conf/nginx.conf') as f: text=f.read()
needle='/www/server/panel/vhost/nginx/*.conf'
if text.count(needle)!=1: raise SystemExit('unrecognized Nginx vhost include')
with open(root+'/nginx-test.conf','w') as f: f.write(text.replace(needle,root+'/vhosts/*.conf'))
PY
"$nginx_bin" -t -c "$backup/nginx-test.conf"

install -d -m 755 "$candidate"
cp -a -- "$previous/." "$candidate/"
asset_dir=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["assetDirectory"])' "$payload/release-manifest.json")
[[ "$asset_dir" =~ ^web-[a-f0-9]{12}$ && ! -e "$candidate/$asset_dir" ]] || { echo 'asset namespace collision' >&2; exit 2; }
cp -a -- "$payload/$asset_dir" "$candidate/$asset_dir"
install -m 644 -- "$payload/index.html" "$candidate/index.html"
find "$candidate/$asset_dir" -type d -exec chmod 755 {} +
find "$candidate/$asset_dir" -type f -exec chmod 644 {} +
python3 - "$previous" "$candidate" "$payload/release-manifest.json" <<'PY'
import hashlib,json,os,sys
old,new,manifest=sys.argv[1:]
def digest(p):
    with open(p,'rb') as f:return hashlib.sha256(f.read()).hexdigest()
count=0
for parent,dirs,files in os.walk(old):
    for name in files:
        rel=os.path.relpath(os.path.join(parent,name),old)
        if rel=='index.html':continue
        if digest(os.path.join(old,rel))!=digest(os.path.join(new,rel)):raise SystemExit('previous website file changed: '+rel)
        count+=1
for item in json.load(open(manifest))['files']:
    if digest(os.path.join(new,item['path']))!=item['sha256']:raise SystemExit('assembled website hash mismatch')
print('PREVIOUS_WEBSITE_FILES_PRESERVED='+str(count))
PY

changed=0
rollback() {
  code=$?
  if [[ "$changed" == 1 ]]; then
    install -m 644 -- "$backup/eatwhat.pro.conf" "$vhosts/eatwhat.pro.conf.rollback.$$"
    install -m 644 -- "$backup/api.eatwhat.pro.conf" "$vhosts/api.eatwhat.pro.conf.rollback.$$"
    mv -Tf -- "$vhosts/eatwhat.pro.conf.rollback.$$" "$vhosts/eatwhat.pro.conf"
    mv -Tf -- "$vhosts/api.eatwhat.pro.conf.rollback.$$" "$vhosts/api.eatwhat.pro.conf"
    ln -s -- "$previous" "$site_root/current.rollback.$$"
    mv -Tf -- "$site_root/current.rollback.$$" "$site_root/current"
    "$nginx_bin" -t
    "$nginx_bin" -s reload
    echo 'WEBSITE_ROLLED_BACK=1' >&2
  fi
  exit "$code"
}
trap rollback ERR
# Recheck after candidate preparation, immediately before touching live files.
cmp -- "$backup/eatwhat.pro.conf" "$vhosts/eatwhat.pro.conf"
cmp -- "$backup/api.eatwhat.pro.conf" "$vhosts/api.eatwhat.pro.conf"
[[ $(readlink -f -- "$site_root/current") == "$previous" ]]
changed=1
install -m 644 -- "$configs/eatwhat.pro.conf" "$vhosts/eatwhat.pro.conf.next.$$"
install -m 644 -- "$configs/api.eatwhat.pro.conf" "$vhosts/api.eatwhat.pro.conf.next.$$"
mv -Tf -- "$vhosts/eatwhat.pro.conf.next.$$" "$vhosts/eatwhat.pro.conf"
mv -Tf -- "$vhosts/api.eatwhat.pro.conf.next.$$" "$vhosts/api.eatwhat.pro.conf"
"$nginx_bin" -t
"$nginx_bin" -s reload
ln -s -- "$candidate" "$site_root/current.next.$$"
mv -Tf -- "$site_root/current.next.$$" "$site_root/current"

# Reload signals are asynchronous. Old workers can already read the new
# symlink's static files while still lacking /api; wait for both new document
# policy and a successful API response before the unchanged strict checks.
python3 - <<'PY'
import json,subprocess,time
base=['curl','--silent','--show-error','--max-time','2','--resolve','eatwhat.pro:443:127.0.0.1']
deadline=time.monotonic()+20
attempt=0
while time.monotonic()<deadline:
    attempt+=1
    head=subprocess.run(base+['--head','https://eatwhat.pro/index.html'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    headers=head.stdout.decode('iso-8859-1').lower()
    policy_ready=(head.returncode==0 and 'content-security-policy:' in headers
                  and "base-uri 'none'" in headers and 'geolocation=(self)' in headers)
    api=subprocess.run(base+['--fail','https://eatwhat.pro/api/v1/config'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    api_ready=False
    if api.returncode==0:
        try:
            data=json.loads(api.stdout.decode('utf-8'))
            api_ready=isinstance(data,dict) and isinstance(data.get('authCapabilities'),dict)
        except (ValueError,UnicodeDecodeError):
            pass
    if policy_ready and api_ready:
        print('NGINX_CANDIDATE_READY=OK ATTEMPTS='+str(attempt))
        break
    time.sleep(.25)
else:
    raise SystemExit('candidate Nginx workers did not become ready within 20 seconds')
PY

python3 - "$payload/release-manifest.json" "$backup" "$candidate" <<'PY'
import hashlib,json,subprocess,sys
manifest,backup,candidate=sys.argv[1:]
data=json.load(open(manifest))
def fetch(url,extra=[]):
    return subprocess.check_output(['curl','--fail','--silent','--show-error','--resolve','eatwhat.pro:443:127.0.0.1']+extra+['https://eatwhat.pro/'+url])
for item in data['files']:
    if hashlib.sha256(fetch(item['path'])).hexdigest()!=item['sha256']:raise SystemExit('served website hash mismatch: '+item['path'])
for legacy in ['privacy','terms','support','download','third-parties','recommendation-rules']:
    fetch(legacy+'/')
config=json.loads(fetch('api/v1/config'))
if config.get('contractVersion') not in [1,'1'] and 'authCapabilities' not in config:raise SystemExit('unexpected proxied API config')
checks=[('api/v1/restaurant-decisions/route?probe=1','400'),('api/v1/restaurant-decisions/%72oute','404'),('api/v1/restaurant-decisions/route/','404'),('api/admin','404')]
for uri,expected in checks:
    code=subprocess.check_output(['curl','--silent','--show-error','--path-as-is','--resolve','eatwhat.pro:443:127.0.0.1','-X','POST','-H','Content-Type: application/json','--data','{}','-o','/dev/null','-w','%{http_code}','https://eatwhat.pro/'+uri]).decode()
    if code!=expected:raise SystemExit('proxy boundary failed: '+uri+' returned '+code)
receipt={'release':candidate,'revision':data['revision'],'resourceHashesVerified':len(data['files']),'legacyPagesVerified':6,'proxyBoundariesVerified':len(checks),'status':'deployed'}
with open(backup+'/receipt.json','w') as f:json.dump(receipt,f,indent=2)
print(json.dumps(receipt))
PY
changed=0
trap - ERR
echo 'WEBSITE_RELEASE_ACTIVATION=OK'
