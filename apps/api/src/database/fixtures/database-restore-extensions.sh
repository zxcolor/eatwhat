#!/usr/bin/env bash

# Real pg_dump/pg_restore integration against an explicitly isolated cluster.
# No Docker, deployed release, external provider or production data is accessed.
set -Eeuo pipefail
umask 077
fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$fixture_dir/../../../../.." && pwd -P)"
plan_script="$repo_root/infra/ecs/scripts/restore-extension-plan.sh"
extension_sql="$repo_root/infra/postgres/restore-extensions.sql"
restore_script="$repo_root/infra/ecs/scripts/restore-database.sh"
psql_command="${ECS_DATABASE_SCRIPT_PSQL:-psql}"
dump_command="${ECS_DATABASE_SCRIPT_PG_DUMP:-pg_dump}"
restore_command="${ECS_DATABASE_SCRIPT_PG_RESTORE:-pg_restore}"
fail() { printf 'database restore extension fixture failed: %s\n' "$1" >&2; exit 1; }

[[ "${PGHOST:-}" == '127.0.0.1' && "${PGUSER:-}" == 'postgres' &&
   "${PGPORT:-}" =~ ^[0-9]+$ && "$PGPORT" -gt 1024 && "$PGPORT" -le 65535 ]] ||
  fail 'an explicit loopback PostgreSQL test connection is required'
if [[ "${GITHUB_ACTIONS:-}" == 'true' ]]; then
  [[ "${CI:-}" == 'true' && "$PGPORT" == '5432' && "${PGDATABASE:-}" == 'chi_shen_me_ci' ]] ||
    fail 'unexpected CI database boundary'
else
  [[ "${ECS_DATABASE_SCRIPT_PSQL_E2E:-}" == '1' && "$PGPORT" != '5432' &&
     "${PGDATABASE:-}" == 'postgres' ]] || fail 'local tests require an explicit temporary cluster'
fi
export PGCONNECT_TIMEOUT=3 PGCLIENTENCODING=UTF8
export PGOPTIONS='-c lock_timeout=2000 -c statement_timeout=30000'
for command in "$psql_command" "$dump_command" "$restore_command"; do
  command -v "$command" >/dev/null || fail 'a PostgreSQL client is unavailable'
done
run_bootstrap_psql() {
  local database="$1"; shift
  "$psql_command" -X -w -h 127.0.0.1 -p "$PGPORT" -U postgres \
    -v ON_ERROR_STOP=1 -d "$database" "$@"
}
data_directory="$(run_bootstrap_psql "$PGDATABASE" -qAt -c 'SHOW data_directory;')"
data_directory="${data_directory//$'\r'/}"
data_directory="${data_directory//\\//}"
if [[ "${GITHUB_ACTIONS:-}" != 'true' ]]; then
  [[ "$data_directory" =~ /eatwhat-(restore|schema14)-[0-9a-f]{32}/data$ ]] ||
    fail 'local server is not an isolated temporary test cluster'
fi
source "$plan_script"

temporary_directory="$(mktemp -d)"
database_prefix="eatwhat_restore_ext_$$_$(date -u +%H%M%S)"
owned_databases=()
role_created='false'
cleanup() {
  local status="$?" database cleanup_failed='false'
  trap - EXIT
  for database in "${owned_databases[@]}"; do
    if ! run_bootstrap_psql postgres -qAt -v target="$database" <<'SQL' >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'target' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS :"target";
SQL
    then cleanup_failed='true'; fi
  done
  if [[ "$role_created" == 'true' ]]; then
    if ! run_bootstrap_psql postgres -qAt -c 'DROP ROLE schema_migrator;' >/dev/null; then cleanup_failed='true'; fi
  fi
  find "$temporary_directory" -maxdepth 1 -type f -delete
  rmdir -- "$temporary_directory"
  if [[ "$cleanup_failed" == 'true' ]]; then
    printf 'database restore extension fixture cleanup failed\n' >&2
    return 1
  fi
  return "$status"
}
trap cleanup EXIT
if [[ -z "$(run_bootstrap_psql postgres -qAt -c "SELECT 1 FROM pg_roles WHERE rolname = 'schema_migrator';")" ]]; then
  run_bootstrap_psql postgres -qAt -c 'CREATE ROLE schema_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE;' >/dev/null
  role_created='true'
