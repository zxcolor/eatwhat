#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

usage() {
  printf '%s\n' \
    'usage:' \
    '  update-amap-secrets.sh --enable --key-file FILE --signature-file FILE --ip-whitelist-confirmed' \
    '  update-amap-secrets.sh --disable' >&2
  exit 2
}

if [[ "$(id -u)" -ne 0 ]]; then
  die 'run as root'
fi

mode=''
web_value_file=''
signature_file=''
whitelist_confirmed='false'

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --enable|--disable)
      [[ -z "$mode" ]] || usage
      mode="$1"
      shift
      ;;
    --key-file)
      [[ "$#" -ge 2 && -z "$web_value_file" ]] || usage
      web_value_file="$2"
      shift 2
      ;;
    --signature-file)
      [[ "$#" -ge 2 && -z "$signature_file" ]] || usage
      signature_file="$2"
      shift 2
      ;;
    --ip-whitelist-confirmed)
      whitelist_confirmed='true'
      shift
      ;;
    *) usage ;;
  esac
done

[[ -n "$mode" ]] || usage
if [[ "$mode" == '--enable' ]]; then
  [[ -n "$web_value_file" && -n "$signature_file" && "$whitelist_confirmed" == 'true' ]] || usage
else
  [[ -z "$web_value_file" && -z "$signature_file" && "$whitelist_confirmed" == 'false' ]] || usage
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"
shared_state_directory='/opt/chi-shen-me/shared'
api_env="$shared_state_directory/secrets/api.env"
preflight="$script_dir/preflight-deployment.sh"

