\set ON_ERROR_STOP on

-- Only this restore-specific file can provision optional extensions. No SQL
-- from the archive is ever executed with the bootstrap role.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SELECT set_config('restore.extensions', :'restore_extensions', true) AS configured_extensions,
       set_config('restore.phase', :'restore_phase', true) AS configured_phase,
       set_config('restore.migration_owner', :'migration_owner', true) AS configured_owner \gset
DO $guard$
BEGIN
  IF current_setting('restore.migration_owner') <> 'schema_migrator'
     OR current_setting('restore.phase') NOT IN ('prepare', 'snapshot', 'grant', 'revoke')
     OR current_setting('restore.extensions') !~ '^pgcrypto,postgis(,fuzzystrmatch)?(,postgis_tiger_geocoder)?(,postgis_topology)?$'
     OR (current_setting('restore.extensions') LIKE '%postgis_tiger_geocoder%'
         AND current_setting('restore.extensions') NOT LIKE '%fuzzystrmatch%')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schema_migrator'
                    AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                WHERE r.rolname = 'schema_migrator') THEN
    RAISE EXCEPTION 'invalid restore extension phase, role or allowlist';
  END IF;
END
$guard$;
SELECT current_setting('restore.phase') = 'prepare' AS preparing \gset
\if :preparing
  CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
  CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
  SELECT 'fuzzystrmatch' = ANY(string_to_array(current_setting('restore.extensions'), ',')) AS needs_fuzzy,
         'postgis_tiger_geocoder' = ANY(string_to_array(current_setting('restore.extensions'), ',')) AS needs_tiger,
         'postgis_topology' = ANY(string_to_array(current_setting('restore.extensions'), ',')) AS needs_topology \gset
  \if :needs_fuzzy
    CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;
  \endif
  \if :needs_tiger
    CREATE EXTENSION IF NOT EXISTS postgis_tiger_geocoder;
  \endif
  \if :needs_topology
    CREATE EXTENSION IF NOT EXISTS postgis_topology;
  \endif
\endif

CREATE TEMP TABLE restore_config (extension_name text, schema_name text, object_name text, kind "char") ON COMMIT DROP;
INSERT INTO restore_config VALUES
  ('postgis', 'public', 'spatial_ref_sys', 'r'),
  ('postgis_tiger_geocoder', 'tiger', 'geocode_settings', 'r'),
  ('postgis_tiger_geocoder', 'tiger', 'pagc_gaz', 'r'),
  ('postgis_tiger_geocoder', 'tiger', 'pagc_lex', 'r'),
  ('postgis_tiger_geocoder', 'tiger', 'pagc_rules', 'r'),
  ('postgis_topology', 'topology', 'topology', 'r'),
  ('postgis_topology', 'topology', 'layer', 'r'),
  ('postgis_topology', 'topology', 'topology_id_seq', 'S');
DELETE FROM restore_config WHERE extension_name <> ALL(string_to_array(current_setting('restore.extensions'), ','));

