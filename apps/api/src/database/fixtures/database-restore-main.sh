#!/usr/bin/env bash

# Execute the shipped restore body with real PostgreSQL tools. Only Docker,
# secret/TLS transport and the already separately tested host preflight are
# replaced; the actual list transport, restore command and EXIT cleanup run.
set -Eeuo pipefail
umask 077
fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$fixture_dir/../../../../.." && pwd -P)"
psql_command="${ECS_DATABASE_SCRIPT_PSQL:-psql}"
dump_command="${ECS_DATABASE_SCRIPT_PG_DUMP:-pg_dump}"
restore_command="${ECS_DATABASE_SCRIPT_PG_RESTORE:-pg_restore}"
fail() { printf 'database restore main fixture failed: %s\n' "$1" >&2; exit 1; }
[[ "${PGHOST:-}" == '127.0.0.1' && "${PGUSER:-}" == 'postgres' &&
   "${PGPORT:-}" =~ ^[0-9]+$ && "$PGPORT" -gt 1024 && "$PGPORT" -le 65535 ]] || fail 'explicit loopback connection required'
if [[ "${GITHUB_ACTIONS:-}" == 'true' ]]; then
  [[ "${CI:-}" == 'true' && "$PGPORT" == '5432' && "${PGDATABASE:-}" == 'chi_shen_me_ci' ]] || fail 'unexpected CI boundary'
else
  [[ "${ECS_DATABASE_SCRIPT_PSQL_E2E:-}" == '1' && "$PGPORT" != '5432' && "${PGDATABASE:-}" == 'postgres' ]] || fail 'isolated local cluster required'
fi
export PGCONNECT_TIMEOUT=3 PGCLIENTENCODING=UTF8
export PGOPTIONS='-c lock_timeout=2000 -c statement_timeout=30000'
psql() { command "$psql_command" "$@" | tr -d '\r'; }
run_psql() { psql -X -w -v ON_ERROR_STOP=1 -U postgres -d "$@"; }
data_directory="$(run_psql "$PGDATABASE" -qAt -c 'SHOW data_directory;')"
data_directory="${data_directory//\\//}"
if [[ "${GITHUB_ACTIONS:-}" != 'true' ]]; then
  [[ "$data_directory" =~ /eatwhat-(restore|schema14)-[0-9a-f]{32}/data$ ]] || fail 'server is not an isolated temporary cluster'
fi

