\set ON_ERROR_STOP on

-- Run only against the isolated PostgreSQL integration database as its
-- bootstrap role. Every synthetic row and every successful mutation is rolled
-- back. No live user, device, release or credential is used by this fixture.
BEGIN;
SET LOCAL ROLE schema_migrator;
DO $fixture_isolation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.app_config_versions
    WHERE config_key = 'clients.minimum-version'
  ) THEN
    RAISE EXCEPTION 'minimum-version fixture requires an unused isolated key';
  END IF;
END;
$fixture_isolation$;

SELECT set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
INSERT INTO public.admin_users (
  id, login_lookup_hash, login_hash_algorithm, login_hash_key_version,
  status, created_at, status_changed_at
) VALUES (
  'a5300000-0000-0000-0000-000000000001', repeat('f053cafe', 8),
  'HMAC-SHA256', 'fixture-v1', 'ACTIVE', now(), now()
);
INSERT INTO public.admin_user_roles (admin_user_id, role_id)
SELECT 'a5300000-0000-0000-0000-000000000001'::uuid, role.id
FROM public.admin_roles AS role WHERE role.role_code = 'ALGORITHM_ADMIN';
INSERT INTO public.admin_sessions (
  id, admin_user_id, token_hash, token_hash_algorithm, token_hash_key_version,
  device_hash, last_ip_hash, binding_hash_key_version, created_at, last_seen_at,
  idle_expires_at, absolute_expires_at, retain_until
) VALUES (
  'e5300000-0000-0000-0000-000000000001',
  'a5300000-0000-0000-0000-000000000001', repeat('f0531111', 8),
  'HMAC-SHA256', 'fixture-v1', repeat('f0532222', 8), repeat('f0533333', 8),
  'fixture-bind-v1', now(), now(), now() + interval '15 minutes',
  now() + interval '8 hours', now() + interval '30 days 8 hours'
);
SELECT set_config('chi_shen_me.admin_security_mutation', 'disabled', true);

SET LOCAL ROLE admin_api_runtime;
DO $first_publish$
DECLARE outcome record;
BEGIN
  SELECT * INTO outcome FROM public.admin_publish_app_config(
    repeat('f0531111', 8), 'fixture-v1', repeat('f0533333', 8),
    repeat('f0532222', 8), 'fixture-bind-v1',
    'clients.minimum-version', NULL::integer,
    '{"android":"1.5.0"}'::jsonb, 'RELEASE_COMPATIBILITY'
  );
  IF outcome.status IS DISTINCT FROM 'CLIENT_RELEASE_UNVERIFIED'
    OR outcome.version IS NOT NULL OR outcome.value_json IS NOT NULL THEN
    RAISE EXCEPTION 'unverified first minimum-version publication was not rejected';
  END IF;
END;
$first_publish$;

SET LOCAL ROLE schema_migrator;
DO $no_first_write$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config_versions WHERE config_key = 'clients.minimum-version')
    OR EXISTS (
      SELECT 1 FROM public.admin_audit_log
      WHERE context_json ->> 'configKey' = 'clients.minimum-version'
    ) THEN
    RAISE EXCEPTION 'rejected first publication changed configuration or audit';
  END IF;
END;
$no_first_write$;

-- Model an explicitly reviewed legacy baseline. This is fixture-only owner
-- setup, not a product path that bypasses release verification.
SELECT set_config('chi_shen_me.app_config_mutation', 'enabled', true);
INSERT INTO public.app_config_versions (
  config_key, version, value_json, config_schema, classification,
  created_by_admin_user_id, created_at, activated_at, retired_at, change_reason
) VALUES
  ('clients.minimum-version', 1, '{"android":"1.3.0"}'::jsonb,
   'MINIMUM_APP_VERSION_V1', 'PUBLIC', 'a5300000-0000-0000-0000-000000000001',
   now(), now(), now(), 'RELEASE_COMPATIBILITY'),
  ('clients.minimum-version', 2, '{"android":"1.6.0","ios":"1.2.0","miniprogram":"1.3.0"}'::jsonb,
   'MINIMUM_APP_VERSION_V1', 'PUBLIC', 'a5300000-0000-0000-0000-000000000001',
   now(), now(), now(), 'RELEASE_COMPATIBILITY'),
  ('clients.minimum-version', 3, '{"android":"1.5.0","ios":"1.1.0"}'::jsonb,
   'MINIMUM_APP_VERSION_V1', 'PUBLIC', 'a5300000-0000-0000-0000-000000000001',
   now(), now(), NULL, 'RELEASE_COMPATIBILITY');
SELECT set_config('chi_shen_me.app_config_mutation', 'disabled', true);

SET LOCAL ROLE admin_api_runtime;
DO $mutations$
DECLARE
  outcome record;
  forbidden_value jsonb;
