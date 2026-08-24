\set ON_ERROR_STOP on

\if :{?migration_owner}
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'migration_owner psql variable is required';
  END
  $psql_fail$;
\endif
\if :{?runtime_role}
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'runtime_role psql variable is required';
  END
  $psql_fail$;
\endif
\if :{?maintenance_role}
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'maintenance_role psql variable is required';
  END
  $psql_fail$;
\endif

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;

SELECT (
  count(*) FILTER (WHERE extension.extname = 'pgcrypto' AND extension.extversion = '1.3') = 1
  AND count(*) FILTER (
    WHERE extension.extname = 'postgis' AND extension.extversion ~ '^3[.]5([.]|$)'
  ) = 1
  AND bool_and(
    owner_role.rolname NOT IN (
      :'migration_owner', :'runtime_role', :'maintenance_role'
    )
  )
) AS extensions_are_isolated
FROM pg_catalog.pg_extension AS extension
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = extension.extowner
WHERE extension.extname IN ('pgcrypto', 'postgis')
\gset

\if :extensions_are_isolated
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'required extension version or ownership isolation check failed';
  END
  $psql_fail$;
\endif
