\set ON_ERROR_STOP on

\if :{?migration_owner}
\else
  \echo 'migration_owner psql variable is required'
  \quit 3
\endif
\if :{?runtime_role}
\else
  \echo 'runtime_role psql variable is required'
  \quit 3
\endif
\if :{?maintenance_role}
\else
  \echo 'maintenance_role psql variable is required'
  \quit 3
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
  \echo 'required extension version or ownership isolation check failed'
  \quit 3
\endif