BEGIN
  FOREACH forbidden_value IN ARRAY ARRAY[
    '{"android":"1.6.0","ios":"1.1.0"}'::jsonb,
    '{"android":"1.5.0","ios":"1.2.0"}'::jsonb,
    '{"android":"1.5.0","ios":"1.1.0","miniprogram":"0.0.1"}'::jsonb
  ] LOOP
    SELECT * INTO outcome FROM public.admin_publish_app_config(
      repeat('f0531111', 8), 'fixture-v1', repeat('f0533333', 8),
      repeat('f0532222', 8), 'fixture-bind-v1',
      'clients.minimum-version', 3, forbidden_value, 'RELEASE_COMPATIBILITY'
    );
    IF outcome.status IS DISTINCT FROM 'CLIENT_RELEASE_UNVERIFIED' THEN
      RAISE EXCEPTION 'an unverified platform or raised minimum version was accepted';
    END IF;
  END LOOP;

  SELECT * INTO outcome FROM public.admin_publish_app_config(
    repeat('f0531111', 8), 'fixture-v1', repeat('f0533333', 8),
    repeat('f0532222', 8), 'fixture-bind-v1',
    'clients.minimum-version', 2, '{"android":"1.3.0"}'::jsonb, 'RELEASE_COMPATIBILITY'
  );
  IF outcome.status IS DISTINCT FROM 'VERSION_CONFLICT' THEN
    RAISE EXCEPTION 'stale expected version bypassed optimistic concurrency';
  END IF;
  SELECT * INTO outcome FROM public.admin_rollback_app_config(
    repeat('f0531111', 8), 'fixture-v1', repeat('f0533333', 8),
    repeat('f0532222', 8), 'fixture-bind-v1',
    'clients.minimum-version', 3, 2, 'ROLLBACK'
  );
  IF outcome.status IS DISTINCT FROM 'CLIENT_RELEASE_UNVERIFIED' THEN
    RAISE EXCEPTION 'rollback raised an unverified client minimum';
  END IF;

  SELECT * INTO outcome FROM public.admin_publish_app_config(
    repeat('f0531111', 8), 'fixture-v1', repeat('f0533333', 8),
    repeat('f0532222', 8), 'fixture-bind-v1',
    'clients.minimum-version', 3, '{"android":"1.5.0","ios":"1.1.0"}'::jsonb,
    'RELEASE_COMPATIBILITY'
  );
  IF outcome.status IS DISTINCT FROM 'PUBLISHED' OR outcome.version IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'unchanged verified baseline was not retained';
  END IF;
  SELECT * INTO outcome FROM public.admin_publish_app_config(
    repeat('f0531111', 8), 'fixture-v1', repeat('f0533333', 8),
    repeat('f0532222', 8), 'fixture-bind-v1',
    'clients.minimum-version', 4, '{"android":"1.4.0"}'::jsonb, 'RELEASE_COMPATIBILITY'
  );
  IF outcome.status IS DISTINCT FROM 'PUBLISHED' OR outcome.version IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'lowering an existing minimum or removing an optional platform failed';
  END IF;
  SELECT * INTO outcome FROM public.admin_rollback_app_config(
    repeat('f0531111', 8), 'fixture-v1', repeat('f0533333', 8),
    repeat('f0532222', 8), 'fixture-bind-v1',
    'clients.minimum-version', 5, 3, 'ROLLBACK'
  );
  IF outcome.status IS DISTINCT FROM 'CLIENT_RELEASE_UNVERIFIED' THEN
    RAISE EXCEPTION 'rollback reintroduced an unverified platform or raised a minimum';
  END IF;
  SELECT * INTO outcome FROM public.admin_rollback_app_config(
    repeat('f0531111', 8), 'fixture-v1', repeat('f0533333', 8),
    repeat('f0532222', 8), 'fixture-bind-v1',
    'clients.minimum-version', 5, 1, 'ROLLBACK'
  );
  IF outcome.status IS DISTINCT FROM 'ROLLED_BACK' OR outcome.version IS DISTINCT FROM 6
    OR outcome.value_json IS DISTINCT FROM '{"android":"1.3.0"}'::jsonb THEN
    RAISE EXCEPTION 'copy-forward rollback to a lower existing baseline failed';
  END IF;
END;
$mutations$;

SET LOCAL ROLE schema_migrator;
DO $write_accounting$
BEGIN
  IF (SELECT count(*) FROM public.app_config_versions WHERE config_key = 'clients.minimum-version') <> 6
    OR (SELECT count(*) FROM public.admin_audit_log WHERE context_json ->> 'configKey' = 'clients.minimum-version') <> 3
    OR (SELECT count(*) FROM public.admin_audit_log WHERE action_type = 'ADMIN_CONFIG_PUBLISHED' AND context_json ->> 'configKey' = 'clients.minimum-version') <> 2
    OR (SELECT count(*) FROM public.admin_audit_log WHERE action_type = 'ADMIN_CONFIG_ROLLED_BACK' AND context_json ->> 'configKey' = 'clients.minimum-version') <> 1 THEN
    RAISE EXCEPTION 'rejected minimum-version mutations wrote configuration or audit rows';
  END IF;
END;
$write_accounting$;
ROLLBACK;
SELECT 'ADMIN_CONFIG_MINIMUM_VERSION_POLICY=OK';
