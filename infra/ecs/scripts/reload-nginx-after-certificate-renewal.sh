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
[[ "$#" -eq 0 ]] || die 'reload-nginx-after-certificate-renewal.sh does not accept arguments'

for required_command in awk chmod chown curl flock grep id install openssl realpath sha256sum sleep stat timeout; do
  command -v "$required_command" >/dev/null || die "required command is unavailable: $required_command"
done

nginx='/www/server/nginx/sbin/nginx'
vhost_directory='/www/server/panel/vhost/nginx'
api_vhost="$vhost_directory/api.unfinished-era.com.conf"
wordpress_vhost="$vhost_directory/www.unfinished-era.com.conf"
certificate='/www/server/panel/vhost/cert/api.unfinished-era.com/fullchain.pem'
key_file_path='/www/server/panel/vhost/cert/api.unfinished-era.com/privkey.pem'
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

server_name_tokens_from_file() {
  awk '
    {
      line = $0
      sub(/[[:space:]]*#.*/, "", line)
      if (collecting) {
        directive = directive " " line
      } else if (match(line, /server_name[[:space:]]+/)) {
        directive = substr(line, RSTART)
        collecting = 1
      }
      if (collecting && index(directive, ";") > 0) {
        value = directive
        sub(/^[[:space:]]*server_name[[:space:]]+/, "", value)
        sub(/;.*/, "", value)
        count = split(value, tokens, /[[:space:]]+/)
        for (i = 1; i <= count; i += 1) {
          print tokens[i]
        }
        directive = ""
        collecting = 0
      }
    }
  ' "$1"
}

if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  assert_safe_root_directory "$lock_directory" || die 'public Nginx lock directory is unsafe'
else
  install -d -o root -g root -m 700 "$lock_directory"
fi
if [[ -e "$lock_file" || -L "$lock_file" ]]; then
  assert_root_regular_file "$lock_file" || die 'public Nginx lock is unsafe'
else
  ( set -o noclobber; : >"$lock_file" ) 2>/dev/null || true
fi
[[ -f "$lock_file" && ! -L "$lock_file" ]] || die 'public Nginx lock could not be created safely'
chown root:root "$lock_file"
chmod 600 "$lock_file"
exec 9<>"$lock_file"
flock -n 9 || die 'another public Nginx mutation is already running' 9

[[ -x "$nginx" && -f "$nginx" ]] || die 'BaoTa Nginx executable is unavailable'
assert_safe_root_directory "$vhost_directory" || die 'BaoTa vhost directory is unsafe'
assert_root_regular_file "$api_vhost" || die 'active API vhost is unavailable or unsafe'
assert_root_regular_file "$wordpress_vhost" || die 'WordPress vhost is unavailable or unsafe'
active_server_names="$(server_name_tokens_from_file "$api_vhost")" || die 'could not parse active API server names'
grep -Fxq 'api.unfinished-era.com' <<<"$active_server_names" || die 'active API vhost has the wrong server name'
grep -Fq 'proxy_pass http://127.0.0.1:13001;' "$api_vhost" || die 'active API vhost has the wrong upstream'
! grep -Exq '(www\.unfinished-era\.com|unfinished-era\.com)' <<<"$active_server_names" ||
  die 'active API vhost claims the WordPress hostname'
assert_root_regular_file "$certificate" || die 'renewed API certificate is unavailable or unsafe'
assert_root_regular_file "$key_file_path" || die 'renewed API private key is unavailable or unsafe'
tls_material_mode="$(stat -c '%a' "$key_file_path")"
(( (8#$tls_material_mode & 0077) == 0 )) || die 'API private key must not be accessible by group or other users'

openssl x509 -in "$certificate" -noout -checkend 604800 >/dev/null ||
  die 'renewed API certificate is invalid or expires within seven days'
certificate_san="$(openssl x509 -in "$certificate" -noout -ext subjectAltName)"
grep -Eq 'DNS:[[:space:]]*api\.unfinished-era\.com([,[:space:]]|$)' <<<"$certificate_san" ||
  die 'renewed certificate does not cover api.unfinished-era.com'
cert_public_sha="$(openssl x509 -in "$certificate" -pubkey -noout |
  openssl pkey -pubin -outform DER 2>/dev/null |
  sha256sum | awk '{print $1}')"
tls_public_sha="$(openssl pkey -in "$key_file_path" -pubout -outform DER 2>/dev/null |
  sha256sum | awk '{print $1}')"
[[ -n "$cert_public_sha" && "$cert_public_sha" == "$tls_public_sha" ]] ||
  die 'renewed API certificate and private key do not match'

api_vhost_sha_before="$(sha256sum "$api_vhost" | awk '{print $1}')"
wordpress_sha_before="$(sha256sum "$wordpress_vhost" | awk '{print $1}')"

served_certificate_matches_file() {
  local expected_sha
  local served_sha
  local attempt
  expected_sha="$(openssl x509 -in "$certificate" -outform DER | sha256sum | awk '{print $1}')"
  for attempt in {1..8}; do
    served_sha="$(
      timeout 3 openssl s_client -connect 127.0.0.1:443 -servername api.unfinished-era.com </dev/null 2>/dev/null |
        openssl x509 -outform DER 2>/dev/null |
        sha256sum | awk '{print $1}'
    )" || true
    if [[ -n "$expected_sha" && "$served_sha" == "$expected_sha" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

"$nginx" -t >/dev/null
"$nginx" -s reload >/dev/null
sleep 1
"$nginx" -t >/dev/null
served_certificate_matches_file || die 'BaoTa Nginx is not serving the renewed API certificate'

[[ "$(sha256sum "$api_vhost" | awk '{print $1}')" == "$api_vhost_sha_before" ]] ||
  die 'API vhost changed during certificate reload'
[[ "$(sha256sum "$wordpress_vhost" | awk '{print $1}')" == "$wordpress_sha_before" ]] ||
  die 'WordPress vhost changed during certificate reload'

https_status="$(curl --silent --show-error --max-time 8 --noproxy '*' \
  --resolve api.unfinished-era.com:443:127.0.0.1 \
  --output /dev/null --write-out '%{http_code}' \
  https://api.unfinished-era.com/health)"
[[ "$https_status" == '200' ]] || die 'renewed API certificate HTTPS smoke failed'

printf 'NGINX_CERTIFICATE_RELOAD=OK\n'
printf 'API_VHOST_UNCHANGED=true\n'
printf 'WORDPRESS_VHOST_UNCHANGED=true\n'