DO $validate$
DECLARE target record; has_rows boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(string_to_array(current_setting('restore.extensions'), ',')) wanted(name)
    LEFT JOIN pg_extension e ON e.extname = wanted.name
    LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
    LEFT JOIN pg_available_extensions a ON a.name = e.extname
    WHERE e.oid IS NULL OR e.extowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
       OR e.extversion <> a.default_version
       OR n.nspname <> CASE wanted.name WHEN 'postgis_tiger_geocoder' THEN 'tiger' WHEN 'postgis_topology' THEN 'topology' ELSE 'public' END
       OR (e.extname IN ('postgis', 'postgis_tiger_geocoder', 'postgis_topology') AND e.extversion !~ '^3[.]5[.]')
       OR (e.extname = 'pgcrypto' AND e.extversion <> '1.3')
       OR (e.extname = 'fuzzystrmatch' AND e.extversion <> '1.2')
  ) OR EXISTS (
    SELECT 1 FROM pg_extension e WHERE e.extname <> 'plpgsql'
      AND e.extname <> ALL(string_to_array(current_setting('restore.extensions'), ','))
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'plpgsql' AND e.extversion = '1.0' AND n.nspname = 'pg_catalog'
      AND e.extowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  ) THEN RAISE EXCEPTION 'restore extension inventory, version or ownership mismatch'; END IF;
  FOR target IN SELECT * FROM restore_config LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_extension e ON e.extname = target.extension_name
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.objsubid = 0
                       AND d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid AND d.deptype = 'e'
      WHERE n.nspname = target.schema_name AND c.relname = target.object_name AND c.relkind = target.kind
        AND c.relowner = e.extowner AND c.oid = ANY(e.extconfig)
    ) THEN RAISE EXCEPTION 'unregistered or incorrectly owned extension configuration object'; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_extension e, unnest(e.extconfig) config(oid)
    JOIN pg_class c ON c.oid = config.oid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE e.extname = ANY(string_to_array(current_setting('restore.extensions'), ','))
      AND NOT EXISTS (SELECT 1 FROM restore_config r WHERE r.extension_name = e.extname
                        AND r.schema_name = n.nspname AND r.object_name = c.relname AND r.kind = c.relkind)
  ) THEN RAISE EXCEPTION 'unexpected extension configuration object'; END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('tiger', 'topology')
              AND n.nspowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'unexpected extension schema owner';
  END IF;
  IF current_setting('restore.phase') IN ('prepare', 'grant') THEN
    FOR target IN SELECT * FROM restore_config LOOP
      IF (CASE WHEN target.kind = 'S'
         THEN has_sequence_privilege('schema_migrator', format('%I.%I', target.schema_name, target.object_name), 'UPDATE')
         ELSE has_table_privilege('schema_migrator', format('%I.%I', target.schema_name, target.object_name), 'INSERT') END) THEN
        RAISE EXCEPTION 'migration role already has extension restore write privilege';
      END IF;
    END LOOP;
    FOR target IN SELECT * FROM restore_config WHERE (schema_name, object_name) IN
      (('tiger', 'geocode_settings'), ('topology', 'topology'), ('topology', 'layer')) LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', target.schema_name, target.object_name) INTO has_rows;
      IF has_rows THEN RAISE EXCEPTION 'new extension full-configuration table is not empty'; END IF;
    END LOOP;
  END IF;
END
$validate$;

SELECT current_setting('restore.phase') = 'snapshot' AS snapshotting,
       current_setting('restore.phase') = 'grant' AS granting,
       current_setting('restore.phase') = 'revoke' AS revoking \gset
\if :snapshotting
  -- Resolve NULL ACL defaults so a GRANT/REVOKE round trip compares semantically.
  SELECT 'extension|' || e.extname || '|' || e.extversion || '|' || n.nspname || '|' || pg_get_userbyid(e.extowner)
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.extname;
  SELECT 'object|' || n.nspname || '.' || c.relname || '|' || pg_get_userbyid(c.relowner) || '|' ||
    COALESCE((SELECT string_agg(format('%s:%s:%s:%s', a.grantor, a.grantee, a.privilege_type, a.is_grantable), ',' ORDER BY a.grantor, a.grantee, a.privilege_type, a.is_grantable)
      FROM aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) a), '')
  FROM restore_config r JOIN pg_namespace n ON n.nspname = r.schema_name
  JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = r.object_name ORDER BY n.nspname, c.relname;
  SELECT 'schema|' || n.nspname || '|' || pg_get_userbyid(n.nspowner) || '|' ||
    COALESCE((SELECT string_agg(format('%s:%s:%s:%s', a.grantor, a.grantee, a.privilege_type, a.is_grantable), ',' ORDER BY a.grantor, a.grantee, a.privilege_type, a.is_grantable)
      FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a), '')
  FROM pg_namespace n WHERE n.nspname IN ('tiger', 'topology') ORDER BY n.nspname;
\endif
\if :granting
  SELECT format('GRANT %s ON %s %I.%I TO schema_migrator;',
    CASE WHEN kind = 'S' THEN 'UPDATE' ELSE 'INSERT' END,
    CASE WHEN kind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, schema_name, object_name)
  FROM restore_config ORDER BY schema_name, object_name \gexec
  SELECT format('GRANT USAGE ON SCHEMA %I TO schema_migrator;', nspname)
  FROM pg_namespace WHERE nspname IN ('tiger', 'topology') ORDER BY nspname \gexec
\endif
\if :revoking
  SELECT format('REVOKE %s ON %s %I.%I FROM schema_migrator;',
    CASE WHEN kind = 'S' THEN 'UPDATE' ELSE 'INSERT' END,
    CASE WHEN kind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, schema_name, object_name)
  FROM restore_config ORDER BY schema_name, object_name \gexec
  SELECT format('REVOKE USAGE ON SCHEMA %I FROM schema_migrator;', nspname)
  FROM pg_namespace WHERE nspname IN ('tiger', 'topology') ORDER BY nspname \gexec
\endif
COMMIT;
