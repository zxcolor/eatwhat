#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
die() { printf '%s\n' "$1" >&2; exit "${2:-2}"; }
[[ "$-" != *x* ]] || die 'shell tracing must be disabled before secret operations'
[[ "$(id -u)" -eq 0 ]] || die 'run as root'
mode=''
key_file=''
if [[ "$#" -eq 3 && "$1" == '--enable' && "$2" == '--key-file' ]]; then
  mode='enable'; key_file="$3"
elif [[ "$#" -eq 1 && "$1" == '--disable' ]]; then
  mode='disable'
else
  die 'usage: update-mimo-secrets.sh --enable --key-file FILE | --disable'
fi

script_path="$(realpath -e -- "${BASH_SOURCE[0]}")"
script_dir="$(dirname -- "$script_path")"
bundle_root="$(dirname -- "$script_dir")"
candidate_release="$(dirname -- "$bundle_root")"
candidate_id="${candidate_release##*/}"
[[ "$candidate_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die 'invalid candidate release ID'
[[ "$bundle_root" == "/opt/chi-shen-me/releases/$candidate_id/deploy" ]] || die 'unexpected deployment directory'
[[ ! -L "${BASH_SOURCE[0]}" && "$script_path" == "$script_dir/update-mimo-secrets.sh" ]] || die 'updater must be a regular candidate script'
[[ "$(realpath -e -- "$candidate_release")" == "$candidate_release" && ! -L "$candidate_release" ]] || die 'candidate release path is unsafe'
[[ "$(stat -c '%a:%u:%g' "$candidate_release")" == '700:0:0' ]] || die 'candidate release must be root-owned mode 0700'
current='/opt/chi-shen-me/current'
[[ -L "$current" && "$(stat -c '%u:%g' "$current")" == '0:0' ]] || die 'current release is unavailable'
[[ "$(realpath -e -- "$current")" != "$candidate_release" ]] || die 'MiMo settings must be prepared in an inactive candidate'

secrets='/opt/chi-shen-me/shared/secrets'
api_env="$secrets/api.env"
deployment_env="$bundle_root/deployment.env"
preflight="$script_dir/preflight-deployment.sh"
[[ -d "$secrets" && ! -L "$secrets" && "$(realpath -e -- "$secrets")" == "$secrets" ]] || die 'shared secrets directory is unsafe'
[[ "$(stat -c '%a:%u:%g' "$secrets")" == '700:0:0' ]] || die 'shared secrets directory must be root-owned mode 0700'
for file in "$api_env" "$deployment_env"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%a:%u:%g' "$file")" == '600:0:0' ]] || die 'configuration must be a root-owned regular file with mode 0600'
done
[[ -x "$preflight" && ! -L "$preflight" ]] || die 'candidate preflight is unavailable'
[[ -f "$bundle_root/SHA256SUMS" && ! -L "$bundle_root/SHA256SUMS" ]] || die 'candidate manifest is unavailable'
(cd "$bundle_root"; sha256sum --check --strict SHA256SUMS >/dev/null)

lock_dir='/run/lock/chi-shen-me'
lock="$lock_dir/mutation.lock"
if [[ ! -e "$lock_dir" && ! -L "$lock_dir" ]]; then install -d -m 700 "$lock_dir"; fi
[[ -d "$lock_dir" && ! -L "$lock_dir" && "$(realpath -e -- "$lock_dir")" == "$lock_dir" ]] || die 'deployment lock directory is unsafe'
[[ "$(stat -c '%a:%u:%g' "$lock_dir")" == '700:0:0' ]] || die 'deployment lock directory must be root-owned mode 0700'
if [[ ! -e "$lock" && ! -L "$lock" ]]; then
  if ! (set -o noclobber; : >"$lock") 2>/dev/null; then die 'deployment lock creation raced another operation'; fi
fi
[[ -f "$lock" && ! -L "$lock" && "$(stat -c '%a:%u:%g' "$lock")" == '600:0:0' ]] || die 'deployment mutation lock is unsafe'
exec 9<>"$lock"
flock -n 9 || die 'another deployment mutation, backup or secret update is running'
# Recheck after acquiring the shared mutation lock: another activation may have
# completed while the immutable candidate and its manifest were inspected.
[[ "$(realpath -e -- "$current")" != "$candidate_release" ]] || die 'candidate became active before the settings update'

mimo_value=''
if [[ "$mode" == 'enable' ]]; then
  [[ -f "$key_file" && ! -L "$key_file" && "$(stat -c '%a:%u:%g' "$key_file")" == '600:0:0' ]] || die 'key input must be a root-owned regular file with mode 0600'
  [[ "$(wc -l <"$key_file")" -eq 1 ]] || die 'key input must contain exactly one line'
  mimo_value="$(<"$key_file")"
  [[ "${#mimo_value}" -ge 8 && "${#mimo_value}" -le 512 && "$mimo_value" =~ ^[A-Za-z0-9._-]+$ ]] || die 'invalid MiMo key shape'
fi

api_stage=''; api_backup=''; deployment_stage=''; deployment_backup=''
api_changed='false'; deployment_changed='false'; complete='false'
cleanup() {
  local status="$?" rollback_failed='false'
  unset mimo_value
  if [[ "$complete" != 'true' ]]; then
    if [[ "$api_changed" == 'true' ]]; then
      if mv -f -- "$api_backup" "$api_env"; then api_backup=''; else rollback_failed='true'; fi
    fi
    if [[ "$deployment_changed" == 'true' ]]; then
      if mv -f -- "$deployment_backup" "$deployment_env"; then deployment_backup=''; else rollback_failed='true'; fi
    fi
  fi
  for temporary in "$api_stage" "$deployment_stage"; do if [[ -n "$temporary" ]]; then rm -f -- "$temporary"; fi; done
  if [[ "$rollback_failed" == 'true' ]]; then
    printf 'MIMO_CONFIGURATION_ROLLBACK=FAILED\nRECOVERY_REQUIRED=true\n' >&2
    # Keep protected recovery copies if either restoration failed.
    return 4
  fi
  for temporary in "$api_backup" "$deployment_backup"; do if [[ -n "$temporary" ]]; then rm -f -- "$temporary"; fi; done
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
api_stage="$(mktemp "$secrets/.api.env.mimo.XXXXXX")"
api_backup="$(mktemp "$secrets/.api.env.mimo-rollback.XXXXXX")"
deployment_stage="$(mktemp "$bundle_root/.deployment.env.mimo.XXXXXX")"
deployment_backup="$(mktemp "$bundle_root/.deployment.env.mimo-rollback.XXXXXX")"
cp --preserve=mode,ownership,timestamps -- "$api_env" "$api_backup"
cp --preserve=mode,ownership,timestamps -- "$deployment_env" "$deployment_backup"
if [[ "$mode" == 'enable' ]]; then
  awk '!/^MIMO_API_KEY=/' "$api_env" >"$api_stage"
  printf 'MIMO_API_KEY=%s\n' "$mimo_value" >>"$api_stage"
else
  # Preserve an unused key for a reversible off switch; the disabled provider
  # does not retain it in configuration or send any upstream requests.
  cp -- "$api_env" "$api_stage"
fi
awk '!/^MIMO_ENABLED=/' "$deployment_env" >"$deployment_stage"
if [[ "$mode" == 'enable' ]]; then printf 'MIMO_ENABLED=true\n' >>"$deployment_stage";
else printf 'MIMO_ENABLED=false\n' >>"$deployment_stage"; fi
chown root:root "$api_stage" "$deployment_stage"
chmod 600 "$api_stage" "$deployment_stage"
mv -f -- "$api_stage" "$api_env"; api_stage=''; api_changed='true'
mv -f -- "$deployment_stage" "$deployment_env"; deployment_stage=''; deployment_changed='true'
if ! "$preflight" >/dev/null; then die 'updated MiMo configuration failed preflight; restoring prior files' 3; fi
complete='true'
printf 'MIMO_CONFIGURATION_UPDATED=%s\nAPI_RECREATE_REQUIRED=true\n' "$mode"
