#!/usr/bin/env bash

# Execute the actual parameterized calls from restore/rollback against synthetic
# databases. Docker, release directories, production scripts and secrets are not
# invoked. The real psql parser, database DDL and connection cleanup are exercised.
set -Eeuo pipefail
fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$fixture_dir/../../../../.." && pwd -P)"
restore_script="$repo_root/infra/ecs/scripts/restore-database.sh"
rollback_script="$repo_root/infra/ecs/scripts/rollback-database.sh"
psql_command="${ECS_DATABASE_SCRIPT_PSQL:-psql}"

fail() { printf 'database script psql fixture failed: %s\n' "$1" >&2; exit 1; }
[[ "${PGHOST:-}" == '127.0.0.1' && "${PGUSER:-}" == 'postgres' &&
   "${PGPORT:-}" =~ ^[0-9]+$ && "$PGPORT" -gt 1024 && "$PGPORT" -le 65535 ]] ||
  fail 'an explicit loopback PostgreSQL test connection is required'
if [[ "${GITHUB_ACTIONS:-}" == 'true' ]]; then
  [[ "${CI:-}" == 'true' && "$PGPORT" == '5432' &&
     "${PGDATABASE:-}" == 'chi_shen_me_ci' ]] || fail 'unexpected CI database boundary'
else
  [[ "${ECS_DATABASE_SCRIPT_PSQL_E2E:-}" == '1' && "$PGPORT" != '5432' &&
     "${PGDATABASE:-}" == 'postgres' ]] || fail 'local tests require an explicit temporary cluster'
fi
export PGCONNECT_TIMEOUT=3 PGCLIENTENCODING=UTF8
export PGOPTIONS='-c lock_timeout=2000 -c statement_timeout=10000'
command -v "$psql_command" >/dev/null || fail 'psql is unavailable'

run_bootstrap_psql() {
  local database="$1"
  shift
  "$psql_command" -X -w -h 127.0.0.1 -p "$PGPORT" -U postgres \
    -v ON_ERROR_STOP=1 -d "$database" "$@"
}

data_directory="$(run_bootstrap_psql "$PGDATABASE" -qAt -c 'SHOW data_directory;')"
data_directory="${data_directory//$'\r'/}"
data_directory="${data_directory//\\//}"
if [[ "${GITHUB_ACTIONS:-}" != 'true' ]]; then
  [[ "$data_directory" =~ /eatwhat-(restore|schema14)-[0-9a-f]{32}/data$ ]] ||
    fail 'local server is not an isolated temporary test cluster'
fi

# Keep each invocation and its quoted heredoc verbatim. Only remove the outer
# command-substitution assignment, so tests exercise argument passing as shipped.
extract_call() {
  local source="$1" query="$2" occurrence="${3:-1}"
  awk -v query="$query" -v occurrence="$occurrence" '
    /run_bootstrap_psql .*<<\047SQL\047/ {
      block = $0; sub(/^.*run_bootstrap_psql/, "run_bootstrap_psql", block)
      collecting = 1; next
    }
    collecting {
      block = block "\n" $0
      if ($0 == "SQL") {
        collecting = 0
        if (index(block, query) && ++matched == occurrence) { print block; found = 1; exit }
      }
    }
    END { if (!found) exit 1 }
  ' "$source"
}
run_call() {
  local invocation
  invocation="$(extract_call "$@")" || fail 'parameterized source call was not found'
  eval "$invocation"
}
[[ "$(grep -c 'run_bootstrap_psql .*<<' "$restore_script")" == '4' &&
   "$(grep -c 'run_bootstrap_psql .*<<' "$rollback_script")" == '7' ]] ||
  fail 'not every parameterized operation uses stdin SQL'

operation_id="$(date -u +%Y%m%dt%H%M%Sz)"
restore_database="chi_shen_me_restore_$operation_id"
preserved_database="chi_shen_me_before_rollback_$operation_id"
failed_database="chi_shen_me_failed_rollback_$operation_id"
test_databases=(chi_shen_me "$restore_database" "$preserved_database" "$failed_database")
for candidate in "${test_databases[@]}"; do
  [[ -z "$(run_call "$rollback_script" 'SELECT 1 FROM pg_database')" ]] ||
    fail 'a reserved synthetic database already exists; nothing was changed'
done

