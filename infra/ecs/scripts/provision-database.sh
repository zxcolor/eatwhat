#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

[[ "$(id -u)" -eq 0 ]] || die 'run as root'

phone_only_cutover='false'
wechat_union_aliases_cutover='false'
if [[ "$#" -eq 0 ]]; then
  :
elif [[ "$#" -eq 1 && "$1" == '--phone-only-cutover' ]]; then
  phone_only_cutover='true'
elif [[ "$#" -eq 1 && "$1" == '--wechat-union-aliases-cutover' ]]; then
  wechat_union_aliases_cutover='true'
else
  die 'usage: provision-database.sh [--phone-only-cutover|--wechat-union-aliases-cutover]'
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bundle_root="$(cd -- "$script_dir/.." && pwd -P)"
deployment_env="$bundle_root/deployment.env"

command -v flock >/dev/null
command -v install >/dev/null
command -v realpath >/dev/null
command -v stat >/dev/null

lock_directory='/run/lock/chi-shen-me'
mutation_lock="$lock_directory/mutation.lock"
if [[ -e "$lock_directory" || -L "$lock_directory" ]]; then
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] ||
    die 'deployment lock directory is unsafe'
else
  install -d -m 700 "$lock_directory"
fi
[[ "$(realpath -e -- "$lock_directory")" == "$lock_directory" ]] ||
  die 'deployment lock directory resolves unexpectedly'
[[ "$(stat -c '%a:%u:%g' "$lock_directory")" == '700:0:0' ]] ||
  die 'deployment lock directory must be root:root mode 0700'

if [[ ! -e "$mutation_lock" && ! -L "$mutation_lock" ]]; then
  ( set -o noclobber; : >"$mutation_lock" ) 2>/dev/null || true
fi
[[ -f "$mutation_lock" && ! -L "$mutation_lock" ]] ||
  die 'deployment mutation lock is unsafe'
[[ "$(stat -c '%a:%u:%g' "$mutation_lock")" == '600:0:0' ]] ||
  die 'deployment mutation lock must be root:root mode 0600'
exec 8<>"$mutation_lock"
flock -n 8 || die 'another deployment mutation, backup or secret update is running'

"$script_dir/preflight-deployment.sh" >/dev/null

cd "$bundle_root"

read_deployment_value() {
  local name="$1"
  local value
  value="$(sed -n "s/^${name}=//p" "$deployment_env")"
  if [[ -z "$value" || "$value" == *$'\n'* ]]; then
    printf 'missing or duplicate deployment setting: %s\n' "$name" >&2
    exit 3
  fi
  printf '%s' "$value"
}

shared_state_directory="$(read_deployment_value SHARED_STATE_DIRECTORY)"
api_image="$(read_deployment_value API_IMAGE)"
postgres_volume_name="$(read_deployment_value POSTGRES_VOLUME_NAME)"
if [[ "$shared_state_directory" != "/opt/chi-shen-me/shared" ]]; then
  printf 'unexpected shared state directory\n' >&2
  exit 3
fi
secrets_dir="$shared_state_directory/secrets"

for required_path in \
  "$deployment_env" \
  "$secrets_dir/postgres_bootstrap_password" \
  "$secrets_dir/api_runtime_password" \
  "$secrets_dir/schema_migrator_password" \
  "$secrets_dir/retention_worker_password" \
  "$secrets_dir/admin_api_runtime_password" \
  "$secrets_dir/data_export_worker_password"; do
  if [[ ! -f "$required_path" ]]; then
    printf 'required deployment file is missing: %s\n' "$required_path" >&2
    exit 3
  fi
done

docker compose --env-file deployment.env config --quiet
docker image inspect "$api_image" >/dev/null
docker run --rm --entrypoint sh "$api_image" -eu -c \
  'test -r /app/dist/main.js && test -r /app/dist/database/migrate-cli.js'
if ! docker volume inspect "$postgres_volume_name" >/dev/null 2>&1; then
  docker volume create \
    --driver local \
    --label com.chi-shen-me.purpose=postgres-data \
    --label com.chi-shen-me.protected=true \
    "$postgres_volume_name" >/dev/null
fi
docker compose --env-file deployment.env up -d postgres

postgres_container="$(docker compose --env-file deployment.env ps -q postgres)"
if [[ -z "$postgres_container" ]]; then
  printf 'postgres container was not created\n' >&2
  exit 4
fi

for _ in $(seq 1 36); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container")"
  if [[ "$health" == "healthy" ]]; then
    break
  fi
  sleep 5
done
if [[ "$health" != "healthy" ]]; then
  docker compose --env-file deployment.env logs --tail 80 postgres >&2
  printf 'postgres did not become healthy\n' >&2
  exit 5
fi

