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

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
case "$bundle_root" in
  /opt/chi-shen-me/releases/*/deploy) ;;
  *) die "unexpected deployment directory: $bundle_root" ;;
esac

if find "$bundle_root" -xdev -type l -print -quit | grep -q .; then
  die 'deployment bundle must not contain links'
fi

while IFS= read -r path; do
  chown root:root "$path"
  chmod 700 "$path"
done < <(find "$bundle_root" -xdev -type d -print | sort)

while IFS= read -r path; do
  chown root:root "$path"
  case "$path" in
    "$script_dir"/*.sh) chmod 700 "$path" ;;
    *) chmod 600 "$path" ;;
  esac
done < <(find "$bundle_root" -xdev -type f -print | sort)

printf 'RELEASE_PERMISSIONS=OK\n'
printf 'DEPLOYMENT_DIRECTORY=%s\n' "$bundle_root"
