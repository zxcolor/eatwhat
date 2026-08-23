#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

base_url="${1:-https://api.unfinished-era.com}"
base_url="${base_url%/}"

readiness_body="$(curl --fail --silent --show-error --max-time 10 --noproxy '*' "$base_url/health/ready")"
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' <<<"$readiness_body"

config_body="$(curl --fail --silent --show-error --max-time 10 --noproxy '*' "$base_url/v1/config")"
grep -Eq '"minimumSupportedVersion"' <<<"$config_body"

printf 'PUBLIC_SMOKE=OK\n'