api_runtime_value="$(<"$secrets_dir/api_runtime_password")"
schema_migrator_value="$(<"$secrets_dir/schema_migrator_password")"
retention_worker_value="$(<"$secrets_dir/retention_worker_password")"
admin_api_runtime_value="$(<"$secrets_dir/admin_api_runtime_password")"
data_export_worker_value="$(<"$secrets_dir/data_export_worker_password")"

roles_sql="$(mktemp /tmp/chi-shen-me-roles.XXXXXX.sql)"
cleanup() {
  rm -f -- "$roles_sql"
  unset api_runtime_value schema_migrator_value retention_worker_value
  unset admin_api_runtime_value data_export_worker_value
}
trap cleanup EXIT
chmod 600 "$roles_sql"

{
  printf '\\set ON_ERROR_STOP on\n'
  printf "\\set api_runtime_password '%s'\\n" "$api_runtime_value"
  printf "\\set schema_migrator_password '%s'\\n" "$schema_migrator_value"
  printf "\\set retention_worker_password '%s'\\n" "$retention_worker_value"
  printf "\\set admin_api_runtime_password '%s'\\n" "$admin_api_runtime_value"
  printf "\\set data_export_worker_password '%s'\\n" "$data_export_worker_value"
  cat <<'SQL'

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_runtime') THEN
    CREATE ROLE api_runtime LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schema_migrator') THEN
    CREATE ROLE schema_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retention_worker') THEN
    CREATE ROLE retention_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_api_runtime') THEN
    CREATE ROLE admin_api_runtime LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'data_export_worker') THEN
    CREATE ROLE data_export_worker LOGIN;
  END IF;
END
$roles$;

ALTER ROLE api_runtime WITH LOGIN PASSWORD :'api_runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE schema_migrator WITH LOGIN PASSWORD :'schema_migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE retention_worker WITH LOGIN PASSWORD :'retention_worker_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE admin_api_runtime WITH LOGIN PASSWORD :'admin_api_runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE data_export_worker WITH LOGIN PASSWORD :'data_export_worker_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT schema_migrator TO postgres_bootstrap;
GRANT CONNECT ON DATABASE chi_shen_me TO api_runtime, schema_migrator, retention_worker, admin_api_runtime, data_export_worker;
SQL
} >"$roles_sql"

run_bootstrap_psql() {
  docker compose --env-file deployment.env exec -T postgres sh -eu -c \
    'export PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)"; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' \
    sh "$@"
}

read_active_auth_proof_count() {
  run_bootstrap_psql -qAt -c "
    SELECT count(*) FROM (
      SELECT otp.id
      FROM public.otp_challenges AS otp
      WHERE (otp.consumed_at IS NULL AND otp.expires_at > clock_timestamp())
        OR (otp.purpose = 'REGISTER'
          AND otp.consumed_at > clock_timestamp() - interval '15 minutes'
          AND otp.registration_claimed_at IS NULL)
        OR (otp.purpose IN ('BIND', 'RECOVERY')
          AND otp.consumed_at > clock_timestamp() - interval '15 minutes'
          AND otp.binding_claimed_at IS NULL)
      UNION ALL
      SELECT oauth.id
      FROM public.oauth_states AS oauth
      WHERE (oauth.consumed_at IS NULL AND oauth.expires_at > clock_timestamp())
        OR (oauth.purpose = 'REGISTER'
          AND oauth.consumed_at > clock_timestamp() - interval '15 minutes'
          AND oauth.registration_claimed_at IS NULL)
        OR (oauth.purpose = 'BIND'
          AND oauth.consumed_at > clock_timestamp() - interval '15 minutes'
          AND oauth.binding_claimed_at IS NULL)
      UNION ALL
      SELECT fusion.id
      FROM public.fusion_auth_flows AS fusion
      WHERE fusion.consumed_at IS NULL
        AND ((fusion.verified_at IS NULL AND fusion.expires_at > clock_timestamp())
          OR (fusion.verified_at IS NOT NULL
            AND fusion.proof_expires_at > clock_timestamp()))
    ) AS active_auth_proof;"
}

