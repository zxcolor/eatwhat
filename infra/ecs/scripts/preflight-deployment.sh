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
  AMAP_ENABLED
  API_IMAGE
  API_IMAGE_ID
  API_LOOPBACK_PORT
  COMPOSE_PROJECT_NAME
  MINIMUM_SUPPORTED_VERSION
  POSTGIS_IMAGE
  POSTGIS_IMAGE_ID
  POSTGRES_BOOTSTRAP_USER
  POSTGRES_DB
  POSTGRES_VOLUME_NAME
  RETENTION_MODE
  SHARED_STATE_DIRECTORY
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
if [[ "$amap_enabled" == 'true' ]]; then
  assert_exact_env_keys "$secrets_dir/api.env" \
    DATABASE_URL DATABASE_SSL_CA_BASE64 \
    AMAP_WEB_SERVICE_KEY AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY AMAP_IP_WHITELIST_CONFIGURED
else
  assert_exact_env_keys "$secrets_dir/api.env" DATABASE_URL DATABASE_SSL_CA_BASE64
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
  'test -r /app/dist/main.js && test -r /app/dist/database/migrate-cli.js && test -r /app/migrations/0001_initial_schema.sql'

cd "$bundle_root"
docker compose --env-file deployment.env config --quiet

printf 'DEPLOYMENT_PREFLIGHT=OK\n'