case "$bundle_root" in
  /opt/chi-shen-me/releases/*/deploy) ;;
  *) die "unexpected deployment directory: $bundle_root" ;;
esac

assert_root_secret_input() {
  local path="$1"
  local actual
  [[ -f "$path" && ! -L "$path" ]] || die "credential input is missing or is a link: $path"
  actual="$(stat -c '%a:%u:%g' "$path")"
  [[ "$actual" == '600:0:0' ]] || die "credential input must be root:root mode 0600: $path"
  [[ "$(wc -l <"$path")" -eq 1 ]] || die "credential input must contain exactly one line: $path"
}

[[ -x "$preflight" && ! -L "$preflight" ]] || die 'deployment preflight is unavailable'
[[ -f "$deployment_env" && ! -L "$deployment_env" ]] || die 'deployment.env is unavailable'
[[ -f "$api_env" && ! -L "$api_env" ]] || die 'api.env is unavailable'
[[ "$(stat -c '%a:%u:%g' "$deployment_env")" == '600:0:0' ]] || die 'deployment.env must be root:root mode 0600'
[[ "$(stat -c '%a:%u:%g' "$api_env")" == '600:0:0' ]] || die 'api.env must be root:root mode 0600'

amap_web_value=''
amap_signing_value=''
if [[ "$mode" == '--enable' ]]; then
  assert_root_secret_input "$web_value_file"
  assert_root_secret_input "$signature_file"
  amap_web_value="$(<"$web_value_file")"
  amap_signing_value="$(<"$signature_file")"
  [[ "$amap_web_value" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || die 'invalid AMap Web Service key shape'
  [[ "$amap_signing_value" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || die 'invalid AMap signing secret shape'
fi

command -v flock >/dev/null
command -v install >/dev/null
command -v realpath >/dev/null
lock_directory='/run/lock/chi-shen-me'
mutation_lock="$lock_directory/mutation.lock"
amap_lock="$lock_directory/amap-secrets.lock"

if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] || die 'deployment lock directory is unsafe'
else
  install -d -m 700 "$lock_directory"
fi
[[ "$(realpath -e -- "$lock_directory")" == "$lock_directory" ]] || die 'deployment lock directory resolves unexpectedly'
[[ "$(stat -c '%a:%u:%g' "$lock_directory")" == '700:0:0' ]] ||
  die 'deployment lock directory must be root:root mode 0700'

for lock_path in "$mutation_lock" "$amap_lock"; do
  if [[ -e "$lock_path" || -L "$lock_path" ]]; then
    [[ -f "$lock_path" && ! -L "$lock_path" ]] || die "deployment lock is unsafe: $lock_path"
  else
    ( set -o noclobber; : >"$lock_path" ) 2>/dev/null || true
  fi
  [[ -f "$lock_path" && ! -L "$lock_path" ]] || die "deployment lock could not be created safely: $lock_path"
  [[ "$(stat -c '%a:%u:%g' "$lock_path")" == '600:0:0' ]] ||
    die "deployment lock must be root:root mode 0600: $lock_path"
done
exec 8<>"$mutation_lock"
flock -n 8 || die 'another deployment mutation, backup or AMap update is running'
exec 9<>"$amap_lock"
flock -n 9 || die 'another AMap secret update is running'

api_candidate="$(mktemp "$shared_state_directory/secrets/.api.env.amap.XXXXXX")"
api_rollback="$(mktemp "$shared_state_directory/secrets/.api.env.rollback.XXXXXX")"
deployment_candidate="$(mktemp "$bundle_root/.deployment.env.amap.XXXXXX")"
deployment_rollback="$(mktemp "$bundle_root/.deployment.env.rollback.XXXXXX")"
api_replaced='false'
deployment_replaced='false'
completed='false'

cleanup() {
  local status="$?"
  unset amap_web_value amap_signing_value
  if [[ "$completed" != 'true' ]]; then
    if [[ "$api_replaced" == 'true' && -n "${api_rollback:-}" && -f "$api_rollback" ]]; then
      mv -f -- "$api_rollback" "$api_env"
      api_rollback=''
    fi
    if [[ "$deployment_replaced" == 'true' && -n "${deployment_rollback:-}" && -f "$deployment_rollback" ]]; then
      mv -f -- "$deployment_rollback" "$deployment_env"
      deployment_rollback=''
    fi
  fi
  rm -f -- \
    "${api_candidate:-}" "${api_rollback:-}" \
    "${deployment_candidate:-}" "${deployment_rollback:-}"
  return "$status"
}
trap cleanup EXIT

cp --preserve=mode,ownership,timestamps -- "$api_env" "$api_rollback"
cp --preserve=mode,ownership,timestamps -- "$deployment_env" "$deployment_rollback"

awk '
  !/^AMAP_WEB_SERVICE_KEY=/ &&
  !/^AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=/ &&
  !/^AMAP_IP_WHITELIST_CONFIGURED=/
' "$api_env" >"$api_candidate"
if [[ "$mode" == '--enable' ]]; then
  {
    printf 'AMAP_WEB_SERVICE_KEY=%s\n' "$amap_web_value"
    printf 'AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=%s\n' "$amap_signing_value"
    printf 'AMAP_IP_WHITELIST_CONFIGURED=true\n'
  } >>"$api_candidate"
fi
chown root:root "$api_candidate"
chmod 600 "$api_candidate"

awk '!/^AMAP_ENABLED=/' "$deployment_env" >"$deployment_candidate"
if [[ "$mode" == '--enable' ]]; then
  printf 'AMAP_ENABLED=true\n' >>"$deployment_candidate"
else
  printf 'AMAP_ENABLED=false\n' >>"$deployment_candidate"
fi
chown root:root "$deployment_candidate"
chmod 600 "$deployment_candidate"

mv -f -- "$api_candidate" "$api_env"
api_candidate=''
api_replaced='true'
mv -f -- "$deployment_candidate" "$deployment_env"
deployment_candidate=''
deployment_replaced='true'

if ! "$preflight" >/dev/null; then
  mv -f -- "$api_rollback" "$api_env"
  api_rollback=''
  mv -f -- "$deployment_rollback" "$deployment_env"
  deployment_rollback=''
  api_replaced='false'
  deployment_replaced='false'
  die 'updated AMap configuration failed preflight and was rolled back' 3
fi

completed='true'
rm -f -- "$api_rollback" "$deployment_rollback"
api_rollback=''
deployment_rollback=''

if [[ "$mode" == '--enable' ]]; then
  printf 'AMAP_CONFIGURATION_UPDATED=enabled\n'
else
  printf 'AMAP_CONFIGURATION_UPDATED=disabled\n'
fi
printf 'API_RECREATE_REQUIRED=true\n'
