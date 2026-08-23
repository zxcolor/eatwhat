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
[[ "$#" -eq 1 ]] || die 'usage: verify-database-backup.sh BACKUP_DIRECTORY'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"
backup_root='/opt/chi-shen-me/backups/postgres'
backup_dir="$(realpath -e -- "$1")"

case "$backup_dir" in
  "$backup_root"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) die "unexpected PostgreSQL backup directory: $backup_dir" ;;
esac

[[ "$(stat -c '%a:%u:%g' "$backup_dir")" == '700:0:0' ]] || die 'backup directory must be root:root mode 0700'

declare -a required_files=(chi_shen_me.pgdump RESTORE_LIST.txt METADATA.txt SHA256SUMS)
for name in "${required_files[@]}"; do
  path="$backup_dir/$name"
  [[ -f "$path" && ! -L "$path" ]] || die "required backup file is missing or is a link: $name"
  [[ "$(stat -c '%a:%u:%g' "$path")" == '600:0:0' ]] || die "backup file must be root:root mode 0600: $name"
done

actual_file_count="$(find "$backup_dir" -mindepth 1 -maxdepth 1 -type f | wc -l)"
actual_entry_count="$(find "$backup_dir" -mindepth 1 -maxdepth 1 | wc -l)"
[[ "$actual_file_count" -eq 4 && "$actual_entry_count" -eq 4 ]] || die 'backup directory contains an unexpected entry'

(
  cd "$backup_dir"
  [[ "$(wc -l <SHA256SUMS)" -eq 3 ]] || die 'backup checksum manifest must contain exactly three entries'
  grep -Eq '^[0-9a-f]{64}  chi_shen_me\.pgdump$' SHA256SUMS || die 'database dump checksum is missing'
  grep -Eq '^[0-9a-f]{64}  RESTORE_LIST\.txt$' SHA256SUMS || die 'restore-list checksum is missing'
  grep -Eq '^[0-9a-f]{64}  METADATA\.txt$' SHA256SUMS || die 'metadata checksum is missing'
  sha256sum --check --strict SHA256SUMS >/dev/null
)
grep -qx 'backup_format=chi-shen-me-postgres-v1' "$backup_dir/METADATA.txt" || die 'backup metadata format is invalid'
grep -q 'schema_migrations' "$backup_dir/RESTORE_LIST.txt" || die 'backup restore list is incomplete'

postgis_image="$(sed -n 's/^POSTGIS_IMAGE=//p' "$deployment_env")"
postgis_image_id="$(sed -n 's/^POSTGIS_IMAGE_ID=//p' "$deployment_env")"
[[ -n "$postgis_image" && "$postgis_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'PostGIS deployment identity is invalid'
[[ "$(docker image inspect --format '{{.Id}}' "$postgis_image")" == "$postgis_image_id" ]] || die 'PostGIS image ID does not match deployment.env'

generated_list="$(mktemp /tmp/chi-shen-me-restore-list.XXXXXX)"
cleanup() {
  rm -f -- "${generated_list:-}"
}
trap cleanup EXIT

docker run --rm -i --entrypoint pg_restore "$postgis_image" --list \
  <"$backup_dir/chi_shen_me.pgdump" >"$generated_list"
cmp -s "$generated_list" "$backup_dir/RESTORE_LIST.txt" || die 'pg_restore list differs from the recorded restore list'

printf 'POSTGRES_BACKUP_VERIFICATION=OK\n'
printf 'BACKUP_DIRECTORY=%s\n' "$backup_dir"
