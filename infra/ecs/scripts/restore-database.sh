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
mutation_lock_inherited='false'
if [[ "$#" -eq 2 ]]; then
  :
elif [[ "$#" -eq 3 && "$3" == '--mutation-lock-held' ]]; then
  mutation_lock_inherited='true'
else
  die 'usage: restore-database.sh BACKUP_DIRECTORY RESTORE_DATABASE_NAME'
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
restore_database="$2"

[[ "$restore_database" =~ ^chi_shen_me_restore_[0-9]{8}t[0-9]{6}z$ ]] ||
  die 'restore database must use chi_shen_me_restore_YYYYMMDDtHHMMSSz'

command -v flock >/dev/null
command -v install >/dev/null
command -v readlink >/dev/null
command -v realpath >/dev/null
command -v stat >/dev/null
lock_directory='/run/lock/chi-shen-me'
mutation_lock="$lock_directory/mutation.lock"
restore_lock="$lock_directory/postgres-restore.lock"
if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] ||
    die 'deployment lock directory is unsafe'
else
  install -d -m 700 "$lock_directory"
fi
[[ "$(realpath -e -- "$lock_directory")" == "$lock_directory" ]] ||
  die 'deployment lock directory resolves unexpectedly'
[[ "$(stat -c '%a:%u:%g' "$lock_directory")" == '700:0:0' ]] ||
  die 'deployment lock directory must be root:root mode 0700'
for lock_path in "$mutation_lock" "$restore_lock"; do
  if [[ ! -e "$lock_path" && ! -L "$lock_path" ]]; then
    ( set -o noclobber; : >"$lock_path" ) 2>/dev/null || true
  fi
  [[ -f "$lock_path" && ! -L "$lock_path" ]] ||
    die "deployment lock is unsafe: $lock_path"
  [[ "$(stat -c '%a:%u:%g' "$lock_path")" == '600:0:0' ]] ||
    die "deployment lock must be root:root mode 0600: $lock_path"
done
if [[ "$mutation_lock_inherited" == 'true' ]]; then
  [[ -e "/proc/$$/fd/8" ]] || die 'inherited global mutation lock descriptor is missing'
  [[ "$(readlink -f -- "/proc/$$/fd/8")" == "$mutation_lock" ]] ||
    die 'inherited global mutation lock descriptor is invalid'
  flock -n 8 || die 'inherited global mutation lock is not held'
else
  exec 8<>"$mutation_lock"
  flock -n 8 || die 'another deployment mutation, backup or secret update is running'
fi
exec 9<>"$restore_lock"
flock -n 9 || die 'another PostgreSQL restore is running'

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

# psql expands variables in stdin SQL, but sends -c SQL directly to the server.
existing="$(run_bootstrap_psql postgres -qAt -v target="$restore_database" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'target';
SQL
)"
[[ -z "$existing" ]] || die "restore database already exists: $restore_database"

created='false'
completed='false'
cleanup() {
  local status="$?"
  if [[ -n "${restored_ledger:-}" ]]; then rm -f -- "$restored_ledger"; fi
  if [[ "$completed" != 'true' && "$created" == 'true' ]]; then
    run_bootstrap_psql postgres -qAt -v target="$restore_database" <<'SQL' >/dev/null || true
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'target' AND pid <> pg_backend_pid();
SQL
    run_bootstrap_psql postgres -qAt -v target="$restore_database" <<'SQL' >/dev/null || true
DROP DATABASE IF EXISTS :"target";
SQL
  fi
  return "$status"
}
trap cleanup EXIT

run_bootstrap_psql postgres -v target="$restore_database" <<'SQL'
CREATE DATABASE :"target" OWNER schema_migrator TEMPLATE template0 ENCODING 'UTF8';
SQL
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
  cat "$backup_dir/ROLE_GRANTS.sql"
} | run_bootstrap_psql "$restore_database" \
  -v migration_owner=schema_migrator \
  -v runtime_role=api_runtime \
  -v maintenance_role=retention_worker \
  -v admin_runtime_role=admin_api_runtime \
  -v export_worker_role=data_export_worker

schema_facts="$(run_bootstrap_psql "$restore_database" -qAt -F '|' -c \
  "SELECT current_database(), count(*) FROM public.schema_migrations;")"
[[ "$schema_facts" == "$restore_database|$recorded_migration_count" ]] || die 'restored database schema verification failed'
restored_ledger="$(mktemp /tmp/chi-shen-me-restored-ledger.XXXXXX)"
run_bootstrap_psql "$restore_database" -qAt -F '|' -c \
  'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version;' \
  >"$restored_ledger"
cmp -s "$restored_ledger" "$backup_dir/SCHEMA_MIGRATIONS.txt" ||
  die 'restored database migration ledger differs from the verified backup'
rm -f -- "$restored_ledger"

completed='true'
printf 'POSTGRES_RESTORE=OK\n'
printf 'RESTORED_DATABASE=%s\n' "$restore_database"
printf 'SOURCE_BACKUP=%s\n' "$backup_dir"