temporary_directory="$(mktemp -d)"
role_created='false'
cleanup_enabled='false'
sleeping_client=''
cleanup() {
  local status="$?" database
  trap - EXIT
  if [[ "$cleanup_enabled" == 'true' ]]; then
    for database in "${test_databases[@]}"; do
      run_bootstrap_psql postgres -qAt -v target="$database" <<'SQL' >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'target' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS :"target";
SQL
    done
  fi
  if [[ -n "$sleeping_client" ]]; then wait "$sleeping_client" 2>/dev/null || true; fi
  if [[ "$role_created" == 'true' ]]; then
    run_bootstrap_psql postgres -qAt -c 'DROP ROLE schema_migrator;' >/dev/null
  fi
  rm -f -- "$temporary_directory/client.out" "$temporary_directory/client.err"
  rmdir -- "$temporary_directory"
  return "$status"
}
trap cleanup EXIT

if [[ -z "$(run_bootstrap_psql postgres -qAt -c "SELECT 1 FROM pg_roles WHERE rolname = 'schema_migrator';")" ]]; then
  run_bootstrap_psql postgres -qAt -c 'CREATE ROLE schema_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE;' >/dev/null
  role_created='true'
fi
cleanup_enabled='true'

[[ -z "$(run_call "$restore_script" 'SELECT 1 FROM pg_database')" ]] || fail 'new restore target appears occupied'
run_call "$restore_script" 'CREATE DATABASE' >/dev/null
[[ "$(run_call "$restore_script" 'SELECT 1 FROM pg_database')" == '1' ]] || fail 'restore collision was missed'
candidate="$restore_database"
[[ "$(run_call "$rollback_script" 'SELECT 1 FROM pg_database')" == '1' ]] || fail 'rollback collision was missed'
candidate="untrusted' OR true --"
[[ -z "$(run_call "$rollback_script" 'SELECT 1 FROM pg_database')" ]] || fail 'literal binding changed the query'

run_bootstrap_psql "$restore_database" -qAt <<'SQL' >/dev/null
CREATE TABLE marker (value text NOT NULL);
INSERT INTO marker VALUES ('restored');
SQL
run_bootstrap_psql postgres -qAt -c 'CREATE DATABASE chi_shen_me;' >/dev/null
run_bootstrap_psql chi_shen_me -qAt <<'SQL' >/dev/null
CREATE TABLE marker (value text NOT NULL);
INSERT INTO marker VALUES ('original');
SQL

# Execute both normal rollback renames, then the failure-path reverse renames.
run_call "$rollback_script" 'SELECT pg_terminate_backend' 2
run_call "$rollback_script" 'RENAME TO :"preserved"' >/dev/null
run_call "$rollback_script" 'ALTER DATABASE :"restored"' >/dev/null
[[ "$(run_bootstrap_psql chi_shen_me -qAt -c 'SELECT value FROM marker;')" == 'restored' ]] || fail 'restored database did not become active'
[[ "$(run_bootstrap_psql "$preserved_database" -qAt -c 'SELECT value FROM marker;')" == 'original' ]] || fail 'original database was not preserved'

run_call "$rollback_script" 'SELECT pg_terminate_backend' 1
run_call "$rollback_script" 'RENAME TO :"failed"'
run_call "$rollback_script" 'ALTER DATABASE :"preserved"'
[[ "$(run_bootstrap_psql chi_shen_me -qAt -c 'SELECT value FROM marker;')" == 'original' ]] || fail 'failure cleanup did not restore the original database'
[[ "$(run_bootstrap_psql "$failed_database" -qAt -c 'SELECT value FROM marker;')" == 'restored' ]] || fail 'failure cleanup lost the failed replacement'

# A connected failed restore must be terminated before the actual DROP call.
restore_database="$failed_database"
run_bootstrap_psql "$restore_database" -qAt -c 'SELECT pg_sleep(8);' \
  >"$temporary_directory/client.out" 2>"$temporary_directory/client.err" &
sleeping_client="$!"
client_ready='false'
for _ in $(seq 1 30); do
  client_count="$(run_bootstrap_psql postgres -qAt -v target="$restore_database" <<'SQL'
SELECT count(*) FROM pg_stat_activity WHERE datname = :'target' AND query = 'SELECT pg_sleep(8);';
SQL
)"
  if [[ "$client_count" == '1' ]]; then client_ready='true'; break; fi
  sleep 0.1
done
[[ "$client_ready" == 'true' ]] || fail 'synthetic connection was not established'
run_call "$restore_script" 'SELECT pg_terminate_backend'
if wait "$sleeping_client"; then fail 'restore cleanup did not terminate its target connection'; fi
sleeping_client=''
run_call "$restore_script" 'DROP DATABASE'
[[ -z "$(run_call "$restore_script" 'SELECT 1 FROM pg_database')" ]] || fail 'failed restore database was not removed'
[[ "$(run_bootstrap_psql chi_shen_me -qAt -c 'SELECT value FROM marker;')" == 'original' ]] || fail 'cleanup changed the preserved source data'

printf 'DATABASE_SCRIPT_PSQL_FIXTURE=OK\n'