fi
role_fingerprint() {
  run_bootstrap_psql postgres -qAt <<'SQL'
SELECT row_to_json(r) FROM (SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
  rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN
  ('schema_migrator', 'api_runtime', 'retention_worker', 'data_export_worker', 'admin_api_runtime') ORDER BY rolname) r;
SELECT row_to_json(m) FROM (SELECT pg_get_userbyid(roleid) AS granted_role, pg_get_userbyid(member) AS member,
  admin_option, inherit_option, set_option FROM pg_auth_members WHERE member IN
  (SELECT oid FROM pg_roles WHERE rolname IN ('schema_migrator', 'api_runtime', 'retention_worker', 'data_export_worker', 'admin_api_runtime'))
  ORDER BY roleid, member) m;
SQL
}
role_fingerprint >"$temporary_directory/roles.before"
create_database() {
  local database="$1"
  [[ "$database" == "$database_prefix"_* ]] || fail 'synthetic database boundary changed'
  [[ -z "$(run_bootstrap_psql postgres -qAt -v target="$database" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'target';
SQL
)" ]] || fail 'synthetic database name is already occupied'
  run_bootstrap_psql postgres -qAt -v target="$database" <<'SQL' >/dev/null
CREATE DATABASE :"target" OWNER schema_migrator TEMPLATE template0 ENCODING 'UTF8';
SQL
  owned_databases+=("$database")
}
extension_phase() {
  local database="$1" phase="$2" extensions="$3"
  run_bootstrap_psql "$database" -qAt -v restore_extensions="$extensions" \
    -v restore_phase="$phase" -v migration_owner=schema_migrator -f "$extension_sql"
}
seed_source() {
  local database="$1" mode="$2"
  create_database "$database"
  run_bootstrap_psql "$database" -qAt <<'SQL' >/dev/null
CREATE EXTENSION pgcrypto WITH SCHEMA public;
CREATE EXTENSION postgis WITH SCHEMA public;
INSERT INTO public.spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
VALUES (990001, 'FIXTURE', 990001, 'LOCAL_CS["Synthetic restore fixture"]', '+proj=longlat +datum=WGS84 +no_defs');
SET ROLE schema_migrator;
CREATE TABLE public.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL);
INSERT INTO public.schema_migrations VALUES (1, 'synthetic_restore_ledger', repeat('a', 64));
CREATE TABLE public.fixture_business (id integer PRIMARY KEY, value text NOT NULL, shape public.geometry(Point, 4326));
INSERT INTO public.fixture_business VALUES (1, 'synthetic business row', public.ST_SetSRID(public.ST_MakePoint(0, 0), 4326));
CREATE TABLE public.fixture_late_failure (id integer PRIMARY KEY, payload text NOT NULL);
INSERT INTO public.fixture_late_failure VALUES (1, 'reject');
RESET ROLE;
SQL
  if [[ "$mode" == 'full' ]]; then
    run_bootstrap_psql "$database" -qAt <<'SQL' >/dev/null
CREATE EXTENSION fuzzystrmatch WITH SCHEMA public;
CREATE EXTENSION postgis_tiger_geocoder;
CREATE EXTENSION postgis_topology;
-- Some local installers create this empty convenience schema. It is absent
-- from the production-shaped archive; never remove objects or use CASCADE.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tiger_data') THEN
    IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = 'tiger_data' AND
       (n.nspowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user) OR EXISTS
        (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid AND d.deptype = 'e'))) THEN
      RAISE EXCEPTION 'unexpected synthetic tiger_data schema ownership or membership';
    END IF;
    DROP SCHEMA tiger_data;
  END IF;
