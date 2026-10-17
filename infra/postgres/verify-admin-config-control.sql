\set ON_ERROR_STOP on

-- Bootstrap-only, read-only deployment gate. Print aggregate facts, never
-- configuration values, administrator identities, sessions or audit context.
BEGIN READ ONLY;

DO $verify_admin_config_control$
DECLARE
  service_role text;
  required_function record;
  observed_function record;
  expected_execute boolean;
BEGIN
  IF NOT (SELECT (
      (count(*) = 13 AND min(version) = 1 AND max(version) = 13)
      OR (count(*) = 14 AND min(version) = 1 AND max(version) = 14
        AND bool_or(version = 14 AND name = 'wechat_miniprogram_login'))
      )
      AND bool_and(checksum ~ '^[0-9a-f]{64}$')
      AND bool_or(version = 13 AND name = 'admin_config_control')
    FROM public.schema_migrations) THEN
    RAISE EXCEPTION 'admin configuration requires the exact schema 0013 or 0014 ledger';
  END IF;

  IF EXISTS (SELECT 1 FROM public.app_config_versions AS config
      WHERE config.config_schema IS NULL OR config.classification IS NULL
        OR NOT public.app_config_value_is_valid(config.config_schema, config.value_json))
    OR EXISTS (SELECT config.config_key FROM public.app_config_versions AS config
      WHERE config.activated_at IS NOT NULL AND config.retired_at IS NULL
      GROUP BY config.config_key HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'administrator configuration baseline validation failed';
  END IF;

  IF EXISTS (SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) AS privilege
    WHERE relation.oid = 'public.app_config_versions'::regclass
      AND privilege.grantee = 0)
    OR EXISTS (SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE attribute.attrelid = 'public.app_config_versions'::regclass
        AND privilege.grantee = 0) THEN
    RAISE EXCEPTION 'PUBLIC must not access administrator configuration storage';
  END IF;

  FOREACH service_role IN ARRAY ARRAY[
    'api_runtime', 'admin_api_runtime', 'retention_worker', 'data_export_worker'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = service_role AND NOT role.rolsuper AND NOT role.rolbypassrls)
      OR has_table_privilege(service_role, 'public.app_config_versions',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(service_role, 'public.app_config_versions',
        'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'service role has unsafe administrator configuration privileges';
    END IF;
  END LOOP;

  FOR required_function IN SELECT * FROM (VALUES
    ('public.runtime_list_active_app_config()', 'api_runtime'),
    ('public.admin_list_sanitized_audit_events_v2(character varying,character varying,character varying,character varying,character varying,timestamp with time zone,uuid,integer)', 'admin_api_runtime'),
    ('public.admin_list_active_app_config(character varying,character varying,character varying,character varying,character varying)', 'admin_api_runtime'),
    ('public.admin_list_app_config_history(character varying,character varying,character varying,character varying,character varying,character varying,integer)', 'admin_api_runtime'),
    ('public.admin_publish_app_config(character varying,character varying,character varying,character varying,character varying,character varying,integer,jsonb,character varying)', 'admin_api_runtime'),
    ('public.admin_rollback_app_config(character varying,character varying,character varying,character varying,character varying,character varying,integer,integer,character varying)', 'admin_api_runtime')
  ) AS required(signature, allowed_role) LOOP
    SELECT routine.* INTO observed_function FROM pg_catalog.pg_proc AS routine
      WHERE routine.oid = to_regprocedure(required_function.signature);
    IF NOT FOUND OR NOT observed_function.prosecdef
      OR observed_function.proowner <> 'schema_migrator'::regrole
      OR observed_function.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
        observed_function.proacl, pg_catalog.acldefault('f', observed_function.proowner))) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'administrator configuration function execution context is unsafe';
    END IF;
    FOREACH service_role IN ARRAY ARRAY[
      'api_runtime', 'admin_api_runtime', 'retention_worker', 'data_export_worker'
    ] LOOP
      expected_execute := service_role = required_function.allowed_role;
      IF has_function_privilege(service_role, observed_function.oid, 'EXECUTE')
        IS DISTINCT FROM expected_execute THEN
        RAISE EXCEPTION 'administrator configuration function role isolation failed';
      END IF;
    END LOOP;
  END LOOP;

  FOR observed_function IN SELECT routine.* FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid IN (
      'public.minimum_app_version_change_is_release_safe(jsonb,jsonb)'::regprocedure,
      'public.app_config_value_is_valid(text,jsonb)'::regprocedure,
      'public.reject_direct_app_config_mutation()'::regprocedure
    ) LOOP
    IF observed_function.prosecdef
      OR observed_function.proowner <> 'schema_migrator'::regrole
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
        observed_function.proacl, pg_catalog.acldefault('f', observed_function.proowner))) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'administrator configuration helper execution context is unsafe';
    END IF;
    FOREACH service_role IN ARRAY ARRAY[
      'api_runtime', 'admin_api_runtime', 'retention_worker', 'data_export_worker'
    ] LOOP
      IF has_function_privilege(service_role, observed_function.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'service role must not execute administrator configuration helpers';
      END IF;
    END LOOP;
  END LOOP;
END;
$verify_admin_config_control$;

SELECT 'ADMIN_CONFIG_BASELINE_ROWS=' || count(*)::text FROM public.app_config_versions;
SELECT 'ADMIN_CONFIG_ACTIVE_KEYS=' || count(*)::text FROM public.app_config_versions
  WHERE activated_at IS NOT NULL AND retired_at IS NULL;
SELECT 'ADMIN_CONFIG_SCHEMA_AND_ACL=OK';
COMMIT;