fixture_work="$(mktemp -d)"
source_database="eatwhat_restore_main_$$_$(date -u +%H%M%S)"
restore_database="chi_shen_me_restore_$(date -u +%Y%m%dt%H%M%Sz)"
source_created='false'; role_created='false'; target_owned='false'
cleanup_fixture() {
  local status="$?" candidate failed='false'
  trap - EXIT
  for candidate in "$source_database" "$restore_database"; do
    if [[ ( "$candidate" == "$source_database" && "$source_created" == 'true' ) ||
          ( "$candidate" == "$restore_database" && "$target_owned" == 'true' ) ]]; then
      if ! run_psql postgres -qAt -v target="$candidate" <<'SQL' >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'target' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS :"target";
SQL
      then failed='true'; fi
    fi
  done
  if [[ "$role_created" == 'true' ]]; then
    if ! run_psql postgres -qAt -c 'DROP ROLE schema_migrator;' >/dev/null; then failed='true'; fi
  fi
  find "$fixture_work" -maxdepth 2 -type f -delete
  rmdir -- "$fixture_work/sql" "$fixture_work/backup" "$fixture_work"
  [[ "$failed" == 'false' ]] || return 1
  return "$status"
}
trap cleanup_fixture EXIT
mkdir "$fixture_work/sql" "$fixture_work/backup"
for candidate in "$source_database" "$restore_database"; do
  [[ -z "$(run_psql postgres -qAt -v target="$candidate" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'target';
SQL
)" ]] || fail 'synthetic database is occupied; nothing was changed'
done
if [[ -z "$(run_psql postgres -qAt -c "SELECT 1 FROM pg_roles WHERE rolname = 'schema_migrator';")" ]]; then
  run_psql postgres -qAt -c 'CREATE ROLE schema_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE;' >/dev/null
  role_created='true'
fi
run_psql postgres -qAt -v target="$source_database" <<'SQL' >/dev/null
CREATE DATABASE :"target" OWNER schema_migrator TEMPLATE template0 ENCODING 'UTF8';
SQL
source_created='true'
run_psql "$source_database" -qAt <<'SQL' >/dev/null
CREATE EXTENSION pgcrypto WITH SCHEMA public;
CREATE EXTENSION postgis WITH SCHEMA public;
INSERT INTO public.spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
VALUES (990002, 'FIXTURE', 990002, 'LOCAL_CS["Synthetic main restore"]', '');
SET ROLE schema_migrator;
CREATE TABLE public.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL);
INSERT INTO public.schema_migrations VALUES (1, 'synthetic_restore_main', repeat('a', 64));
CREATE TABLE public.fixture_business (id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO public.fixture_business VALUES (1, 'synthetic source');
SQL
command "$dump_command" --format=custom --no-owner --no-acl --dbname="$source_database" >"$fixture_work/backup/chi_shen_me.pgdump"
command "$restore_command" --list "$fixture_work/backup/chi_shen_me.pgdump" >"$fixture_work/backup/RESTORE_LIST.txt"
run_psql "$source_database" -qAt -F '|' -c 'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version;' >"$fixture_work/backup/SCHEMA_MIGRATIONS.txt"
printf '%s\n' 'GRANT SELECT ON public.fixture_business TO schema_migrator;' >"$fixture_work/backup/ROLE_GRANTS.sql"
fixture_image="sha256:$(printf 'a%.0s' {1..64})"
printf 'postgis_image_id=%s\n' "$fixture_image" >"$fixture_work/backup/METADATA.txt"
cp "$repo_root/infra/postgres/restore-extensions.sql" "$fixture_work/sql/restore-extensions.sql"

# Keep the complete database restore body, with one exact owner adaptation for
# the synthetic CI/local bootstrap account (production is postgres_bootstrap).
[[ "$(grep -c '"$filtered_restore_list" postgres_bootstrap)' "$repo_root/infra/ecs/scripts/restore-database.sh")" == '1' ]] || fail 'source owner binding changed'
awk '/^postgres_container=/{copying=1} copying{print}' "$repo_root/infra/ecs/scripts/restore-database.sh" \
  | sed 's/"$filtered_restore_list" postgres_bootstrap)/"$filtered_restore_list" postgres)/' >"$fixture_work/body.sh"
[[ -s "$fixture_work/body.sh" ]] || fail 'restore body extraction failed'

pg_restore() {
  local argument database='' list='' single='false' role='false' status
  for argument in "$@"; do
    case "$argument" in
      --dbname=*) database="${argument#*=}";;
      --use-list=*) list="${argument#*=}";;
      --single-transaction) single='true';;
      --role=schema_migrator) role='true';;
    esac
  done
  [[ "$database" == "$restore_database" && "$single" == 'true' && "$role" == 'true' && -f "$list" ]] || return 91
  grep -q 'TABLE DATA public fixture_business schema_migrator' "$list" || return 92
  [[ "$(grep -Ec '^[0-9]+; [0-9]+ [0-9]+ EXTENSION ' "$list" || true)" == '0' ]] || return 93
  printf 'RESTORE_LIST_READ=%s\n' "$list" >>"$fixture_work/transport.log"
  if [[ "$fixture_failure" == 'copy' ]]; then
    run_psql "$database" -qAt <<'SQL' >/dev/null
CREATE FUNCTION public.fixture_reject_copy() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE'
             AND object_identity = 'public.fixture_business') THEN
    ALTER TABLE public.fixture_business ADD CONSTRAINT fixture_reject CHECK (value <> 'synthetic source');
  END IF;
