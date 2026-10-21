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

command -v base64 >/dev/null
command -v cmp >/dev/null
command -v docker >/dev/null
command -v openssl >/dev/null
command -v readlink >/dev/null
command -v realpath >/dev/null

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"

case "$bundle_root" in
  /opt/chi-shen-me/releases/*/deploy) ;;
  *) die "unexpected deployment directory: $bundle_root" ;;
esac

assert_regular_file() {
  local path="$1"
  local expected_mode="$2"
  local expected_uid="${3:-0}"
  local expected_gid="${4:-0}"
  local actual

  [[ -f "$path" && ! -L "$path" ]] || die "required regular file is missing or is a link: $path"
  actual="$(stat -c '%a:%u:%g' "$path")"
  [[ "$actual" == "$expected_mode:$expected_uid:$expected_gid" ]] ||
    die "unexpected file mode or owner: $path"
}

assert_directory() {
  local path="$1"
  local expected_mode="$2"
  local expected_uid="${3:-0}"
  local expected_gid="${4:-0}"
  local actual

  [[ -d "$path" && ! -L "$path" ]] || die "required directory is missing or is a link: $path"
  actual="$(stat -c '%a:%u:%g' "$path")"
  [[ "$actual" == "$expected_mode:$expected_uid:$expected_gid" ]] || die "unexpected directory mode or owner: $path"
}

read_deployment_value() {
  local name="$1"
  local -a matches=()
  mapfile -t matches < <(grep -E "^${name}=" "$deployment_env" || true)
  [[ "${#matches[@]}" -eq 1 ]] || die "missing or duplicate deployment setting: $name"
  [[ -n "${matches[0]#*=}" ]] || die "empty deployment setting: $name"
  printf '%s' "${matches[0]#*=}"
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

assert_env_keys_with_optional() {
  local path="$1"
  shift
  local -A required=()
  local -A optional=()
  local -A actual=()
  local env_name line section='required'

  for env_name in "$@"; do
    if [[ "$env_name" == '--' ]]; then
      [[ "$section" == 'required' ]] || die 'invalid optional environment key delimiter'
      section='optional'
    elif [[ "$section" == 'required' ]]; then
      required["$env_name"]=1
    else
      optional["$env_name"]=1
    fi
  done
  [[ "$section" == 'optional' ]] || die 'optional environment key delimiter is missing'

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] || die "invalid environment line in $path"
    env_name="${line%%=*}"
    [[ -z "${actual[$env_name]+x}" ]] || die "duplicate environment key in $path: $env_name"
    [[ -n "${required[$env_name]+x}" || -n "${optional[$env_name]+x}" ]] ||
      die "unexpected environment key in $path: $env_name"
    [[ -n "${line#*=}" ]] || die "empty secret setting: $env_name"
    actual["$env_name"]=1
  done <"$path"

  for env_name in "${!required[@]}"; do
    [[ -n "${actual[$env_name]+x}" ]] || die "required environment key is missing from $path: $env_name"
  done
}

read_env_value() {
  local path="$1"
  local name="$2"
  local -a matches=()
  mapfile -t matches < <(grep -E "^${name}=" "$path" || true)
  [[ "${#matches[@]}" -eq 1 ]] || die "missing or duplicate secret setting: $name"
  [[ -n "${matches[0]#*=}" ]] || die "empty secret setting: $name"
  printf '%s' "${matches[0]#*=}"
}

count_present_env_keys() {
  local path="$1"
  shift
  local count=0 name
  for name in "$@"; do
    if grep -Eq "^${name}=" "$path"; then
      read_env_value "$path" "$name" >/dev/null
      count=$((count + 1))
    fi
  done
  printf '%s' "$count"
}

assert_directory "$bundle_root" 700
assert_directory "$script_dir" 700
assert_regular_file "$deployment_env" 600

while IFS= read -r path; do
  assert_directory "$path" 700
done < <(find "$bundle_root" -xdev -mindepth 1 -type d -print | sort)

while IFS= read -r path; do
  case "$path" in
    "$deployment_env") ;;
    "$script_dir"/*.sh) assert_regular_file "$path" 700 ;;
    "$bundle_root/postgres/pg_hba.conf") assert_regular_file "$path" 644 ;;
    *) assert_regular_file "$path" 600 ;;
  esac
done < <(find "$bundle_root" -xdev -type f -print | sort)

declare -a deployment_names=(
  ACCOUNTS_ENABLED
  ALIBABA_CLOUD_ECS_METADATA
  AMAP_ENABLED
  API_IMAGE
  API_IMAGE_ID
  API_LOOPBACK_PORT
  AUTH_SCHEMA_TRANSITION_MODE
  COMPOSE_PROJECT_NAME
  EMAIL_AUTH_ENABLED
  MINIMUM_SUPPORTED_VERSION
  POSTGIS_IMAGE
  POSTGIS_IMAGE_ID
  POSTGRES_BOOTSTRAP_USER
  POSTGRES_DB
  POSTGRES_VOLUME_NAME
  PHONE_AUTH_ENABLED
  QQ_AUTH_ENABLED
  QQ_OPEN_PLATFORM_REALM_ID
  QQ_UNION_ID_ENABLED
  RETENTION_MODE
  SHARED_STATE_DIRECTORY
  WECHAT_AUTH_ENABLED
  WECHAT_MINIPROGRAM_AUTH_ENABLED
  WECHAT_OPEN_PLATFORM_REALM_ID
)
# Only these new non-secret settings are optional for pre-MiMo bundles. All
# pre-existing required keys and rejection of arbitrary keys remain unchanged.
for mimo_setting in MIMO_ENABLED MIMO_MODEL MIMO_TIMEOUT_MS MIMO_MAX_CALLS_PER_MINUTE MIMO_MAX_CONCURRENCY; do
  if grep -Eq "^${mimo_setting}=" "$deployment_env"; then deployment_names+=("$mimo_setting"); fi
done
assert_exact_env_keys "$deployment_env" "${deployment_names[@]}"
read_mimo_setting() {
  if grep -Eq "^${1}=" "$deployment_env"; then read_deployment_value "$1"; else printf '%s' "$2"; fi
}
mimo_enabled="$(read_mimo_setting MIMO_ENABLED false)"
mimo_model="$(read_mimo_setting MIMO_MODEL mimo-v2.6-flash)"
mimo_timeout_ms="$(read_mimo_setting MIMO_TIMEOUT_MS 8000)"
mimo_calls_per_minute="$(read_mimo_setting MIMO_MAX_CALLS_PER_MINUTE 30)"
mimo_concurrency="$(read_mimo_setting MIMO_MAX_CONCURRENCY 4)"
[[ "$mimo_enabled" == 'true' || "$mimo_enabled" == 'false' ]] || die 'MIMO_ENABLED must be true or false'

compose_project_name="$(read_deployment_value COMPOSE_PROJECT_NAME)"
shared_state_directory="$(read_deployment_value SHARED_STATE_DIRECTORY)"
api_loopback_port="$(read_deployment_value API_LOOPBACK_PORT)"
api_image="$(read_deployment_value API_IMAGE)"
api_image_id="$(read_deployment_value API_IMAGE_ID)"
postgis_image="$(read_deployment_value POSTGIS_IMAGE)"
postgis_image_id="$(read_deployment_value POSTGIS_IMAGE_ID)"
postgres_db="$(read_deployment_value POSTGRES_DB)"
postgres_bootstrap_user="$(read_deployment_value POSTGRES_BOOTSTRAP_USER)"
postgres_volume_name="$(read_deployment_value POSTGRES_VOLUME_NAME)"
minimum_supported_version="$(read_deployment_value MINIMUM_SUPPORTED_VERSION)"
amap_enabled="$(read_deployment_value AMAP_ENABLED)"
auth_schema_transition_mode="$(read_deployment_value AUTH_SCHEMA_TRANSITION_MODE)"
accounts_enabled="$(read_deployment_value ACCOUNTS_ENABLED)"
phone_auth_enabled="$(read_deployment_value PHONE_AUTH_ENABLED)"
email_auth_enabled="$(read_deployment_value EMAIL_AUTH_ENABLED)"
wechat_auth_enabled="$(read_deployment_value WECHAT_AUTH_ENABLED)"
wechat_miniprogram_auth_enabled="$(read_deployment_value WECHAT_MINIPROGRAM_AUTH_ENABLED)"
wechat_open_platform_realm_id="$(read_deployment_value WECHAT_OPEN_PLATFORM_REALM_ID)"
qq_auth_enabled="$(read_deployment_value QQ_AUTH_ENABLED)"
qq_union_id_enabled="$(read_deployment_value QQ_UNION_ID_ENABLED)"
qq_open_platform_realm_id="$(read_deployment_value QQ_OPEN_PLATFORM_REALM_ID)"
aliyun_ram_role="$(read_deployment_value ALIBABA_CLOUD_ECS_METADATA)"
retention_mode="$(read_deployment_value RETENTION_MODE)"

[[ "$compose_project_name" == 'chi-shen-me-alpha' ]] || die 'unexpected Compose project name'
[[ "$shared_state_directory" == '/opt/chi-shen-me/shared' ]] || die 'unexpected shared state directory'
assert_directory "$shared_state_directory" 700
[[ "$api_loopback_port" =~ ^[0-9]+$ && "$api_loopback_port" -ge 1024 && "$api_loopback_port" -le 65535 ]] ||
  die 'invalid API loopback port'
[[ "$api_image" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die 'invalid API image reference'
[[ "$postgis_image" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die 'invalid PostGIS image reference'
[[ "$api_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'invalid API image ID'
[[ "$postgis_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'invalid PostGIS image ID'
[[ "$postgres_db" == 'chi_shen_me' ]] || die 'unexpected PostgreSQL database name'
[[ "$postgres_bootstrap_user" == 'postgres_bootstrap' ]] || die 'unexpected PostgreSQL bootstrap role'
[[ "$postgres_volume_name" == 'chi-shen-me-alpha_postgres_data' ]] || die 'unexpected PostgreSQL volume name'
[[ "$minimum_supported_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'invalid minimum supported version'
[[ "$amap_enabled" == 'true' || "$amap_enabled" == 'false' ]] || die 'AMAP_ENABLED must be true or false'
[[ "$auth_schema_transition_mode" == 'none' || "$auth_schema_transition_mode" == 'legacy_phone_drain' || "$auth_schema_transition_mode" == 'wechat_union_aliases_pending' ]] ||
  die 'AUTH_SCHEMA_TRANSITION_MODE must be none, legacy_phone_drain or wechat_union_aliases_pending'
[[ "$wechat_open_platform_realm_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
  die 'WECHAT_OPEN_PLATFORM_REALM_ID must be a stable lowercase internal identifier'
[[ "$qq_open_platform_realm_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
  die 'QQ_OPEN_PLATFORM_REALM_ID must be a stable lowercase internal identifier'

# QQ identity semantics outlive every immutable release. Once QQ is enabled,
# the realm and the monotonic UnionID marker are also anchored in this shared,
# root-only non-secret state file. This survives a rollback to an older release
# whose deployment.env predates these fields.
qq_identity_state_file="$shared_state_directory/auth-identity-state.env"
qq_identity_state_present='false'
persisted_qq_namespace_initialized='false'
if [[ -e "$qq_identity_state_file" || -L "$qq_identity_state_file" ]]; then
  assert_regular_file "$qq_identity_state_file" 600
  assert_exact_env_keys "$qq_identity_state_file" \
    AUTH_IDENTITY_STATE_FORMAT_VERSION \
    QQ_OPEN_PLATFORM_REALM_ID QQ_UNION_ID_NAMESPACE_INITIALIZED
  persisted_identity_state_format_version="$(
    read_env_value "$qq_identity_state_file" AUTH_IDENTITY_STATE_FORMAT_VERSION
  )"
  persisted_qq_realm_id="$(read_env_value "$qq_identity_state_file" QQ_OPEN_PLATFORM_REALM_ID)"
  persisted_qq_namespace_initialized="$(
    read_env_value "$qq_identity_state_file" QQ_UNION_ID_NAMESPACE_INITIALIZED
  )"
  [[ "$persisted_identity_state_format_version" == '1' ]] ||
    die 'shared QQ identity state has an unsupported format version'
  [[ "$persisted_qq_realm_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
    die 'shared QQ identity state has an invalid Open Platform realm'
  [[ "$persisted_qq_namespace_initialized" == 'true' ||
     "$persisted_qq_namespace_initialized" == 'false' ]] ||
    die 'shared QQ identity state has an invalid UnionID namespace marker'
  [[ "$persisted_qq_realm_id" == "$qq_open_platform_realm_id" ]] ||
    die 'release must preserve the shared QQ Open Platform realm'
  qq_identity_state_present='true'
else
  [[ "$qq_auth_enabled" == 'false' ]] ||
    die 'QQ authentication requires initialized shared identity state'
fi

# Once a schema-0012-aware release is active, the Open Platform realm is an
# identity namespace rather than an ordinary feature flag. A routine release
# must not silently re-hash the same UnionID into a different namespace.
current_link='/opt/chi-shen-me/current'
if [[ -e "$current_link" || -L "$current_link" ]]; then
  [[ -L "$current_link" ]] || die 'current release path must be a direct symlink'
  current_release="$(readlink -- "$current_link")"
  [[ "$current_release" =~ ^/opt/chi-shen-me/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    die 'current release link does not directly name an immutable release'
  [[ "$(realpath -e -- "$current_link")" == "$current_release" ]] ||
    die 'current release link resolves unexpectedly'
  current_deployment_env="$current_release/deploy/deployment.env"
  if [[ "$current_deployment_env" != "$deployment_env" && -f "$current_deployment_env" ]]; then
    mapfile -t current_realm_lines < <(
      grep -E '^WECHAT_OPEN_PLATFORM_REALM_ID=' "$current_deployment_env" || true
    )
    [[ "${#current_realm_lines[@]}" -le 1 ]] ||
      die 'current release has a duplicate WeChat Open Platform realm'
    if [[ "${#current_realm_lines[@]}" -eq 1 ]]; then
      current_realm="${current_realm_lines[0]#*=}"
      [[ -n "$current_realm" && "$current_realm" == "$wechat_open_platform_realm_id" ]] ||
        die 'routine releases must preserve the WeChat Open Platform realm'
    fi
    if [[ "$qq_identity_state_present" == 'false' ]]; then
      mapfile -t current_qq_realm_lines < <(
        grep -E '^QQ_OPEN_PLATFORM_REALM_ID=' "$current_deployment_env" || true
      )
      [[ "${#current_qq_realm_lines[@]}" -le 1 ]] ||
        die 'current release has a duplicate QQ Open Platform realm'
      if [[ "${#current_qq_realm_lines[@]}" -eq 1 ]]; then
        current_qq_realm="${current_qq_realm_lines[0]#*=}"
        [[ -n "$current_qq_realm" && "$current_qq_realm" == "$qq_open_platform_realm_id" ]] ||
          die 'routine releases must preserve the QQ Open Platform realm'
      fi
    else
      mapfile -t current_qq_enabled_lines < <(
        grep -E '^QQ_AUTH_ENABLED=' "$current_deployment_env" || true
      )
      [[ "${#current_qq_enabled_lines[@]}" -le 1 ]] ||
        die 'current release has a duplicate QQ authentication switch'
      if [[ "${#current_qq_enabled_lines[@]}" -eq 1 &&
            "${current_qq_enabled_lines[0]#*=}" == 'true' ]]; then
        current_qq_realm="$(read_env_value "$current_deployment_env" QQ_OPEN_PLATFORM_REALM_ID)"
        current_qq_union_enabled="$(read_env_value "$current_deployment_env" QQ_UNION_ID_ENABLED)"
        [[ "$current_qq_realm" == "$persisted_qq_realm_id" ]] ||
          die 'enabled current QQ release differs from the shared identity realm'
        if [[ "$persisted_qq_namespace_initialized" == 'true' ]]; then
          [[ "$current_qq_union_enabled" == 'true' ]] ||
            die 'enabled current QQ release must preserve the shared UnionID namespace'
        else
          [[ "$current_qq_union_enabled" == 'false' ]] ||
            die 'current QQ release cannot enable an uninitialized UnionID namespace'
        fi
      fi
    fi
  fi
fi
for auth_switch in "$accounts_enabled" "$phone_auth_enabled" "$email_auth_enabled" "$wechat_auth_enabled" "$wechat_miniprogram_auth_enabled" "$qq_auth_enabled" "$qq_union_id_enabled"; do
  [[ "$auth_switch" == 'true' || "$auth_switch" == 'false' ]] || die 'authentication switches must be true or false'
done
if [[ "$accounts_enabled" == 'true' ]]; then
  [[ "$phone_auth_enabled" == 'true' ]] || die 'PHONE_ONLY accounts require SMS phone authentication'
else
  [[ "$phone_auth_enabled" == 'false' && "$email_auth_enabled" == 'false' && "$wechat_auth_enabled" == 'false' && "$wechat_miniprogram_auth_enabled" == 'false' && "$qq_auth_enabled" == 'false' && "$qq_union_id_enabled" == 'false' ]] ||
    die 'authentication channels must stay disabled when accounts are disabled'
fi
if [[ "$auth_schema_transition_mode" == 'legacy_phone_drain' && "$accounts_enabled" != 'false' ]]; then
  die 'legacy_phone_drain requires ACCOUNTS_ENABLED=false'
fi
if [[ "$auth_schema_transition_mode" == 'wechat_union_aliases_pending' && "$wechat_auth_enabled" != 'false' ]]; then
  die 'wechat_union_aliases_pending requires WECHAT_AUTH_ENABLED=false'
fi
if [[ "$wechat_miniprogram_auth_enabled" == 'true' && "$auth_schema_transition_mode" != 'none' ]]; then
  die 'Mini Program authentication requires AUTH_SCHEMA_TRANSITION_MODE=none'
fi
if [[ "$qq_union_id_enabled" == 'true' && "$qq_auth_enabled" != 'true' ]]; then
  die 'QQ_UNION_ID_ENABLED requires QQ_AUTH_ENABLED'
fi
if [[ "$qq_union_id_enabled" == 'true' && "$persisted_qq_namespace_initialized" != 'true' ]]; then
  die 'QQ_UNION_ID_ENABLED requires an initialized QQ UnionID namespace'
fi
if [[ "$persisted_qq_namespace_initialized" == 'true' && "$qq_auth_enabled" == 'true' && "$qq_union_id_enabled" != 'true' ]]; then
  die 'initialized QQ UnionID namespace requires UnionID whenever QQ authentication is enabled'
fi
if [[ "$phone_auth_enabled" == 'true' ]]; then
  [[ "$aliyun_ram_role" =~ ^[A-Za-z0-9._-]{1,64}$ && "$aliyun_ram_role" != 'replace-with-ram-role-name' ]] ||
    die 'a real ECS RAM role name is required for Aliyun authentication APIs'
fi
[[ "$retention_mode" == '--dry-run' ]] || die 'persistent deployment must keep retention in dry-run mode'

actual_api_image_id="$(docker image inspect --format '{{.Id}}' "$api_image")"
actual_postgis_image_id="$(docker image inspect --format '{{.Id}}' "$postgis_image")"
[[ "$actual_api_image_id" == "$api_image_id" ]] || die 'API image ID does not match deployment.env'
[[ "$actual_postgis_image_id" == "$postgis_image_id" ]] || die 'PostGIS image ID does not match deployment.env'
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$api_image")" == 'linux/amd64' ]] || die 'API image platform is not linux/amd64'
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$postgis_image")" == 'linux/amd64' ]] || die 'PostGIS image platform is not linux/amd64'
[[ "$(docker image inspect --format '{{.Config.User}}' "$api_image")" == 'node' ]] || die 'API image must run as node'

secrets_dir="$shared_state_directory/secrets"
assert_directory "$secrets_dir" 700

for password_name in \
  postgres_bootstrap_password \
  api_runtime_password \
  schema_migrator_password \
  retention_worker_password \
  admin_api_runtime_password \
  data_export_worker_password; do
  assert_regular_file "$secrets_dir/$password_name" 600
  grep -Eq '^[0-9a-f]{64}$' "$secrets_dir/$password_name" || die "invalid generated password file: $password_name"
  [[ "$(wc -l <"$secrets_dir/$password_name")" -eq 1 ]] || die "password file must contain exactly one line: $password_name"
done

assert_regular_file "$secrets_dir/api.env" 600
assert_regular_file "$secrets_dir/migration.env" 600
assert_regular_file "$secrets_dir/maintenance.env" 600
assert_regular_file "$secrets_dir/postgres/ca.key" 600
assert_regular_file "$secrets_dir/postgres/ca.crt" 644
assert_regular_file "$secrets_dir/postgres/server.crt" 644

postgres_identity="$(docker run --rm --entrypoint sh "$postgis_image" -c 'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"')"
[[ "$postgres_identity" =~ ^[0-9]+:[0-9]+$ ]] || die 'could not determine the Postgres container identity'
assert_directory "$secrets_dir/postgres" 750 0 "${postgres_identity##*:}"
assert_regular_file "$secrets_dir/postgres/server.key" 600 "${postgres_identity%%:*}" "${postgres_identity##*:}"

assert_exact_env_keys "$secrets_dir/migration.env" DATABASE_MIGRATION_URL DATABASE_MIGRATION_SSL_CA_BASE64
assert_exact_env_keys "$secrets_dir/maintenance.env" DATABASE_MAINTENANCE_URL DATABASE_MAINTENANCE_SSL_CA_BASE64
declare -a api_env_names=(DATABASE_URL DATABASE_SSL_CA_BASE64)
mimo_field_count="$(count_present_env_keys "$secrets_dir/api.env" MIMO_API_KEY)"
if [[ "$mimo_enabled" == 'true' && "$mimo_field_count" -ne 1 ]]; then die 'MiMo requires MIMO_API_KEY in api.env'; fi
# Keeping an unused MiMo key allows switching this feature off reversibly.
if [[ "$mimo_field_count" -eq 1 ]]; then api_env_names+=(MIMO_API_KEY); fi
if [[ "$amap_enabled" == 'true' ]]; then
  api_env_names+=(
    AMAP_WEB_SERVICE_KEY AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY AMAP_IP_WHITELIST_CONFIGURED
  )
fi
identity_continuity_names=(
  AUTH_HASH_ACTIVE_VERSION AUTH_HASH_KEYS_JSON AUTH_IDENTITY_DEDUP_KEY_VERSION
)
otp_continuity_names=(AUTH_OTP_PEPPER_ACTIVE_VERSION AUTH_OTP_PEPPER_KEYS_JSON)
identity_continuity_count="$(
  count_present_env_keys "$secrets_dir/api.env" "${identity_continuity_names[@]}"
)"
otp_continuity_count="$(
  count_present_env_keys "$secrets_dir/api.env" "${otp_continuity_names[@]}"
)"
[[ "$identity_continuity_count" -eq 0 || "$identity_continuity_count" -eq 3 ]] ||
  die 'api.env contains an incomplete authentication identity/session continuity group'
[[ "$otp_continuity_count" -eq 0 || "$otp_continuity_count" -eq 2 ]] ||
  die 'api.env contains an incomplete email OTP continuity group'
[[ "$otp_continuity_count" -eq 0 || "$identity_continuity_count" -eq 3 ]] ||
  die 'email OTP continuity requires the authentication identity/session continuity group'
if [[ "$accounts_enabled" == 'true' ]]; then
  [[ "$identity_continuity_count" -eq 3 ]] ||
    die 'enabled accounts require the authentication identity/session continuity group'
fi
if [[ "$identity_continuity_count" -eq 3 ]]; then
  api_env_names+=(
    "${identity_continuity_names[@]}"
  )
fi
if [[ "$wechat_auth_enabled" == 'true' ]]; then
  api_env_names+=(WECHAT_APP_ID WECHAT_APP_SECRET)
fi
mini_provider_env_count="$(count_present_env_keys "$secrets_dir/api.env" \
  WECHAT_MINIPROGRAM_APP_ID WECHAT_MINIPROGRAM_APP_SECRET)"
[[ "$mini_provider_env_count" -eq 0 || "$mini_provider_env_count" -eq 2 ]] ||
  die 'api.env contains an incomplete Mini Program provider credential group'
if [[ "$wechat_miniprogram_auth_enabled" == 'true' ]]; then
  api_env_names+=(WECHAT_MINIPROGRAM_APP_ID WECHAT_MINIPROGRAM_APP_SECRET)
fi
# A prevalidated schema 0014 rollback may keep this channel disabled while the
# shared api.env gains its credentials during candidate activation. Accept the
# complete unused group so that rollback remains valid; config loading below
# still proves the channel is disabled and exposes no provider configuration.
if [[ "$wechat_miniprogram_auth_enabled" == 'false' && "$mini_provider_env_count" -eq 2 ]]; then
  api_env_names+=(WECHAT_MINIPROGRAM_APP_ID WECHAT_MINIPROGRAM_APP_SECRET)
fi
if [[ "$phone_auth_enabled" == 'true' ]]; then
  api_env_names+=(
    ALIYUN_PNVS_SIGN_NAME ALIYUN_PNVS_TEMPLATE_CODE
  )
fi
if [[ "$email_auth_enabled" == 'true' ]]; then
  [[ "$otp_continuity_count" -eq 2 ]] ||
    die 'email authentication requires the email OTP continuity group'
fi
if [[ "$otp_continuity_count" -eq 2 ]]; then
  api_env_names+=("${otp_continuity_names[@]}")
fi
if [[ "$email_auth_enabled" == 'true' ]]; then
  api_env_names+=(
    SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USERNAME SMTP_PASSWORD
    SMTP_FROM_ADDRESS SMTP_REPLY_TO SMTP_FROM_NAME
  )
fi
if [[ "$qq_auth_enabled" == 'true' ]]; then
  api_env_names+=(QQ_APP_ID QQ_APP_KEY)
fi
if [[ "$auth_schema_transition_mode" == 'legacy_phone_drain' ]]; then
  declare -a legacy_optional_auth_env_names=(
    ALIYUN_PNVS_SIGN_NAME
    ALIYUN_PNVS_TEMPLATE_CODE
    SMTP_HOST
    SMTP_PORT
    SMTP_SECURE
    SMTP_USERNAME
    SMTP_PASSWORD
    SMTP_FROM_ADDRESS
    SMTP_REPLY_TO
    SMTP_FROM_NAME
    QQ_APP_ID
    QQ_APP_KEY
    ALIYUN_SMS_SIGN_NAME
    ALIYUN_SMS_TEMPLATE_CODE
    ALIYUN_FUSION_SCHEME_CODE
    ALIYUN_FUSION_PACKAGE_NAME
    ALIYUN_FUSION_PACKAGE_SIGN
    WECHAT_APP_ID
    WECHAT_APP_SECRET
  )
  assert_env_keys_with_optional \
    "$secrets_dir/api.env" "${api_env_names[@]}" -- "${legacy_optional_auth_env_names[@]}"
else
  assert_exact_env_keys "$secrets_dir/api.env" "${api_env_names[@]}"
fi

database_url="$(read_env_value "$secrets_dir/api.env" DATABASE_URL)"
migration_url="$(read_env_value "$secrets_dir/migration.env" DATABASE_MIGRATION_URL)"
maintenance_url="$(read_env_value "$secrets_dir/maintenance.env" DATABASE_MAINTENANCE_URL)"
runtime_url_pattern='^postgresql://api_runtime:'
runtime_url_pattern+='[0-9a-f]{64}'
runtime_url_pattern+='@postgres\.internal:5432/chi_shen_me$'
migration_url_pattern='^postgresql://schema_migrator:'
migration_url_pattern+='[0-9a-f]{64}'
migration_url_pattern+='@postgres\.internal:5432/chi_shen_me$'
maintenance_url_pattern='^postgresql://retention_worker:'
maintenance_url_pattern+='[0-9a-f]{64}'
maintenance_url_pattern+='@postgres\.internal:5432/chi_shen_me$'
[[ "$database_url" =~ $runtime_url_pattern ]] ||
  die 'invalid runtime database URL'
[[ "$migration_url" =~ $migration_url_pattern ]] ||
  die 'invalid migration database URL'
[[ "$maintenance_url" =~ $maintenance_url_pattern ]] ||
  die 'invalid maintenance database URL'

if [[ "$amap_enabled" == 'true' ]]; then
  amap_web_value="$(read_env_value "$secrets_dir/api.env" AMAP_WEB_SERVICE_KEY)"
  amap_signing_value="$(read_env_value "$secrets_dir/api.env" AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY)"
  amap_whitelist="$(read_env_value "$secrets_dir/api.env" AMAP_IP_WHITELIST_CONFIGURED)"
  [[ "$amap_web_value" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || die 'invalid AMap Web Service key shape'
  [[ "$amap_signing_value" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || die 'invalid AMap signing secret shape'
  [[ "$amap_whitelist" == 'true' ]] || die 'AMap IP whitelist confirmation is missing'
  unset amap_web_value amap_signing_value amap_whitelist
fi

# Keep deployment validation exactly aligned with the API process. The pinned
# candidate image validates the same api.env through the production
# loadAuthRuntimeConfig implementation, without initializing credentials or
# allowing any network access. This covers strict JSON parsing, the 1-3 key
# limit, key-version grammar, canonical Base64/byte length, active and dedup
# membership, cross-ring material reuse, provider fields and the conditional
# WeChat AppID.
if ! docker run --rm --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --env-file "$secrets_dir/api.env" \
  --env AUTH_SCHEMA_TRANSITION_MODE="$auth_schema_transition_mode" \
  --env MIMO_ENABLED="$mimo_enabled" \
  --env MIMO_MODEL="$mimo_model" \
  --env MIMO_TIMEOUT_MS="$mimo_timeout_ms" \
  --env MIMO_MAX_CALLS_PER_MINUTE="$mimo_calls_per_minute" \
  --env MIMO_MAX_CONCURRENCY="$mimo_concurrency" \
  --env ACCOUNTS_ENABLED="$accounts_enabled" \
  --env PHONE_AUTH_ENABLED="$phone_auth_enabled" \
  --env EMAIL_AUTH_ENABLED="$email_auth_enabled" \
  --env WECHAT_AUTH_ENABLED="$wechat_auth_enabled" \
  --env WECHAT_MINIPROGRAM_AUTH_ENABLED="$wechat_miniprogram_auth_enabled" \
  --env WECHAT_OPEN_PLATFORM_REALM_ID="$wechat_open_platform_realm_id" \
  --env QQ_AUTH_ENABLED="$qq_auth_enabled" \
  --env QQ_UNION_ID_ENABLED="$qq_union_id_enabled" \
  --env QQ_OPEN_PLATFORM_REALM_ID="$qq_open_platform_realm_id" \
  --env DATA_EXPORT_ENABLED=false \
  --env ALIYUN_CREDENTIAL_ALLOWED_PROVIDER=default/ecs_ram_role \
  --entrypoint node "$api_image" --input-type=module --eval '
    const { loadAuthRuntimeConfig } = await import("./dist/auth/auth-config.js");
    const { loadCanteenMimoConfig } = await import("./dist/canteen/canteen-mimo.config.js");
    loadCanteenMimoConfig(process.env);
    const enabled = process.env.ACCOUNTS_ENABLED === "true";
    const config = loadAuthRuntimeConfig(process.env, {
      accountsEnabled: enabled,
      databaseEnabled: true,
      production: true,
    });
    const continuityNames = [
      "AUTH_HASH_ACTIVE_VERSION",
      "AUTH_HASH_KEYS_JSON",
      "AUTH_IDENTITY_DEDUP_KEY_VERSION",
    ];
    const otpContinuityNames = [
      "AUTH_OTP_PEPPER_ACTIVE_VERSION",
      "AUTH_OTP_PEPPER_KEYS_JSON",
    ];
    const hasContinuity = continuityNames.every(
      (name) => process.env[name] !== undefined,
    );
    const hasOtpContinuity = otpContinuityNames.every(
      (name) => process.env[name] !== undefined,
    );
    if (!enabled && hasContinuity) {
      const continuityConfig = loadAuthRuntimeConfig(
        {
          ...process.env,
          ACCOUNTS_ENABLED: "true",
          PHONE_AUTH_ENABLED: "true",
          EMAIL_AUTH_ENABLED: hasOtpContinuity ? "true" : "false",
          WECHAT_AUTH_ENABLED: "false",
          WECHAT_MINIPROGRAM_AUTH_ENABLED: "false",
          QQ_AUTH_ENABLED: "false",
          QQ_UNION_ID_ENABLED: "false",
          ALIYUN_PNVS_SIGN_NAME: "continuity",
          ALIYUN_PNVS_TEMPLATE_CODE: "100001",
          SMTP_HOST: "smtp.example.invalid",
          SMTP_PORT: "465",
          SMTP_SECURE: "true",
          SMTP_USERNAME: "continuity-check",
          ["SMTP_" + "PASSWORD"]: "continuity-check-only",
          SMTP_FROM_ADDRESS: "continuity@example.invalid",
          SMTP_REPLY_TO: "continuity@example.invalid",
          SMTP_FROM_NAME: "continuity-check",
        },
        { accountsEnabled: true, databaseEnabled: true, production: false },
      );
      const primaryRing = continuityConfig["hash" + "KeyRing"];
      const stableVersion = continuityConfig["identityDedup" + "KeyVersion"];
      const emailRing = continuityConfig["otp" + "PepperRing"];
      if (
        primaryRing === null ||
        stableVersion === null ||
        (hasOtpContinuity && emailRing === null)
      ) {
        throw new Error("disabled authentication continuity validation failed");
      }
    }
    const registrationEnabled = enabled && process.env.PHONE_AUTH_ENABLED === "true";
    if (
      config.enabled !== enabled ||
      config.phone.enabled !== (process.env.PHONE_AUTH_ENABLED === "true" && enabled) ||
      config.email.enabled !== (process.env.EMAIL_AUTH_ENABLED === "true" && enabled) ||
      config.wechat.enabled !== (process.env.WECHAT_AUTH_ENABLED === "true" && enabled) ||
      config.wechatMiniProgram.enabled !== (process.env.WECHAT_MINIPROGRAM_AUTH_ENABLED === "true" && enabled) ||
      config.wechatMiniProgram.openPlatformRealmId !==
        (process.env.WECHAT_MINIPROGRAM_AUTH_ENABLED === "true" && enabled
          ? process.env.WECHAT_OPEN_PLATFORM_REALM_ID
          : null) ||
      config.wechat.openPlatformRealmId !==
        (process.env.WECHAT_AUTH_ENABLED === "true" && enabled
          ? process.env.WECHAT_OPEN_PLATFORM_REALM_ID
          : null) ||
      config.qq.enabled !== (process.env.QQ_AUTH_ENABLED === "true" && enabled) ||
      config.qq.unionIdEnabled !== (process.env.QQ_UNION_ID_ENABLED === "true") ||
      config.qq.openPlatformRealmId !==
        (process.env.QQ_UNION_ID_ENABLED === "true"
          ? process.env.QQ_OPEN_PLATFORM_REALM_ID
          : null) ||
      config.registrationEnabled !== registrationEnabled
    ) {
      throw new Error("authentication switch mismatch");
    }
    process.stdout.write("AUTH_CONFIG_VALIDATION=OK\n");
  ' >/dev/null; then
  die 'API image rejected authentication configuration'
fi

decoded_ca="$(mktemp /tmp/chi-shen-me-ca.XXXXXX)"
cleanup() {
  rm -f -- "${decoded_ca:-}"
}
trap cleanup EXIT
api_ca="$(read_env_value "$secrets_dir/api.env" DATABASE_SSL_CA_BASE64)"
migration_ca="$(read_env_value "$secrets_dir/migration.env" DATABASE_MIGRATION_SSL_CA_BASE64)"
maintenance_ca="$(read_env_value "$secrets_dir/maintenance.env" DATABASE_MAINTENANCE_SSL_CA_BASE64)"
[[ "$api_ca" == "$migration_ca" && "$api_ca" == "$maintenance_ca" ]] || die 'database CA settings differ between roles'
printf '%s' "$api_ca" | base64 -d >"$decoded_ca"
cmp -s "$decoded_ca" "$secrets_dir/postgres/ca.crt" || die 'injected database CA does not match the mounted CA'
unset database_url migration_url maintenance_url api_ca migration_ca maintenance_ca

openssl verify -CAfile "$secrets_dir/postgres/ca.crt" "$secrets_dir/postgres/server.crt" >/dev/null
openssl x509 -in "$secrets_dir/postgres/server.crt" -noout -checkend 604800 >/dev/null || die 'PostgreSQL server certificate is expired or near expiry'
openssl x509 -in "$secrets_dir/postgres/server.crt" -noout -ext subjectAltName |
  grep -q 'DNS:postgres.internal' || die 'PostgreSQL certificate SAN is invalid'
server_public_digest="$(openssl x509 -in "$secrets_dir/postgres/server.crt" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
server_private_digest="$(openssl pkey -in "$secrets_dir/postgres/server.key" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
ca_public_digest="$(openssl x509 -in "$secrets_dir/postgres/ca.crt" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
ca_private_digest="$(openssl pkey -in "$secrets_dir/postgres/ca.key" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
[[ "$server_public_digest" == "$server_private_digest" ]] || die 'PostgreSQL certificate and private key do not match'
[[ "$ca_public_digest" == "$ca_private_digest" ]] || die 'PostgreSQL CA certificate and private key do not match'
docker run --rm --entrypoint sh "$api_image" -eu -c \
  'test -r /app/dist/main.js && test -r /app/dist/auth/auth-config.js && test -r /app/dist/database/migrate-cli.js && test -r /app/migrations/0001_initial_schema.sql && test -r /app/migrations/0012_wechat_union_aliases.sql && test -r /app/migrations/0013_admin_config_control.sql && test -r /app/migrations/0014_wechat_miniprogram_login.sql'

cd "$bundle_root"
docker compose --env-file deployment.env config --quiet

printf 'DEPLOYMENT_PREFLIGHT=OK\n'
