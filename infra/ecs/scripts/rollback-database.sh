#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

usage() {
  printf 'usage: rollback-database.sh [--wechat-union-aliases] BACKUP_DIRECTORY --execute CONFIRMATION\n' >&2
  exit 2
}

if [[ "$(id -u)" -ne 0 ]]; then
  die 'run as root'
fi
rollback_kind='phone-only'
if [[ "$#" -eq 4 && "$1" == '--wechat-union-aliases' ]]; then
  rollback_kind='wechat-union-aliases'
  shift
fi
[[ "$#" -eq 3 && "$2" == '--execute' ]] || usage

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
command -v flock >/dev/null
command -v install >/dev/null
command -v realpath >/dev/null
command -v stat >/dev/null
lock_directory='/run/lock/chi-shen-me'
mutation_lock="$lock_directory/mutation.lock"
rollback_lock="$lock_directory/postgres-rollback.lock"
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
for lock_path in "$mutation_lock" "$rollback_lock"; do
  if [[ ! -e "$lock_path" && ! -L "$lock_path" ]]; then
    ( set -o noclobber; : >"$lock_path" ) 2>/dev/null || true
  fi
  [[ -f "$lock_path" && ! -L "$lock_path" ]] ||
    die "deployment lock is unsafe: $lock_path"
  [[ "$(stat -c '%a:%u:%g' "$lock_path")" == '600:0:0' ]] ||
    die "deployment lock must be root:root mode 0600: $lock_path"
done
exec 8<>"$mutation_lock"
flock -n 8 || die 'another deployment mutation, backup or secret update is running'
exec 9<>"$rollback_lock"
flock -n 9 || die 'another PostgreSQL rollback is running'

"$script_dir/preflight-deployment.sh" >/dev/null
if [[ "$rollback_kind" == 'wechat-union-aliases' ]]; then
  "$script_dir/assert-wechat-union-aliases-bridge-runtime.sh" >/dev/null
else
  "$script_dir/assert-phone-only-bridge-runtime.sh" >/dev/null
fi
"$script_dir/verify-runtime.sh" >/dev/null
"$script_dir/verify-database-backup.sh" "$1" >/dev/null
backup_dir="$(realpath -e -- "$1")"
backup_id="$(basename -- "$backup_dir")"
expected_confirmation="ROLLBACK_chi_shen_me_FROM_${backup_id}"
[[ "$3" == "$expected_confirmation" ]] || die "confirmation mismatch; expected: $expected_confirmation"

cd "$bundle_root"

api_container="$(docker compose --env-file deployment.env ps -q api)"
postgres_container="$(docker compose --env-file deployment.env ps -q postgres)"
[[ -n "$api_container" && -n "$postgres_container" ]] || die 'API or PostgreSQL container is missing'
[[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_container")" == 'running/healthy' ]] ||
  die 'API container must be healthy before rollback'
[[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")" == 'running/healthy' ]] ||
  die 'PostgreSQL container must be healthy before rollback'

operation_id="$(date -u +%Y%m%dt%H%M%Sz)"
restore_database="chi_shen_me_restore_${operation_id}"
preserved_database="chi_shen_me_before_rollback_${operation_id}"
failed_database="chi_shen_me_failed_rollback_${operation_id}"

run_bootstrap_psql() {
  local database="$1"
  shift
  docker compose --env-file deployment.env exec -T postgres sh -eu -c \
    'database="$1"; shift; export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" "$@"' \
    sh "$database" "$@"
}

