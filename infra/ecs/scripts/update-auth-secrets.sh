#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

usage() {
  printf '%s\n' \
    'usage:' \
    '  update-auth-secrets.sh --apply --config-file FILE' \
    '  update-auth-secrets.sh --disable' \
    '  update-auth-secrets.sh --legacy-drain' >&2
  exit 2
}

[[ "$(id -u)" -eq 0 ]] || die 'run as root'

mode=''
config_file=''
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --apply|--disable|--legacy-drain)
      [[ -z "$mode" ]] || usage
      mode="$1"
      shift
      ;;
    --config-file)
      [[ "$#" -ge 2 && -z "$config_file" ]] || usage
      config_file="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
[[ -n "$mode" ]] || usage
if [[ "$mode" == '--apply' ]]; then
  [[ -n "$config_file" ]] || usage
else
  [[ -z "$config_file" ]] || usage
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"
shared_state_directory='/opt/chi-shen-me/shared'
secrets_dir="$shared_state_directory/secrets"
api_env="$secrets_dir/api.env"
qq_identity_state_file="$shared_state_directory/auth-identity-state.env"
preflight="$script_dir/preflight-deployment.sh"

case "$bundle_root" in
  /opt/chi-shen-me/releases/*/deploy) ;;
  *) die "unexpected deployment directory: $bundle_root" ;;
esac

assert_root_file() {
  local path="$1" expected_mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || die "required regular file is missing or is a link: $path"
  [[ "$(stat -c '%a:%u:%g' "$path")" == "$expected_mode:0:0" ]] ||
    die "file must be root:root mode 0$expected_mode: $path"
}

assert_root_directory() {
  local path="$1" expected_mode="$2"
  [[ -d "$path" && ! -L "$path" ]] || die "required directory is missing or is a link: $path"
  [[ "$(stat -c '%a:%u:%g' "$path")" == "$expected_mode:0:0" ]] ||
    die "directory must be root:root mode 0$expected_mode: $path"
}

read_env_value() {
  local path="$1" name="$2"
  local -a matches=()
  mapfile -t matches < <(grep -E "^${name}=" "$path" || true)
  [[ "${#matches[@]}" -eq 1 ]] || die "missing or duplicate setting in $path: $name"
  [[ -n "${matches[0]#*=}" ]] || die "empty setting in $path: $name"
  printf '%s' "${matches[0]#*=}"
}

assert_exact_env_keys() {
  local path="$1"
  shift
  local -A expected=() actual=()
  local name line
  for name in "$@"; do expected["$name"]=1; done
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] || die "invalid environment line in $path"
    name="${line%%=*}"
    [[ -z "${actual[$name]+x}" ]] || die "duplicate environment key in $path: $name"
    actual["$name"]=1
  done <"$path"
  [[ "${#actual[@]}" -eq "${#expected[@]}" ]] || die "unexpected environment key count in $path"
  for name in "${!expected[@]}"; do
    [[ -n "${actual[$name]+x}" ]] || die "required environment key is missing from $path: $name"
  done
}

count_present_env_keys() {
  local path="$1"
  shift
  local count=0 name
  for name in "$@"; do
    if grep -Eq "^${name}=" "$path"; then
      read_env_value "$path" "$name" >/dev/null
      count=$((count + 1))
    fi
  done
  printf '%s' "$count"
}

assert_same_env_values() {
  local before="$1" after="$2" reason="$3"
  shift 3
  local name
  for name in "$@"; do
    [[ "$(read_env_value "$before" "$name")" == "$(read_env_value "$after" "$name")" ]] ||
      die "$reason: $name"
  done
}

resolve_active_deploy() {
  local current_link='/opt/chi-shen-me/current'
  local active_release active_deploy_path

  [[ -L "$current_link" ]] || die 'authentication updates require an active immutable release'
  [[ "$(stat -c '%u:%g' "$current_link")" == '0:0' ]] ||
    die 'active release link must be owned by root'
  active_release="$(readlink -- "$current_link")"
  [[ "$active_release" =~ ^/opt/chi-shen-me/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    die 'active release link must directly name an immutable release'
  [[ -d "$active_release" && ! -L "$active_release" ]] ||
    die 'active release directory is unavailable or is a link'
  [[ "$(realpath -e -- "$current_link")" == "$active_release" ]] ||
    die 'active release link resolves unexpectedly'
  [[ "$(stat -c '%a:%u:%g' "$active_release")" == '700:0:0' ]] ||
    die 'active release must be root:root mode 0700'

  active_deploy_path="$active_release/deploy"
  assert_root_directory "$active_deploy_path" 700
  assert_root_file "$active_deploy_path/deployment.env" 600
  assert_root_file "$active_deploy_path/scripts/verify-runtime.sh" 700
  [[ -x "$active_deploy_path/scripts/verify-runtime.sh" ]] ||
    die 'active runtime verifier is not executable'
  printf '%s' "$active_deploy_path"
}

assert_phone_only_cutover_ready() {
  local require_bridge="$1"
  local current_link='/opt/chi-shen-me/current'
  local active_release active_deploy active_deployment_env active_runtime_verifier
  local active_transition active_switch postgres_container database_acl_ready

  [[ -L "$current_link" ]] || die 'active release must be the legacy phone drain bridge before retiring legacy authentication configuration'
  [[ "$(stat -c '%u:%g' "$current_link")" == '0:0' ]] ||
    die 'active release link must be owned by root'
  active_release="$(readlink -- "$current_link")"
  [[ "$active_release" =~ ^/opt/chi-shen-me/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    die 'active release link must directly name an immutable release'
  [[ -d "$active_release" && ! -L "$active_release" ]] ||
    die 'active release directory is unavailable or is a link'
  [[ "$(realpath -e -- "$current_link")" == "$active_release" ]] ||
    die 'active release link resolves unexpectedly'
  [[ "$(stat -c '%a:%u:%g' "$active_release")" == '700:0:0' ]] ||
    die 'active release must be root:root mode 0700'

  active_deploy="$active_release/deploy"
  active_deployment_env="$active_deploy/deployment.env"
  active_runtime_verifier="$active_deploy/scripts/verify-runtime.sh"
  [[ -d "$active_deploy" && ! -L "$active_deploy" ]] ||
    die 'active deployment directory is unavailable or is a link'
  assert_root_file "$active_deployment_env" 600
  assert_root_file "$active_runtime_verifier" 700
  [[ -x "$active_runtime_verifier" ]] || die 'active runtime verifier is not executable'

  active_transition="$(read_env_value "$active_deployment_env" AUTH_SCHEMA_TRANSITION_MODE)"
  if [[ "$active_transition" == 'legacy_phone_drain' ]]; then
    for active_switch in \
      ACCOUNTS_ENABLED PHONE_AUTH_ENABLED EMAIL_AUTH_ENABLED WECHAT_AUTH_ENABLED \
      QQ_AUTH_ENABLED QQ_UNION_ID_ENABLED; do
      [[ "$(read_env_value "$active_deployment_env" "$active_switch")" == 'false' ]] ||
        die 'active legacy phone drain bridge must keep accounts and every authentication channel disabled'
    done
  elif [[ "$require_bridge" == 'true' ]]; then
    die 'legacy Fusion, SMS and associated WeChat configuration can only be retired from the active legacy phone drain bridge'
  else
    [[ "$active_transition" == 'none' ]] || die 'active release has an unsupported authentication schema transition mode'
  fi

  "$active_runtime_verifier" >/dev/null
  postgres_container="$(
    cd "$active_deploy"
    docker compose --env-file deployment.env ps -q postgres
  )"
  [[ -n "$postgres_container" ]] || die 'active bridge PostgreSQL container is missing'
  [[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")" == 'running/healthy' ]] ||
    die 'active bridge PostgreSQL container is not healthy'

  database_acl_ready="$(
    cd "$active_deploy"
    docker compose --env-file deployment.env exec -T postgres sh -eu -c \
      'export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT (
  EXISTS (
    SELECT 1
    FROM public.schema_migrations
    WHERE version = 11 AND name = 'phone_only_auth'
  )
  AND has_function_privilege(
    'api_runtime',
    'public.register_phone_account_from_consumed_otp(uuid,uuid,character varying)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'api_runtime',
    'public.register_fusion_phone_wechat_account(uuid,uuid,uuid,character varying,character varying)',
    'EXECUTE'
  )
  AND NOT has_table_privilege('api_runtime', 'public.fusion_auth_flows', 'SELECT')
  AND has_function_privilege(
    'retention_worker', 'public.preview_fusion_auth_retention_cleanup()', 'EXECUTE'
  )
  AND has_function_privilege(
    'retention_worker', 'public.execute_fusion_auth_retention_cleanup()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'api_runtime', 'public.preview_fusion_auth_retention_cleanup()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'api_runtime', 'public.execute_fusion_auth_retention_cleanup()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'admin_api_runtime', 'public.preview_fusion_auth_retention_cleanup()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'admin_api_runtime', 'public.execute_fusion_auth_retention_cleanup()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'data_export_worker', 'public.preview_fusion_auth_retention_cleanup()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'data_export_worker', 'public.execute_fusion_auth_retention_cleanup()', 'EXECUTE'
  )
);
SQL
  )"
  [[ "$database_acl_ready" == 't' ]] ||
    die 'phone-only migration and least-privilege ACL smoke must pass before updating authentication configuration'
}

assert_wechat_union_aliases_ready() {
  local active_transition active_realm candidate_realm
  local postgres_container database_acl_ready

  active_transition="$(read_env_value "$active_deploy/deployment.env" AUTH_SCHEMA_TRANSITION_MODE)"
  [[ "$active_transition" == 'none' ]] ||
    die 'WeChat authentication requires the final non-transition schema 0013 release'
  active_realm="$(read_env_value "$active_deploy/deployment.env" WECHAT_OPEN_PLATFORM_REALM_ID)"
  candidate_realm="$(read_env_value "$deployment_env" WECHAT_OPEN_PLATFORM_REALM_ID)"
  [[ "$active_realm" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
    die 'WeChat authentication requires a stable Open Platform realm'
  [[ "$active_realm" == "$candidate_realm" ]] ||
    die 'candidate release must preserve the active WeChat Open Platform realm'
  "$active_deploy/scripts/verify-runtime.sh" >/dev/null

  postgres_container="$(
    cd "$active_deploy"
    docker compose --env-file deployment.env ps -q postgres
  )"
  [[ -n "$postgres_container" ]] || die 'active PostgreSQL container is missing'
  [[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")" == 'running/healthy' ]] ||
    die 'active PostgreSQL container is not healthy'
  database_acl_ready="$(
    cd "$active_deploy"
    docker compose --env-file deployment.env exec -T postgres sh -eu -c \
      'export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -v expected_wechat_realm="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      sh "$active_realm" <<'SQL'
SELECT (
  (SELECT count(*) = 13 AND min(version) = 1 AND max(version) = 13
     AND bool_or(version = 12 AND name = 'wechat_union_aliases')
     AND bool_or(version = 13 AND name = 'admin_config_control')
   FROM public.schema_migrations)
  AND to_regclass('public.wechat_union_aliases') IS NOT NULL
  AND has_function_privilege(
    'api_runtime',
    'public.consume_oauth_state_with_wechat_union(uuid,character varying,character varying,character varying,character varying,uuid,character varying,character varying,character varying,character varying,character varying,character varying,character varying,character varying)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'api_runtime',
    'public.record_wechat_union_alias_from_consumed_state(uuid,uuid)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'api_runtime',
    'public.bind_oauth_identity_with_wechat_union_from_consumed_state(uuid,uuid,character varying,character varying,character varying,character varying)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'api_runtime', 'public.wechat_union_aliases',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.wechat_union_aliases
    WHERE realm_id <> :'expected_wechat_realm'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'public.consume_oauth_state_with_wechat_union(uuid,character varying,character varying,character varying,character varying,uuid,character varying,character varying,character varying,character varying,character varying,character varying,character varying,character varying)'::regprocedure,
      'public.record_wechat_union_alias_from_consumed_state(uuid,uuid)'::regprocedure,
      'public.bind_oauth_identity_with_wechat_union_from_consumed_state(uuid,uuid,character varying,character varying,character varying,character varying)'::regprocedure
    ]) AS required_function(routine_oid)
    JOIN pg_catalog.pg_proc AS routine ON routine.oid = required_function.routine_oid
    WHERE NOT routine.prosecdef
       OR routine.proowner <> 'schema_migrator'::regrole
       OR NOT ('search_path=pg_catalog, public' = ANY(routine.proconfig))
       OR NOT has_function_privilege('api_runtime', routine.oid, 'EXECUTE')
       OR has_function_privilege('retention_worker', routine.oid, 'EXECUTE')
       OR has_function_privilege('admin_api_runtime', routine.oid, 'EXECUTE')
       OR has_function_privilege('data_export_worker', routine.oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
         ) AS privilege
         WHERE privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
       )
  )
);
SQL
  )"
  [[ "$database_acl_ready" == 't' ]] ||
    die 'schema 0013 and WeChat Union alias least-privilege ACL smoke must pass before enabling WeChat'
}

assert_qq_identity_state_change_ready() {
  local active_transition active_realm candidate_realm
  local active_qq_auth_enabled active_qq_union_id_enabled
  local -a active_qq_realm_lines=()
  local postgres_container qq_binding_count

  active_transition="$(read_env_value "$active_deploy/deployment.env" AUTH_SCHEMA_TRANSITION_MODE)"
  [[ "$active_transition" == 'none' ]] ||
    die 'QQ identity state requires the final non-transition schema 0013 release'
  candidate_realm="$(read_env_value "$deployment_env" QQ_OPEN_PLATFORM_REALM_ID)"
  [[ "$candidate_realm" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
    die 'QQ identity state requires a stable candidate Open Platform realm'
  mapfile -t active_qq_realm_lines < <(
    grep -E '^QQ_OPEN_PLATFORM_REALM_ID=' "$active_deploy/deployment.env" || true
  )
  [[ "${#active_qq_realm_lines[@]}" -le 1 ]] ||
    die 'active release has a duplicate QQ Open Platform realm'
  if [[ "${#active_qq_realm_lines[@]}" -eq 1 ]]; then
    active_realm="${active_qq_realm_lines[0]#*=}"
    [[ "$active_realm" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
      die 'active release has an invalid QQ Open Platform realm'
    [[ "$active_realm" == "$candidate_realm" ]] ||
      die 'candidate release must preserve the active QQ Open Platform realm'
  fi
  "$active_deploy/scripts/verify-runtime.sh" >/dev/null

  active_qq_auth_enabled="$(read_env_value "$active_deploy/deployment.env" QQ_AUTH_ENABLED)"
  active_qq_union_id_enabled="$(read_env_value "$active_deploy/deployment.env" QQ_UNION_ID_ENABLED)"
  [[ "$active_qq_auth_enabled" == 'false' && "$active_qq_union_id_enabled" == 'false' ]] ||
    die 'QQ identity state initialization or UnionID promotion requires the active QQ channel to be disabled'
  postgres_container="$(
    cd "$active_deploy"
    docker compose --env-file deployment.env ps -q postgres
  )"
  [[ -n "$postgres_container" ]] || die 'active PostgreSQL container is missing'
  [[ "$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")" == 'running/healthy' ]] ||
    die 'active PostgreSQL container is not healthy'
  qq_binding_count="$(
    cd "$active_deploy"
    docker compose --env-file deployment.env exec -T postgres sh -eu -c \
      'export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT count(*) FROM public.identity_bindings WHERE identity_type = 'QQ';
SQL
  )"
  [[ "$qq_binding_count" =~ ^[0-9]+$ ]] ||
    die 'could not read the aggregate QQ binding count'
  printf 'QQ_BINDING_COUNT_BEFORE_IDENTITY_STATE_CHANGE=%s\n' "$qq_binding_count"
  [[ "$qq_binding_count" -eq 0 ]] ||
    die 'QQ identity state initialization or UnionID promotion requires zero existing QQ bindings'
}

persist_qq_identity_state() {
  local realm_id="$1"
  local namespace_initialized="$2"
  local candidate

  candidate="$(mktemp "$shared_state_directory/.auth-identity-state.candidate.XXXXXX")"
  if ! {
    printf 'AUTH_IDENTITY_STATE_FORMAT_VERSION=1\n'
    printf 'QQ_OPEN_PLATFORM_REALM_ID=%s\n' "$realm_id"
    printf 'QQ_UNION_ID_NAMESPACE_INITIALIZED=%s\n' "$namespace_initialized"
  } >"$candidate"; then
    rm -f -- "$candidate"
    die 'could not write shared QQ identity state candidate'
  fi
  if ! chown root:root "$candidate" || ! chmod 600 "$candidate" || ! sync -f "$candidate"; then
    rm -f -- "$candidate"
    die 'could not harden shared QQ identity state candidate'
  fi
  if ! mv -Tf -- "$candidate" "$qq_identity_state_file"; then
    rm -f -- "$candidate"
    die 'could not atomically persist shared QQ identity state'
  fi
  # This state is deliberately never rolled back. A process interruption after
  # this point leaves QQ disabled or forces UnionID, which is fail-closed and
  # can be retried without losing the realm or monotonic marker.
  sync -f "$shared_state_directory" ||
    die 'shared QQ identity state was replaced but its directory could not be synchronized'
  assert_root_file "$qq_identity_state_file" 600
  assert_exact_env_keys "$qq_identity_state_file" \
    AUTH_IDENTITY_STATE_FORMAT_VERSION \
    QQ_OPEN_PLATFORM_REALM_ID QQ_UNION_ID_NAMESPACE_INITIALIZED
  [[ "$(read_env_value "$qq_identity_state_file" AUTH_IDENTITY_STATE_FORMAT_VERSION)" == '1' ]] ||
    die 'persisted QQ identity state has an unsupported format version'
  [[ "$(read_env_value "$qq_identity_state_file" QQ_OPEN_PLATFORM_REALM_ID)" == "$realm_id" ]] ||
    die 'persisted QQ identity realm differs from the requested realm'
  [[ "$(read_env_value "$qq_identity_state_file" QQ_UNION_ID_NAMESPACE_INITIALIZED)" == "$namespace_initialized" ]] ||
    die 'persisted QQ UnionID namespace marker differs from the requested state'
}

[[ -x "$preflight" && ! -L "$preflight" ]] || die 'deployment preflight is unavailable'
assert_root_file "$deployment_env" 600
assert_root_file "$api_env" 600
assert_root_directory "$shared_state_directory" 700
if [[ "$mode" == '--apply' ]]; then
  assert_root_file "$config_file" 600
  LC_ALL=C grep -q $'\r' "$config_file" && die 'authentication input must use LF line endings'
fi
command -v docker >/dev/null
command -v flock >/dev/null
command -v install >/dev/null
command -v readlink >/dev/null
command -v realpath >/dev/null
command -v sha256sum >/dev/null
command -v stat >/dev/null
command -v sync >/dev/null

lock_directory='/run/lock/chi-shen-me'
mutation_lock="$lock_directory/mutation.lock"
auth_lock="$lock_directory/auth-secrets.lock"
if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] || die 'deployment lock directory is unsafe'
else
  install -d -m 700 "$lock_directory"
fi
[[ "$(realpath -e -- "$lock_directory")" == "$lock_directory" ]] || die 'deployment lock directory resolves unexpectedly'
[[ "$(stat -c '%a:%u:%g' "$lock_directory")" == '700:0:0' ]] ||
  die 'deployment lock directory must be root:root mode 0700'
for lock_path in "$mutation_lock" "$auth_lock"; do
  if [[ ! -e "$lock_path" && ! -L "$lock_path" ]]; then
    ( set -o noclobber; : >"$lock_path" ) 2>/dev/null || true
  fi
  [[ -f "$lock_path" && ! -L "$lock_path" ]] || die "deployment lock is unsafe: $lock_path"
  [[ "$(stat -c '%a:%u:%g' "$lock_path")" == '600:0:0' ]] ||
    die "deployment lock must be root:root mode 0600: $lock_path"
done
exec 8<>"$mutation_lock"
flock -n 8 || die 'another deployment mutation, backup or secret update is running'
exec 9<>"$auth_lock"
flock -n 9 || die 'another authentication secret update is running'

active_deploy="$(resolve_active_deploy)"
[[ "$active_deploy" != "$bundle_root" ]] ||
  die 'authentication changes must be prepared in a non-active candidate release'

# Do not run the new release's full preflight against the old shared api.env
# here. During the one-time migration it may still contain retired auth keys.
# In ordinary modes the transaction removes them before validation; bridge mode
# deliberately leaves api.env byte-for-byte unchanged. Any validation failure
# restores api.env and deployment.env. A shared QQ identity-state initialization
# or monotonic UnionID promotion is intentionally durable and never rolled back.

read_deployment_value() { read_env_value "$deployment_env" "$1"; }
current_accounts_enabled="$(read_deployment_value ACCOUNTS_ENABLED)"
current_schema_transition_mode="$(read_deployment_value AUTH_SCHEMA_TRANSITION_MODE)"
current_qq_auth_enabled="$(read_deployment_value QQ_AUTH_ENABLED)"
current_qq_union_id_enabled="$(read_deployment_value QQ_UNION_ID_ENABLED)"
current_qq_open_platform_realm_id="$(read_deployment_value QQ_OPEN_PLATFORM_REALM_ID)"
current_ram_role="$(read_deployment_value ALIBABA_CLOUD_ECS_METADATA)"
api_image="$(read_deployment_value API_IMAGE)"
for current_qq_state in \
  "$current_qq_auth_enabled" "$current_qq_union_id_enabled"; do
  [[ "$current_qq_state" == 'true' || "$current_qq_state" == 'false' ]] ||
    die 'current QQ deployment state must be boolean'
done
[[ "$current_qq_open_platform_realm_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
  die 'current QQ Open Platform realm is invalid'

qq_identity_state_present='false'
persisted_qq_open_platform_realm_id=''
persisted_qq_union_id_namespace_initialized='false'
if [[ -e "$qq_identity_state_file" || -L "$qq_identity_state_file" ]]; then
  assert_root_file "$qq_identity_state_file" 600
  assert_exact_env_keys "$qq_identity_state_file" \
    AUTH_IDENTITY_STATE_FORMAT_VERSION \
    QQ_OPEN_PLATFORM_REALM_ID QQ_UNION_ID_NAMESPACE_INITIALIZED
  [[ "$(read_env_value "$qq_identity_state_file" AUTH_IDENTITY_STATE_FORMAT_VERSION)" == '1' ]] ||
    die 'shared QQ identity state has an unsupported format version'
  persisted_qq_open_platform_realm_id="$(
    read_env_value "$qq_identity_state_file" QQ_OPEN_PLATFORM_REALM_ID
  )"
  persisted_qq_union_id_namespace_initialized="$(
    read_env_value "$qq_identity_state_file" QQ_UNION_ID_NAMESPACE_INITIALIZED
  )"
  [[ "$persisted_qq_open_platform_realm_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
    die 'shared QQ identity state has an invalid Open Platform realm'
  [[ "$persisted_qq_union_id_namespace_initialized" == 'true' ||
     "$persisted_qq_union_id_namespace_initialized" == 'false' ]] ||
    die 'shared QQ identity state has an invalid UnionID namespace marker'
  [[ "$persisted_qq_open_platform_realm_id" == "$current_qq_open_platform_realm_id" ]] ||
    die 'candidate release differs from the shared QQ Open Platform realm'
  qq_identity_state_present='true'
else
  [[ "$current_qq_auth_enabled" == 'false' ]] ||
    die 'active QQ authentication state is missing its shared identity anchor'
fi

current_qq_union_id_namespace_initialized="$persisted_qq_union_id_namespace_initialized"
if [[ "$current_qq_union_id_enabled" == 'true' && "$current_qq_auth_enabled" != 'true' ]]; then
  die 'current QQ UnionID configuration requires QQ authentication'
fi
if [[ "$current_qq_union_id_enabled" == 'true' && "$current_qq_union_id_namespace_initialized" != 'true' ]]; then
  die 'current QQ UnionID configuration is missing its initialized namespace state'
fi
if [[ "$current_qq_union_id_namespace_initialized" == 'true' && "$current_qq_auth_enabled" == 'true' && "$current_qq_union_id_enabled" != 'true' ]]; then
  die 'current initialized QQ namespace cannot run QQ without UnionID'
fi

identity_continuity_names=(
  AUTH_HASH_ACTIVE_VERSION AUTH_HASH_KEYS_JSON AUTH_IDENTITY_DEDUP_KEY_VERSION
)
otp_continuity_names=(AUTH_OTP_PEPPER_ACTIVE_VERSION AUTH_OTP_PEPPER_KEYS_JSON)
baseline_identity_count="$(count_present_env_keys "$api_env" "${identity_continuity_names[@]}")"
baseline_otp_count="$(count_present_env_keys "$api_env" "${otp_continuity_names[@]}")"
[[ "$baseline_identity_count" -eq 0 || "$baseline_identity_count" -eq "${#identity_continuity_names[@]}" ]] ||
  die 'shared api.env contains an incomplete authentication identity/session continuity group'
[[ "$baseline_otp_count" -eq 0 || "$baseline_otp_count" -eq "${#otp_continuity_names[@]}" ]] ||
  die 'shared api.env contains an incomplete email OTP continuity group'
if [[ "$current_accounts_enabled" == 'true' ]]; then
  [[ "$baseline_identity_count" -eq "${#identity_continuity_names[@]}" ]] ||
    die 'enabled accounts require a complete authentication identity/session continuity group'
fi

target_accounts_enabled='false'
target_phone_auth_enabled='false'
target_email_auth_enabled='false'
target_wechat_auth_enabled='false'
target_qq_auth_enabled='false'
target_qq_union_id_enabled='false'
target_qq_union_id_namespace_initialized="$current_qq_union_id_namespace_initialized"
target_schema_transition_mode='none'
target_ram_role="$current_ram_role"

if [[ "$mode" == '--legacy-drain' ]]; then
  target_schema_transition_mode='legacy_phone_drain'
fi

declare -a input_names=(
  ACCOUNTS_ENABLED PHONE_AUTH_ENABLED EMAIL_AUTH_ENABLED WECHAT_AUTH_ENABLED
  QQ_AUTH_ENABLED QQ_UNION_ID_ENABLED ALIBABA_CLOUD_ECS_METADATA
)
if [[ "$mode" == '--apply' ]]; then
  target_accounts_enabled="$(read_env_value "$config_file" ACCOUNTS_ENABLED)"
  target_phone_auth_enabled="$(read_env_value "$config_file" PHONE_AUTH_ENABLED)"
  target_email_auth_enabled="$(read_env_value "$config_file" EMAIL_AUTH_ENABLED)"
  target_wechat_auth_enabled="$(read_env_value "$config_file" WECHAT_AUTH_ENABLED)"
  target_qq_auth_enabled="$(read_env_value "$config_file" QQ_AUTH_ENABLED)"
  target_qq_union_id_enabled="$(read_env_value "$config_file" QQ_UNION_ID_ENABLED)"
  target_ram_role="$(read_env_value "$config_file" ALIBABA_CLOUD_ECS_METADATA)"
  [[ "$target_accounts_enabled" == 'true' ]] || die '--apply requires ACCOUNTS_ENABLED=true; use --disable to close accounts'
  for switch_value in \
    "$target_phone_auth_enabled" "$target_email_auth_enabled" \
    "$target_wechat_auth_enabled" "$target_qq_auth_enabled" \
    "$target_qq_union_id_enabled"; do
    [[ "$switch_value" == 'true' || "$switch_value" == 'false' ]] || die 'authentication switches must be true or false'
  done
  [[ "$target_phone_auth_enabled" == 'true' ]] || die 'PHONE_ONLY accounts require PHONE_AUTH_ENABLED=true'
  if [[ "$target_qq_union_id_enabled" == 'true' ]]; then
    [[ "$target_qq_auth_enabled" == 'true' ]] || die 'QQ_UNION_ID_ENABLED requires QQ_AUTH_ENABLED=true'
  fi
  if [[ "$target_qq_union_id_namespace_initialized" == 'true' && "$target_qq_auth_enabled" == 'true' && "$target_qq_union_id_enabled" != 'true' ]]; then
    die 'initialized QQ UnionID namespace requires UnionID whenever QQ authentication is enabled'
  fi
  [[ "$target_ram_role" =~ ^[A-Za-z0-9._-]{1,64}$ && "$target_ram_role" != 'replace-with-ram-role-name' ]] ||
    die 'a real ECS RAM role name is required'

  input_names+=(
    AUTH_HASH_ACTIVE_VERSION AUTH_HASH_KEYS_JSON AUTH_IDENTITY_DEDUP_KEY_VERSION
    ALIYUN_PNVS_SIGN_NAME ALIYUN_PNVS_TEMPLATE_CODE
  )
  if [[ "$target_email_auth_enabled" == 'true' ]]; then
    input_names+=(
      AUTH_OTP_PEPPER_ACTIVE_VERSION AUTH_OTP_PEPPER_KEYS_JSON
      SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USERNAME SMTP_APP_PASSWORD
      SMTP_FROM_ADDRESS SMTP_REPLY_TO SMTP_FROM_NAME
    )
  fi
  if [[ "$target_wechat_auth_enabled" == 'true' ]]; then
    input_names+=(WECHAT_APP_ID WECHAT_APP_SECRET)
  fi
  if [[ "$target_qq_auth_enabled" == 'true' ]]; then
    input_names+=(QQ_APP_ID QQ_APP_KEY)
  fi
  assert_exact_env_keys "$config_file" "${input_names[@]}"
  for input_name in "${input_names[@]}"; do read_env_value "$config_file" "$input_name" >/dev/null; done
fi

if [[ "$mode" != '--legacy-drain' && "$current_schema_transition_mode" == 'wechat_union_aliases_pending' ]]; then
  die 'activate the final schema 0013 release before updating authentication configuration'
fi
if [[ "$mode" == '--apply' && "$target_wechat_auth_enabled" == 'true' ]]; then
  assert_wechat_union_aliases_ready
fi
if [[ "$mode" != '--legacy-drain' ]]; then
  retires_legacy_auth_configuration='false'
  legacy_sensitive_configuration_present='false'
  if grep -Eq '^(ALIYUN_SMS_SIGN_NAME|ALIYUN_SMS_TEMPLATE_CODE|ALIYUN_FUSION_[A-Z0-9_]+)=' "$api_env"; then
    retires_legacy_auth_configuration='true'
  fi
  if grep -Eq '^(ALIYUN_SMS_SIGN_NAME|ALIYUN_SMS_TEMPLATE_CODE|ALIYUN_FUSION_[A-Z0-9_]+|WECHAT_APP_ID|WECHAT_APP_SECRET)=' "$api_env"; then
    legacy_sensitive_configuration_present='true'
  fi
  # A direct, lock-protected database check deliberately replaces a durable
  # cutover marker: restoring a pre-0011 database therefore invalidates this
  # proof automatically. Legacy-only SMS/Fusion keys identify the old config;
  # its same-file WeChat keys are protected by the same bridge requirement.
  # This gate covers both --apply and --disable because both retire old fields.
  if [[ "$legacy_sensitive_configuration_present" == 'true' ]]; then
    assert_phone_only_cutover_ready "$retires_legacy_auth_configuration"
  fi
fi

if [[ "$mode" == '--apply' && "$target_qq_auth_enabled" == 'true' ]]; then
  qq_identity_state_change_required='false'
  if [[ "$qq_identity_state_present" == 'false' ]]; then
    qq_identity_state_change_required='true'
    target_qq_union_id_namespace_initialized="$target_qq_union_id_enabled"
  elif [[ "$target_qq_union_id_enabled" == 'true' &&
          "$current_qq_union_id_namespace_initialized" == 'false' ]]; then
    qq_identity_state_change_required='true'
    target_qq_union_id_namespace_initialized='true'
  fi
  if [[ "$qq_identity_state_change_required" == 'true' ]]; then
    assert_qq_identity_state_change_ready
    persist_qq_identity_state \
      "$current_qq_open_platform_realm_id" \
      "$target_qq_union_id_namespace_initialized"
    qq_identity_state_present='true'
    persisted_qq_open_platform_realm_id="$current_qq_open_platform_realm_id"
    persisted_qq_union_id_namespace_initialized="$target_qq_union_id_namespace_initialized"
    current_qq_union_id_namespace_initialized="$target_qq_union_id_namespace_initialized"
  fi
fi

api_candidate=''
api_rollback=''
api_env_checksum_before=''
if [[ "$mode" != '--legacy-drain' ]]; then
  api_candidate="$(mktemp "$secrets_dir/.api.env.auth.XXXXXX")"
  api_rollback="$(mktemp "$secrets_dir/.api.env.rollback.XXXXXX")"
else
  api_env_checksum_before="$(sha256sum -- "$api_env")"
  api_env_checksum_before="${api_env_checksum_before%% *}"
fi
deployment_candidate="$(mktemp "$bundle_root/.deployment.env.auth.XXXXXX")"
deployment_rollback="$(mktemp "$bundle_root/.deployment.env.rollback.XXXXXX")"
api_replaced='false'
deployment_replaced='false'
completed='false'
cleanup() {
  local status="$?"
  if [[ "$completed" != 'true' ]]; then
    if [[ "$api_replaced" == 'true' && -f "${api_rollback:-}" ]]; then mv -f -- "$api_rollback" "$api_env"; fi
    if [[ "$deployment_replaced" == 'true' && -f "${deployment_rollback:-}" ]]; then mv -f -- "$deployment_rollback" "$deployment_env"; fi
  fi
  for cleanup_path in \
    "${api_candidate:-}" "${api_rollback:-}" \
    "${deployment_candidate:-}" "${deployment_rollback:-}"; do
    [[ -z "$cleanup_path" ]] || rm -f -- "$cleanup_path"
  done
  return "$status"
}
trap cleanup EXIT
if [[ "$mode" != '--legacy-drain' ]]; then
  cp --preserve=mode,ownership,timestamps -- "$api_env" "$api_rollback"
fi
cp --preserve=mode,ownership,timestamps -- "$deployment_env" "$deployment_rollback"

if [[ "$mode" == '--apply' ]]; then
  awk '
    !/^AUTH_HASH_ACTIVE_VERSION=/ &&
    !/^AUTH_HASH_KEYS_JSON=/ &&
    !/^AUTH_IDENTITY_DEDUP_KEY_VERSION=/ &&
    !/^AUTH_OTP_PEPPER_ACTIVE_VERSION=/ &&
    !/^AUTH_OTP_PEPPER_KEYS_JSON=/ &&
    !/^ALIYUN_PNVS_SIGN_NAME=/ &&
    !/^ALIYUN_PNVS_TEMPLATE_CODE=/ &&
    !/^ALIYUN_SMS_SIGN_NAME=/ &&
    !/^ALIYUN_SMS_TEMPLATE_CODE=/ &&
    !/^ALIYUN_FUSION_/ &&
    !/^SMTP_/ &&
    !/^WECHAT_APP_ID=/ &&
    !/^WECHAT_APP_SECRET=/ &&
    !/^QQ_APP_ID=/ &&
    !/^QQ_APP_KEY=/
  ' "$api_env" >"$api_candidate"
  awk '
    !/^ACCOUNTS_ENABLED=/ &&
    !/^PHONE_AUTH_ENABLED=/ &&
    !/^EMAIL_AUTH_ENABLED=/ &&
    !/^WECHAT_AUTH_ENABLED=/ &&
    !/^QQ_AUTH_ENABLED=/ &&
    !/^QQ_UNION_ID_ENABLED=/ &&
    !/^ALIBABA_CLOUD_ECS_METADATA=/ &&
    !/^SMTP_APP_PASSWORD=/
    ' "$config_file" >>"$api_candidate"
  if [[ "$target_email_auth_enabled" == 'true' ]]; then
    printf 'SMTP_PASSWORD=%s\n' "$(read_env_value "$config_file" SMTP_APP_PASSWORD)" >>"$api_candidate"
  fi
  if [[ "$target_email_auth_enabled" == 'false' && "$baseline_otp_count" -eq "${#otp_continuity_names[@]}" ]]; then
    grep -E '^(AUTH_OTP_PEPPER_ACTIVE_VERSION|AUTH_OTP_PEPPER_KEYS_JSON)=' "$api_env" >>"$api_candidate"
  fi
  chown root:root "$api_candidate"
  chmod 600 "$api_candidate"
elif [[ "$mode" == '--disable' ]]; then
  # Emergency disable is reversible: remove provider credentials while keeping
  # the identity/session HMAC ring, stable dedup version and any email OTP
  # pepper ring byte-for-byte in the root-only api.env.
  awk '
    !/^ALIYUN_PNVS_SIGN_NAME=/ &&
    !/^ALIYUN_PNVS_TEMPLATE_CODE=/ &&
    !/^ALIYUN_SMS_SIGN_NAME=/ &&
    !/^ALIYUN_SMS_TEMPLATE_CODE=/ &&
    !/^ALIYUN_FUSION_/ &&
    !/^SMTP_/ &&
    !/^WECHAT_APP_ID=/ &&
    !/^WECHAT_APP_SECRET=/ &&
    !/^QQ_APP_ID=/ &&
    !/^QQ_APP_KEY=/
  ' "$api_env" >"$api_candidate"
  chown root:root "$api_candidate"
  chmod 600 "$api_candidate"
  if [[ "$baseline_identity_count" -eq 3 ]]; then
    assert_same_env_values "$api_env" "$api_candidate" \
      'emergency disable must preserve authentication identity/session continuity' \
      "${identity_continuity_names[@]}"
  fi
  if [[ "$baseline_otp_count" -eq 2 ]]; then
    assert_same_env_values "$api_env" "$api_candidate" \
      'emergency disable must preserve email OTP continuity' \
      "${otp_continuity_names[@]}"
  fi
fi

baseline_identity_config_present='false'
if [[ "$baseline_identity_count" -eq 3 ]]; then
  baseline_identity_config_present='true'
fi
if [[ "$mode" == '--apply' && "$current_accounts_enabled" == 'false' && "$baseline_identity_config_present" == 'true' ]]; then
  assert_same_env_values "$api_env" "$api_candidate" \
    'reenabling disabled accounts must preserve authentication identity/session continuity' \
    "${identity_continuity_names[@]}"
fi
if [[ "$mode" == '--apply' && "$target_email_auth_enabled" == 'false' && "$baseline_otp_count" -eq "${#otp_continuity_names[@]}" ]]; then
  assert_same_env_values "$api_env" "$api_candidate" \
    'disabling email authentication must preserve email OTP continuity' \
    "${otp_continuity_names[@]}"
fi
if [[ "$mode" == '--apply' ]] &&
  [[ "$current_accounts_enabled" == 'true' || "$baseline_identity_config_present" == 'true' ]]; then
  comparison_status=0
  docker run --rm --network none --read-only --user 0:0 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --volume "$api_env:/run/auth-baseline.env:ro" \
    --volume "$api_candidate:/run/auth-candidate.env:ro" \
    --entrypoint node "$api_image" --input-type=module --eval '
      import { readFileSync } from "node:fs";
      const parse = (path) => {
        const result = Object.create(null);
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (line === "") continue;
          const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
          if (match === null || Object.hasOwn(result, match[1])) process.exit(12);
          result[match[1]] = match[2];
        }
        return result;
      };
      const ring = (env, name) => new Map(Object.entries(env[name] ? JSON.parse(env[name]) : {}));
      const before = parse("/run/auth-baseline.env");
      const after = parse("/run/auth-candidate.env");
      if (
        before.AUTH_IDENTITY_DEDUP_KEY_VERSION !== undefined &&
        before.AUTH_IDENTITY_DEDUP_KEY_VERSION !== after.AUTH_IDENTITY_DEDUP_KEY_VERSION
      ) process.exit(11);
      const retiresLegacyPhone = [
        "ALIYUN_SMS_SIGN_NAME",
        "ALIYUN_SMS_TEMPLATE_CODE",
        "ALIYUN_FUSION_SCHEME_CODE",
        "ALIYUN_FUSION_PACKAGE_NAME",
        "ALIYUN_FUSION_PACKAGE_SIGN",
      ].some((name) => Object.hasOwn(before, name));
      const rings = retiresLegacyPhone
        ? ["AUTH_HASH_KEYS_JSON"]
        : ["AUTH_HASH_KEYS_JSON", "AUTH_OTP_PEPPER_KEYS_JSON"];
      for (const name of rings) {
        for (const [version, material] of ring(before, name)) if (ring(after, name).get(version) !== material) process.exit(10);
      }
    ' || comparison_status=$?
  case "$comparison_status" in
    0) ;;
    10) die 'ordinary authentication update cannot remove an in-use key version; use a separately reviewed drain procedure' ;;
    11) die 'AUTH_IDENTITY_DEDUP_KEY_VERSION changes require a dedicated audited migration' ;;
    *) die 'could not compare current and candidate authentication key rings' ;;
  esac
fi

awk '
  !/^AUTH_SCHEMA_TRANSITION_MODE=/ &&
  !/^ACCOUNTS_ENABLED=/ &&
  !/^PHONE_AUTH_ENABLED=/ &&
  !/^EMAIL_AUTH_ENABLED=/ &&
  !/^WECHAT_AUTH_ENABLED=/ &&
  !/^QQ_AUTH_ENABLED=/ &&
  !/^QQ_UNION_ID_ENABLED=/ &&
  !/^ALIBABA_CLOUD_ECS_METADATA=/
' "$deployment_env" >"$deployment_candidate"
{
  printf 'AUTH_SCHEMA_TRANSITION_MODE=%s\n' "$target_schema_transition_mode"
  printf 'ACCOUNTS_ENABLED=%s\n' "$target_accounts_enabled"
  printf 'PHONE_AUTH_ENABLED=%s\n' "$target_phone_auth_enabled"
  printf 'EMAIL_AUTH_ENABLED=%s\n' "$target_email_auth_enabled"
  printf 'WECHAT_AUTH_ENABLED=%s\n' "$target_wechat_auth_enabled"
  printf 'QQ_AUTH_ENABLED=%s\n' "$target_qq_auth_enabled"
  printf 'QQ_UNION_ID_ENABLED=%s\n' "$target_qq_union_id_enabled"
  printf 'ALIBABA_CLOUD_ECS_METADATA=%s\n' "$target_ram_role"
} >>"$deployment_candidate"
chown root:root "$deployment_candidate"
chmod 600 "$deployment_candidate"

if [[ "$mode" != '--legacy-drain' ]]; then
  mv -f -- "$api_candidate" "$api_env"
  api_candidate=''
  api_replaced='true'
fi
mv -f -- "$deployment_candidate" "$deployment_env"
deployment_candidate=''
deployment_replaced='true'
if ! "$preflight" >/dev/null; then
  die 'updated authentication configuration failed preflight and was rolled back' 3
fi
if [[ "$mode" == '--legacy-drain' ]]; then
  api_env_checksum_after="$(sha256sum -- "$api_env")"
  api_env_checksum_after="${api_env_checksum_after%% *}"
  [[ "$api_env_checksum_after" == "$api_env_checksum_before" ]] ||
    die 'legacy bridge must preserve the shared api.env byte-for-byte' 3
fi

completed='true'
if [[ -n "$api_rollback" ]]; then rm -f -- "$api_rollback"; fi
rm -f -- "$deployment_rollback"
api_rollback=''
deployment_rollback=''
if [[ "$mode" == '--legacy-drain' ]]; then
  printf 'AUTHENTICATION_CONFIGURATION_UPDATED=legacy_phone_drain\n'
  printf 'SHARED_API_ENV_PRESERVED=true\n'
elif [[ "$mode" == '--disable' ]]; then
  printf 'AUTHENTICATION_CONFIGURATION_UPDATED=disabled\n'
else
  printf 'AUTHENTICATION_CONFIGURATION_UPDATED=enabled\n'
fi
printf 'API_RECREATE_REQUIRED=true\n'
