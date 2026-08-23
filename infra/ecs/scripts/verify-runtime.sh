#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"
api_loopback_port="$(sed -n 's/^API_LOOPBACK_PORT=//p' "$deployment_env")"
if [[ -z "$api_loopback_port" || "$api_loopback_port" == *$'\n'* || ! "$api_loopback_port" =~ ^[0-9]+$ || "$api_loopback_port" -lt 1024 || "$api_loopback_port" -gt 65535 ]]; then
  printf 'missing, duplicate or invalid API_LOOPBACK_PORT\n' >&2
  exit 2
fi

cd "$bundle_root"
docker compose --env-file deployment.env config --quiet

api_container="$(docker compose --env-file deployment.env ps -q api)"
postgres_container="$(docker compose --env-file deployment.env ps -q postgres)"
if [[ -z "$api_container" || -z "$postgres_container" ]]; then
  printf 'api or postgres container is missing\n' >&2
  exit 2
fi

api_state=""
postgres_state=""
for attempt in $(seq 1 31); do
  api_state="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api_container")"
  postgres_state="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")"
  if [[ "$api_state" == "running/healthy" && "$postgres_state" == "running/healthy" ]]; then
    break
  fi
  if [[ "$attempt" -lt 31 ]]; then
    sleep 2
  fi
done
if [[ "$api_state" != "running/healthy" ]]; then
  printf 'container is not healthy: %s %s\n' "$api_container" "$api_state" >&2
  exit 3
fi
if [[ "$postgres_state" != "running/healthy" ]]; then
  printf 'container is not healthy: %s %s\n' "$postgres_container" "$postgres_state" >&2
  exit 3
fi

readiness_body="$(curl --fail --silent --show-error --max-time 5 --noproxy '*' "http://127.0.0.1:$api_loopback_port/health/ready")"
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' <<<"$readiness_body"

if ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)5432$'; then
  printf 'PostgreSQL must not publish a host listener\n' >&2
  exit 4
fi
if ! ss -ltnH | awk '{print $4}' | grep -qx "127.0.0.1:$api_loopback_port"; then
  printf 'API loopback listener is missing\n' >&2
  exit 5
fi

printf 'RUNTIME_VERIFICATION=OK\n'
