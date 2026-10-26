\set ON_ERROR_STOP on

-- Metadata only: never read account or session data during deployment checks.
BEGIN READ ONLY;
DO $verify_web_browser_sessions$
DECLARE
  constraint_expression text;
BEGIN
  IF NOT (SELECT count(*) = 17 AND min(version) = 1 AND max(version) = 17
      AND bool_and(checksum ~ '^[0-9a-f]{64}$')
      AND bool_or(version = 14 AND name = 'wechat_miniprogram_login')
      AND bool_or(version = 15 AND name = 'place_image_display_rights')
      AND bool_or(version = 16 AND name = 'canteen_public_ratings')
      AND bool_or(version = 17 AND name = 'web_browser_sessions')
    FROM public.schema_migrations) THEN
    RAISE EXCEPTION 'WEB browser sessions require the exact schema 0017 ledger';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(check_constraint.oid)
    INTO constraint_expression
    FROM pg_catalog.pg_constraint AS check_constraint
    JOIN pg_catalog.pg_class AS relation ON relation.oid = check_constraint.conrelid
    WHERE relation.oid = 'public.auth_session_families'::regclass
      AND relation.relowner = 'schema_migrator'::regrole
      AND check_constraint.conname = 'auth_session_families_platform_check'
      AND check_constraint.contype = 'c' AND check_constraint.convalidated;
  IF constraint_expression IS DISTINCT FROM
    'CHECK ((platform = ANY (ARRAY[''ANDROID''::text, ''IOS''::text, ''MINIPROGRAM''::text, ''WEB''::text])))' THEN
    RAISE EXCEPTION 'WEB session platform constraint is missing or differs from the reviewed allowlist';
  END IF;
  IF has_table_privilege('api_runtime', 'public.auth_session_families', 'DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR NOT has_table_privilege('api_runtime', 'public.auth_session_families', 'SELECT')
    OR NOT has_table_privilege('api_runtime', 'public.auth_session_families', 'INSERT') THEN
    RAISE EXCEPTION 'WEB session migration changed the API session-table privilege boundary';
  END IF;
END;
$verify_web_browser_sessions$;
SELECT 'WEB_BROWSER_SESSIONS_SCHEMA_ACL=OK';
COMMIT;
