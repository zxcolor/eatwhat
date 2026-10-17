\set ON_ERROR_STOP on

-- Bootstrap-only, read-only gate. Never print identity or proof values.
BEGIN READ ONLY;
DO $verify_wechat_miniprogram_login$
DECLARE
  service_role text;
  resolver record;
BEGIN
  IF NOT (SELECT count(*) = 14 AND min(version) = 1 AND max(version) = 14
      AND bool_and(checksum ~ '^[0-9a-f]{64}$')
      AND bool_or(version = 12 AND name = 'wechat_union_aliases')
      AND bool_or(version = 13 AND name = 'admin_config_control')
      AND bool_or(version = 14 AND name = 'wechat_miniprogram_login')
    FROM public.schema_migrations) THEN
    RAISE EXCEPTION 'Mini Program login requires the exact schema 0014 ledger';
  END IF;

  SELECT routine.* INTO resolver FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = to_regprocedure(
      'public.resolve_wechat_miniprogram_user_from_consumed_state(uuid)');
  IF NOT FOUND OR NOT resolver.prosecdef
    OR resolver.proowner <> 'schema_migrator'::regrole
    OR resolver.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR pg_catalog.pg_get_function_result(resolver.oid) IS DISTINCT FROM
      'TABLE(result text, user_id uuid)'
    OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
      resolver.proacl, pg_catalog.acldefault('f', resolver.proowner))) AS privilege
      WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'Mini Program login resolver execution context is unsafe';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        relation.relacl, pg_catalog.acldefault('r', relation.relowner))) AS privilege
      WHERE relation.oid = 'public.wechat_union_aliases'::regclass
        AND privilege.grantee = 0)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE attribute.attrelid = 'public.wechat_union_aliases'::regclass
        AND privilege.grantee = 0) THEN
    RAISE EXCEPTION 'PUBLIC must not access WeChat Union alias storage';
  END IF;

  FOREACH service_role IN ARRAY ARRAY[
    'api_runtime', 'admin_api_runtime', 'retention_worker', 'data_export_worker'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = service_role AND NOT role.rolsuper AND NOT role.rolbypassrls)
      OR has_table_privilege(service_role, 'public.wechat_union_aliases',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(service_role, 'public.wechat_union_aliases',
        'SELECT,INSERT,UPDATE,REFERENCES')
      OR has_function_privilege(service_role, resolver.oid, 'EXECUTE')
        IS DISTINCT FROM (service_role = 'api_runtime') THEN
      RAISE EXCEPTION 'Mini Program login role privileges are unsafe';
    END IF;
  END LOOP;
END;
$verify_wechat_miniprogram_login$;
SELECT 'WECHAT_MINIPROGRAM_SCHEMA_ACL=OK';
COMMIT;
