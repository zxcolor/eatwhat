#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly FUSION_DRAIN_SECONDS=43200

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

usage() {
  printf '%s\n' \
    'usage:' \
    '  update-auth-secrets.sh --apply --config-file FILE' \
    '  update-auth-secrets.sh --disable' \
    '  update-auth-secrets.sh --finalize-drain' >&2
  exit 2
}

if [[ "$(id -u)" -ne 0 ]]; then
  die 'run as root'
fi

mode=''
config_file=''
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --apply|--disable|--finalize-drain)
      [[ -z "$mode" ]] || usage
      mode="$1"
      shift
      ;;
    --config-file)
      [[ "$#" -ge 2 && -z "$config_file" ]] || usage
      config_file="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$mode" ]] || usage
if [[ "$mode" == '--apply' ]]; then
  [[ -n "$config_file" ]] || usage
else
  [[ -z "$config_file" ]] || usage
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"
shared_state_directory='/opt/chi-shen-me/shared'
secrets_dir="$shared_state_directory/secrets"
api_env="$secrets_dir/api.env"
drain_state="$secrets_dir/auth-key-drain.env"
preflight="$script_dir/preflight-deployment.sh"

case "$bundle_root" in
  /opt/chi-shen-me/releases/*/deploy) ;;
  *) die "unexpected deployment directory: $bundle_root" ;;
esac

assert_root_file() {
  local path="$1"
  local expected_mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || die "required regular file is missing or is a link: $path"
  [[ "$(stat -c '%a:%u:%g' "$path")" == "$expected_mode:0:0" ]] ||
    die "file must be root:root mode 0$expected_mode: $path"
}

assert_exact_env_keys() {
  local path="$1"
  shift
  local -A expected=()
  local -A actual=()
  local env_name line

  for env_name in "$@"; do
    expected["$env_name"]=1
  done
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] || die "invalid environment line in $path"
    env_name="${line%%=*}"
    [[ -z "${actual[$env_name]+x}" ]] || die "duplicate environment key in $path: $env_name"
    actual["$env_name"]=1
  done <"$path"

  [[ "${#actual[@]}" -eq "${#expected[@]}" ]] || die "unexpected environment key count in $path"
  for env_name in "${!expected[@]}"; do
    [[ -n "${actual[$env_name]+x}" ]] || die "required environment key is missing from $path: $env_name"
  done
}

read_env_value() {
  local path="$1"
  local name="$2"
  local -a matches=()
  mapfile -t matches < <(grep -E "^${name}=" "$path" || true)
  [[ "${#matches[@]}" -eq 1 ]] || die "missing or duplicate setting in $path: $name"
  [[ -n "${matches[0]#*=}" ]] || die "empty setting in $path: $name"
  printf '%s' "${matches[0]#*=}"
}

assert_drain_state() {
  assert_root_file "$drain_state" 600
  local -a names=(
    AUTH_KEY_DRAIN_STARTED_AT_EPOCH
    AUTH_HASH_ACTIVE_VERSION
    AUTH_HASH_KEYS_JSON
    AUTH_IDENTITY_DEDUP_KEY_VERSION
  )
  if grep -q '^AUTH_OTP_PEPPER_ACTIVE_VERSION=' "$drain_state" ||
    grep -q '^AUTH_OTP_PEPPER_KEYS_JSON=' "$drain_state"; then
    names+=(AUTH_OTP_PEPPER_ACTIVE_VERSION AUTH_OTP_PEPPER_KEYS_JSON)
  fi
  assert_exact_env_keys "$drain_state" "${names[@]}"
  for name in "${names[@]}"; do
    read_env_value "$drain_state" "$name" >/dev/null
  done
}

[[ -x "$preflight" && ! -L "$preflight" ]] || die 'deployment preflight is unavailable'
assert_root_file "$deployment_env" 600
assert_root_file "$api_env" 600

if [[ "$mode" == '--apply' ]]; then
  assert_root_file "$config_file" 600
  if LC_ALL=C grep -q $'\r' "$config_file"; then
    die 'authentication input must use LF line endings'
  fi
fi

command -v docker >/dev/null
command -v flock >/dev/null
command -v install >/dev/null
command -v realpath >/dev/null

lock_directory='/run/lock/chi-shen-me'
mutation_lock="$lock_directory/mutation.lock"
auth_lock="$lock_directory/auth-secrets.lock"
if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] || die 'deployment lock directory is unsafe'
else
  install -d -m 700 "$lock_directory"
fi
[[ "$(realpath -e -- "$lock_directory")" == "$lock_directory" ]] || die 'deployment lock directory resolves unexpectedly'
[[ "$(stat -c '%a:%u:%g' "$lock_directory")" == '700:0:0' ]] ||
  die 'deployment lock directory must be root:root mode 0700'

for lock_path in "$mutation_lock" "$auth_lock"; do
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
flock -n 8 || die 'another deployment mutation, backup or secret update is running'
exec 9<>"$auth_lock"
flock -n 9 || die 'another authentication secret update is running'

# Refuse to mutate an already-invalid release. The second preflight below
# validates the candidate only after both canonical files have been replaced,
# so every failure exercises the rollback path.
"$preflight" >/dev/null

read_deployment_value() {
  read_env_value "$deployment_env" "$1"
}

current_accounts_enabled="$(read_deployment_value ACCOUNTS_ENABLED)"
current_phone_auth_enabled="$(read_deployment_value PHONE_AUTH_ENABLED)"
current_fusion_auth_enabled="$(read_deployment_value FUSION_AUTH_ENABLED)"
current_wechat_auth_enabled="$(read_deployment_value WECHAT_AUTH_ENABLED)"
current_ram_role="$(read_deployment_value ALIBABA_CLOUD_ECS_METADATA)"
api_image="$(read_deployment_value API_IMAGE)"

target_accounts_enabled='false'
target_phone_auth_enabled='false'
target_fusion_auth_enabled='false'
target_wechat_auth_enabled='false'
target_ram_role="$current_ram_role"

declare -a input_names=(
  ACCOUNTS_ENABLED PHONE_AUTH_ENABLED FUSION_AUTH_ENABLED WECHAT_AUTH_ENABLED
  ALIBABA_CLOUD_ECS_METADATA
)
if [[ "$mode" == '--apply' ]]; then
  target_accounts_enabled="$(read_env_value "$config_file" ACCOUNTS_ENABLED)"
  target_phone_auth_enabled="$(read_env_value "$config_file" PHONE_AUTH_ENABLED)"
  target_fusion_auth_enabled="$(read_env_value "$config_file" FUSION_AUTH_ENABLED)"
  target_wechat_auth_enabled="$(read_env_value "$config_file" WECHAT_AUTH_ENABLED)"
  target_ram_role="$(read_env_value "$config_file" ALIBABA_CLOUD_ECS_METADATA)"

  [[ "$target_accounts_enabled" == 'true' ]] || die '--apply requires ACCOUNTS_ENABLED=true; use --disable to close accounts'
  [[ "$target_wechat_auth_enabled" == 'true' ]] || die 'accounts require WeChat authentication'
  [[ "$target_phone_auth_enabled" == 'true' || "$target_phone_auth_enabled" == 'false' ]] ||
    die 'PHONE_AUTH_ENABLED must be true or false'
  [[ "$target_fusion_auth_enabled" == 'true' || "$target_fusion_auth_enabled" == 'false' ]] ||
    die 'FUSION_AUTH_ENABLED must be true or false'
  [[ "$target_phone_auth_enabled" == 'true' || "$target_fusion_auth_enabled" == 'true' ]] ||
    die 'accounts require SMS phone auth or FusionAuth'
  [[ "$target_ram_role" =~ ^[A-Za-z0-9._-]{1,64}$ && "$target_ram_role" != 'replace-with-ram-role-name' ]] ||
    die 'a real ECS RAM role name is required'

  input_names+=(
    AUTH_HASH_ACTIVE_VERSION AUTH_HASH_KEYS_JSON AUTH_IDENTITY_DEDUP_KEY_VERSION
    WECHAT_APP_ID WECHAT_APP_SECRET
  )
  if [[ "$target_phone_auth_enabled" == 'true' ]]; then
    input_names+=(
      AUTH_OTP_PEPPER_ACTIVE_VERSION AUTH_OTP_PEPPER_KEYS_JSON
      ALIYUN_SMS_SIGN_NAME ALIYUN_SMS_TEMPLATE_CODE
    )
  fi
  if [[ "$target_fusion_auth_enabled" == 'true' ]]; then
    input_names+=(
      ALIYUN_FUSION_SCHEME_CODE ALIYUN_FUSION_PACKAGE_NAME ALIYUN_FUSION_PACKAGE_SIGN
    )
  fi
  assert_exact_env_keys "$config_file" "${input_names[@]}"
  for input_name in "${input_names[@]}"; do
    read_env_value "$config_file" "$input_name" >/dev/null
  done
fi

run_active_fusion_flow_count() {
  (
    cd "$bundle_root"
    docker compose --env-file deployment.env exec -T postgres sh -eu -c \
      'export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM public.fusion_auth_flows WHERE consumed_at IS NULL AND expires_at > clock_timestamp();"'
  )
}

assert_drain_ready() {
  [[ "$current_fusion_auth_enabled" == 'false' ]] || die 'disable FusionAuth before finalizing a key removal'
  [[ -f "$drain_state" && ! -L "$drain_state" ]] || die 'no authenticated key-drain state exists'
  assert_drain_state

  local started_at now elapsed active_flows
  started_at="$(read_env_value "$drain_state" AUTH_KEY_DRAIN_STARTED_AT_EPOCH)"
  now="$(date -u +%s)"
  [[ "$started_at" =~ ^[0-9]{10,}$ && "$now" =~ ^[0-9]{10,}$ && "$started_at" -le "$now" ]] ||
    die 'invalid authentication key-drain timestamp'
  elapsed=$((now - started_at))
  [[ "$elapsed" -ge "$FUSION_DRAIN_SECONDS" ]] ||
    die 'authentication keys must drain for at least 12 hours before removal'
  active_flows="$(run_active_fusion_flow_count)"
  [[ "$active_flows" =~ ^[0-9]+$ ]] || die 'could not determine active FusionAuth flow count'
  [[ "$active_flows" -eq 0 ]] || die 'active FusionAuth flows still block key removal'
}

if [[ "$mode" == '--finalize-drain' ]]; then
  assert_drain_ready
  # Keep the root-only evidence until the next successful --apply. Otherwise a
  # phone-only deployment would compare the candidate with the live ring, see
  # a removal, and have no drain evidence left with which to authorize it.
  # The removal path rechecks both elapsed time and the live flow count, then
  # atomically deletes or advances this state after candidate preflight passes.
  printf 'AUTH_KEY_DRAIN_READY=true\n'
  printf 'AUTH_KEY_DRAIN_STATE_RETAINED=true\n'
  printf 'API_RECREATE_REQUIRED=false\n'
  exit 0
fi

api_candidate="$(mktemp "$secrets_dir/.api.env.auth.XXXXXX")"
api_rollback="$(mktemp "$secrets_dir/.api.env.rollback.XXXXXX")"
deployment_candidate="$(mktemp "$bundle_root/.deployment.env.auth.XXXXXX")"
deployment_rollback="$(mktemp "$bundle_root/.deployment.env.rollback.XXXXXX")"
drain_candidate=''
drain_rollback=''
drain_existed='false'
drain_replaced='false'
drain_removed='false'
api_replaced='false'
deployment_replaced='false'
completed='false'

cleanup() {
  local status="$?"
  if [[ "$completed" != 'true' ]]; then
    if [[ "$drain_removed" == 'true' && -n "${drain_rollback:-}" && -f "$drain_rollback" ]]; then
      mv -f -- "$drain_rollback" "$drain_state"
      drain_rollback=''
    elif [[ "$drain_replaced" == 'true' ]]; then
      if [[ "$drain_existed" == 'true' && -n "${drain_rollback:-}" && -f "$drain_rollback" ]]; then
        mv -f -- "$drain_rollback" "$drain_state"
        drain_rollback=''
      else
        rm -f -- "$drain_state"
      fi
    fi
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
    "${deployment_candidate:-}" "${deployment_rollback:-}" \
    "${drain_candidate:-}" "${drain_rollback:-}"
  return "$status"
}
trap cleanup EXIT

cp --preserve=mode,ownership,timestamps -- "$api_env" "$api_rollback"
cp --preserve=mode,ownership,timestamps -- "$deployment_env" "$deployment_rollback"
if [[ -e "$drain_state" || -L "$drain_state" ]]; then
  assert_drain_state
  drain_existed='true'
  drain_rollback="$(mktemp "$secrets_dir/.auth-key-drain.rollback.XXXXXX")"
  cp --preserve=mode,ownership,timestamps -- "$drain_state" "$drain_rollback"
fi

awk '
  !/^AUTH_HASH_ACTIVE_VERSION=/ &&
  !/^AUTH_HASH_KEYS_JSON=/ &&
  !/^AUTH_IDENTITY_DEDUP_KEY_VERSION=/ &&
  !/^AUTH_OTP_PEPPER_ACTIVE_VERSION=/ &&
  !/^AUTH_OTP_PEPPER_KEYS_JSON=/ &&
  !/^ALIYUN_SMS_SIGN_NAME=/ &&
  !/^ALIYUN_SMS_TEMPLATE_CODE=/ &&
  !/^ALIYUN_FUSION_SCHEME_CODE=/ &&
  !/^ALIYUN_FUSION_PACKAGE_NAME=/ &&
  !/^ALIYUN_FUSION_PACKAGE_SIGN=/ &&
  !/^WECHAT_APP_ID=/ &&
  !/^WECHAT_APP_SECRET=/
' "$api_env" >"$api_candidate"
if [[ "$mode" == '--apply' ]]; then
  awk '
    !/^ACCOUNTS_ENABLED=/ &&
    !/^PHONE_AUTH_ENABLED=/ &&
    !/^FUSION_AUTH_ENABLED=/ &&
    !/^WECHAT_AUTH_ENABLED=/ &&
    !/^ALIBABA_CLOUD_ECS_METADATA=/
  ' "$config_file" >>"$api_candidate"
fi
chown root:root "$api_candidate"
chmod 600 "$api_candidate"

awk '
  !/^ACCOUNTS_ENABLED=/ &&
  !/^PHONE_AUTH_ENABLED=/ &&
  !/^FUSION_AUTH_ENABLED=/ &&
  !/^WECHAT_AUTH_ENABLED=/ &&
  !/^ALIBABA_CLOUD_ECS_METADATA=/
' "$deployment_env" >"$deployment_candidate"
{
  printf 'ACCOUNTS_ENABLED=%s\n' "$target_accounts_enabled"
  printf 'PHONE_AUTH_ENABLED=%s\n' "$target_phone_auth_enabled"
  printf 'FUSION_AUTH_ENABLED=%s\n' "$target_fusion_auth_enabled"
  printf 'WECHAT_AUTH_ENABLED=%s\n' "$target_wechat_auth_enabled"
  printf 'ALIBABA_CLOUD_ECS_METADATA=%s\n' "$target_ram_role"
} >>"$deployment_candidate"
chown root:root "$deployment_candidate"
chmod 600 "$deployment_candidate"

baseline_env=''
if [[ "$drain_existed" == 'true' ]]; then
  baseline_env="$drain_state"
elif [[ "$current_accounts_enabled" == 'true' ]]; then
  baseline_env="$api_env"
fi

key_removal='false'
if [[ "$mode" == '--apply' && -n "$baseline_env" ]]; then
  comparison_status=0
  docker run --rm --network none --read-only --user 0:0 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --volume "$baseline_env:/run/auth-baseline.env:ro" \
    --volume "$api_candidate:/run/auth-candidate.env:ro" \
    --entrypoint node "$api_image" --input-type=module --eval '
      import { readFileSync } from "node:fs";
      const parse = (path) => {
        const result = Object.create(null);
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (line === "") continue;
          const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
          if (match === null || Object.hasOwn(result, match[1])) process.exit(12);
          result[match[1]] = match[2];
        }
        return result;
      };
      const ring = (env, name) => {
        if (!(name in env)) return new Map();
        const parsed = JSON.parse(env[name]);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) process.exit(12);
        return new Map(Object.entries(parsed));
      };
      const baseline = parse("/run/auth-baseline.env");
      const candidate = parse("/run/auth-candidate.env");
      if (
        baseline.AUTH_IDENTITY_DEDUP_KEY_VERSION !== undefined &&
        baseline.AUTH_IDENTITY_DEDUP_KEY_VERSION !== candidate.AUTH_IDENTITY_DEDUP_KEY_VERSION
      ) process.exit(11);
      for (const name of ["AUTH_HASH_KEYS_JSON", "AUTH_OTP_PEPPER_KEYS_JSON"]) {
        const before = ring(baseline, name);
        const after = ring(candidate, name);
        for (const [version, material] of before) {
          if (after.get(version) !== material) process.exit(10);
        }
      }
    ' || comparison_status=$?
  case "$comparison_status" in
    0) ;;
    10) key_removal='true' ;;
    11) die 'AUTH_IDENTITY_DEDUP_KEY_VERSION changes require a dedicated audited migration' ;;
    *) die 'could not compare current and candidate authentication key rings' ;;
  esac
fi

if [[ "$key_removal" == 'true' ]]; then
  assert_drain_ready
fi

drain_action='preserve'
drain_timestamp=''
if [[ "$target_accounts_enabled" == 'false' && "$current_accounts_enabled" == 'true' ]]; then
  drain_action='replace-current'
  drain_timestamp="$(date -u +%s)"
elif [[ "$target_fusion_auth_enabled" == 'false' && "$current_fusion_auth_enabled" == 'true' ]]; then
  drain_action='replace-current'
  drain_timestamp="$(date -u +%s)"
elif [[ "$target_fusion_auth_enabled" == 'true' ]]; then
  drain_action='delete'
elif [[ "$target_accounts_enabled" == 'true' && "$drain_existed" == 'true' ]]; then
  drain_action='replace-candidate'
  drain_timestamp="$(read_env_value "$drain_state" AUTH_KEY_DRAIN_STARTED_AT_EPOCH)"
fi

build_drain_candidate() {
  local source_env="$1"
  local started_at="$2"
  drain_candidate="$(mktemp "$secrets_dir/.auth-key-drain.candidate.XXXXXX")"
  {
    printf 'AUTH_KEY_DRAIN_STARTED_AT_EPOCH=%s\n' "$started_at"
    printf 'AUTH_HASH_ACTIVE_VERSION=%s\n' "$(read_env_value "$source_env" AUTH_HASH_ACTIVE_VERSION)"
    printf 'AUTH_HASH_KEYS_JSON=%s\n' "$(read_env_value "$source_env" AUTH_HASH_KEYS_JSON)"
    printf 'AUTH_IDENTITY_DEDUP_KEY_VERSION=%s\n' "$(read_env_value "$source_env" AUTH_IDENTITY_DEDUP_KEY_VERSION)"
    if grep -q '^AUTH_OTP_PEPPER_ACTIVE_VERSION=' "$source_env" ||
      grep -q '^AUTH_OTP_PEPPER_KEYS_JSON=' "$source_env"; then
      printf 'AUTH_OTP_PEPPER_ACTIVE_VERSION=%s\n' "$(read_env_value "$source_env" AUTH_OTP_PEPPER_ACTIVE_VERSION)"
      printf 'AUTH_OTP_PEPPER_KEYS_JSON=%s\n' "$(read_env_value "$source_env" AUTH_OTP_PEPPER_KEYS_JSON)"
    fi
  } >"$drain_candidate"
  chown root:root "$drain_candidate"
  chmod 600 "$drain_candidate"
}

case "$drain_action" in
  replace-current) build_drain_candidate "$api_env" "$drain_timestamp" ;;
  replace-candidate) build_drain_candidate "$api_candidate" "$drain_timestamp" ;;
  preserve|delete) ;;
  *) die 'invalid internal drain action' ;;
esac

mv -f -- "$api_candidate" "$api_env"
api_candidate=''
api_replaced='true'
mv -f -- "$deployment_candidate" "$deployment_env"
deployment_candidate=''
deployment_replaced='true'

if ! "$preflight" >/dev/null; then
  die 'updated authentication configuration failed preflight and was rolled back' 3
fi

case "$drain_action" in
  replace-current|replace-candidate)
    mv -f -- "$drain_candidate" "$drain_state"
    drain_candidate=''
    drain_replaced='true'
    ;;
  delete)
    if [[ "$drain_existed" == 'true' ]]; then
      mv -f -- "$drain_state" "$drain_rollback"
      drain_removed='true'
    fi
    ;;
  preserve) ;;
esac

completed='true'
rm -f -- "$api_rollback" "$deployment_rollback" "$drain_rollback"
api_rollback=''
deployment_rollback=''
drain_rollback=''

if [[ "$mode" == '--disable' ]]; then
  printf 'AUTHENTICATION_CONFIGURATION_UPDATED=disabled\n'
else
  printf 'AUTHENTICATION_CONFIGURATION_UPDATED=enabled\n'
fi
if [[ "$drain_action" == replace-* ]]; then
  printf 'AUTH_KEY_DRAIN_STARTED_AT_EPOCH=%s\n' "$drain_timestamp"
fi
printf 'API_RECREATE_REQUIRED=true\n'