END $$;
CREATE EVENT TRIGGER fixture_reject_copy ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
EXECUTE FUNCTION public.fixture_reject_copy();
SQL
  fi
  if command "$restore_command" "$@"; then return 0; else status="$?"; fi
  [[ "$(run_psql "$database" -qAt -c "SELECT to_regclass('public.fixture_business') IS NULL AND NOT EXISTS (SELECT 1 FROM public.spatial_ref_sys WHERE srid = 990002);")" == 't' ]] || return 94
  printf 'RESTORE_TRANSACTION_ROLLED_BACK=true\n' >>"$fixture_work/transport.log"
  return "$status"
}
docker() {
  local code secret_clause='export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"' generated
  if [[ "$*" == 'compose --env-file deployment.env ps -q postgres' ]]; then
    printf 'fixture-postgres\n'
  elif [[ "$1" == 'inspect' && "$2" == '--format' && "$4" == 'fixture-postgres' ]]; then
    case "$3" in
      '{{.State.Status}}/'*) printf 'running/healthy\n';;
      '{{.Image}}') printf '%s\n' "$fixture_running_image";;
      *) return 95;;
    esac
  elif [[ "$1" == 'exec' && "$2" == 'fixture-postgres' && "$3" == 'sh' && "$4" == '-eu' && "$5" == '-c' && "$6" == 'umask 077; mktemp /tmp/chi-shen-me-restore-list.XXXXXXXX' ]]; then
    generated="$(mktemp /tmp/chi-shen-me-restore-list.XXXXXXXX)" || return
    printf '%s\n' "$generated" >>"$fixture_work/container-paths.log"
    printf '%s\n' "$generated"
  elif [[ "$1" == 'exec' && "$2" == '-i' && "$3" == 'fixture-postgres' && "$4" == 'sh' && "$5" == '-eu' && "$6" == '-c' && "$7" == 'cat > "$1"' ]]; then
    [[ "$9" =~ ^/tmp/chi-shen-me-restore-list[.][A-Za-z0-9]{8}$ ]] || return 96
    cat >"$9"
  elif [[ "$1" == 'exec' && "$2" == 'fixture-postgres' && "$3" == 'rm' && "$4" == '-f' && "$5" == '--' ]]; then
    [[ "$6" =~ ^/tmp/chi-shen-me-restore-list[.][A-Za-z0-9]{8}$ ]] || return 97
    [[ "$fixture_failure" != 'list_cleanup' ]] || return 99
    rm -f -- "$6"
  elif [[ "${*:1:9}" == 'compose --env-file deployment.env exec -T postgres sh -eu -c' ]]; then
    shift 9; code="$1"; shift
    code="${code//"$secret_clause"/:}"
    code="${code//export PGSSLMODE=verify-full/export PGSSLMODE=disable}"
    code="${code//--host=postgres.internal/--host=127.0.0.1}"
    code="${code//exec psql/psql}"
    code="${code//exec pg_restore/pg_restore}"
    POSTGRES_USER=postgres bash -Eeu -o pipefail -c "$code" "$@"
  else
    printf 'unexpected Docker operation in restore main fixture\n' >&2
    return 98
  fi
}
export -f docker psql pg_restore run_psql
export psql_command restore_command fixture_work fixture_image restore_database
export fixture_running_image="$fixture_image" fixture_failure='none'
run_main() {
  (
    set -Eeuo pipefail
    die() { printf '%s\n' "$1" >&2; exit "${2:-2}"; }
    script_dir="$repo_root/infra/ecs/scripts"
    bundle_root="$fixture_work"
    backup_dir="$fixture_work/backup"
    recorded_migration_count=1
    cd "$fixture_work"
    source "$fixture_work/body.sh"
  ) >"$fixture_work/main.out" 2>"$fixture_work/main.err"
}
target_exists() { run_psql postgres -qAt -v target="$restore_database" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'target';
SQL
}
assert_paths_removed() {
  local path
  while IFS= read -r path; do [[ ! -e "$path" ]] || fail 'container list was not removed'; done <"$fixture_work/container-paths.log"
}

