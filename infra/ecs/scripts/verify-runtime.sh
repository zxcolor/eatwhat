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

read_deployment_setting() {
  local name="$1"
  local -a matches=()
  mapfile -t matches < <(grep -F "${name}=" "$deployment_env" || true)
  if [[ "${#matches[@]}" -ne 1 || "${matches[0]}" != "${name}="* || -z "${matches[0]#*=}" ]]; then
    printf 'missing or duplicate deployment setting: %s\n' "$name" >&2
    exit 2
  fi
  printf '%s' "${matches[0]#*=}"
}

read_boolean_setting() {
  local name="$1"
  local value
  value="$(read_deployment_setting "$name")"
  if [[ ! "$value" =~ ^(true|false)$ ]]; then
    printf 'invalid deployment boolean: %s\n' "$name" >&2
    exit 2
  fi
  printf '%s' "$value"
}

read_identity_state_setting() {
  local path="$1"
  local name="$2"
  local -a matches=()
  mapfile -t matches < <(grep -E "^${name}=" "$path" || true)
  if [[ "${#matches[@]}" -ne 1 || -z "${matches[0]#*=}" ]]; then
    printf 'missing or duplicate shared QQ identity setting: %s\n' "$name" >&2
    exit 2
  fi
  printf '%s' "${matches[0]#*=}"
}

expected_schema_transition_mode="$(read_deployment_setting AUTH_SCHEMA_TRANSITION_MODE)"
expected_shared_state_directory="$(read_deployment_setting SHARED_STATE_DIRECTORY)"
expected_wechat_realm_id="$(read_deployment_setting WECHAT_OPEN_PLATFORM_REALM_ID)"
expected_qq_realm_id="$(read_deployment_setting QQ_OPEN_PLATFORM_REALM_ID)"
expected_accounts_enabled="$(read_boolean_setting ACCOUNTS_ENABLED)"
expected_phone_enabled="$(read_boolean_setting PHONE_AUTH_ENABLED)"
expected_wechat_enabled="$(read_boolean_setting WECHAT_AUTH_ENABLED)"
expected_email_enabled="$(read_boolean_setting EMAIL_AUTH_ENABLED)"
expected_qq_enabled="$(read_boolean_setting QQ_AUTH_ENABLED)"
expected_qq_union_id_enabled="$(read_boolean_setting QQ_UNION_ID_ENABLED)"
[[ "$expected_schema_transition_mode" == 'none' ||
   "$expected_schema_transition_mode" == 'legacy_phone_drain' ||
   "$expected_schema_transition_mode" == 'wechat_union_aliases_pending' ]] || {
  printf 'invalid AUTH_SCHEMA_TRANSITION_MODE\n' >&2
  exit 2
}
[[ "$expected_wechat_realm_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || {
  printf 'invalid WECHAT_OPEN_PLATFORM_REALM_ID\n' >&2
  exit 2
}
[[ "$expected_qq_realm_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || {
  printf 'invalid QQ_OPEN_PLATFORM_REALM_ID\n' >&2
  exit 2
}
if [[ "$expected_shared_state_directory" != '/opt/chi-shen-me/shared' ]]; then
  printf 'invalid SHARED_STATE_DIRECTORY\n' >&2
  exit 2
fi
qq_identity_state_file="$expected_shared_state_directory/auth-identity-state.env"
expected_qq_union_id_namespace_initialized='false'
if [[ -e "$qq_identity_state_file" || -L "$qq_identity_state_file" ]]; then
  if [[ ! -f "$qq_identity_state_file" || -L "$qq_identity_state_file" ||
        "$(stat -c '%a:%u:%g' "$qq_identity_state_file")" != '600:0:0' ]]; then
    printf 'shared QQ identity state must be a root-only regular file\n' >&2
    exit 2
  fi
  mapfile -t qq_identity_state_lines <"$qq_identity_state_file"
  if [[ "${#qq_identity_state_lines[@]}" -ne 3 ]]; then
    printf 'shared QQ identity state must contain exactly three settings\n' >&2
    exit 2
  fi
  identity_state_format_version="$(
    read_identity_state_setting "$qq_identity_state_file" AUTH_IDENTITY_STATE_FORMAT_VERSION
  )"
  persisted_qq_realm_id="$(
    read_identity_state_setting "$qq_identity_state_file" QQ_OPEN_PLATFORM_REALM_ID
  )"
  persisted_qq_namespace_initialized="$(
    read_identity_state_setting "$qq_identity_state_file" QQ_UNION_ID_NAMESPACE_INITIALIZED
  )"
  for state_line in "${qq_identity_state_lines[@]}"; do
    [[ "$state_line" =~ ^(AUTH_IDENTITY_STATE_FORMAT_VERSION|QQ_OPEN_PLATFORM_REALM_ID|QQ_UNION_ID_NAMESPACE_INITIALIZED)=.+$ ]] || {
      printf 'unexpected shared QQ identity setting\n' >&2
      exit 2
    }
  done
  if [[ "$identity_state_format_version" != '1' ]]; then
    printf 'unsupported shared QQ identity state format\n' >&2
    exit 2
  fi
  if [[ "$persisted_qq_realm_id" != "$expected_qq_realm_id" ]]; then
    printf 'shared QQ identity realm differs from deployment.env\n' >&2
    exit 2
  fi
  if [[ "$persisted_qq_namespace_initialized" != 'true' &&
        "$persisted_qq_namespace_initialized" != 'false' ]]; then
    printf 'invalid shared QQ UnionID namespace marker\n' >&2
    exit 2
  fi
  expected_qq_union_id_namespace_initialized="$persisted_qq_namespace_initialized"
