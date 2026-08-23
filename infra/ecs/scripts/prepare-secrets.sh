#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'run as root\n' >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"

if [[ ! -f "$deployment_env" ]]; then
  printf 'deployment.env is missing\n' >&2
  exit 3
fi

read_deployment_value() {
  local name="$1"
  local value
  value="$(sed -n "s/^${name}=//p" "$deployment_env")"
  if [[ -z "$value" || "$value" == *$'\n'* ]]; then
    printf 'missing or duplicate deployment setting: %s\n' "$name" >&2
    exit 5
  fi
  printf '%s' "$value"
}

postgis_image="$(read_deployment_value POSTGIS_IMAGE)"
postgis_image_id="$(read_deployment_value POSTGIS_IMAGE_ID)"
postgres_db="$(read_deployment_value POSTGRES_DB)"
postgres_bootstrap_user="$(read_deployment_value POSTGRES_BOOTSTRAP_USER)"
shared_state_directory="$(read_deployment_value SHARED_STATE_DIRECTORY)"
if [[ "$postgres_db" != "chi_shen_me" || "$postgres_bootstrap_user" != "postgres_bootstrap" ]]; then
  printf 'unexpected PostgreSQL deployment identity\n' >&2
  exit 6
fi
if [[ "$shared_state_directory" != "/opt/chi-shen-me/shared" ]]; then
  printf 'unexpected shared state directory\n' >&2
  exit 6
fi

secrets_dir="$shared_state_directory/secrets"
if [[ -e "$secrets_dir" ]]; then
  printf 'shared secrets already exist; refusing to overwrite them\n' >&2
  exit 4
fi

command -v docker >/dev/null
command -v openssl >/dev/null
command -v base64 >/dev/null

[[ "$postgis_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf 'invalid PostGIS image ID\n' >&2
  exit 7
}
if [[ "$(docker image inspect --format '{{.Id}}' "$postgis_image")" != "$postgis_image_id" ]]; then
  printf 'PostGIS image ID does not match deployment.env\n' >&2
  exit 7
fi

postgres_identity="$(docker run --rm --entrypoint sh "$postgis_image" -c 'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"')"
if [[ ! "$postgres_identity" =~ ^[0-9]+:[0-9]+$ ]]; then
  printf 'could not determine postgres container identity\n' >&2
  exit 7
fi
postgres_uid="${postgres_identity%%:*}"
postgres_gid="${postgres_identity##*:}"

install -d -m 700 "$shared_state_directory"
staging_dir="$(mktemp -d "$shared_state_directory/.secrets.staging.XXXXXX")"
cleanup() {
  if [[ -n "${staging_dir:-}" && -d "$staging_dir" ]]; then
    case "$staging_dir" in
      "$shared_state_directory"/.secrets.staging.*)
        rm -rf -- "$staging_dir"
        ;;
      *)
        printf 'refusing to clean unexpected staging directory: %s\n' "$staging_dir" >&2
        ;;
    esac
  fi
}
trap cleanup EXIT

install -d -m 750 -o root -g "$postgres_gid" "$staging_dir/postgres"

random_hex() {
  openssl rand -hex 32
}

postgres_bootstrap_value="$(random_hex)"
api_runtime_value="$(random_hex)"
schema_migrator_value="$(random_hex)"
retention_worker_value="$(random_hex)"
admin_api_runtime_value="$(random_hex)"
data_export_worker_value="$(random_hex)"

printf '%s\n' "$postgres_bootstrap_value" >"$staging_dir/postgres_bootstrap_password"
printf '%s\n' "$api_runtime_value" >"$staging_dir/api_runtime_password"
printf '%s\n' "$schema_migrator_value" >"$staging_dir/schema_migrator_password"
printf '%s\n' "$retention_worker_value" >"$staging_dir/retention_worker_password"
printf '%s\n' "$admin_api_runtime_value" >"$staging_dir/admin_api_runtime_password"
printf '%s\n' "$data_export_worker_value" >"$staging_dir/data_export_worker_password"
chmod 600 "$staging_dir"/*_password

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -subj '/CN=chi-shen-me-postgres-ca' \
  -keyout "$staging_dir/postgres/ca.key" \
  -out "$staging_dir/postgres/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
  -subj '/CN=postgres.internal' \
  -keyout "$staging_dir/postgres/server.key" \
  -out "$staging_dir/postgres/server.csr" >/dev/null 2>&1
printf '%s\n' \
  'subjectAltName=DNS:postgres.internal' \
  'keyUsage=digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' \
  'basicConstraints=CA:FALSE' \
  >"$staging_dir/postgres/server.ext"
openssl x509 -req -sha256 -days 825 \
  -in "$staging_dir/postgres/server.csr" \
  -CA "$staging_dir/postgres/ca.crt" \
  -CAkey "$staging_dir/postgres/ca.key" \
  -CAcreateserial \
  -extfile "$staging_dir/postgres/server.ext" \
  -out "$staging_dir/postgres/server.crt" >/dev/null 2>&1

rm -f -- "$staging_dir/postgres/server.csr" "$staging_dir/postgres/server.ext" "$staging_dir/postgres/ca.srl"
chmod 600 "$staging_dir/postgres/ca.key"
chmod 644 "$staging_dir/postgres/ca.crt" "$staging_dir/postgres/server.crt"
chown "$postgres_uid:$postgres_gid" "$staging_dir/postgres/server.key"
chmod 600 "$staging_dir/postgres/server.key"

ca_base64="$(base64 -w 0 "$staging_dir/postgres/ca.crt")"
database_scheme="postgresql"

{
  printf 'DATABASE_URL=%s://api_runtime:%s@postgres.internal:5432/%s\n' "$database_scheme" "$api_runtime_value" "$postgres_db"
  printf 'DATABASE_SSL_CA_BASE64=%s\n' "$ca_base64"
} >"$staging_dir/api.env"
{
  printf 'DATABASE_MIGRATION_URL=%s://schema_migrator:%s@postgres.internal:5432/%s\n' "$database_scheme" "$schema_migrator_value" "$postgres_db"
  printf 'DATABASE_MIGRATION_SSL_CA_BASE64=%s\n' "$ca_base64"
} >"$staging_dir/migration.env"
{
  printf 'DATABASE_MAINTENANCE_URL=%s://retention_worker:%s@postgres.internal:5432/%s\n' "$database_scheme" "$retention_worker_value" "$postgres_db"
  printf 'DATABASE_MAINTENANCE_SSL_CA_BASE64=%s\n' "$ca_base64"
} >"$staging_dir/maintenance.env"
chmod 600 "$staging_dir/api.env" "$staging_dir/migration.env" "$staging_dir/maintenance.env"

openssl verify -CAfile "$staging_dir/postgres/ca.crt" "$staging_dir/postgres/server.crt" >/dev/null
cert_public_digest="$(openssl x509 -in "$staging_dir/postgres/server.crt" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
private_public_digest="$(openssl pkey -in "$staging_dir/postgres/server.key" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
if [[ "$cert_public_digest" != "$private_public_digest" ]]; then
  printf 'generated PostgreSQL certificate and key do not match\n' >&2
  exit 8
fi

mv -T -- "$staging_dir" "$secrets_dir"
staging_dir=""

unset postgres_bootstrap_value api_runtime_value schema_migrator_value
unset retention_worker_value admin_api_runtime_value data_export_worker_value ca_base64

printf 'SECRETS_PREPARED=OK\n'
printf 'POSTGRES_CONTAINER_IDENTITY=%s\n' "$postgres_identity"
