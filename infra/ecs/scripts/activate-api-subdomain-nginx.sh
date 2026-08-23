#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

if [[ "$(id -u)" -ne 0 ]]; then
  die 'run as root'
fi
[[ "$#" -eq 0 ]] || die 'activate-api-subdomain-nginx.sh does not accept arguments'

for required_command in awk chmod chown cp curl date dirname find flock grep id install mktemp mv openssl readlink realpath rm sed sha256sum sleep stat; do
  command -v "$required_command" >/dev/null || die "required command is unavailable: $required_command"
done

script_source="${BASH_SOURCE[0]}"
[[ -f "$script_source" && ! -L "$script_source" ]] || die 'activation script must be a regular file, not a link'
script_path="$(realpath -e -- "$script_source")"
script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
release_root="$(dirname -- "$bundle_root")"
release_id="${release_root##*/}"

[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die 'invalid release ID'
[[ "$bundle_root" == "/opt/chi-shen-me/releases/$release_id/deploy" ]] ||
  die "unexpected deployment directory: $bundle_root"
[[ "$release_root" == "/opt/chi-shen-me/releases/$release_id" ]] || die 'unexpected release path'
[[ "$(realpath -e -- "$release_root")" == "$release_root" && ! -L "$release_root" ]] ||
  die 'release must not be a link'
[[ "$script_path" == "$script_dir/activate-api-subdomain-nginx.sh" ]] || die 'unexpected activation script path'

manifest="$bundle_root/SHA256SUMS"
deployment_env="$bundle_root/deployment.env"
preflight="$script_dir/preflight-deployment.sh"
template="$bundle_root/nginx/api.unfinished-era.com.conf"
well_known_template="$bundle_root/nginx/api.unfinished-era.com.well-known.conf"
current_link='/opt/chi-shen-me/current'

for required_file in "$manifest" "$deployment_env" "$preflight" "$template" "$well_known_template"; do
  [[ -f "$required_file" && ! -L "$required_file" ]] || die "required deployment file is unavailable or unsafe: $required_file"
done
[[ "$(stat -c '%a:%u:%g' "$deployment_env")" == '600:0:0' ]] ||
  die 'deployment.env must be root:root mode 0600'
if find "$bundle_root" -xdev -type l -print -quit | grep -q .; then
  die 'deployment bundle must not contain links'
fi
(
  cd "$bundle_root"
  sha256sum --check --strict SHA256SUMS >/dev/null
)
"$preflight" >/dev/null

[[ -L "$current_link" ]] || die 'current must be a release symlink before publishing the API vhost'
[[ "$(realpath -e -- "$current_link")" == "$release_root" ]] ||
  die 'the API vhost may be activated only from the current release'

mapfile -t api_port_lines < <(grep -E '^API_LOOPBACK_PORT=' "$deployment_env" || true)
[[ "${#api_port_lines[@]}" -eq 1 ]] || die 'API_LOOPBACK_PORT must occur exactly once'
api_loopback_port="${api_port_lines[0]#*=}"
[[ "$api_loopback_port" == '13001' ]] || die 'public API activation requires API_LOOPBACK_PORT=13001'

nginx='/www/server/nginx/sbin/nginx'
vhost_directory='/www/server/panel/vhost/nginx'
api_vhost="$vhost_directory/api.unfinished-era.com.conf"
wordpress_vhost="$vhost_directory/www.unfinished-era.com.conf"
well_known_include="$vhost_directory/well-known/api.unfinished-era.com.conf"
acme_webroot='/opt/chi-shen-me/acme-webroot'
certificate='/www/server/panel/vhost/cert/api.unfinished-era.com/fullchain.pem'
key_file_path='/www/server/panel/vhost/cert/api.unfinished-era.com/privkey.pem'
backup_parent='/www/backup/manual'
lock_directory='/run/lock/chi-shen-me'
lock_file="$lock_directory/public-nginx.lock"

assert_root_regular_file() {
  local path="$1"
  local mode
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(realpath -e -- "$path")" == "$path" ]] || return 1
  [[ "$(stat -c '%u:%g' "$path")" == '0:0' ]] || return 1
  mode="$(stat -c '%a' "$path")"
  (( (8#$mode & 0022) == 0 )) || return 1
}

assert_safe_root_directory() {
  local path="$1"
  local mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  [[ "$(realpath -e -- "$path")" == "$path" ]] || return 1
  [[ "$(stat -c '%u:%g' "$path")" == '0:0' ]] || return 1
  mode="$(stat -c '%a' "$path")"
  (( (8#$mode & 0022) == 0 )) || return 1
}

if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  assert_safe_root_directory "$lock_directory" || die 'Nginx activation lock directory is unsafe'
else
  install -d -o root -g root -m 700 "$lock_directory"
fi
if [[ -e "$lock_file" || -L "$lock_file" ]]; then
  assert_root_regular_file "$lock_file" || die 'Nginx activation lock is unsafe'
else
  ( set -o noclobber; : >"$lock_file" ) 2>/dev/null || true
fi
[[ -f "$lock_file" && ! -L "$lock_file" ]] || die 'Nginx activation lock could not be created safely'
chown root:root "$lock_file"
chmod 600 "$lock_file"
exec 9<>"$lock_file"
flock -n 9 || die 'another Nginx vhost mutation is already running' 9

[[ -x "$nginx" && -f "$nginx" ]] || die 'BaoTa Nginx executable is unavailable'
assert_safe_root_directory "$vhost_directory" || die 'BaoTa vhost directory is unsafe'
assert_safe_root_directory "$acme_webroot" || die 'API ACME webroot is unavailable or unsafe'
assert_root_regular_file "$wordpress_vhost" || die 'WordPress vhost is unavailable or unsafe'
assert_root_regular_file "$well_known_include" || die 'API ACME include is unavailable or unsafe'
[[ "$(sha256sum "$well_known_include" | awk '{print $1}')" == "$(sha256sum "$well_known_template" | awk '{print $1}')" ]] ||
  die 'installed API ACME include differs from the reviewed release template'
assert_root_regular_file "$certificate" || die 'API certificate is unavailable or unsafe'
assert_root_regular_file "$key_file_path" || die 'API private key is unavailable or unsafe'
tls_material_mode="$(stat -c '%a' "$key_file_path")"
(( (8#$tls_material_mode & 0077) == 0 )) || die 'API private key must not be accessible by group or other users'

openssl x509 -in "$certificate" -noout -checkend 604800 >/dev/null ||
  die 'API certificate is invalid or expires within seven days'
certificate_san="$(openssl x509 -in "$certificate" -noout -ext subjectAltName)"
grep -Eq 'DNS:[[:space:]]*api\.unfinished-era\.com([,[:space:]]|$)' <<<"$certificate_san" ||
  die 'API certificate does not cover api.unfinished-era.com'
cert_public_sha="$(openssl x509 -in "$certificate" -pubkey -noout |
  openssl pkey -pubin -outform DER 2>/dev/null |
  sha256sum | awk '{print $1}')"
tls_public_sha="$(openssl pkey -in "$key_file_path" -pubout -outform DER 2>/dev/null |
  sha256sum | awk '{print $1}')"
[[ -n "$cert_public_sha" && "$cert_public_sha" == "$tls_public_sha" ]] ||
  die 'API certificate and private key do not match'

"$nginx" -t >/dev/null
wordpress_sha_before="$(sha256sum "$wordpress_vhost" | awk '{print $1}')"

if [[ -e "$backup_parent" || -L "$backup_parent" ]]; then
  assert_safe_root_directory "$backup_parent" || die 'manual backup directory is unsafe'
else
  install -d -o root -g root -m 700 "$backup_parent"
fi
activation_id="chi-shen-me-api-vhost-$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_directory="$backup_parent/$activation_id"
install -d -o root -g root -m 700 "$backup_directory"
printf '%s  %s\n' "$wordpress_sha_before" "$wordpress_vhost" >"$backup_directory/wordpress-vhost.sha256"
chmod 600 "$backup_directory/wordpress-vhost.sha256"

previous_api_vhost_present='false'
previous_api_vhost_sha=''
if [[ -e "$api_vhost" || -L "$api_vhost" ]]; then
  assert_root_regular_file "$api_vhost" || die 'existing API vhost is unsafe'
  previous_api_vhost_present='true'
  previous_api_vhost_sha="$(sha256sum "$api_vhost" | awk '{print $1}')"
  cp -a -- "$api_vhost" "$backup_directory/api-vhost-before.conf"
  printf '%s  %s\n' "$previous_api_vhost_sha" "$api_vhost" >"$backup_directory/api-vhost-before.sha256"
else
  printf 'ABSENT\n' >"$backup_directory/api-vhost-before.absent"
fi
chmod 600 "$backup_directory"/*

candidate="$(mktemp "$vhost_directory/.api.unfinished-era.com.conf.candidate.XXXXXX")"
isolated_config="$(mktemp /tmp/chi-shen-me-api-nginx-test.XXXXXX.conf)"
http_headers="$(mktemp /tmp/chi-shen-me-api-http-headers.XXXXXX)"
smoke_body="$(mktemp /tmp/chi-shen-me-api-smoke.XXXXXX)"
restore_candidate=''
installation_started='false'
installed_sha=''

cleanup_temporary_files() {
  rm -f -- "$candidate" "$isolated_config" "$http_headers" "$smoke_body"
  if [[ -n "$restore_candidate" ]]; then
    rm -f -- "$restore_candidate"
  fi
}

wordpress_unchanged() {
  [[ -f "$wordpress_vhost" && ! -L "$wordpress_vhost" ]] || return 1
  [[ "$(sha256sum "$wordpress_vhost" | awk '{print $1}')" == "$wordpress_sha_before" ]]
}

rollback_api_vhost() {
  local rollback_ok='true'
  local live_sha=''

  if [[ "$installation_started" == 'true' ]]; then
    if [[ -f "$api_vhost" && ! -L "$api_vhost" ]]; then
      live_sha="$(sha256sum "$api_vhost" | awk '{print $1}')"
    fi
    if [[ "$live_sha" == "$installed_sha" ]]; then
      if [[ "$previous_api_vhost_present" == 'true' ]]; then
        restore_candidate="$(mktemp "$vhost_directory/.api.unfinished-era.com.conf.restore.XXXXXX")"
        cp -a -- "$backup_directory/api-vhost-before.conf" "$restore_candidate" || rollback_ok='false'
        if [[ "$rollback_ok" == 'true' ]]; then
          mv -Tf -- "$restore_candidate" "$api_vhost" || rollback_ok='false'
          restore_candidate=''
        fi
      else
        rm -f -- "$api_vhost" || rollback_ok='false'
      fi
    elif [[ "$previous_api_vhost_present" == 'true' && "$live_sha" == "$previous_api_vhost_sha" ]]; then
      : # The atomic installation did not occur; the original target is intact.
    elif [[ "$previous_api_vhost_present" == 'false' && ! -e "$api_vhost" && ! -L "$api_vhost" ]]; then
      : # The atomic installation did not occur; the original absence is intact.
    else
      rollback_ok='false'
    fi
  fi

  if [[ "$rollback_ok" == 'true' ]]; then
    if [[ "$previous_api_vhost_present" == 'true' ]]; then
      [[ -f "$api_vhost" && ! -L "$api_vhost" ]] || rollback_ok='false'
      if [[ "$rollback_ok" == 'true' && "$(sha256sum "$api_vhost" | awk '{print $1}')" != "$previous_api_vhost_sha" ]]; then
        rollback_ok='false'
      fi
    elif [[ -e "$api_vhost" || -L "$api_vhost" ]]; then
      rollback_ok='false'
    fi
  fi

  if [[ "$rollback_ok" == 'true' ]]; then
    "$nginx" -t >/dev/null || rollback_ok='false'
  fi
  if [[ "$rollback_ok" == 'true' ]]; then
    "$nginx" -s reload >/dev/null || rollback_ok='false'
  fi
  wordpress_unchanged || rollback_ok='false'

  [[ "$rollback_ok" == 'true' ]]
}

on_exit() {
  local status="$?"
  trap - EXIT INT TERM HUP
  set +e
  if [[ "$status" -ne 0 && "$installation_started" == 'true' ]]; then
    if rollback_api_vhost; then
      printf 'NGINX_API_SUBDOMAIN_ROLLBACK=OK\n' >&2
    else
      printf 'NGINX_API_SUBDOMAIN_ROLLBACK=FAILED\n' >&2
      printf 'RECOVERY_REQUIRED=true\n' >&2
    fi
  fi
  cleanup_temporary_files
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

placeholder_count="$(grep -o '__API_LOOPBACK_PORT__' "$template" | awk 'END {print NR}')"
[[ "$placeholder_count" == '4' ]] || die 'API vhost template must contain exactly four loopback port placeholders'
sed 's/__API_LOOPBACK_PORT__/13001/g' "$template" >"$candidate"
chown root:root "$candidate"
chmod 600 "$candidate"
! grep -q '__API_LOOPBACK_PORT__' "$candidate" || die 'API vhost candidate still contains a loopback placeholder'
grep -Fq 'server_name api.unfinished-era.com;' "$candidate" || die 'API vhost candidate has the wrong server name'
! grep -Eq 'server_name[[:space:]]+(www\.)?unfinished-era\.com([[:space:];]|$)' "$candidate" ||
  die 'API vhost candidate claims the WordPress hostname'
grep -Fq 'proxy_pass http://127.0.0.1:13001;' "$candidate" || die 'API vhost candidate has the wrong upstream'
grep -Fq 'location ^~ /v1/' "$candidate" || die 'API vhost candidate is missing the v1 boundary'
grep -Fq "return 404 '{\"code\":\"NOT_FOUND\"}';" "$candidate" || die 'API vhost candidate is missing the deny-by-default route'

printf 'worker_processes 1;\nevents { worker_connections 16; }\nhttp {\ninclude %s;\n}\n' \
  "$candidate" >"$isolated_config"
"$nginx" -t -q -p /www/server/nginx/ -c "$isolated_config"
wordpress_unchanged || die 'WordPress vhost changed during candidate validation' 20

installed_sha="$(sha256sum "$candidate" | awk '{print $1}')"
installation_started='true'
mv -Tf -- "$candidate" "$api_vhost"
[[ -f "$api_vhost" && ! -L "$api_vhost" ]] || die 'API vhost atomic installation failed' 21
[[ "$(sha256sum "$api_vhost" | awk '{print $1}')" == "$installed_sha" ]] || die 'installed API vhost hash mismatch' 21
wordpress_unchanged || die 'WordPress vhost changed during API vhost installation' 22

"$nginx" -t >/dev/null || die 'BaoTa Nginx rejected the installed API vhost' 23
wordpress_unchanged || die 'WordPress vhost changed during full Nginx validation' 24
"$nginx" -s reload >/dev/null || die 'BaoTa Nginx reload failed' 25
sleep 1
wordpress_unchanged || die 'WordPress vhost changed during Nginx reload' 26

http_status="$(curl --silent --show-error --max-time 8 --noproxy '*' \
  --resolve api.unfinished-era.com:80:127.0.0.1 \
  --dump-header "$http_headers" --output /dev/null --write-out '%{http_code}' \
  http://api.unfinished-era.com/health/ready)"
[[ "$http_status" == '301' ]] || die 'API HTTP smoke did not return the HTTPS redirect' 27
grep -Eiq '^location:[[:space:]]*https://api\.unfinished-era\.com/health/ready[[:space:]]*$' "$http_headers" ||
  die 'API HTTP smoke returned an unexpected redirect target' 27

https_status="$(curl --silent --show-error --max-time 8 --noproxy '*' \
  --resolve api.unfinished-era.com:443:127.0.0.1 \
  --output "$smoke_body" --write-out '%{http_code}' \
  https://api.unfinished-era.com/health/ready)"
[[ "$https_status" == '200' ]] || die 'API HTTPS readiness smoke failed' 28
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' "$smoke_body" ||
  die 'API HTTPS readiness body is invalid' 28

config_status="$(curl --silent --show-error --max-time 8 --noproxy '*' \
  --resolve api.unfinished-era.com:443:127.0.0.1 \
  --output "$smoke_body" --write-out '%{http_code}' \
  https://api.unfinished-era.com/v1/config)"
[[ "$config_status" == '200' ]] || die 'API HTTPS config smoke failed' 29
grep -Eq '"minimumSupportedVersion"[[:space:]]*:' "$smoke_body" ||
  die 'API HTTPS config body is invalid' 29

admin_status="$(curl --silent --show-error --max-time 8 --noproxy '*' \
  --resolve api.unfinished-era.com:443:127.0.0.1 \
  --output "$smoke_body" --write-out '%{http_code}' \
  https://api.unfinished-era.com/admin/v1)"
[[ "$admin_status" == '404' ]] || die 'admin endpoint crossed the public API vhost boundary' 30
grep -Eq '"code"[[:space:]]*:[[:space:]]*"NOT_FOUND"' "$smoke_body" ||
  die 'public admin rejection body is invalid' 30

wordpress_unchanged || die 'WordPress vhost changed during API smoke tests' 31
[[ "$(sha256sum "$api_vhost" | awk '{print $1}')" == "$installed_sha" ]] ||
  die 'API vhost changed during smoke tests' 32
"$nginx" -t >/dev/null || die 'final BaoTa Nginx validation failed' 33
wordpress_unchanged || die 'WordPress vhost changed during final Nginx validation' 34
[[ "$(sha256sum "$api_vhost" | awk '{print $1}')" == "$installed_sha" ]] ||
  die 'API vhost changed during final Nginx validation' 34

cleanup_temporary_files
trap - EXIT INT TERM HUP
printf 'NGINX_API_SUBDOMAIN_ACTIVATION=OK\n'
printf 'API_VHOST=%s\n' "$api_vhost"
printf 'API_VHOST_BACKUP=%s\n' "$backup_directory"
printf 'WORDPRESS_VHOST_UNCHANGED=true\n'
printf 'ADMIN_ENDPOINT_PUBLIC=false\n'
