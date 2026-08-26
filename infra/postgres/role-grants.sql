\set ON_ERROR_STOP on

-- Run from a controlled provisioning session as the schema owner. All five
-- variables must name existing roles. This script is convergent and is never
-- executed by the API container.
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
\if :{?admin_runtime_role}
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'admin_runtime_role psql variable is required';
  END
  $psql_fail$;
\endif
\if :{?export_worker_role}
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'export_worker_role psql variable is required';
  END
  $psql_fail$;
\endif

SELECT (
  :'migration_owner' <> :'runtime_role'
  AND :'migration_owner' <> :'maintenance_role'
  AND :'migration_owner' <> :'admin_runtime_role'
  AND :'migration_owner' <> :'export_worker_role'
  AND :'runtime_role' <> :'maintenance_role'
  AND :'runtime_role' <> :'admin_runtime_role'
  AND :'runtime_role' <> :'export_worker_role'
  AND :'maintenance_role' <> :'admin_runtime_role'
  AND :'maintenance_role' <> :'export_worker_role'
  AND :'admin_runtime_role' <> :'export_worker_role'
) AS declared_roles_are_distinct \gset
\if :declared_roles_are_distinct
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'database roles must be pairwise distinct';
  END
  $psql_fail$;
\endif

SELECT (
  to_regrole(:'migration_owner') IS NOT NULL
  AND to_regrole(:'runtime_role') IS NOT NULL
  AND to_regrole(:'maintenance_role') IS NOT NULL
  AND to_regrole(:'admin_runtime_role') IS NOT NULL
  AND to_regrole(:'export_worker_role') IS NOT NULL
  AND pg_has_role(current_user, :'migration_owner', 'MEMBER')
) AS provisioning_authorized \gset
\if :provisioning_authorized
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'current database role is not authorized to provision migration-owned objects';
  END
  $psql_fail$;
\endif

SELECT NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname IN (
      :'migration_owner', :'runtime_role', :'maintenance_role',
      :'admin_runtime_role', :'export_worker_role'
    )
    AND (
      role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
      OR role.rolreplication OR role.rolbypassrls
    )
) AND NOT EXISTS (
  SELECT 1
  FROM (VALUES
    (:'migration_owner', :'runtime_role'),
    (:'migration_owner', :'maintenance_role'),
    (:'migration_owner', :'admin_runtime_role'),
    (:'migration_owner', :'export_worker_role'),
    (:'runtime_role', :'migration_owner'),
    (:'runtime_role', :'maintenance_role'),
    (:'runtime_role', :'admin_runtime_role'),
    (:'runtime_role', :'export_worker_role'),
    (:'maintenance_role', :'migration_owner'),
    (:'maintenance_role', :'runtime_role'),
    (:'maintenance_role', :'admin_runtime_role'),
    (:'maintenance_role', :'export_worker_role'),
    (:'admin_runtime_role', :'migration_owner'),
    (:'admin_runtime_role', :'runtime_role'),
    (:'admin_runtime_role', :'maintenance_role'),
    (:'admin_runtime_role', :'export_worker_role'),
    (:'export_worker_role', :'migration_owner'),
    (:'export_worker_role', :'runtime_role'),
    (:'export_worker_role', :'maintenance_role'),
    (:'export_worker_role', :'admin_runtime_role')
  ) AS role_edge(member_role, target_role)
  WHERE pg_has_role(role_edge.member_role, role_edge.target_role, 'MEMBER')
    OR pg_has_role(role_edge.member_role, role_edge.target_role, 'USAGE')
)
  AS least_privilege_roles \gset
\if :least_privilege_roles
\else
  DO $psql_fail$
  BEGIN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'database roles violate the least-privilege deployment contract';
  END
  $psql_fail$;
\endif

BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Revoke only migration-owned application objects. PostGIS extension objects
-- are owned by the separate bootstrap role and are not mutable here.
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I, %I, %I, %I;',
  namespace.nspname,
  relation.relname,
  :'runtime_role',
  :'maintenance_role',
  :'admin_runtime_role',
  :'export_worker_role'
)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner
WHERE namespace.nspname = 'public'
  AND owner_role.rolname = :'migration_owner'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY relation.relname
\gexec
-- Table-level REVOKE does not necessarily erase historical column ACLs. Build
-- one safely quoted column-level REVOKE per current table inside this transaction.
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM %I, %I, %I, %I;',
  string_agg(pg_catalog.format('%I', column_name), ', ' ORDER BY ordinal_position),
  table_schema,
  table_name,
  :'runtime_role',
  :'maintenance_role',
  :'admin_runtime_role',
  :'export_worker_role'
)
FROM information_schema.columns
WHERE table_schema = 'public'
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = table_schema
      AND relation.relname = table_name
      AND owner_role.rolname = :'migration_owner'
  )
GROUP BY table_schema, table_name
ORDER BY table_name
\gexec
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I, %I, %I, %I;',
  namespace.nspname,
  relation.relname,
  :'runtime_role',
  :'maintenance_role',
  :'admin_runtime_role',
  :'export_worker_role'
)
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = relation.relowner
WHERE namespace.nspname = 'public'
  AND owner_role.rolname = :'migration_owner'
  AND relation.relkind = 'S'
ORDER BY relation.relname
\gexec
SELECT pg_catalog.format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, %I, %I, %I, %I;',
  routine.oid::regprocedure,
  :'runtime_role',
  :'maintenance_role',
  :'admin_runtime_role',
  :'export_worker_role'
)
FROM pg_catalog.pg_proc AS routine
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = routine.proowner
WHERE namespace.nspname = 'public'
  AND owner_role.rolname = :'migration_owner'
ORDER BY routine.oid
\gexec
REVOKE CREATE ON SCHEMA public FROM
  :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";

ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT SELECT ON public.schema_migrations TO :"runtime_role";
GRANT SELECT ON public.users, public.identity_bindings TO :"runtime_role";
GRANT SELECT, INSERT ON
  public.otp_challenges,
  public.auth_refresh_credentials,
  public.auth_access_tokens,
  public.oauth_states,
  public.fusion_auth_flows
TO :"runtime_role";
GRANT SELECT, INSERT ON public.auth_session_families TO :"runtime_role";
GRANT UPDATE (status, last_seen_at, last_ip_hash, compromised_at, revoked_at)
  ON public.auth_session_families TO :"runtime_role";
GRANT UPDATE (revoked_at) ON public.auth_access_tokens TO :"runtime_role";
GRANT SELECT ON public.account_deletion_jobs TO :"runtime_role";
GRANT SELECT ON
  public.coverage_areas,
  public.app_config_versions
TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.data_rights_authorization_allows(
  uuid, varchar, text
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.claim_persistence_idempotency(
  uuid, varchar, varchar, varchar, varchar, uuid
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.complete_persistence_idempotency_resource(
  uuid, varchar, varchar, varchar, uuid, uuid
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_insert_favorite(
  uuid, uuid, varchar, varchar, uuid, timestamptz, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_update_favorite_group(
  uuid, uuid, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_get_favorite(uuid, uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_list_favorites(
  uuid, timestamptz, uuid, integer, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_delete_favorite(uuid, uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_record_history(
  uuid, uuid, varchar, varchar, uuid, timestamptz,
  varchar, varchar, varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_list_history(
  uuid, timestamptz, uuid, integer, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_clear_history(uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_insert_private_feedback(
  uuid, uuid, varchar, varchar, uuid, timestamptz,
  varchar, varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_get_private_feedback(uuid, uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_list_private_feedback(
  uuid, timestamptz, uuid, integer, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_delete_private_feedback(uuid, uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.persistence_clear_private_feedback(uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.revoke_non_primary_identity_binding(uuid, uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.bind_email_identity_from_consumed_otp(
  uuid, uuid, varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.bind_qq_identity_from_consumed_oauth_state(
  uuid, uuid, varchar, varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.finalize_otp_delivery(
  uuid, varchar, varchar, timestamptz
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.record_otp_verification_attempt(
  uuid, varchar, uuid, varchar, varchar, boolean
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.rotate_auth_refresh_credential(
  uuid, uuid, uuid
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.mark_auth_refresh_replay(
  uuid, uuid
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.consume_oauth_state(
  uuid, varchar, varchar, varchar, varchar, uuid, varchar,
  varchar, varchar, varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.register_phone_wechat_account(
  uuid, uuid, uuid, varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.claim_fusion_auth_verify_token(
  uuid, varchar, varchar, varchar, varchar[], varchar[], varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.record_fusion_auth_result(
  uuid, varchar, varchar, varchar, varchar, varchar, boolean, boolean,
  varchar, varchar, varchar, varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.register_fusion_phone_wechat_account(
  uuid, uuid, uuid, varchar, varchar
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.begin_account_deletion(
  uuid, uuid, varchar, varchar, timestamptz
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.submit_support_feedback(
  uuid, uuid, varchar, varchar, bytea, varchar, varchar, varchar,
  jsonb, varchar, varchar, jsonb
) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.support_feedback_required_key_versions()
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.app_queue_data_export(uuid, uuid, boolean)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.app_get_data_export_status(uuid, uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.app_get_latest_data_export_status(uuid)
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.app_open_data_export_artifact(uuid, uuid)
  TO :"runtime_role";

-- The export process has a separate login role. Its only direct read is the
-- non-sensitive migration ledger used by the startup schema gate; all business
-- data remains behind fenced worker primitives. In particular it cannot
-- authenticate users, submit feedback, open administrator data, or call the API
-- artifact opener.
GRANT USAGE ON SCHEMA public TO :"export_worker_role";
GRANT SELECT ON public.schema_migrations TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_artifact_required_locator_key_versions()
  TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.support_feedback_required_key_versions()
  TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_claim_next_job(
  varchar, varchar, integer
) TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_renew_job_lease(
  uuid, varchar, varchar, bigint, integer
) TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_stage_job_artifact(
  uuid, varchar, varchar, bigint, bytea, varchar, varchar, bigint, varchar
) TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_build_safe_snapshot(
  uuid, varchar, varchar
) TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_complete_job(
  uuid, varchar, varchar, bigint
) TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_fail_job(
  uuid, varchar, varchar, bigint, varchar, boolean
) TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_claim_next_artifact_deletion(
  varchar, varchar, integer
) TO :"export_worker_role";
GRANT EXECUTE ON FUNCTION public.export_mark_artifact_deleted(
  uuid, varchar, varchar, bigint
) TO :"export_worker_role";

GRANT USAGE ON SCHEMA public TO :"admin_runtime_role";
GRANT SELECT ON public.schema_migrations TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_begin_login_challenge(
	uuid, varchar[], varchar[], varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_begin_login_challenge(
  uuid, varchar, varchar, varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_get_login_credential_options(
  uuid, varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_get_assertion_credential(
  uuid, varchar, varchar, varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_fail_login_challenge(
  uuid, varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_complete_login_assertion(
  uuid, varchar, varchar, varchar, varchar, varchar, varchar, varchar,
  varchar, varchar, varchar, varchar, boolean, bigint, uuid, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_authenticate_session(
  varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_logout_session(
  varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_begin_enroll_challenge(
  varchar, varchar, varchar, varchar, varchar, uuid, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_fail_enroll_challenge(
  uuid, varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_complete_credential_enrollment(
  uuid, varchar, varchar, varchar, varchar, varchar, uuid, varchar,
  varchar, bytea, varchar, bytea, varchar, varchar, varchar, varchar,
  boolean, bigint
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_get_self_enroll_credential_options(
  varchar, varchar, varchar, varchar, varchar, uuid, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_list_self_credentials(
  varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_get_self_credential_record(
  varchar, varchar, varchar, varchar, varchar, uuid
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_revoke_self_credential(
  varchar, varchar, varchar, varchar, varchar, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_list_sanitized_audit_events(
  varchar, varchar, varchar, varchar, varchar, timestamptz, uuid, integer
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_grant_role(
  varchar, varchar, varchar, varchar, varchar, uuid, varchar, timestamptz
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_revoke_role(
  varchar, varchar, varchar, varchar, varchar, uuid, varchar
) TO :"admin_runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_set_user_status(
  varchar, varchar, varchar, varchar, varchar, uuid, varchar
) TO :"admin_runtime_role";

GRANT USAGE ON SCHEMA public TO :"maintenance_role";
GRANT SELECT ON public.schema_migrations TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.preview_retention_cleanup()
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.execute_retention_cleanup()
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.preview_persistence_retention_cleanup()
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.execute_persistence_retention_cleanup()
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.preview_fusion_auth_retention_cleanup()
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.execute_fusion_auth_retention_cleanup()
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.complete_account_deletion(uuid, uuid)
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.preview_admin_security_retention_cleanup()
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.execute_admin_security_retention_cleanup()
  TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.rewrap_support_feedback(
  uuid, varchar, varchar, varchar, bytea, varchar, varchar, varchar
) TO :"maintenance_role";
GRANT EXECUTE ON FUNCTION public.anonymize_expired_support_feedback_guest_ip_hashes()
  TO :"maintenance_role";

-- Defense in depth: these remain explicit even though the convergent revocation
-- above already removes all direct access.
REVOKE ALL ON public.admin_audit_log,
  public.admin_users,
  public.admin_roles,
  public.admin_user_roles,
  public.admin_permissions,
  public.admin_role_permissions,
  public.admin_mfa_credentials,
  public.admin_sessions,
  public.admin_webauthn_challenges,
  public.data_rights_authorizations,
  public.data_rights_authorization_operations,
  public.external_place_references,
  public.favorites,
  public.recommendation_history,
  public.private_recommendation_feedback,
  public.persistence_idempotency_records,
  public.support_feedback,
  public.data_export_jobs
FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.persist_licensed_external_place_reference(
  varchar, varchar, uuid, timestamptz
) FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.purge_expired_admin_audit_events()
  FROM :"runtime_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.purge_inactive_external_place_references()
  FROM :"runtime_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.revoke_data_rights_authorization(
  uuid, varchar, varchar
) FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.reactivate_phone_email_identity_binding(
  uuid, uuid, uuid, varchar, varchar
) FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.admin_bootstrap_first_security_admin(
  uuid, varchar, varchar, uuid, varchar, varchar, bytea, varchar, bytea,
  varchar, varchar, varchar, varchar, boolean, bigint
) FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.admin_actor_has_permission(uuid, varchar)
  FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.admin_revoke_user_sessions(
  uuid, varchar, varchar, varchar
) FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.admin_revoke_credential(
  varchar, varchar, varchar, varchar, varchar, uuid
) FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.append_admin_security_audit_event(
  varchar, varchar, varchar, varchar, varchar
) FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.append_admin_audit_event(
  varchar, varchar, varchar, varchar, varchar, jsonb
) FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.preview_admin_security_retention_cleanup()
  FROM :"runtime_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.execute_admin_security_retention_cleanup()
  FROM :"runtime_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.rewrap_support_feedback(
  uuid, varchar, varchar, varchar, bytea, varchar, varchar, varchar
) FROM :"runtime_role", :"admin_runtime_role", :"export_worker_role";
REVOKE EXECUTE ON FUNCTION public.anonymize_expired_support_feedback_guest_ip_hashes()
  FROM :"runtime_role", :"admin_runtime_role", :"export_worker_role";

COMMIT;
