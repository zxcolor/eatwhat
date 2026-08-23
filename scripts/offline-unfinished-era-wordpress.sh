#!/usr/bin/env bash

set -Eeuo pipefail

backup_dir="${1:?usage: offline-unfinished-era-wordpress.sh VERIFIED_BACKUP_DIR}"
vhost="/www/server/panel/vhost/nginx/www.unfinished-era.com.conf"
stop_page="/www/server/stop/bt-stop.html"
nginx="/www/server/nginx/sbin/nginx"

case "$backup_dir" in
  /www/backup/manual/unfinished-era-offline-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *)
    printf 'unexpected backup directory: %s\n' "$backup_dir" >&2
    exit 2
    ;;
esac

for required_path in "$backup_dir/SHA256SUMS" "$backup_dir/vhost-active-before-stop.conf" "$vhost" "$stop_page"; do
  if [[ ! -e "$required_path" ]]; then
    printf 'required path is missing: %s\n' "$required_path" >&2
    exit 3
  fi
done

(
  cd "$backup_dir"
  sha256sum -c SHA256SUMS >/dev/null
)

if ! cmp -s "$backup_dir/vhost-active-before-stop.conf" "$vhost"; then
  printf 'live vhost changed after backup; refusing to stop the site\n' >&2
  exit 4
fi

if [[ "$(sha256sum "$stop_page" | awk '{print $1}')" != "bf21a7489a5bbb1e04e6ad11a83e47c958b4da1610a5c272c0d2ddd5822f47d2" ]]; then
  printf 'BaoTa stop page changed; refusing to continue\n' >&2
  exit 5
fi

temporary_vhost="$(mktemp /www/server/panel/vhost/nginx/.www.unfinished-era.com.offline.XXXXXX)"
rollback_vhost="$(mktemp /tmp/www.unfinished-era.com.rollback.XXXXXX)"

cleanup() {
  rm -f -- "$temporary_vhost" "$rollback_vhost"
}
trap cleanup EXIT

cp -a -- "$vhost" "$rollback_vhost"

awk '
  BEGIN { replacements = 0 }
  $0 == "    root /www/wwwroot/www.unfinished-era.com;" {
    print "    # CODEX-WORDPRESS-OFFLINE-20260823"
    print "    root /www/server/stop;"
    print ""
    print "    rewrite ^/(?!bt-stop\\.html$).* /bt-stop.html last;"
    print "    location = /bt-stop.html {"
    print "        root /www/server/stop;"
    print "        internal;"
    print "    }"
    replacements++
    next
  }
  { print }
  END {
    if (replacements != 1) {
      exit 42
    }
  }
' "$vhost" >"$temporary_vhost"

chown --reference="$vhost" "$temporary_vhost"
chmod --reference="$vhost" "$temporary_vhost"
mv -f -- "$temporary_vhost" "$vhost"

if ! "$nginx" -t; then
  cp -a -- "$rollback_vhost" "$vhost"
  printf 'nginx validation failed; original vhost restored\n' >&2
  exit 6
fi

if ! "$nginx" -s reload; then
  cp -a -- "$rollback_vhost" "$vhost"
  "$nginx" -t
  "$nginx" -s reload
  printf 'nginx reload failed; original vhost restored and reloaded\n' >&2
  exit 7
fi

sleep 1

for scheme in http https; do
  port=80
  curl_options=()
  if [[ "$scheme" == "https" ]]; then
    port=443
    curl_options=(-k)
  fi
  for domain in www.unfinished-era.com unfinished-era.com; do
    body_hash="$(curl "${curl_options[@]}" --resolve "$domain:$port:127.0.0.1" -sS -L --max-redirs 3 "$scheme://$domain/" | sha256sum | awk '{print $1}')"
    if [[ "$body_hash" != "bf21a7489a5bbb1e04e6ad11a83e47c958b4da1610a5c272c0d2ddd5822f47d2" ]]; then
      cp -a -- "$rollback_vhost" "$vhost"
      "$nginx" -t
      "$nginx" -s reload
      printf 'stop-page verification failed for %s://%s; original vhost restored\n' "$scheme" "$domain" >&2
      exit 8
    fi
  done
done

printf 'SITE_STATUS=OFFLINE\n'
printf 'VHOST=%s\n' "$vhost"
printf 'STOP_PAGE_VERIFICATION=OK\n'