else
  if [[ "$expected_qq_enabled" != 'false' ]]; then
    printf 'QQ authentication requires initialized shared identity state\n' >&2
    exit 2
  fi
fi
if [[ "$expected_qq_union_id_enabled" == 'true' && "$expected_qq_enabled" != 'true' ]]; then
  printf 'QQ_UNION_ID_ENABLED requires QQ_AUTH_ENABLED=true\n' >&2
  exit 2
fi
if [[ "$expected_qq_union_id_enabled" == 'true' && "$expected_qq_union_id_namespace_initialized" != 'true' ]]; then
  printf 'QQ_UNION_ID_ENABLED requires an initialized QQ UnionID namespace\n' >&2
  exit 2
fi
if [[ "$expected_qq_union_id_namespace_initialized" == 'true' &&
      "$expected_qq_enabled" == 'true' && "$expected_qq_union_id_enabled" != 'true' ]]; then
  printf 'initialized QQ UnionID namespace requires UnionID whenever QQ authentication is enabled\n' >&2
  exit 2
fi
if [[ "$expected_schema_transition_mode" == 'wechat_union_aliases_pending' &&
      "$expected_wechat_enabled" != 'false' ]]; then
  printf 'wechat_union_aliases_pending requires WECHAT_AUTH_ENABLED=false\n' >&2
  exit 2
fi
expected_registration_enabled='false'
if [[ "$expected_accounts_enabled" == 'true' && "$expected_phone_enabled" == 'true' ]]; then
  expected_registration_enabled='true'
fi

cd "$bundle_root"
docker compose --env-file deployment.env config --quiet

api_container="$(docker compose --env-file deployment.env ps -q api)"
postgres_container="$(docker compose --env-file deployment.env ps -q postgres)"
if [[ -z "$api_container" || -z "$postgres_container" ]]; then
  printf 'api or postgres container is missing\n' >&2
  exit 2
fi

assert_api_container_env() {
  local expected="$1"
  local actual
  actual="$(docker inspect --format \
    "{{range .Config.Env}}{{if eq . \"$expected\"}}{{println .}}{{end}}{{end}}" \
    "$api_container")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'API container environment differs from deployment.env: %s\n' "${expected%%=*}" >&2
    exit 2
  fi
}

assert_api_container_env "AUTH_SCHEMA_TRANSITION_MODE=$expected_schema_transition_mode"
assert_api_container_env "WECHAT_OPEN_PLATFORM_REALM_ID=$expected_wechat_realm_id"
assert_api_container_env "WECHAT_AUTH_ENABLED=$expected_wechat_enabled"
assert_api_container_env "QQ_OPEN_PLATFORM_REALM_ID=$expected_qq_realm_id"
assert_api_container_env "QQ_AUTH_ENABLED=$expected_qq_enabled"
assert_api_container_env "QQ_UNION_ID_ENABLED=$expected_qq_union_id_enabled"

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

config_body="$(curl --fail --silent --show-error --max-time 5 --noproxy '*' "http://127.0.0.1:$api_loopback_port/v1/config")"
if ! printf '%s' "$config_body" | docker exec -i --user node "$api_container" node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const config = JSON.parse(raw);
    const auth = config.authCapabilities;
    const names = [
      "accountsEnabled",
      "registrationEnabled",
      "phoneEnabled",
      "wechatEnabled",
      "emailEnabled",
      "qqEnabled",
    ];
    const expected = process.argv.slice(1);
    if (auth === null || typeof auth !== "object" || expected.length !== names.length) {
      process.exit(2);
    }
    for (let index = 0; index < names.length; index += 1) {
      if (typeof auth[names[index]] !== "boolean" || auth[names[index]] !== (expected[index] === "true")) {
        process.exit(3);
      }
    }
  } catch {
    process.exit(4);
  }
});
' "$expected_accounts_enabled" "$expected_registration_enabled" "$expected_phone_enabled" \
    "$expected_wechat_enabled" "$expected_email_enabled" "$expected_qq_enabled"; then
  printf 'public authentication capabilities do not match deployment.env\n' >&2
  exit 6
fi

if ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)5432$'; then
  printf 'PostgreSQL must not publish a host listener\n' >&2
  exit 4
fi
if ! ss -ltnH | awk '{print $4}' | grep -qx "127.0.0.1:$api_loopback_port"; then
  printf 'API loopback listener is missing\n' >&2
  exit 5
fi

printf 'RUNTIME_VERIFICATION=OK\n'
