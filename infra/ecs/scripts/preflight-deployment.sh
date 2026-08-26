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

read_env_value() {
  local path="$1"
  local name="$2"
  local -a matches=()
  mapfile -t matches < <(grep -E "^${name}=" "$path" || true)
  [[ "${#matches[@]}" -eq 1 ]] || die "missing or duplicate secret setting: $name"
  [[ -n "${matches[0]#*=}" ]] || die "empty secret setting: $name"
  printf '%s' "${matches[0]#*=}"
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
  COMPOSE_PROJECT_NAME
  FUSION_AUTH_ENABLED
  MINIMUM_SUPPORTED_VERSION
  POSTGIS_IMAGE
  POSTGIS_IMAGE_ID
  POSTGRES_BOOTSTRAP_USER
  POSTGRES_DB
  POSTGRES_VOLUME_NAME
  PHONE_AUTH_ENABLED
  RETENTION_MODE
  SHARED_STATE_DIRECTORY
  WECHAT_AUTH_ENABLED
)
assert_exact_env_keys "$deployment_env" "${deployment_names[@]}"

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
accounts_enabled="$(read_deployment_value ACCOUNTS_ENABLED)"
phone_auth_enabled="$(read_deployment_value PHONE_AUTH_ENABLED)"
fusion_auth_enabled="$(read_deployment_value FUSION_AUTH_ENABLED)"
wechat_auth_enabled="$(read_deployment_value WECHAT_AUTH_ENABLED)"
aliyun_ram_role="$(read_deployment_value ALIBABA_CLOUD_ECS_METADATA)"
retention_mode="$(read_deployment_value RETENTION_MODE)"

[[ "$compose_project_name" == 'chi-shen-me-alpha' ]] || die 'unexpected Compose project name'
[[ "$shared_state_directory" == '/opt/chi-shen-me/shared' ]] || die 'unexpected shared state directory'
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
for auth_switch in "$accounts_enabled" "$phone_auth_enabled" "$fusion_auth_enabled" "$wechat_auth_enabled"; do
  [[ "$auth_switch" == 'true' || "$auth_switch" == 'false' ]] || die 'authentication switches must be true or false'
done
if [[ "$accounts_enabled" == 'true' ]]; then
  [[ "$wechat_auth_enabled" == 'true' ]] || die 'accounts require WeChat authentication'
  [[ "$phone_auth_enabled" == 'true' || "$fusion_auth_enabled" == 'true' ]] ||
    die 'accounts require SMS phone auth or FusionAuth'
else
  [[ "$phone_auth_enabled" == 'false' && "$fusion_auth_enabled" == 'false' && "$wechat_auth_enabled" == 'false' ]] ||
    die 'authentication channels must stay disabled when accounts are disabled'
fi
if [[ "$phone_auth_enabled" == 'true' || "$fusion_auth_enabled" == 'true' ]]; then
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

assert_directory "$shared_state_directory" 700
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
if [[ "$amap_enabled" == 'true' ]]; then
  api_env_names+=(
    AMAP_WEB_SERVICE_KEY AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY AMAP_IP_WHITELIST_CONFIGURED
  )
fi
if [[ "$accounts_enabled" == 'true' ]]; then
  api_env_names+=(
    AUTH_HASH_ACTIVE_VERSION AUTH_HASH_KEYS_JSON AUTH_IDENTITY_DEDUP_KEY_VERSION
    WECHAT_APP_ID WECHAT_APP_SECRET
  )
fi
if [[ "$phone_auth_enabled" == 'true' ]]; then
  api_env_names+=(
    AUTH_OTP_PEPPER_ACTIVE_VERSION AUTH_OTP_PEPPER_KEYS_JSON
    ALIYUN_SMS_SIGN_NAME ALIYUN_SMS_TEMPLATE_CODE
  )
fi
if [[ "$fusion_auth_enabled" == 'true' ]]; then
  api_env_names+=(
    ALIYUN_FUSION_SCHEME_CODE ALIYUN_FUSION_PACKAGE_NAME ALIYUN_FUSION_PACKAGE_SIGN
  )
fi
assert_exact_env_keys "$secrets_dir/api.env" "${api_env_names[@]}"

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

if [[ "$fusion_auth_enabled" == 'true' ]]; then
  fusion_package_name="$(read_env_value "$secrets_dir/api.env" ALIYUN_FUSION_PACKAGE_NAME)"
  [[ "$fusion_package_name" == 'com.chishenme.app.alpha' ]] || die 'FusionAuth package must match the Alpha application ID'
  unset fusion_package_name
fi

# Keep deployment validation exactly aligned with the API process. The pinned
# candidate image validates the same api.env through the production
# loadAuthRuntimeConfig implementation, without initializing credentials or
# allowing any network access. This covers strict JSON parsing, the 1-3 key
# limit, key-version grammar, canonical Base64/byte length, active and dedup
# membership, cross-ring material reuse, provider fields and WeChat AppID.
if ! docker run --rm --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --env-file "$secrets_dir/api.env" \
  --env ACCOUNTS_ENABLED="$accounts_enabled" \
  --env PHONE_AUTH_ENABLED="$phone_auth_enabled" \
  --env FUSION_AUTH_ENABLED="$fusion_auth_enabled" \
  --env EMAIL_AUTH_ENABLED=false \
  --env WECHAT_AUTH_ENABLED="$wechat_auth_enabled" \
  --env QQ_AUTH_ENABLED=false \
  --env DATA_EXPORT_ENABLED=false \
  --env ALIYUN_CREDENTIAL_ALLOWED_PROVIDER=default/ecs_ram_role \
  --entrypoint node "$api_image" --input-type=module --eval '
    const { loadAuthRuntimeConfig } = await import("./dist/auth/auth-config.js");
    const enabled = process.env.ACCOUNTS_ENABLED === "true";
    const config = loadAuthRuntimeConfig(process.env, {
      accountsEnabled: enabled,
      databaseEnabled: true,
      production: true,
    });
    if (
      config.enabled !== enabled ||
      config.phone.enabled !== (process.env.PHONE_AUTH_ENABLED === "true" && enabled) ||
      config.fusion.enabled !== (process.env.FUSION_AUTH_ENABLED === "true" && enabled) ||
      config.wechat.enabled !== (process.env.WECHAT_AUTH_ENABLED === "true" && enabled)
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
  'test -r /app/dist/main.js && test -r /app/dist/auth/auth-config.js && test -r /app/dist/database/migrate-cli.js && test -r /app/migrations/0001_initial_schema.sql'

cd "$bundle_root"
docker compose --env-file deployment.env config --quiet

printf 'DEPLOYMENT_PREFLIGHT=OK\n'