END $$;
INSERT INTO tiger.geocode_settings (name, setting, category) VALUES ('fixture_setting', 'nonempty', 'fixture');
INSERT INTO tiger.pagc_gaz (id, seq, word, stdword, token, is_custom) VALUES (990001, 1, 'FIXTURE_GAZ', 'FIXTURE', 1, true);
INSERT INTO tiger.pagc_lex (id, seq, word, stdword, token, is_custom) VALUES (990001, 1, 'FIXTURE_LEX', 'FIXTURE', 1, true);
INSERT INTO tiger.pagc_rules (id, rule, is_custom) VALUES (990001, '1 2 3', true);
INSERT INTO topology.topology (id, name, srid, precision, hasz) VALUES (730001, 'fixture_topology', 4326, 0, false);
INSERT INTO topology.layer (topology_id, layer_id, schema_name, table_name, feature_column, feature_type, level, child_id)
VALUES (730001, 1, 'public', 'fixture_business', 'shape', 1, 0, NULL);
SELECT pg_catalog.setval('topology.topology_id_seq', 733001, false);
SQL
  fi
}
data_fingerprint() {
  local database="$1" mode="$2"
  run_bootstrap_psql "$database" -qAt <<'SQL'
SELECT 'ledger|' || md5(jsonb_agg(to_jsonb(t) ORDER BY version)::text) FROM public.schema_migrations t;
SELECT 'business|' || md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.fixture_business t;
SELECT 'late|' || md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.fixture_late_failure t;
SELECT 'spatial_ref_sys|' || count(*) || '|' || md5(jsonb_agg(to_jsonb(t) ORDER BY srid)::text) FROM public.spatial_ref_sys t;
SQL
  if [[ "$mode" == 'full' ]]; then
    run_bootstrap_psql "$database" -qAt <<'SQL'
SELECT 'geocode_settings|' || count(*) || '|' || md5(jsonb_agg(to_jsonb(t) ORDER BY name)::text) FROM tiger.geocode_settings t;
SELECT 'pagc_gaz|' || count(*) || '|' || md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM tiger.pagc_gaz t;
SELECT 'pagc_lex|' || count(*) || '|' || md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM tiger.pagc_lex t;
SELECT 'pagc_rules|' || count(*) || '|' || md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM tiger.pagc_rules t;
SELECT 'topology|' || md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM topology.topology t;
SELECT 'layer|' || md5(jsonb_agg(to_jsonb(t) ORDER BY topology_id, layer_id)::text) FROM topology.layer t;
SELECT 'sequence|' || last_value || '|' || is_called FROM topology.topology_id_seq;
SQL
  fi
}
make_archive() {
  local source_database="$1" label="$2"
  "$dump_command" -w -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$source_database" \
    --format=custom --no-owner --no-acl --file="$temporary_directory/$label.dump"
  "$restore_command" --list "$temporary_directory/$label.dump" >"$temporary_directory/$label.toc"
  prepare_restore_extension_plan "$temporary_directory/$label.toc" "$temporary_directory/$label.list" postgres
}
restore_archive() {
  local database="$1" label="$2" list="${3:-$temporary_directory/$2.list}"
  "$restore_command" -w -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$database" \
    --exit-on-error --single-transaction --no-owner --no-acl --no-comments \
    --role=schema_migrator --use-list="$list" "$temporary_directory/$label.dump"
}
assert_write_denied() {
  local database="$1" mode="$2"
  if run_bootstrap_psql "$database" -qAt >"$temporary_directory/denied.out" 2>"$temporary_directory/denied.err" <<'SQL'
SET ROLE schema_migrator;
INSERT INTO public.spatial_ref_sys (srid) VALUES (990002);
SQL
  then fail 'migration role retained extension table INSERT'; fi
  grep -q 'permission denied' "$temporary_directory/denied.err" || fail 'extension INSERT failed for an unrelated reason'
  if [[ "$mode" == 'full' ]]; then
    if run_bootstrap_psql "$database" -qAt >"$temporary_directory/denied.out" 2>"$temporary_directory/denied.err" <<'SQL'
SET ROLE schema_migrator;
SELECT pg_catalog.setval('topology.topology_id_seq', 733002, true);
SQL
    then fail 'migration role retained extension sequence UPDATE'; fi
    grep -q 'permission denied' "$temporary_directory/denied.err" || fail 'sequence UPDATE failed for an unrelated reason'
  fi
}
successful_restore() {
  local source_database="$1" label="$2" mode="$3" database="$database_prefix"_"$2"_restored extensions
  data_fingerprint "$source_database" "$mode" >"$temporary_directory/$label.source"
  extensions="$(make_archive "$source_database" "$label")"
  create_database "$database"
  extension_phase "$database" prepare "$extensions" >/dev/null
  extension_phase "$database" snapshot "$extensions" >"$temporary_directory/$label.acl.before"
  extension_phase "$database" grant "$extensions" >/dev/null
  restore_archive "$database" "$label"
  extension_phase "$database" revoke "$extensions" >/dev/null
  extension_phase "$database" snapshot "$extensions" >"$temporary_directory/$label.acl.after"
  cmp -s "$temporary_directory/$label.acl.before" "$temporary_directory/$label.acl.after" || fail 'extension owner or ACL baseline changed'
  data_fingerprint "$database" "$mode" >"$temporary_directory/$label.restored"
  cmp -s "$temporary_directory/$label.source" "$temporary_directory/$label.restored" || fail 'restored business/configuration/default/sequence data differs'
  [[ "$(run_bootstrap_psql "$database" -qAt -c "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.fixture_business'::regclass;")" == 'schema_migrator' ]] ||
    fail 'archive business DDL did not execute as the migration role'
  if [[ "$mode" == 'base' ]]; then
    [[ "$(run_bootstrap_psql "$database" -qAt -c "SELECT count(*) FROM pg_extension WHERE extname IN ('fuzzystrmatch', 'postgis_tiger_geocoder', 'postgis_topology');")" == '0' ]] ||
      fail 'base-only archive installed optional extensions'
  fi
  assert_write_denied "$database" "$mode"
  printf 'RESTORE_EXTENSION_%s=OK\n' "$label"
}

base_source="$database_prefix"_base_source
full_source="$database_prefix"_full_source
seed_source "$base_source" base
seed_source "$full_source" full
successful_restore "$base_source" base base
successful_restore "$full_source" full_false full
run_bootstrap_psql "$full_source" -qAt -c "SELECT pg_catalog.setval('topology.topology_id_seq', 733003, true);" >/dev/null
successful_restore "$full_source" full_true full

# Feed mutations of a real archive TOC to the production parser. Accepted data
# must survive the actual restore above; each unsupported archive must fail.
expect_invalid_plan() {
  if prepare_restore_extension_plan "$temporary_directory/invalid.toc" "$temporary_directory/invalid.list" postgres \
      >"$temporary_directory/invalid.out" 2>"$temporary_directory/invalid.err"; then fail "$1"; fi
}
cp "$temporary_directory/full_true.toc" "$temporary_directory/invalid.toc"
printf '999999; 3079 999999 EXTENSION - hstore\n' >>"$temporary_directory/invalid.toc"
expect_invalid_plan 'unknown extension was accepted'
cp "$temporary_directory/full_true.toc" "$temporary_directory/invalid.toc"
awk '!/^;/ && NF {print; exit}' "$temporary_directory/full_true.toc" >>"$temporary_directory/invalid.toc"
expect_invalid_plan 'duplicate TOC ID was accepted'
awk '!/TABLE DATA tiger pagc_rules /' "$temporary_directory/full_true.toc" >"$temporary_directory/invalid.toc"
expect_invalid_plan 'missing extension configuration data was accepted'
cp "$temporary_directory/full_true.toc" "$temporary_directory/invalid.toc"
printf '999999; 2615 999999 SCHEMA - tiger_data postgres\n' >>"$temporary_directory/invalid.toc"
expect_invalid_plan 'unexpected protected schema was accepted'
sed 's/SCHEMA - tiger postgres/SCHEMA - tiger forged_owner/' "$temporary_directory/full_true.toc" >"$temporary_directory/invalid.toc"
expect_invalid_plan 'forged extension schema owner was accepted'
sed 's/TABLE DATA tiger pagc_gaz postgres/TABLE DATA tiger pagc_gaz forged_owner/' "$temporary_directory/full_true.toc" >"$temporary_directory/invalid.toc"
expect_invalid_plan 'forged extension configuration owner was accepted'
if rejected_csv="$(prepare_restore_extension_plan "$temporary_directory/missing-input.toc" "$temporary_directory/missing-input.list" postgres 2>"$temporary_directory/missing-input.err")"; then
  fail 'unreadable TOC input was accepted'
fi
[[ ! -e "$temporary_directory/missing-input.list" ]] || fail 'unreadable input created a partial restore plan'

# The deployed caller captures CSV inside an OR/conditional context, where
# Bash errexit does not protect helper writes. Fail exactly the first output
# write; later writes and the final CSV could otherwise make it look successful.
(
  fixture_printf_calls=0
  printf() {
    fixture_printf_calls=$((fixture_printf_calls + 1))
    if [[ "$fixture_printf_calls" == '1' ]]; then return 1; fi
    builtin printf "$@"
  }
  if rejected_csv="$(prepare_restore_extension_plan "$temporary_directory/full_true.toc" "$temporary_directory/write-failure.list" postgres)"; then
    fail 'TOC output write failure was ignored in conditional command substitution'
  fi
)
if [[ -e /dev/full ]]; then
  if rejected_csv="$(prepare_restore_extension_plan "$temporary_directory/full_true.toc" /dev/full postgres 2>"$temporary_directory/write-failure.err")"; then
    fail 'full output device was accepted in conditional command substitution'
  fi
fi

extensions="$(prepare_restore_extension_plan "$temporary_directory/full_true.toc" "$temporary_directory/checked.list" postgres)"
guard_database="$database_prefix"_guard
create_database "$guard_database"
extension_phase "$guard_database" prepare "$extensions" >/dev/null
run_bootstrap_psql "$guard_database" -qAt -c 'ALTER SCHEMA tiger OWNER TO schema_migrator;' >/dev/null
if extension_phase "$guard_database" snapshot "$extensions" >"$temporary_directory/invalid.out" 2>"$temporary_directory/invalid.err"; then
  fail 'incorrect extension namespace owner was accepted'
fi
run_bootstrap_psql "$guard_database" -qAt <<'SQL' >/dev/null
ALTER SCHEMA tiger OWNER TO postgres;
ALTER EXTENSION postgis_tiger_geocoder DROP TABLE tiger.geocode_settings;
SQL
if extension_phase "$guard_database" snapshot "$extensions" >"$temporary_directory/invalid.out" 2>"$temporary_directory/invalid.err"; then
  fail 'configuration relation without extension membership was accepted'
fi
printf 'RESTORE_EXTENSION_REJECTION=OK\n'

# Force the final business COPY to fail after extension data and the sequence
# have been processed. Transactional DDL/COPY must roll back. setval itself is
# not transactional, so the entire failed clone must then be dropped.
failed_database="$database_prefix"_failed
create_database "$failed_database"
extension_phase "$failed_database" prepare "$extensions" >/dev/null
extension_phase "$failed_database" grant "$extensions" >/dev/null
run_bootstrap_psql "$failed_database" -qAt <<'SQL' >/dev/null
CREATE FUNCTION public.fixture_reject_late_copy() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE'
             AND object_identity = 'public.fixture_late_failure') THEN
    ALTER TABLE public.fixture_late_failure ADD CONSTRAINT fixture_forced_copy_failure CHECK (payload <> 'reject');
  END IF;
END $$;
CREATE EVENT TRIGGER fixture_reject_late_copy ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
EXECUTE FUNCTION public.fixture_reject_late_copy();
SQL
awk '/TABLE DATA public fixture_late_failure / {late=$0; next} {print} END {if (!late) exit 1; print late}' \
  "$temporary_directory/full_true.list" >"$temporary_directory/failure.list"
if restore_archive "$failed_database" full_true "$temporary_directory/failure.list" \
    >"$temporary_directory/failure.out" 2>"$temporary_directory/failure.err"; then fail 'forced late business COPY unexpectedly succeeded'; fi
grep -q 'fixture_forced_copy_failure' "$temporary_directory/failure.err" || fail 'restore failed before the intentional late COPY'
[[ "$(run_bootstrap_psql "$failed_database" -qAt -c 'SELECT last_value = 733003 AND is_called FROM topology.topology_id_seq;')" == 't' ]] ||
  fail 'intentional failure happened before the extension sequence was restored'
[[ "$(run_bootstrap_psql "$failed_database" -qAt <<'SQL'
SELECT to_regclass('public.fixture_business') IS NULL AND to_regclass('public.schema_migrations') IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.spatial_ref_sys WHERE srid = 990001)
  AND NOT EXISTS (SELECT 1 FROM tiger.geocode_settings)
  AND NOT EXISTS (SELECT 1 FROM tiger.pagc_gaz WHERE is_custom)
  AND NOT EXISTS (SELECT 1 FROM tiger.pagc_lex WHERE is_custom)
  AND NOT EXISTS (SELECT 1 FROM tiger.pagc_rules WHERE is_custom)
  AND NOT EXISTS (SELECT 1 FROM topology.topology)
  AND NOT EXISTS (SELECT 1 FROM topology.layer);
SQL
)" == 't' ]] || fail 'failed restore leaked transactional business or configuration data'

# Exercise the shipped cleanup SQL and literal binding, without invoking the
# deployed wrapper, Docker, release directories or credentials.
extract_cleanup_call() {
  local query="$1"
  awk -v query="$query" '
    /run_bootstrap_psql .*<<\047SQL\047/ {block=$0; sub(/^.*run_bootstrap_psql/, "run_bootstrap_psql", block); collecting=1; next}
    collecting {block=block "\n" $0; if ($0 == "SQL") {collecting=0; if (index(block, query)) {print block; found=1; exit}}}
    END {if (!found) exit 1}
  ' "$restore_script"
}
restore_database="$failed_database"
cleanup_call="$(extract_cleanup_call 'SELECT pg_terminate_backend')" || fail 'actual restore termination call was not found'
eval "$cleanup_call"
cleanup_call="$(extract_cleanup_call 'DROP DATABASE')" || fail 'actual restore DROP call was not found'
eval "$cleanup_call"
[[ -z "$(run_bootstrap_psql postgres -qAt -v target="$failed_database" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'target';
SQL
)" ]] || fail 'failed restore clone was not dropped'
data_fingerprint "$full_source" full >"$temporary_directory/full_true.source.after"
cmp -s "$temporary_directory/full_true.source" "$temporary_directory/full_true.source.after" || fail 'restore attempts changed the source database'
data_fingerprint "$base_source" base >"$temporary_directory/base.source.after"
cmp -s "$temporary_directory/base.source" "$temporary_directory/base.source.after" || fail 'restore attempts changed the base-only source database'
role_fingerprint >"$temporary_directory/roles.after"
cmp -s "$temporary_directory/roles.before" "$temporary_directory/roles.after" || fail 'restore changed cluster role privileges or membership'
printf 'RESTORE_EXTENSION_FAILURE_CLEANUP=OK\n'
printf 'DATABASE_RESTORE_EXTENSION_FIXTURE=OK\n'
