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
[[ "$#" -eq 2 ]] || die 'usage: restore-database.sh BACKUP_DIRECTORY RESTORE_DATABASE_NAME'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
restore_database="$2"

[[ "$restore_database" =~ ^chi_shen_me_restore_[0-9]{8}t[0-9]{6}z$ ]] ||
  die 'restore database must use chi_shen_me_restore_YYYYMMDDtHHMMSSz'

"$script_dir/preflight-deployment.sh" >/dev/null
"$script_dir/verify-database-backup.sh" "$1" >/dev/null
backup_dir="$(realpath -e -- "$1")"

recorded_facts="$(sed -n 's/^database_facts=//p' "$backup_dir/METADATA.txt")"
IFS='|' read -r recorded_database recorded_size_bytes recorded_migration_count <<<"$recorded_facts"
[[ "$recorded_database" == 'chi_shen_me' && "$recorded_size_bytes" =~ ^[0-9]+$ && "$recorded_migration_count" =~ ^[1-9][0-9]*$ ]] ||
  die 'backup metadata database facts are invalid'
available_bytes="$(df --output=avail -B1 /var/lib/docker | tail -n 1 | tr -d '[:space:]')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || die 'could not determine restore disk budget'
minimum_available_bytes=$((recorded_size_bytes + 536870912))
[[ "$available_bytes" -ge "$minimum_available_bytes" ]] || die 'insufficient free disk space for an isolated restore'

cd "$bundle_root"
command -v flock >/dev/null
exec 9>/run/lock/chi-shen-me-postgres-restore.lock
flock -n 9 || die 'another PostgreSQL restore is running'

postgres_container="$(docker compose --env-file deployment.env ps -q postgres)"
[[ -n "$postgres_container" ]] || die 'PostgreSQL container is missing'
[[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")" == 'running/healthy' ]] ||
  die 'PostgreSQL container is not healthy'

run_bootstrap_psql() {
  local database="$1"
  shift
  docker compose --env-file deployment.env exec -T postgres sh -eu -c \
    'database="$1"; shift; export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" "$@"' \
    sh "$database" "$@"
}

existing="$(run_bootstrap_psql postgres -qAt -v target="$restore_database" -c "SELECT 1 FROM pg_database WHERE datname = :'target';")"
[[ -z "$existing" ]] || die "restore database already exists: $restore_database"

created='false'
completed='false'
cleanup() {
  local status="$?"
  if [[ "$completed" != 'true' && "$created" == 'true' ]]; then
    run_bootstrap_psql postgres -qAt -v target="$restore_database" -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'target' AND pid <> pg_backend_pid();" >/dev/null || true
    run_bootstrap_psql postgres -qAt -v target="$restore_database" -c 'DROP DATABASE IF EXISTS :"target";' >/dev/null || true
  fi
  return "$status"
}
trap cleanup EXIT

run_bootstrap_psql postgres -v target="$restore_database" -c \
  'CREATE DATABASE :"target" OWNER schema_migrator TEMPLATE template0 ENCODING '\''UTF8'\'';'
created='true'

run_bootstrap_psql "$restore_database" \
  -v migration_owner=schema_migrator \
  -v runtime_role=api_runtime \
  -v maintenance_role=retention_worker \
  <"$bundle_root/sql/bootstrap-extensions.sql"

docker compose --env-file deployment.env exec -T postgres sh -eu -c '
  export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"
  export PGSSLMODE=verify-full
  export PGSSLROOTCERT=/run/postgres-tls/ca.crt
  exec pg_restore \
    --host=postgres.internal \
    --username="$POSTGRES_USER" \
    --dbname="$1" \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-acl \
    --no-comments \
    --role=schema_migrator
' sh "$restore_database" <"$backup_dir/chi_shen_me.pgdump"

{
  printf '\\set ON_ERROR_STOP on\n'
  printf 'SET ROLE schema_migrator;\n'
  cat "$bundle_root/sql/role-grants.sql"
} | run_bootstrap_psql "$restore_database" \
  -v migration_owner=schema_migrator \
  -v runtime_role=api_runtime \
  -v maintenance_role=retention_worker \
  -v admin_runtime_role=admin_api_runtime \
  -v export_worker_role=data_export_worker

schema_facts="$(run_bootstrap_psql "$restore_database" -qAt -F '|' -c \
  "SELECT current_database(), count(*) FROM public.schema_migrations;")"
[[ "$schema_facts" == "$restore_database|$recorded_migration_count" ]] || die 'restored database schema verification failed'

completed='true'
printf 'POSTGRES_RESTORE=OK\n'
printf 'RESTORED_DATABASE=%s\n' "$restore_database"
printf 'SOURCE_BACKUP=%s\n' "$backup_dir"