# Wrong image and malformed extension plans must stop before database creation.
fixture_running_image="sha256:$(printf 'b%.0s' {1..64})"
if ( set -e; run_main ); then fail 'image mismatch was accepted'; fi
[[ -z "$(target_exists)" && ! -e "$fixture_work/container-paths.log" ]] || fail 'image mismatch started restore work'
fixture_running_image="$fixture_image"
cp "$fixture_work/backup/RESTORE_LIST.txt" "$fixture_work/original-list.txt"
printf '999999; 3079 999999 EXTENSION - hstore \n' >>"$fixture_work/backup/RESTORE_LIST.txt"
if ( set -e; run_main ); then fail 'unsupported extension was accepted'; fi
[[ -z "$(target_exists)" && ! -e "$fixture_work/container-paths.log" ]] || fail 'rejected plan started restore work'
cp "$fixture_work/original-list.txt" "$fixture_work/backup/RESTORE_LIST.txt"

# Invoke success outside a conditional to retain normal errexit semantics.
target_owned='true'
run_main
grep -q '^POSTGRES_RESTORE=OK$' "$fixture_work/main.out" || fail 'main restore did not finish'
[[ "$(run_psql "$restore_database" -qAt -c 'SELECT value FROM public.fixture_business;')" == 'synthetic source' ]] || fail 'main restore data missing'
grep -q '^RESTORE_LIST_READ=' "$fixture_work/transport.log" || fail 'pg_restore did not read the transported list'
assert_paths_removed
if ( set -e; run_main ); then fail 'occupied target was accepted'; fi
[[ "$(run_psql "$restore_database" -qAt -c 'SELECT value FROM public.fixture_business;')" == 'synthetic source' ]] || fail 'occupied target changed'
run_psql postgres -qAt -v target="$restore_database" <<'SQL' >/dev/null
DROP DATABASE :"target";
SQL

# A separate bash process avoids Bash's conditional-function errexit exception.
export repo_root
export -f run_main
fixture_failure='list_cleanup'
if bash -Eeuo pipefail -c 'run_main'; then fail 'container list cleanup failure was hidden'; fi
grep -q 'container restore list cleanup failed' "$fixture_work/main.err" || fail 'cleanup failure was not reported'
[[ "$(run_psql "$restore_database" -qAt -c 'SELECT value FROM public.fixture_business;')" == 'synthetic source' ]] || fail 'cleanup-only failure lost the completed restore'
while IFS= read -r path; do
  [[ "$path" =~ ^/tmp/chi-shen-me-restore-list[.][A-Za-z0-9]{8}$ ]] || fail 'owned temporary list path changed'
  rm -f -- "$path"
done <"$fixture_work/container-paths.log"
assert_paths_removed
run_psql postgres -qAt -v target="$restore_database" <<'SQL' >/dev/null
DROP DATABASE :"target";
SQL

fixture_failure='copy'
if bash -Eeuo pipefail -c 'run_main'; then fail 'late COPY failure was accepted'; fi
grep -q 'COPY fixture_business' "$fixture_work/main.err" || fail 'failure occurred before the intentional COPY'
grep -q 'fixture_reject' "$fixture_work/main.err" || fail 'failure was not the intentional check constraint'
[[ -z "$(target_exists)" ]] || fail 'failed restore clone was not deleted'
grep -q '^RESTORE_TRANSACTION_ROLLED_BACK=true$' "$fixture_work/transport.log" || fail 'late failure did not roll back data'
assert_paths_removed
[[ "$(run_psql "$source_database" -qAt -c "SELECT (SELECT value FROM public.fixture_business) = 'synthetic source' AND EXISTS (SELECT 1 FROM public.spatial_ref_sys WHERE srid=990002);")" == 't' ]] || fail 'source data changed'
printf 'DATABASE_RESTORE_MAIN_FIXTURE=OK\n'
