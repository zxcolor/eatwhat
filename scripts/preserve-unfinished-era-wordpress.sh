#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

backup_id="${1:?usage: preserve-unfinished-era-wordpress.sh BACKUP_ID [RECOVERY_DOC] [ACTIVE_VHOST_SOURCE]}"
recovery_doc="${2:-}"
active_vhost_source="${3:-}"

case "$backup_id" in
  unfinished-era-offline-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] | \
  unfinished-era-static-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *)
    printf 'invalid backup id: %s\n' "$backup_id" >&2
    exit 2
    ;;
esac

site_domain="www.unfinished-era.com"
site_root="/www/wwwroot/www.unfinished-era.com"
wp_config="$site_root/wp-config.php"
vhost="/www/server/panel/vhost/nginx/www.unfinished-era.com.conf"
cert_dir="/www/server/panel/vhost/cert/www.unfinished-era.com"
backup_parent="/www/backup/manual"
backup_dir="$backup_parent/$backup_id"

if [[ -z "$active_vhost_source" ]]; then
  active_vhost_source="$vhost"
fi

for required_path in "$site_root" "$wp_config" "$vhost" "$active_vhost_source" "$cert_dir"; do
  if [[ ! -e "$required_path" ]]; then
    printf 'required path is missing: %s\n' "$required_path" >&2
    exit 3
  fi
done

if [[ -e "$backup_dir" ]]; then
  printf 'backup directory already exists: %s\n' "$backup_dir" >&2
  exit 4
fi

install -d -m 700 "$backup_parent"
install -d -m 700 "$backup_dir"

