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

"$script_dir/preflight-deployment.sh" >/dev/null

cd "$bundle_root"

read_deployment_value() {
  local name="$1"
  local value
  value="$(sed -n "s/^${name}=//p" "$deployment_env")"
  if [[ -z "$value" || "$value" == *$'\n'* ]]; then
    printf 'missing or duplicate deployment setting: %s\n' "$name" >&2
    exit 3
  fi
  printf '%s' "$value"
}

shared_state_directory="$(read_deployment_value SHARED_STATE_DIRECTORY)"
api_image="$(read_deployment_value API_IMAGE)"
postgres_volume_name="$(read_deployment_value POSTGRES_VOLUME_NAME)"
if [[ "$shared_state_directory" != "/opt/chi-shen-me/shared" ]]; then
  printf 'unexpected shared state directory\n' >&2
  exit 3
fi
secrets_dir="$shared_state_directory/secrets"

for required_path in \
  "$deployment_env" \
  "$secrets_dir/postgres_bootstrap_password" \
  "$secrets_dir/api_runtime_password" \
  "$secrets_dir/schema_migrator_password" \
  "$secrets_dir/retention_worker_password" \
  "$secrets_dir/admin_api_runtime_password" \
  "$secrets_dir/data_export_worker_password"; do
  if [[ ! -f "$required_path" ]]; then
    printf 'required deployment file is missing: %s\n' "$required_path" >&2
    exit 3
  fi
done

docker compose --env-file deployment.env config --quiet
docker image inspect "$api_image" >/dev/null
docker run --rm --entrypoint sh "$api_image" -eu -c \
  'test -r /app/dist/main.js && test -r /app/dist/database/migrate-cli.js'
if ! docker volume inspect "$postgres_volume_name" >/dev/null 2>&1; then
  docker volume create \
    --driver local \
    --label com.chi-shen-me.purpose=postgres-data \
    --label com.chi-shen-me.protected=true \
    "$postgres_volume_name" >/dev/null
fi
docker compose --env-file deployment.env up -d postgres

postgres_container="$(docker compose --env-file deployment.env ps -q postgres)"
if [[ -z "$postgres_container" ]]; then
  printf 'postgres container was not created\n' >&2
  exit 4
fi

for _ in $(seq 1 36); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")"
  if [[ "$health" == "healthy" ]]; then
    break
  fi
  sleep 5
done
if [[ "$health" != "healthy" ]]; then
  docker compose --env-file deployment.env logs --tail 80 postgres >&2
  printf 'postgres did not become healthy\n' >&2
  exit 5
fi

api_runtime_value="$(<"$secrets_dir/api_runtime_password")"
schema_migrator_value="$(<"$secrets_dir/schema_migrator_password")"
retention_worker_value="$(<"$secrets_dir/retention_worker_password")"
admin_api_runtime_value="$(<"$secrets_dir/admin_api_runtime_password")"
data_export_worker_value="$(<"$secrets_dir/data_export_worker_password")"

roles_sql="$(mktemp /tmp/chi-shen-me-roles.XXXXXX.sql)"
cleanup() {
  rm -f -- "$roles_sql"
  unset api_runtime_value schema_migrator_value retention_worker_value
  unset admin_api_runtime_value data_export_worker_value
}
trap cleanup EXIT
chmod 600 "$roles_sql"

{
  printf '\\set ON_ERROR_STOP on\n'
  printf "\\set api_runtime_password '%s'\\n" "$api_runtime_value"
  printf "\\set schema_migrator_password '%s'\\n" "$schema_migrator_value"
  printf "\\set retention_worker_password '%s'\\n" "$retention_worker_value"
  printf "\\set admin_api_runtime_password '%s'\\n" "$admin_api_runtime_value"
  printf "\\set data_export_worker_password '%s'\\n" "$data_export_worker_value"
  cat <<'SQL'

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_runtime') THEN
    CREATE ROLE api_runtime LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schema_migrator') THEN
    CREATE ROLE schema_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retention_worker') THEN
    CREATE ROLE retention_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_api_runtime') THEN
    CREATE ROLE admin_api_runtime LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'data_export_worker') THEN
    CREATE ROLE data_export_worker LOGIN;
  END IF;
END
$roles$;

ALTER ROLE api_runtime WITH LOGIN PASSWORD :'api_runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE schema_migrator WITH LOGIN PASSWORD :'schema_migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE retention_worker WITH LOGIN PASSWORD :'retention_worker_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE admin_api_runtime WITH LOGIN PASSWORD :'admin_api_runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE data_export_worker WITH LOGIN PASSWORD :'data_export_worker_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT schema_migrator TO postgres_bootstrap;
GRANT CONNECT ON DATABASE chi_shen_me TO api_runtime, schema_migrator, retention_worker, admin_api_runtime, data_export_worker;
SQL
} >"$roles_sql"

run_bootstrap_psql() {
  docker compose --env-file deployment.env exec -T postgres sh -eu -c \
    'export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' \
    sh "$@"
}

run_bootstrap_psql <"$roles_sql"
run_bootstrap_psql \
  -v migration_owner=schema_migrator \
  -v runtime_role=api_runtime \
  -v maintenance_role=retention_worker \
  -f /opt/chi-shen-me/sql/bootstrap-extensions.sql
run_bootstrap_psql -c 'ALTER DATABASE chi_shen_me OWNER TO schema_migrator; ALTER SCHEMA public OWNER TO schema_migrator;'

docker compose --env-file deployment.env --profile ops run --rm migrate

{
  printf '\\set ON_ERROR_STOP on\n'
  printf 'SET ROLE schema_migrator;\n'
  cat "$bundle_root/sql/role-grants.sql"
} | run_bootstrap_psql \
  -v migration_owner=schema_migrator \
  -v runtime_role=api_runtime \
  -v maintenance_role=retention_worker \
  -v admin_runtime_role=admin_api_runtime \
  -v export_worker_role=data_export_worker

run_bootstrap_psql -qAt -c \
  "SELECT count(*) FROM schema_migrations; SELECT extname || '=' || extversion FROM pg_extension WHERE extname IN ('pgcrypto','postgis') ORDER BY extname;"

printf 'DATABASE_PROVISIONING=OK\n'
docker image inspect --format 'API_IMAGE_ID={{.Id}}' "$api_image"