if [[ "$rollback_kind" == 'wechat-union-aliases' ]]; then
  active_release="$(realpath -e -- /opt/chi-shen-me/current)"
  recorded_release="$(sed -n 's/^release_path=//p' "$backup_dir/METADATA.txt")"
  recorded_database_facts="$(sed -n 's/^database_facts=//p' "$backup_dir/METADATA.txt")"
  [[ "$recorded_release" == "$active_release" ]] ||
    die 'WeChat Union alias rollback backup was not produced by the active bridge'
  [[ "$recorded_database_facts" =~ ^chi_shen_me\|[0-9]+\|11$ ]] ||
    die 'WeChat Union alias rollback requires an exact schema 0011 backup'
  [[ "$(wc -l <"$backup_dir/SCHEMA_MIGRATIONS.txt")" -eq 11 ]] ||
    die 'WeChat Union alias rollback backup ledger does not have 11 rows'
  [[ "$(tail -n 1 "$backup_dir/SCHEMA_MIGRATIONS.txt")" =~ ^11\|phone_only_auth\|[0-9a-f]{64}$ ]] ||
    die 'WeChat Union alias rollback backup ledger is not schema 0011'
  downgrade_ready="$(run_bootstrap_psql chi_shen_me -qAt -c \
    "SELECT
       (SELECT count(*) = 12 AND min(version) = 1 AND max(version) = 12
          AND bool_or(version = 12 AND name = 'wechat_union_aliases')
        FROM public.schema_migrations)
       AND to_regclass('public.wechat_union_aliases') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.wechat_union_aliases);" )"
  [[ "$downgrade_ready" == 't' ]] ||
    die 'schema 0012 downgrade is forbidden after any WeChat Union alias was stored'
fi

# psql expands variables in stdin SQL, but sends -c SQL directly to the server.
for candidate in "$restore_database" "$preserved_database" "$failed_database"; do
  existing="$(run_bootstrap_psql postgres -qAt -v candidate="$candidate" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'candidate';
SQL
)"
  [[ -z "$existing" ]] || die "rollback database name already exists: $candidate"
done

safety_output="$("$script_dir/backup-database.sh" --mutation-lock-held)"
safety_backup="$(sed -n 's/^BACKUP_DIRECTORY=//p' <<<"$safety_output")"
[[ "$safety_backup" == /opt/chi-shen-me/backups/postgres/* ]] || die 'pre-rollback safety backup did not complete'

"$script_dir/restore-database.sh" "$backup_dir" "$restore_database" --mutation-lock-held >/dev/null

source_renamed='false'
target_activated='false'
completed='false'
cleanup() {
  local status="$?"
  if [[ "$completed" != 'true' && "$source_renamed" == 'true' ]]; then
    docker compose --env-file deployment.env stop --timeout 30 api >/dev/null 2>&1 || true
    if [[ "$target_activated" == 'true' ]]; then
      run_bootstrap_psql postgres -qAt -v database=chi_shen_me <<'SQL' >/dev/null 2>&1 || true
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'database' AND pid <> pg_backend_pid();
SQL
      run_bootstrap_psql postgres -v current=chi_shen_me -v failed="$failed_database" <<'SQL' >/dev/null 2>&1 || true
ALTER DATABASE :"current" RENAME TO :"failed";
SQL
    fi
    run_bootstrap_psql postgres -v preserved="$preserved_database" -v current=chi_shen_me <<'SQL' >/dev/null 2>&1 || true
ALTER DATABASE :"preserved" RENAME TO :"current";
SQL
    docker compose --env-file deployment.env up -d api >/dev/null 2>&1 || true
    "$script_dir/verify-runtime.sh" >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap cleanup EXIT

docker compose --env-file deployment.env stop --timeout 30 api >/dev/null
run_bootstrap_psql postgres -qAt -v database=chi_shen_me <<'SQL' >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'database' AND pid <> pg_backend_pid();
SQL
run_bootstrap_psql postgres -v current=chi_shen_me -v preserved="$preserved_database" <<'SQL'
ALTER DATABASE :"current" RENAME TO :"preserved";
SQL
source_renamed='true'
run_bootstrap_psql postgres -v restored="$restore_database" -v current=chi_shen_me <<'SQL'
ALTER DATABASE :"restored" RENAME TO :"current";
SQL
target_activated='true'

docker compose --env-file deployment.env up -d api >/dev/null
"$script_dir/verify-runtime.sh" >/dev/null
completed='true'

printf 'POSTGRES_ROLLBACK=OK\n'
printf 'ACTIVE_DATABASE=chi_shen_me\n'
printf 'PRESERVED_PREVIOUS_DATABASE=%s\n' "$preserved_database"
printf 'PRE_ROLLBACK_SAFETY_BACKUP=%s\n' "$safety_backup"
printf 'SOURCE_BACKUP=%s\n' "$backup_dir"