cleanup() {
  unset db_password || true
  rm -f -- "$backup_dir"/*.part
}
trap cleanup EXIT

mapfile -d '' -t db_values < <(
  /usr/bin/php -r '
    $content = file_get_contents($argv[1]);
    if ($content === false) {
        exit(10);
    }
    foreach (["DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST"] as $key) {
        $pattern = "/define\\s*\\(\\s*[\"\x27]" . preg_quote($key, "/") . "[\"\x27]\\s*,\\s*[\"\x27]([^\"\x27]*)[\"\x27]\\s*\\)\\s*;/";
        if (!preg_match($pattern, $content, $match)) {
            exit(11);
        }
        echo stripcslashes($match[1]), "\0";
    }
  ' "$wp_config"
)

if [[ "${#db_values[@]}" -ne 4 ]]; then
  printf 'could not parse WordPress database settings\n' >&2
  exit 5
fi

db_name="${db_values[0]}"
db_user="${db_values[1]}"
db_password="${db_values[2]}"
db_host="${db_values[3]}"
unset db_values

if [[ "$db_name" != "www_unfinished_e" || "$db_host" != "localhost" ]]; then
  printf 'unexpected WordPress database mapping; refusing to continue\n' >&2
  exit 6
fi

mysql_base=(/usr/bin/mysql --protocol=socket --socket=/tmp/mysql.sock --user="$db_user" --batch --skip-column-names)
dump_base=(/usr/bin/mysqldump --protocol=socket --socket=/tmp/mysql.sock --user="$db_user")

MYSQL_PWD="$db_password" "${mysql_base[@]}" --execute='SELECT 1' "$db_name" >/dev/null

table_count="$({ MYSQL_PWD="$db_password" "${mysql_base[@]}" --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$db_name' AND table_type = 'BASE TABLE';"; } | tr -d '\r\n')"
if [[ ! "$table_count" =~ ^[0-9]+$ || "$table_count" -lt 1 ]]; then
  printf 'database table count is invalid: %s\n' "$table_count" >&2
  exit 7
fi

sql_archive="$backup_dir/www_unfinished_e.sql.gz"
MYSQL_PWD="$db_password" "${dump_base[@]}" \
  --single-transaction \
  --quick \
  --skip-lock-tables \
  --triggers \
  --hex-blob \
  --default-character-set=utf8mb4 \
  --set-gtid-purged=OFF \
  --no-tablespaces \
  "$db_name" | gzip -6 >"$sql_archive.part"
mv -- "$sql_archive.part" "$sql_archive"

gzip -t "$sql_archive"
dump_table_count="$(gzip -cd "$sql_archive" | grep -c '^CREATE TABLE')"
if [[ "$dump_table_count" != "$table_count" ]]; then
  printf 'database dump table count mismatch: live=%s dump=%s\n' "$table_count" "$dump_table_count" >&2
  exit 8
fi

archive_sources=(
  "www/wwwroot/www.unfinished-era.com"
  "www/server/panel/vhost/nginx/www.unfinished-era.com.conf"
  "www/server/panel/vhost/cert/www.unfinished-era.com"
)

for optional_source in \
  "www/server/panel/vhost/rewrite/www.unfinished-era.com.conf" \
  "www/server/panel/vhost/nginx/well-known/www.unfinished-era.com.conf" \
  "www/server/panel/vhost/nginx/extension/www.unfinished-era.com" \
  "www/server/panel/vhost/nginx/redirect/www.unfinished-era.com"; do
  if [[ -e "/$optional_source" ]]; then
    archive_sources+=("$optional_source")
  fi
done

site_archive="$backup_dir/wordpress-site-and-config.tar.gz"
tar --acls --xattrs --numeric-owner -czf "$site_archive.part" -C / "${archive_sources[@]}"
mv -- "$site_archive.part" "$site_archive"

tar -tzf "$site_archive" >/dev/null
if ! tar -tzf "$site_archive" | grep -qx 'www/wwwroot/www.unfinished-era.com/wp-config.php'; then
  printf 'site archive does not contain wp-config.php\n' >&2
  exit 9
fi

install -m 600 "$vhost" "$backup_dir/vhost-at-snapshot.conf"
install -m 600 "$active_vhost_source" "$backup_dir/vhost-active-before-stop.conf"
/www/server/nginx/sbin/nginx -T >"$backup_dir/nginx-full-config-at-snapshot.txt" 2>&1

find "$site_root" -xdev -type l -printf '%p -> %l\n' >"$backup_dir/site-symlinks.txt"

openssl x509 -in "$cert_dir/fullchain.pem" -noout -subject -issuer -dates -ext subjectAltName >"$backup_dir/CERT_INFO.txt"
cert_public_hash="$(openssl x509 -in "$cert_dir/fullchain.pem" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
key_public_hash="$(openssl pkey -in "$cert_dir/privkey.pem" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
if [[ -z "$cert_public_hash" || "$cert_public_hash" != "$key_public_hash" ]]; then
  printf 'certificate and private key do not match\n' >&2
  exit 13
fi

if [[ -n "$recovery_doc" ]]; then
  if [[ ! -f "$recovery_doc" ]]; then
    printf 'recovery document is missing: %s\n' "$recovery_doc" >&2
    exit 12
  fi
  install -m 600 "$recovery_doc" "$backup_dir/RECOVERY.md"
fi

site_bytes="$(du -sb "$site_root" | awk '{print $1}')"
db_dump_bytes="$(stat -c '%s' "$sql_archive")"
archive_bytes="$(stat -c '%s' "$site_archive")"
archive_entries="$(tar -tzf "$site_archive" | wc -l | tr -d ' ')"
database_engines="$({ MYSQL_PWD="$db_password" "${mysql_base[@]}" --execute="SELECT engine, COUNT(*) FROM information_schema.tables WHERE table_schema = '$db_name' AND table_type = 'BASE TABLE' GROUP BY engine ORDER BY engine;"; } | tr '\t' '=')"
site_state="online"
if grep -q 'CODEX-WORDPRESS-OFFLINE-20260823' "$vhost"; then
  site_state="offline"
fi

{
  printf 'backup_id=%s\n' "$backup_id"
  printf 'created_at=%s\n' "$(date --iso-8601=seconds)"
  printf 'domain=%s\n' "$site_domain"
  printf 'site_state=%s\n' "$site_state"
  printf 'site_root=%s\n' "$site_root"
  printf 'database=%s\n' "$db_name"
  printf 'database_host=%s\n' "$db_host"
  printf 'database_tables=%s\n' "$table_count"
  printf 'database_dump_tables=%s\n' "$dump_table_count"
  printf 'database_engines=%s\n' "$database_engines"
  printf 'site_source_bytes=%s\n' "$site_bytes"
  printf 'site_archive_bytes=%s\n' "$archive_bytes"
  printf 'site_archive_entries=%s\n' "$archive_entries"
  printf 'database_dump_bytes=%s\n' "$db_dump_bytes"
  printf 'mysqldump=%s\n' "$(/usr/bin/mysqldump --version)"
  printf 'nginx=%s\n' "$(/www/server/nginx/sbin/nginx -v 2>&1)"
  printf 'php=%s\n' "$(/usr/bin/php -v | head -n 1)"
} >"$backup_dir/BACKUP_INFO.txt"

(
  cd "$backup_dir"
  checksum_files=(
    BACKUP_INFO.txt
    CERT_INFO.txt
    nginx-full-config-at-snapshot.txt
    site-symlinks.txt
    vhost-at-snapshot.conf
    vhost-active-before-stop.conf
    wordpress-site-and-config.tar.gz
    www_unfinished_e.sql.gz
  )
  if [[ -f RECOVERY.md ]]; then
    checksum_files+=(RECOVERY.md)
  fi
  sha256sum "${checksum_files[@]}" >SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)

chmod 600 "$backup_dir"/*
unset db_password

printf 'BACKUP_DIR=%s\n' "$backup_dir"
printf 'TABLE_COUNT=%s\n' "$table_count"
printf 'ARCHIVE_ENTRIES=%s\n' "$archive_entries"
printf 'VERIFICATION=OK\n'
