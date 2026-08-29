#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

[[ "$(id -u)" -eq 0 ]] || die 'run as root'
[[ "$#" -eq 0 ]] || die 'usage: assert-wechat-union-aliases-bridge-runtime.sh'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"
current_link='/opt/chi-shen-me/current'

read_deployment_value() {
  local name="$1"
  local value
  value="$(sed -n "s/^${name}=//p" "$deployment_env")"
  [[ -n "$value" && "$value" != *$'\n'* ]] ||
    die "missing or duplicate deployment setting: $name"
  printf '%s' "$value"
}

[[ -L "$current_link" ]] || die 'WeChat Union alias transition requires an active bridge'
[[ "$(stat -c '%u:%g' "$current_link")" == '0:0' ]] ||
  die 'active release link must be owned by root'
active_release="$(realpath -e -- "$current_link")"
[[ "$bundle_root" == "$active_release/deploy" ]] ||
  die 'WeChat Union alias transition must run from the active bridge'

[[ "$(read_deployment_value AUTH_SCHEMA_TRANSITION_MODE)" == 'wechat_union_aliases_pending' ]] ||
  die 'WeChat Union alias transition requires wechat_union_aliases_pending'
[[ "$(read_deployment_value WECHAT_AUTH_ENABLED)" == 'false' ]] ||
  die 'WeChat Union alias transition requires WECHAT_AUTH_ENABLED=false'

expected_api_image_id="$(read_deployment_value API_IMAGE_ID)"
[[ "$expected_api_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die 'active bridge API_IMAGE_ID is invalid'

cd "$bundle_root"
docker compose --env-file deployment.env config --quiet
api_container="$(docker compose --env-file deployment.env ps -q api)"
postgres_container="$(docker compose --env-file deployment.env ps -q postgres)"
[[ -n "$api_container" && -n "$postgres_container" ]] ||
  die 'active bridge API or PostgreSQL container is missing'
[[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_container")" == 'running/healthy' ]] ||
  die 'active bridge API container must be running and healthy'
[[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")" == 'running/healthy' ]] ||
  die 'active bridge PostgreSQL container must be running and healthy'
[[ "$(docker inspect --format '{{.Image}}' "$api_container")" == "$expected_api_image_id" ]] ||
  die 'active bridge API container image differs from deployment.env'

assert_container_env() {
  local expected="$1"
  local actual
  actual="$(docker inspect --format \
    "{{range .Config.Env}}{{if eq . \"$expected\"}}{{println .}}{{end}}{{end}}" \
    "$api_container")"
  [[ "$actual" == "$expected" ]] ||
    die "active bridge API container environment mismatch: ${expected%%=*}"
}

assert_container_env 'AUTH_SCHEMA_TRANSITION_MODE=wechat_union_aliases_pending'
assert_container_env 'WECHAT_AUTH_ENABLED=false'
"$script_dir/verify-runtime.sh" >/dev/null

printf 'WECHAT_UNION_ALIASES_BRIDGE_RUNTIME=OK\n'
