#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

usage() {
  printf 'usage: rollback-database.sh BACKUP_DIRECTORY --execute CONFIRMATION\n' >&2
  exit 2
}

if [[ "$(id -u)" -ne 0 ]]; then
  die 'run as root'
fi
[[ "$#" -eq 3 && "$2" == '--execute' ]] || usage

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
"$script_dir/preflight-deployment.sh" >/dev/null
"$script_dir/verify-database-backup.sh" "$1" >/dev/null
backup_dir="$(realpath -e -- "$1")"
backup_id="$(basename -- "$backup_dir")"
expected_confirmation="ROLLBACK_chi_shen_me_FROM_${backup_id}"
[[ "$3" == "$expected_confirmation" ]] || die "confirmation mismatch; expected: $expected_confirmation"

cd "$bundle_root"
command -v flock >/dev/null
exec 8>/run/lock/chi-shen-me-postgres-rollback.lock
flock -n 8 || die 'another PostgreSQL rollback is running'

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

for candidate in "$restore_database" "$preserved_database" "$failed_database"; do
  existing="$(run_bootstrap_psql postgres -qAt -v candidate="$candidate" -c "SELECT 1 FROM pg_database WHERE datname = :'candidate';")"
  [[ -z "$existing" ]] || die "rollback database name already exists: $candidate"
done

safety_output="$("$script_dir/backup-database.sh")"
safety_backup="$(sed -n 's/^BACKUP_DIRECTORY=//p' <<<"$safety_output")"
[[ "$safety_backup" == /opt/chi-shen-me/backups/postgres/* ]] || die 'pre-rollback safety backup did not complete'

"$script_dir/restore-database.sh" "$backup_dir" "$restore_database" >/dev/null

source_renamed='false'
target_activated='false'
completed='false'
cleanup() {
  local status="$?"
  if [[ "$completed" != 'true' && "$source_renamed" == 'true' ]]; then
    docker compose --env-file deployment.env stop --timeout 30 api >/dev/null 2>&1 || true
    if [[ "$target_activated" == 'true' ]]; then
      run_bootstrap_psql postgres -qAt -v database=chi_shen_me -c \
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'database' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
      run_bootstrap_psql postgres -v current=chi_shen_me -v failed="$failed_database" -c \
        'ALTER DATABASE :"current" RENAME TO :"failed";' >/dev/null 2>&1 || true
    fi
    run_bootstrap_psql postgres -v preserved="$preserved_database" -v current=chi_shen_me -c \
      'ALTER DATABASE :"preserved" RENAME TO :"current";' >/dev/null 2>&1 || true
    docker compose --env-file deployment.env up -d api >/dev/null 2>&1 || true
    "$script_dir/verify-runtime.sh" >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap cleanup EXIT

docker compose --env-file deployment.env stop --timeout 30 api >/dev/null
run_bootstrap_psql postgres -qAt -v database=chi_shen_me -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'database' AND pid <> pg_backend_pid();" >/dev/null
run_bootstrap_psql postgres -v current=chi_shen_me -v preserved="$preserved_database" -c \
  'ALTER DATABASE :"current" RENAME TO :"preserved";'
source_renamed='true'
run_bootstrap_psql postgres -v restored="$restore_database" -v current=chi_shen_me -c \
  'ALTER DATABASE :"restored" RENAME TO :"current";'
target_activated='true'

docker compose --env-file deployment.env up -d api >/dev/null
"$script_dir/verify-runtime.sh" >/dev/null
completed='true'

printf 'POSTGRES_ROLLBACK=OK\n'
printf 'ACTIVE_DATABASE=chi_shen_me\n'
printf 'PRESERVED_PREVIOUS_DATABASE=%s\n' "$preserved_database"
printf 'PRE_ROLLBACK_SAFETY_BACKUP=%s\n' "$safety_backup"
printf 'SOURCE_BACKUP=%s\n' "$backup_dir"
