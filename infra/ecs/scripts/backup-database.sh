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

command -v flock >/dev/null
command -v install >/dev/null
command -v realpath >/dev/null
command -v stat >/dev/null
lock_directory='/run/lock/chi-shen-me'
mutation_lock="$lock_directory/mutation.lock"
backup_lock="$lock_directory/postgres-backup.lock"

if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] || die 'deployment lock directory is unsafe'
else
  install -d -m 700 "$lock_directory"
fi
[[ "$(realpath -e -- "$lock_directory")" == "$lock_directory" ]] || die 'deployment lock directory resolves unexpectedly'
[[ "$(stat -c '%a:%u:%g' "$lock_directory")" == '700:0:0' ]] ||
  die 'deployment lock directory must be root:root mode 0700'

for lock_path in "$mutation_lock" "$backup_lock"; do
  if [[ -e "$lock_path" || -L "$lock_path" ]]; then
    [[ -f "$lock_path" && ! -L "$lock_path" ]] || die "deployment lock is unsafe: $lock_path"
  else
    ( set -o noclobber; : >"$lock_path" ) 2>/dev/null || true
  fi
  [[ -f "$lock_path" && ! -L "$lock_path" ]] || die "deployment lock could not be created safely: $lock_path"
  [[ "$(stat -c '%a:%u:%g' "$lock_path")" == '600:0:0' ]] ||
    die "deployment lock must be root:root mode 0600: $lock_path"
done
exec 8<>"$mutation_lock"
flock -n 8 || die 'another deployment mutation, backup or AMap update is running'
exec 9<>"$backup_lock"
flock -n 9 || die 'another PostgreSQL backup is running'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"
backup_root='/opt/chi-shen-me/backups/postgres'

"$script_dir/preflight-deployment.sh" >/dev/null

cd "$bundle_root"
postgres_db="$(sed -n 's/^POSTGRES_DB=//p' "$deployment_env")"
[[ "$postgres_db" == 'chi_shen_me' ]] || die 'unexpected PostgreSQL database name'

install -d -m 700 /opt/chi-shen-me/backups
install -d -m 700 "$backup_root"

postgres_container="$(docker compose --env-file deployment.env ps -q postgres)"
[[ -n "$postgres_container" ]] || die 'PostgreSQL container is missing'
[[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")" == 'running/healthy' ]] ||
  die 'PostgreSQL container is not healthy'

backup_id="$(date -u +%Y%m%dT%H%M%SZ)"
final_dir="$backup_root/$backup_id"
[[ ! -e "$final_dir" ]] || die "backup already exists: $final_dir"
staging_dir="$(mktemp -d "$backup_root/.staging.${backup_id}.XXXXXX")"
cleanup() {
  if [[ -n "${staging_dir:-}" && -d "$staging_dir" ]]; then
    case "$staging_dir" in
      "$backup_root"/.staging.*) rm -rf -- "$staging_dir" ;;
      *) printf 'refusing to clean unexpected backup staging directory\n' >&2 ;;
    esac
  fi
}
trap cleanup EXIT

dump_path="$staging_dir/chi_shen_me.pgdump"
list_path="$staging_dir/RESTORE_LIST.txt"
metadata_path="$staging_dir/METADATA.txt"

run_bootstrap_psql() {
  docker compose --env-file deployment.env exec -T postgres sh -eu -c \
    'export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' \
    sh "$@"
}

database_size_bytes="$(run_bootstrap_psql -qAt -c 'SELECT pg_database_size(current_database());')"
available_bytes="$(df --output=avail -B1 "$backup_root" | tail -n 1 | tr -d '[:space:]')"
[[ "$database_size_bytes" =~ ^[0-9]+$ && "$available_bytes" =~ ^[0-9]+$ ]] || die 'could not determine backup disk budget'
minimum_available_bytes=$((database_size_bytes * 2 + 536870912))
[[ "$available_bytes" -ge "$minimum_available_bytes" ]] || die 'insufficient free disk space for a safe database backup'

docker compose --env-file deployment.env exec -T postgres sh -eu -c '
  export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"
  export PGSSLMODE=verify-full
  export PGSSLROOTCERT=/run/postgres-tls/ca.crt
  exec pg_dump \
    --host=postgres.internal \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --format=custom \
    --compress=6 \
    --no-owner \
    --no-acl \
    --serializable-deferrable
' >"$dump_path"
[[ -s "$dump_path" ]] || die 'PostgreSQL dump is empty'

docker compose --env-file deployment.env exec -T postgres pg_restore --list \
  <"$dump_path" >"$list_path"
[[ -s "$list_path" ]] || die 'pg_restore list is empty'
grep -q 'schema_migrations' "$list_path" || die 'backup does not contain schema_migrations'

database_facts="$(run_bootstrap_psql -qAt -F '|' -c \
  "SELECT current_database(), pg_database_size(current_database()), count(*) FROM public.schema_migrations;")"
[[ "$database_facts" =~ ^chi_shen_me\|[0-9]+\|[0-9]+$ ]] || die 'could not record database backup facts'

release_path="$(realpath -e /opt/chi-shen-me/current)"
api_container="$(docker compose --env-file deployment.env ps -q api)"
api_image_id='not-running'
if [[ -n "$api_container" ]]; then
  api_image_id="$(docker inspect --format '{{.Image}}' "$api_container")"
fi
postgis_image_id="$(docker inspect --format '{{.Image}}' "$postgres_container")"

{
  printf 'backup_format=chi-shen-me-postgres-v1\n'
  printf 'backup_id=%s\n' "$backup_id"
  printf 'created_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'database_facts=%s\n' "$database_facts"
  printf 'release_path=%s\n' "$release_path"
  printf 'api_image_id=%s\n' "$api_image_id"
  printf 'postgis_image_id=%s\n' "$postgis_image_id"
  printf 'postgres_server_version=%s\n' "$(run_bootstrap_psql -qAt -c 'SHOW server_version')"
} >"$metadata_path"

chmod 600 "$dump_path" "$list_path" "$metadata_path"
(
  cd "$staging_dir"
  sha256sum chi_shen_me.pgdump RESTORE_LIST.txt METADATA.txt >SHA256SUMS
  chmod 600 SHA256SUMS
  sha256sum --check --strict SHA256SUMS >/dev/null
)

mv -T -- "$staging_dir" "$final_dir"
staging_dir=''
chmod 700 "$final_dir"

printf 'POSTGRES_BACKUP=OK\n'
printf 'BACKUP_DIRECTORY=%s\n' "$final_dir"