assert_phone_only_cutover_ready() {
  [[ "$phone_only_cutover" == 'true' ]] ||
    die 'schema 0010 requires explicit --phone-only-cutover'
  local active_release active_proofs
  local backup_output recorded_release recorded_cutover_facts recorded_database_facts

  "$script_dir/assert-phone-only-bridge-runtime.sh" >/dev/null
  "$script_dir/verify-runtime.sh" >/dev/null
  active_release="$(realpath -e -- /opt/chi-shen-me/current)"

  active_proofs="$(read_active_auth_proof_count)"
  [[ "$active_proofs" == '0' ]] ||
    die 'legacy authentication challenges or proofs have not drained'

  backup_output="$("$script_dir/backup-database.sh" --mutation-lock-held)"
  phone_only_cutover_backup="$(sed -n 's/^BACKUP_DIRECTORY=//p' <<<"$backup_output")"
  [[ "$phone_only_cutover_backup" == /opt/chi-shen-me/backups/postgres/* ]] ||
    die 'phone-only cutover backup did not complete'
  "$script_dir/verify-database-backup.sh" "$phone_only_cutover_backup" >/dev/null
  recorded_release="$(sed -n 's/^release_path=//p' "$phone_only_cutover_backup/METADATA.txt")"
  recorded_cutover_facts="$(sed -n 's/^phone_only_cutover_facts=//p' "$phone_only_cutover_backup/METADATA.txt")"
  recorded_database_facts="$(sed -n 's/^database_facts=//p' "$phone_only_cutover_backup/METADATA.txt")"
  [[ "$recorded_release" == "$active_release" ]] ||
    die 'phone-only cutover backup was not produced by the active bridge'
  [[ "$recorded_cutover_facts" == '10|0' ]] ||
    die 'phone-only cutover backup contains active legacy authentication proofs'
  [[ "$recorded_database_facts" =~ ^chi_shen_me\|[0-9]+\|10$ ]] ||
    die 'phone-only cutover backup does not contain the exact 0010 schema'
  [[ "$(tail -n 1 "$phone_only_cutover_backup/SCHEMA_MIGRATIONS.txt")" =~ ^10\|fusion_phone_auth\|[0-9a-f]{64}$ ]] ||
    die 'phone-only cutover backup migration ledger is not schema 0010'
  [[ "$(read_active_auth_proof_count)" == '0' ]] ||
    die 'legacy authentication proof state changed after the cutover backup'
}

assert_wechat_union_aliases_cutover_ready() {
  [[ "$wechat_union_aliases_cutover" == 'true' ]] ||
    die 'schema 0011 requires explicit --wechat-union-aliases-cutover'
  local active_release backup_output recorded_release recorded_database_facts

  "$script_dir/assert-wechat-union-aliases-bridge-runtime.sh" >/dev/null
  "$script_dir/verify-runtime.sh" >/dev/null
  active_release="$(realpath -e -- /opt/chi-shen-me/current)"

  backup_output="$("$script_dir/backup-database.sh" --mutation-lock-held)"
  wechat_union_aliases_cutover_backup="$(sed -n 's/^BACKUP_DIRECTORY=//p' <<<"$backup_output")"
  [[ "$wechat_union_aliases_cutover_backup" == /opt/chi-shen-me/backups/postgres/* ]] ||
    die 'WeChat Union alias cutover backup did not complete'
  "$script_dir/verify-database-backup.sh" "$wechat_union_aliases_cutover_backup" >/dev/null
  recorded_release="$(sed -n 's/^release_path=//p' "$wechat_union_aliases_cutover_backup/METADATA.txt")"
  recorded_database_facts="$(sed -n 's/^database_facts=//p' "$wechat_union_aliases_cutover_backup/METADATA.txt")"
  [[ "$recorded_release" == "$active_release" ]] ||
    die 'WeChat Union alias cutover backup was not produced by the active bridge'
  [[ "$recorded_database_facts" =~ ^chi_shen_me\|[0-9]+\|11$ ]] ||
    die 'WeChat Union alias cutover backup does not contain exact schema 0011'
  [[ "$(wc -l <"$wechat_union_aliases_cutover_backup/SCHEMA_MIGRATIONS.txt")" -eq 11 ]] ||
    die 'WeChat Union alias cutover backup migration ledger does not have 11 rows'
  [[ "$(tail -n 1 "$wechat_union_aliases_cutover_backup/SCHEMA_MIGRATIONS.txt")" =~ ^11\|phone_only_auth\|[0-9a-f]{64}$ ]] ||
    die 'WeChat Union alias cutover backup migration ledger is not schema 0011'
}

schema_table="$(run_bootstrap_psql -qAt -c "SELECT to_regclass('public.schema_migrations')::text;")"
if [[ -z "$schema_table" ]]; then
  [[ "$phone_only_cutover" == 'false' && "$wechat_union_aliases_cutover" == 'false' ]] ||
    die 'cutover flags require an exact supported existing schema'
else
  schema_head="$(run_bootstrap_psql -qAt -F '|' -c \
    "SELECT count(*), min(version), max(version), max(name) FILTER (WHERE version = max_version)
       FROM public.schema_migrations
       CROSS JOIN (SELECT max(version) AS max_version FROM public.schema_migrations) AS head;")"
  case "$schema_head" in
    '10|1|10|fusion_phone_auth') assert_phone_only_cutover_ready ;;
    '11|1|11|phone_only_auth')
      [[ "$phone_only_cutover" == 'false' ]] ||
        die '--phone-only-cutover cannot be reused after schema 0011 is active'
      assert_wechat_union_aliases_cutover_ready
      ;;
    '12|1|12|wechat_union_aliases')
      [[ "$phone_only_cutover" == 'false' && "$wechat_union_aliases_cutover" == 'false' ]] ||
        die 'cutover flags cannot be reused after schema 0012 is active'
      ;;
    *) die 'database schema is not an exact supported provisioning state' ;;
  esac
fi

run_bootstrap_psql <"$roles_sql"
run_bootstrap_psql \
  -v migration_owner=schema_migrator \
  -v runtime_role=api_runtime \
  -v maintenance_role=retention_worker \
  -f /opt/chi-shen-me/sql/bootstrap-extensions.sql
run_bootstrap_psql -c 'ALTER DATABASE chi_shen_me OWNER TO schema_migrator; ALTER SCHEMA public OWNER TO schema_migrator;'

docker compose --env-file deployment.env --profile ops run --rm migrate

{
  printf '\\set ON_ERROR_STOP on\n'
  printf 'SET ROLE schema_migrator;\n'
  cat "$bundle_root/sql/role-grants.sql"
} | run_bootstrap_psql \
  -v migration_owner=schema_migrator \
  -v runtime_role=api_runtime \
  -v maintenance_role=retention_worker \
  -v admin_runtime_role=admin_api_runtime \
  -v export_worker_role=data_export_worker

run_bootstrap_psql -qAt -c \
  "SELECT count(*) FROM schema_migrations; SELECT extname || '=' || extversion FROM pg_extension WHERE extname IN ('pgcrypto','postgis') ORDER BY extname;"

if [[ "$wechat_union_aliases_cutover" == 'true' ]]; then
  post_cutover_facts="$(run_bootstrap_psql -qAt -F '|' -c \
    "SELECT count(*), min(version), max(version), max(name) FILTER (WHERE version = max_version)
       FROM public.schema_migrations
       CROSS JOIN (SELECT max(version) AS max_version FROM public.schema_migrations) AS head;")"
  [[ "$post_cutover_facts" == '12|1|12|wechat_union_aliases' ]] ||
    die 'WeChat Union alias cutover did not reach exact schema 0012'
  alias_security_ready="$(run_bootstrap_psql -qAt -c \
    "SELECT
       to_regclass('public.wechat_union_aliases') IS NOT NULL
       AND to_regprocedure('public.consume_oauth_state_with_wechat_union(uuid,character varying,character varying,character varying,character varying,uuid,character varying,character varying,character varying,character varying,character varying,character varying,character varying,character varying)') IS NOT NULL
       AND to_regprocedure('public.record_wechat_union_alias_from_consumed_state(uuid,uuid)') IS NOT NULL
       AND to_regprocedure('public.bind_oauth_identity_with_wechat_union_from_consumed_state(uuid,uuid,character varying,character varying,character varying,character varying)') IS NOT NULL
       AND NOT has_table_privilege('api_runtime', 'public.wechat_union_aliases', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       AND NOT has_table_privilege('retention_worker', 'public.wechat_union_aliases', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       AND NOT has_table_privilege('admin_api_runtime', 'public.wechat_union_aliases', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       AND NOT has_table_privilege('data_export_worker', 'public.wechat_union_aliases', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(
           COALESCE(
             (SELECT relation.relacl FROM pg_catalog.pg_class AS relation
              WHERE relation.oid = 'public.wechat_union_aliases'::regclass),
             pg_catalog.acldefault('r',
               (SELECT relation.relowner FROM pg_catalog.pg_class AS relation
                WHERE relation.oid = 'public.wechat_union_aliases'::regclass))
           )
         ) AS privilege
         WHERE privilege.grantee = 0
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
       AND NOT EXISTS (SELECT 1 FROM public.wechat_union_aliases);" )"
  [[ "$alias_security_ready" == 't' ]] ||
    die 'WeChat Union alias schema or least-privilege ACL verification failed'
  "$script_dir/verify-runtime.sh" >/dev/null
fi

printf 'DATABASE_PROVISIONING=OK\n'
if [[ -n "${phone_only_cutover_backup:-}" ]]; then
  printf 'PHONE_ONLY_CUTOVER_BACKUP=%s\n' "$phone_only_cutover_backup"
fi
if [[ -n "${wechat_union_aliases_cutover_backup:-}" ]]; then
  printf 'WECHAT_UNION_ALIASES_CUTOVER_BACKUP=%s\n' "$wechat_union_aliases_cutover_backup"
fi
docker image inspect --format 'API_IMAGE_ID={{.Id}}' "$api_image"
