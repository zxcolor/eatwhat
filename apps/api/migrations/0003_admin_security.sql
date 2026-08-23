-- Passkey-only administrator security foundation.
-- Raw logins, WebAuthn challenges, IP addresses, user agents, session tokens
-- and credential IDs are never stored by this schema.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.admin_roles
    WHERE role_code NOT IN (
      'AUDITOR', 'OPERATOR', 'ALGORITHM_ADMIN', 'SECURITY_ADMIN'
    )
  ) THEN
    RAISE EXCEPTION 'unknown legacy administrator roles require manual review';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.admin_users
  ) THEN
    RAISE EXCEPTION 'legacy administrators require reviewed offline re-enrollment before this migration';
  END IF;
END;
$$;

CREATE FUNCTION public.admin_grant_role(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_target_admin_user_id uuid,
  p_role_code varchar,
  p_expires_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  actor_admin public.admin_users%ROWTYPE;
  target_admin public.admin_users%ROWTYPE;
  target_role public.admin_roles%ROWTYPE;
  event_time timestamptz := now();
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR NOT ('SECURITY_ADMIN_WRITE' = ANY(actor_session.permission_codes)) THEN
    RETURN 'UNAUTHORIZED';
  END IF;
  SELECT * INTO actor_admin FROM public.admin_users
  WHERE id = actor_session.admin_user_id;
  SELECT * INTO target_admin FROM public.admin_users
  WHERE id = p_target_admin_user_id FOR UPDATE;
  IF NOT FOUND OR target_admin.status = 'DISABLED' THEN
    RETURN 'TARGET_UNAVAILABLE';
  END IF;
  SELECT * INTO target_role FROM public.admin_roles
  WHERE role_code = p_role_code AND status = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'ROLE_UNAVAILABLE'; END IF;
  IF p_expires_at IS NOT NULL
    AND (p_expires_at <= event_time + interval '5 minutes'
      OR p_expires_at > event_time + interval '365 days') THEN
    RETURN 'INVALID_EXPIRY';
  END IF;
  -- At least one non-expiring security administrator must always remain.
  IF target_role.role_code = 'SECURITY_ADMIN'
    AND p_expires_at IS NOT NULL THEN
    RETURN 'INVALID_EXPIRY';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  INSERT INTO public.admin_user_roles (
    admin_user_id, role_id, granted_at, expires_at
  ) VALUES (
    target_admin.id, target_role.id, event_time, p_expires_at
  )
  ON CONFLICT (admin_user_id, role_id) DO UPDATE
  SET granted_at = EXCLUDED.granted_at,
      expires_at = EXCLUDED.expires_at;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.admin_revoke_user_sessions(
    target_admin.id, 'ROLE_CHANGED',
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version
  );
  PERFORM public.append_admin_security_audit_event(
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version,
    'ADMIN_ROLE_GRANTED_' || target_role.role_code,
    'ADMIN_USER', target_admin.login_lookup_hash
  );
  RETURN 'GRANTED';
END;
$$;

CREATE FUNCTION public.admin_revoke_role(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_target_admin_user_id uuid,
  p_role_code varchar
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  actor_admin public.admin_users%ROWTYPE;
  target_admin public.admin_users%ROWTYPE;
  target_role public.admin_roles%ROWTYPE;
  event_time timestamptz := now();
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR NOT ('SECURITY_ADMIN_WRITE' = ANY(actor_session.permission_codes)) THEN
    RETURN 'UNAUTHORIZED';
  END IF;
  SELECT * INTO actor_admin FROM public.admin_users
  WHERE id = actor_session.admin_user_id;
  SELECT * INTO target_admin FROM public.admin_users
  WHERE id = p_target_admin_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'TARGET_UNAVAILABLE'; END IF;
  SELECT * INTO target_role FROM public.admin_roles
  WHERE role_code = p_role_code FOR UPDATE;
  IF NOT FOUND THEN RETURN 'ROLE_UNAVAILABLE'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_user_roles
    WHERE admin_user_id = target_admin.id AND role_id = target_role.id
  ) THEN
    RETURN 'NOT_ASSIGNED';
  END IF;
  IF target_role.role_code = 'SECURITY_ADMIN'
    AND target_admin.status = 'ACTIVE' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('admin-security-admin-invariant', 0)
    );
    IF NOT EXISTS (
      SELECT 1
      FROM public.admin_users AS other_admin
      JOIN public.admin_user_roles AS other_assignment
        ON other_assignment.admin_user_id = other_admin.id
      JOIN public.admin_roles AS other_role
        ON other_role.id = other_assignment.role_id
      WHERE other_admin.id <> target_admin.id
        AND other_admin.status = 'ACTIVE'
        AND other_role.status = 'ACTIVE'
        AND other_role.role_code = 'SECURITY_ADMIN'
        AND other_assignment.granted_at <= event_time
        AND (other_assignment.expires_at IS NULL
          OR other_assignment.expires_at > event_time)
    ) THEN
      RETURN 'LAST_SECURITY_ADMIN';
    END IF;
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  DELETE FROM public.admin_user_roles
  WHERE admin_user_id = target_admin.id AND role_id = target_role.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.admin_revoke_user_sessions(
    target_admin.id, 'ROLE_CHANGED',
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version
  );
  PERFORM public.append_admin_security_audit_event(
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version,
    'ADMIN_ROLE_REVOKED_' || target_role.role_code,
    'ADMIN_USER', target_admin.login_lookup_hash
  );
  RETURN 'REVOKED';
END;
$$;

ALTER TABLE public.admin_users
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now();
UPDATE public.admin_users
SET locked_at = NULL,
    status_changed_at = created_at;
UPDATE public.admin_users
SET disabled_at = NULL
WHERE status <> 'DISABLED';
UPDATE public.admin_users
SET locked_at = created_at
WHERE status = 'LOCKED';
UPDATE public.admin_users
SET disabled_at = COALESCE(disabled_at, created_at)
WHERE status = 'DISABLED';
ALTER TABLE public.admin_users
  ADD CONSTRAINT admin_user_status_shape CHECK (
    (status = 'ACTIVE' AND locked_at IS NULL AND disabled_at IS NULL)
    OR (status = 'LOCKED' AND locked_at IS NOT NULL AND disabled_at IS NULL)
    OR (status = 'DISABLED' AND locked_at IS NULL AND disabled_at IS NOT NULL)
  ),
  ADD CONSTRAINT admin_user_status_times CHECK (
    status_changed_at >= created_at
    AND (locked_at IS NULL OR locked_at >= created_at)
    AND (disabled_at IS NULL OR disabled_at >= created_at)
  );

ALTER TABLE public.admin_roles
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  ADD CONSTRAINT admin_role_code_fixed CHECK (role_code IN (
    'AUDITOR', 'OPERATOR', 'ALGORITHM_ADMIN', 'SECURITY_ADMIN'
  ));

INSERT INTO public.admin_roles (id, role_code, description)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'AUDITOR',
    'Read-only security and operational audit access'),
  ('a0000000-0000-0000-0000-000000000002', 'OPERATOR',
    'User feedback and place-data operations'),
  ('a0000000-0000-0000-0000-000000000003', 'ALGORITHM_ADMIN',
    'Recommendation rule and prompt administration'),
  ('a0000000-0000-0000-0000-000000000004', 'SECURITY_ADMIN',
    'Administrator identity, credential and role administration')
ON CONFLICT (role_code) DO UPDATE
SET description = EXCLUDED.description;

CREATE TABLE public.admin_permissions (
  id uuid PRIMARY KEY,
  permission_code varchar(64) NOT NULL UNIQUE CHECK (permission_code IN (
    'AUDIT_READ', 'OPERATIONS_READ', 'FEEDBACK_MANAGE', 'PLACE_DATA_MANAGE',
    'ALGORITHM_CONFIG_READ', 'ALGORITHM_CONFIG_WRITE',
    'SECURITY_ADMIN_READ', 'SECURITY_ADMIN_WRITE',
    'CREDENTIAL_SELF_MANAGE'
  )),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_role_permissions (
  role_id uuid NOT NULL REFERENCES public.admin_roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL
    REFERENCES public.admin_permissions(id) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_id)
);

INSERT INTO public.admin_permissions (id, permission_code, description)
VALUES
  ('b0000000-0000-0000-0000-000000000001', 'AUDIT_READ',
    'Read immutable administrator audit events'),
  ('b0000000-0000-0000-0000-000000000002', 'OPERATIONS_READ',
    'Read sanitized operational diagnostics'),
  ('b0000000-0000-0000-0000-000000000003', 'FEEDBACK_MANAGE',
    'Process user feedback and complaints'),
  ('b0000000-0000-0000-0000-000000000004', 'PLACE_DATA_MANAGE',
    'Review and temporarily suppress incorrect place data'),
  ('b0000000-0000-0000-0000-000000000005', 'ALGORITHM_CONFIG_READ',
    'Read recommendation rule and prompt versions'),
  ('b0000000-0000-0000-0000-000000000006', 'ALGORITHM_CONFIG_WRITE',
    'Create and roll back recommendation rule and prompt versions'),
  ('b0000000-0000-0000-0000-000000000007', 'SECURITY_ADMIN_READ',
    'Read administrator identity and access state'),
  ('b0000000-0000-0000-0000-000000000008', 'SECURITY_ADMIN_WRITE',
    'Manage administrator status, credentials and role assignments'),
  ('b0000000-0000-0000-0000-000000000009', 'CREDENTIAL_SELF_MANAGE',
    'Enroll and revoke the current administrator own passkeys');

INSERT INTO public.admin_role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM public.admin_roles AS role
JOIN public.admin_permissions AS permission ON (
  (role.role_code = 'AUDITOR' AND permission.permission_code IN (
    'AUDIT_READ', 'OPERATIONS_READ', 'CREDENTIAL_SELF_MANAGE'
  ))
  OR (role.role_code = 'OPERATOR' AND permission.permission_code IN (
    'OPERATIONS_READ', 'FEEDBACK_MANAGE', 'PLACE_DATA_MANAGE',
    'CREDENTIAL_SELF_MANAGE'
  ))
  OR (role.role_code = 'ALGORITHM_ADMIN' AND permission.permission_code IN (
    'OPERATIONS_READ', 'ALGORITHM_CONFIG_READ', 'ALGORITHM_CONFIG_WRITE',
    'CREDENTIAL_SELF_MANAGE'
  ))
  OR (role.role_code = 'SECURITY_ADMIN' AND permission.permission_code IN (
    'AUDIT_READ', 'SECURITY_ADMIN_READ', 'SECURITY_ADMIN_WRITE',
    'CREDENTIAL_SELF_MANAGE'
  ))
);

ALTER TABLE public.admin_mfa_credentials
  ADD COLUMN credential_id_ciphertext bytea,
  ADD COLUMN credential_encryption_key_version varchar(64),
  ADD COLUMN rp_id_hash varchar(64),
  ADD COLUMN rp_id_hash_key_version varchar(64),
  ADD COLUMN origin_hash varchar(64),
  ADD COLUMN origin_hash_key_version varchar(64),
  ADD COLUMN counter_mode text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (counter_mode IN ('UNKNOWN', 'SUPPORTED', 'UNSUPPORTED')),
  ADD COLUMN user_verification_required boolean NOT NULL DEFAULT true
    CHECK (user_verification_required),
  ADD CONSTRAINT admin_credential_active_material CHECK (
    revoked_at IS NOT NULL OR (
      credential_id_ciphertext IS NOT NULL
      AND octet_length(credential_id_ciphertext) BETWEEN 16 AND 4096
      AND credential_encryption_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'
      AND rp_id_hash ~ '^[0-9a-f]{64}$'
      AND rp_id_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'
      AND origin_hash ~ '^[0-9a-f]{64}$'
      AND origin_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'
    )
  ),
  ADD CONSTRAINT admin_credential_usage_times CHECK (
    (last_used_at IS NULL OR last_used_at >= created_at)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  );

CREATE TABLE public.admin_sessions (
  id uuid PRIMARY KEY,
  admin_user_id uuid NOT NULL
    REFERENCES public.admin_users(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hash_algorithm text NOT NULL CHECK (token_hash_algorithm = 'HMAC-SHA256'),
  token_hash_key_version varchar(64) NOT NULL
    CHECK (token_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  device_hash varchar(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  last_ip_hash varchar(64) NOT NULL CHECK (last_ip_hash ~ '^[0-9a-f]{64}$'),
  binding_hash_key_version varchar(64) NOT NULL
    CHECK (binding_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IN (
    'LOGOUT', 'EXPIRED', 'NO_ACTIVE_ROLE', 'ROLE_CHANGED',
    'CREDENTIAL_REVOKED', 'COUNTER_ROLLBACK', 'ADMIN_STATUS_CHANGED',
    'SECURITY_ACTION'
  )),
  retain_until timestamptz NOT NULL,
  CHECK (absolute_expires_at = created_at + interval '8 hours'),
  CHECK (idle_expires_at = LEAST(
    last_seen_at + interval '15 minutes', absolute_expires_at
  )),
  CHECK (last_seen_at >= created_at AND last_seen_at <= absolute_expires_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (retain_until = absolute_expires_at + interval '30 days')
);
CREATE INDEX admin_sessions_user_idx
  ON public.admin_sessions(admin_user_id, created_at DESC);
CREATE INDEX admin_sessions_retention_idx ON public.admin_sessions(retain_until);

CREATE TABLE public.admin_webauthn_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('LOGIN', 'ENROLL')),
  admin_user_id uuid REFERENCES public.admin_users(id) ON DELETE CASCADE,
  initiating_session_id uuid
    REFERENCES public.admin_sessions(id) ON DELETE RESTRICT,
  login_lookup_hash varchar(64) NOT NULL
    CHECK (login_lookup_hash ~ '^[0-9a-f]{64}$'),
  login_hash_key_version varchar(64) NOT NULL
    CHECK (login_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  challenge_hash varchar(64) NOT NULL UNIQUE
    CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  challenge_hash_algorithm text NOT NULL CHECK (challenge_hash_algorithm = 'HMAC-SHA256'),
  challenge_hash_key_version varchar(64) NOT NULL
    CHECK (challenge_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  request_ip_hash varchar(64) NOT NULL
    CHECK (request_ip_hash ~ '^[0-9a-f]{64}$'),
  device_hash varchar(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  binding_hash_key_version varchar(64) NOT NULL
    CHECK (binding_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts = 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  outcome text CHECK (outcome IN (
    'SUCCESS', 'FAILED', 'EXPIRED', 'COUNTER_ROLLBACK'
  )),
  retain_until timestamptz NOT NULL,
  CHECK (expires_at = created_at + interval '5 minutes'),
  CHECK (retain_until = created_at + interval '24 hours'),
  CHECK ((consumed_at IS NULL) = (outcome IS NULL)),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (
    (purpose = 'LOGIN' AND initiating_session_id IS NULL)
    OR (purpose = 'ENROLL' AND admin_user_id IS NOT NULL
      AND initiating_session_id IS NOT NULL)
  )
);
CREATE INDEX admin_challenges_retention_idx
  ON public.admin_webauthn_challenges(retain_until);
CREATE INDEX admin_challenges_login_idx
  ON public.admin_webauthn_challenges(login_lookup_hash, created_at DESC);
CREATE INDEX admin_challenges_ip_idx
  ON public.admin_webauthn_challenges(request_ip_hash, created_at DESC);
CREATE INDEX admin_challenges_device_idx
  ON public.admin_webauthn_challenges(device_hash, created_at DESC);

CREATE FUNCTION public.protect_admin_security_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('chi_shen_me.admin_security_mutation', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'administrator security state requires a controlled transition';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER admin_users_controlled_update
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_users
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_security_state();
CREATE TRIGGER admin_roles_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_roles
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_security_state();
CREATE TRIGGER admin_permissions_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_permissions
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_security_state();
CREATE TRIGGER admin_role_permissions_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_role_permissions
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_security_state();
CREATE TRIGGER admin_user_roles_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_user_roles
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_security_state();
CREATE TRIGGER admin_credentials_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_mfa_credentials
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_security_state();
CREATE TRIGGER admin_sessions_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_sessions
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_security_state();
CREATE TRIGGER admin_challenges_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_webauthn_challenges
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_security_state();

CREATE FUNCTION public.admin_actor_has_permission(
  actor_admin_user_id uuid,
  required_permission_code varchar
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users AS admin_user
    JOIN public.admin_user_roles AS user_role
      ON user_role.admin_user_id = admin_user.id
    JOIN public.admin_roles AS role ON role.id = user_role.role_id
    JOIN public.admin_role_permissions AS role_permission
      ON role_permission.role_id = role.id
    JOIN public.admin_permissions AS permission
      ON permission.id = role_permission.permission_id
    WHERE admin_user.id = actor_admin_user_id
      AND admin_user.status = 'ACTIVE'
      AND role.status = 'ACTIVE'
      AND user_role.granted_at <= now()
      AND (user_role.expires_at IS NULL OR user_role.expires_at > now())
      AND permission.permission_code = required_permission_code
  );
$$;

CREATE FUNCTION public.append_admin_security_audit_event(
  actor_hash varchar,
  event_hash_key_version varchar,
  event_action varchar,
  event_target_type varchar,
  event_target_hash varchar
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT (
    (event_action = 'ADMIN_LOGIN_FAILED'
      AND event_target_type = 'ADMIN_USER')
    OR (event_action = 'ADMIN_LOGIN_SUCCEEDED'
      AND event_target_type = 'ADMIN_SESSION')
    OR (event_action = 'ADMIN_WEBAUTHN_COUNTER_ROLLBACK'
      AND event_target_type = 'ADMIN_CREDENTIAL')
    OR (event_action = 'ADMIN_SESSION_REVOKED'
      AND event_target_type = 'ADMIN_SESSION')
    OR (event_action IN (
      'ADMIN_CREDENTIAL_ENROLLED', 'ADMIN_CREDENTIAL_REVOKED'
    ) AND event_target_type = 'ADMIN_CREDENTIAL')
    OR (event_action IN (
      'ADMIN_ROLE_GRANTED_AUDITOR', 'ADMIN_ROLE_GRANTED_OPERATOR',
      'ADMIN_ROLE_GRANTED_ALGORITHM_ADMIN',
      'ADMIN_ROLE_GRANTED_SECURITY_ADMIN',
      'ADMIN_ROLE_REVOKED_AUDITOR', 'ADMIN_ROLE_REVOKED_OPERATOR',
      'ADMIN_ROLE_REVOKED_ALGORITHM_ADMIN',
      'ADMIN_ROLE_REVOKED_SECURITY_ADMIN'
    ) AND event_target_type = 'ADMIN_USER')
    OR (event_action IN (
      'ADMIN_STATUS_CHANGED_ACTIVE', 'ADMIN_STATUS_CHANGED_LOCKED',
      'ADMIN_STATUS_CHANGED_DISABLED', 'ADMIN_BOOTSTRAP_COMPLETED'
    ) AND event_target_type = 'ADMIN_USER')
  ) THEN
    RAISE EXCEPTION 'invalid administrator audit event shape';
  END IF;
  RETURN public.append_admin_audit_event(
    actor_hash, event_hash_key_version, event_action,
    event_target_type, event_target_hash, '{}'::jsonb
  );
END;
$$;

CREATE FUNCTION public.admin_revoke_user_sessions(
  target_admin_user_id uuid,
  reason_code varchar,
  actor_hash varchar,
  actor_hash_key_version varchar
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_count bigint := 0;
  event_time timestamptz := now();
  revoked_session record;
BEGIN
  IF reason_code NOT IN (
    'ROLE_CHANGED', 'CREDENTIAL_REVOKED', 'COUNTER_ROLLBACK',
    'ADMIN_STATUS_CHANGED', 'SECURITY_ACTION'
  ) THEN
    RAISE EXCEPTION 'invalid administrator session revocation reason';
  END IF;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  FOR revoked_session IN
    UPDATE public.admin_sessions
  SET revoked_at = event_time, revoke_reason = reason_code
    WHERE admin_user_id = target_admin_user_id AND revoked_at IS NULL
    RETURNING token_hash
  LOOP
    affected_count := affected_count + 1;
    PERFORM public.append_admin_security_audit_event(
      actor_hash, actor_hash_key_version,
      'ADMIN_SESSION_REVOKED', 'ADMIN_SESSION', revoked_session.token_hash
    );
  END LOOP;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  RETURN affected_count;
END;
$$;

CREATE FUNCTION public.admin_begin_login_challenge(
  p_challenge_id uuid,
  p_login_lookup_hashes varchar[],
  p_login_hash_key_versions varchar[],
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_admin_user_id uuid;
  effective_login_lookup_hash varchar;
  effective_login_hash_key_version varchar;
  event_time timestamptz := now();
BEGIN
  IF p_login_lookup_hashes IS NULL
    OR p_login_hash_key_versions IS NULL
    OR cardinality(p_login_lookup_hashes) NOT BETWEEN 1 AND 3
    OR cardinality(p_login_lookup_hashes) IS DISTINCT FROM
      cardinality(p_login_hash_key_versions)
    OR EXISTS (
      SELECT 1
      FROM unnest(
        p_login_lookup_hashes,
        p_login_hash_key_versions
      ) AS candidate(lookup_hash, key_version)
      WHERE candidate.lookup_hash IS NULL
        OR candidate.lookup_hash !~ '^[0-9a-f]{64}$'
        OR candidate.key_version IS NULL
        OR candidate.key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    )
    OR p_challenge_hash !~ '^[0-9a-f]{64}$'
    OR p_request_ip_hash !~ '^[0-9a-f]{64}$'
    OR p_device_hash !~ '^[0-9a-f]{64}$'
    OR p_challenge_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_binding_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid administrator login challenge material';
  END IF;
  SELECT admin_user.id, admin_user.login_lookup_hash,
    admin_user.login_hash_key_version
  INTO target_admin_user_id, effective_login_lookup_hash,
    effective_login_hash_key_version
  FROM unnest(
    p_login_lookup_hashes,
    p_login_hash_key_versions
  ) WITH ORDINALITY AS candidate(lookup_hash, key_version, candidate_order)
  JOIN public.admin_users AS admin_user
    ON admin_user.login_lookup_hash = candidate.lookup_hash
    AND admin_user.login_hash_key_version = candidate.key_version
  ORDER BY candidate.candidate_order
  LIMIT 1;
  IF target_admin_user_id IS NULL THEN
    effective_login_lookup_hash := p_login_lookup_hashes[1];
    effective_login_hash_key_version := p_login_hash_key_versions[1];
  END IF;
  -- Serialize each fixed rate-limit dimension before counting. Prefixes keep
  -- the three lock namespaces distinct while preserving a deterministic order.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin-login-login:' || effective_login_lookup_hash, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin-login-ip:' || p_request_ip_hash, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin-login-device:' || p_device_hash, 0)
  );
  IF (
    SELECT count(*) >= 5
    FROM public.admin_webauthn_challenges
    WHERE login_lookup_hash = effective_login_lookup_hash
      AND created_at > event_time - interval '10 minutes'
  ) OR (
    SELECT count(*) >= 20
    FROM public.admin_webauthn_challenges
    WHERE request_ip_hash = p_request_ip_hash
      AND created_at > event_time - interval '10 minutes'
  ) OR (
    SELECT count(*) >= 10
    FROM public.admin_webauthn_challenges
    WHERE device_hash = p_device_hash
      AND created_at > event_time - interval '10 minutes'
  ) THEN
    RAISE EXCEPTION 'administrator login challenge rate limit exceeded';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  INSERT INTO public.admin_webauthn_challenges (
    id, purpose, admin_user_id, login_lookup_hash, login_hash_key_version,
    challenge_hash, challenge_hash_algorithm, challenge_hash_key_version,
    request_ip_hash, device_hash, binding_hash_key_version,
    created_at, expires_at, retain_until
  ) VALUES (
    p_challenge_id, 'LOGIN', target_admin_user_id,
    effective_login_lookup_hash, effective_login_hash_key_version,
    p_challenge_hash, 'HMAC-SHA256', p_challenge_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version,
    event_time, event_time + interval '5 minutes',
    event_time + interval '24 hours'
  );
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  -- Always return the same result for known and unknown login hashes.
  RETURN true;
END;
$$;

-- Compatibility overload for offline/CI operators that intentionally use a
-- single lookup-key version. The API runtime uses the bounded array overload so
-- adding a transition key cannot lock every existing administrator out.
CREATE FUNCTION public.admin_begin_login_challenge(
  p_challenge_id uuid,
  p_login_lookup_hash varchar,
  p_login_hash_key_version varchar,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.admin_begin_login_challenge(
    p_challenge_id,
    ARRAY[p_login_lookup_hash]::varchar[],
    ARRAY[p_login_hash_key_version]::varchar[],
    p_challenge_hash,
    p_challenge_hash_key_version,
    p_request_ip_hash,
    p_device_hash,
    p_binding_hash_key_version
  );
$$;

CREATE FUNCTION public.admin_get_login_credential_options(
  p_challenge_id uuid,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS TABLE(
  credential_id uuid,
  credential_id_ciphertext bytea,
  credential_encryption_key_version varchar
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT credential.id, credential.credential_id_ciphertext,
    credential.credential_encryption_key_version
  FROM public.admin_webauthn_challenges AS challenge
  JOIN public.admin_users AS admin_user
    ON admin_user.id = challenge.admin_user_id
  JOIN public.admin_mfa_credentials AS credential
    ON credential.admin_user_id = admin_user.id
  WHERE challenge.id = p_challenge_id
    AND challenge.purpose = 'LOGIN'
    AND challenge.challenge_hash = p_challenge_hash
    AND challenge.challenge_hash_key_version = p_challenge_hash_key_version
    AND challenge.request_ip_hash = p_request_ip_hash
    AND challenge.device_hash = p_device_hash
    AND challenge.binding_hash_key_version = p_binding_hash_key_version
    AND challenge.consumed_at IS NULL
    AND challenge.expires_at > now()
    AND challenge.attempt_count < challenge.max_attempts
    AND admin_user.status = 'ACTIVE'
    AND credential.revoked_at IS NULL
  ORDER BY credential.created_at, credential.id
  LIMIT 20;
$$;

CREATE FUNCTION public.admin_get_assertion_credential(
  p_challenge_id uuid,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_credential_id_hash varchar,
  p_credential_hash_key_version varchar
)
RETURNS TABLE(
  credential_id uuid,
  public_key bytea,
  signature_counter bigint,
  counter_mode text,
  rp_id_hash varchar,
  rp_id_hash_key_version varchar,
  origin_hash varchar,
  origin_hash_key_version varchar,
  user_verification_required boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT credential.id, credential.public_key, credential.signature_counter,
    credential.counter_mode, credential.rp_id_hash,
    credential.rp_id_hash_key_version, credential.origin_hash,
    credential.origin_hash_key_version, credential.user_verification_required
  FROM public.admin_webauthn_challenges AS challenge
  JOIN public.admin_users AS admin_user
    ON admin_user.id = challenge.admin_user_id
  JOIN public.admin_mfa_credentials AS credential
    ON credential.admin_user_id = admin_user.id
  WHERE challenge.id = p_challenge_id
    AND challenge.purpose = 'LOGIN'
    AND challenge.challenge_hash = p_challenge_hash
    AND challenge.challenge_hash_key_version = p_challenge_hash_key_version
    AND challenge.request_ip_hash = p_request_ip_hash
    AND challenge.device_hash = p_device_hash
    AND challenge.binding_hash_key_version = p_binding_hash_key_version
    AND challenge.consumed_at IS NULL
    AND challenge.expires_at > now()
    AND challenge.attempt_count < challenge.max_attempts
    AND admin_user.status = 'ACTIVE'
    AND credential.credential_id_hash = p_credential_id_hash
    AND credential.credential_hash_key_version = p_credential_hash_key_version
    AND credential.revoked_at IS NULL;
$$;

CREATE FUNCTION public.admin_fail_login_challenge(
  p_challenge_id uuid,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  challenge public.admin_webauthn_challenges%ROWTYPE;
  event_time timestamptz := now();
  next_attempt_count smallint;
BEGIN
  SELECT * INTO challenge
  FROM public.admin_webauthn_challenges
  WHERE id = p_challenge_id
  FOR UPDATE;
  IF NOT FOUND
    OR challenge.purpose <> 'LOGIN'
    OR challenge.challenge_hash <> p_challenge_hash
    OR challenge.challenge_hash_key_version <> p_challenge_hash_key_version
    OR challenge.request_ip_hash <> p_request_ip_hash
    OR challenge.device_hash <> p_device_hash
    OR challenge.binding_hash_key_version <> p_binding_hash_key_version
    OR challenge.consumed_at IS NOT NULL THEN
    RETURN 'INVALID_PROOF';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  IF challenge.expires_at <= event_time THEN
    UPDATE public.admin_webauthn_challenges
    SET consumed_at = event_time, outcome = 'EXPIRED'
    WHERE id = challenge.id;
    PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
    PERFORM public.append_admin_security_audit_event(
      challenge.login_lookup_hash, challenge.login_hash_key_version,
      'ADMIN_LOGIN_FAILED', 'ADMIN_USER', challenge.login_lookup_hash
    );
    RETURN 'EXPIRED';
  END IF;

  next_attempt_count := LEAST(
    challenge.attempt_count + 1, challenge.max_attempts
  );
  UPDATE public.admin_webauthn_challenges
  SET attempt_count = next_attempt_count,
      consumed_at = CASE
        WHEN next_attempt_count >= max_attempts THEN event_time ELSE NULL
      END,
      outcome = CASE
        WHEN next_attempt_count >= max_attempts THEN 'FAILED' ELSE NULL
      END
  WHERE id = challenge.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.append_admin_security_audit_event(
    challenge.login_lookup_hash, challenge.login_hash_key_version,
    'ADMIN_LOGIN_FAILED', 'ADMIN_USER', challenge.login_lookup_hash
  );
  RETURN CASE
    WHEN next_attempt_count >= challenge.max_attempts THEN 'FAILED'
    ELSE 'RETRY_ALLOWED'
  END;
END;
$$;

CREATE FUNCTION public.admin_complete_login_assertion(
  p_challenge_id uuid,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_credential_id_hash varchar,
  p_credential_hash_key_version varchar,
  p_verified_origin_hash varchar,
  p_origin_hash_key_version varchar,
  p_verified_rp_id_hash varchar,
  p_rp_id_hash_key_version varchar,
  p_user_verification_performed boolean,
  p_new_signature_counter bigint,
  p_session_id uuid,
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar
)
RETURNS TABLE(
  security_status text,
  issued_session_id uuid,
  authenticated_admin_user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  challenge public.admin_webauthn_challenges%ROWTYPE;
  credential public.admin_mfa_credentials%ROWTYPE;
  admin_user public.admin_users%ROWTYPE;
  event_time timestamptz := now();
  failure_status text;
  next_counter_mode text;
BEGIN
  SELECT * INTO challenge
  FROM public.admin_webauthn_challenges
  WHERE id = p_challenge_id
  FOR UPDATE;
  IF NOT FOUND
    OR challenge.purpose <> 'LOGIN'
    OR challenge.challenge_hash <> p_challenge_hash
    OR challenge.challenge_hash_key_version <> p_challenge_hash_key_version
    OR challenge.request_ip_hash <> p_request_ip_hash
    OR challenge.device_hash <> p_device_hash
    OR challenge.binding_hash_key_version <> p_binding_hash_key_version
    OR challenge.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'INVALID_PROOF'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  IF challenge.expires_at <= event_time
    OR challenge.attempt_count >= challenge.max_attempts THEN
    SELECT public.admin_fail_login_challenge(
      p_challenge_id, p_challenge_hash, p_challenge_hash_key_version,
      p_request_ip_hash, p_device_hash, p_binding_hash_key_version
    ) INTO failure_status;
    RETURN QUERY SELECT failure_status, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO admin_user FROM public.admin_users
  WHERE id = challenge.admin_user_id FOR UPDATE;
  SELECT * INTO credential FROM public.admin_mfa_credentials
  WHERE admin_user_id = challenge.admin_user_id
    AND credential_id_hash = p_credential_id_hash
    AND credential_hash_key_version = p_credential_hash_key_version
  FOR UPDATE;
  IF NOT FOUND
    OR admin_user.status <> 'ACTIVE'
    OR credential.revoked_at IS NOT NULL
    OR p_user_verification_performed IS DISTINCT FROM true
    OR credential.user_verification_required IS DISTINCT FROM true
    OR credential.origin_hash <> p_verified_origin_hash
    OR credential.origin_hash_key_version <> p_origin_hash_key_version
    OR credential.rp_id_hash <> p_verified_rp_id_hash
    OR credential.rp_id_hash_key_version <> p_rp_id_hash_key_version
    OR p_new_signature_counter < 0
    OR NOT EXISTS (
      SELECT 1 FROM public.admin_user_roles AS user_role
      JOIN public.admin_roles AS role ON role.id = user_role.role_id
      WHERE user_role.admin_user_id = challenge.admin_user_id
        AND role.status = 'ACTIVE'
        AND user_role.granted_at <= event_time
        AND (user_role.expires_at IS NULL OR user_role.expires_at > event_time)
    ) THEN
    SELECT public.admin_fail_login_challenge(
      p_challenge_id, p_challenge_hash, p_challenge_hash_key_version,
      p_request_ip_hash, p_device_hash, p_binding_hash_key_version
    ) INTO failure_status;
    RETURN QUERY SELECT failure_status, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  IF (credential.counter_mode = 'SUPPORTED'
      AND p_new_signature_counter <= credential.signature_counter)
    OR (credential.counter_mode = 'UNKNOWN'
      AND credential.signature_counter > 0
      AND p_new_signature_counter <= credential.signature_counter) THEN
    PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
    UPDATE public.admin_webauthn_challenges
    SET consumed_at = event_time, outcome = 'COUNTER_ROLLBACK'
    WHERE id = challenge.id;
    UPDATE public.admin_mfa_credentials
    SET revoked_at = event_time
    WHERE id = credential.id AND revoked_at IS NULL;
    UPDATE public.admin_users
    SET status = 'LOCKED', locked_at = event_time,
        disabled_at = NULL, status_changed_at = event_time
    WHERE id = admin_user.id;
    PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
    PERFORM public.admin_revoke_user_sessions(
      admin_user.id, 'COUNTER_ROLLBACK',
      admin_user.login_lookup_hash, admin_user.login_hash_key_version
    );
    PERFORM public.append_admin_security_audit_event(
      admin_user.login_lookup_hash, admin_user.login_hash_key_version,
      'ADMIN_WEBAUTHN_COUNTER_ROLLBACK', 'ADMIN_CREDENTIAL',
      credential.credential_id_hash
    );
    RETURN QUERY SELECT 'COUNTER_ROLLBACK'::text, NULL::uuid, admin_user.id;
    RETURN;
  END IF;

  next_counter_mode := CASE
    WHEN p_new_signature_counter > credential.signature_counter THEN 'SUPPORTED'
    WHEN p_new_signature_counter = 0 THEN 'UNSUPPORTED'
    ELSE credential.counter_mode
  END;
  IF p_session_token_hash !~ '^[0-9a-f]{64}$'
    OR p_session_token_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid administrator session token hash';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  UPDATE public.admin_mfa_credentials
  SET signature_counter = p_new_signature_counter,
      counter_mode = next_counter_mode,
      last_used_at = event_time
  WHERE id = credential.id;
  UPDATE public.admin_webauthn_challenges
  SET consumed_at = event_time, outcome = 'SUCCESS'
  WHERE id = challenge.id;
  INSERT INTO public.admin_sessions (
    id, admin_user_id, token_hash, token_hash_algorithm,
    token_hash_key_version, device_hash, last_ip_hash,
    binding_hash_key_version, created_at, last_seen_at,
    idle_expires_at, absolute_expires_at, retain_until
  ) VALUES (
    p_session_id, admin_user.id, p_session_token_hash, 'HMAC-SHA256',
    p_session_token_hash_key_version, p_device_hash, p_request_ip_hash,
    p_binding_hash_key_version, event_time, event_time,
    event_time + interval '15 minutes', event_time + interval '8 hours',
    event_time + interval '30 days 8 hours'
  );
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.append_admin_security_audit_event(
    admin_user.login_lookup_hash, admin_user.login_hash_key_version,
    'ADMIN_LOGIN_SUCCEEDED', 'ADMIN_SESSION', p_session_token_hash
  );
  RETURN QUERY SELECT 'SESSION_ISSUED'::text, p_session_id, admin_user.id;
END;
$$;

CREATE FUNCTION public.admin_authenticate_session(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS TABLE(
  session_id uuid,
  admin_user_id uuid,
  permission_codes text[],
  absolute_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_record public.admin_sessions%ROWTYPE;
  admin_user public.admin_users%ROWTYPE;
  permissions text[];
  event_time timestamptz := now();
  failure_reason text;
BEGIN
  IF p_session_token_hash !~ '^[0-9a-f]{64}$'
    OR p_request_ip_hash !~ '^[0-9a-f]{64}$'
    OR p_device_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT * INTO session_record
  FROM public.admin_sessions
  WHERE token_hash = p_session_token_hash
    AND token_hash_key_version = p_session_token_hash_key_version
    AND device_hash = p_device_hash
    AND binding_hash_key_version = p_binding_hash_key_version
  FOR UPDATE;
  IF NOT FOUND OR session_record.revoked_at IS NOT NULL THEN RETURN; END IF;

  SELECT * INTO admin_user FROM public.admin_users
  WHERE id = session_record.admin_user_id;
  IF session_record.idle_expires_at <= event_time
    OR session_record.absolute_expires_at <= event_time THEN
    failure_reason := 'EXPIRED';
  ELSIF admin_user.status <> 'ACTIVE' THEN
    failure_reason := 'ADMIN_STATUS_CHANGED';
  ELSE
    SELECT array_agg(DISTINCT permission.permission_code ORDER BY permission.permission_code)
    INTO permissions
    FROM public.admin_user_roles AS user_role
    JOIN public.admin_roles AS role ON role.id = user_role.role_id
    JOIN public.admin_role_permissions AS role_permission
      ON role_permission.role_id = role.id
    JOIN public.admin_permissions AS permission
      ON permission.id = role_permission.permission_id
    WHERE user_role.admin_user_id = admin_user.id
      AND role.status = 'ACTIVE'
      AND user_role.granted_at <= event_time
      AND (user_role.expires_at IS NULL OR user_role.expires_at > event_time);
    IF permissions IS NULL OR cardinality(permissions) = 0 THEN
      failure_reason := 'NO_ACTIVE_ROLE';
    END IF;
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  IF failure_reason IS NOT NULL THEN
    UPDATE public.admin_sessions
    SET revoked_at = event_time, revoke_reason = failure_reason
    WHERE id = session_record.id AND revoked_at IS NULL;
    PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
    PERFORM public.append_admin_security_audit_event(
      admin_user.login_lookup_hash, admin_user.login_hash_key_version,
      'ADMIN_SESSION_REVOKED', 'ADMIN_SESSION', session_record.token_hash
    );
    RETURN;
  END IF;

  UPDATE public.admin_sessions
  SET last_seen_at = event_time,
      last_ip_hash = p_request_ip_hash,
      idle_expires_at = LEAST(
        event_time + interval '15 minutes', absolute_expires_at
      )
  WHERE id = session_record.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  RETURN QUERY SELECT session_record.id, admin_user.id, permissions,
    session_record.absolute_expires_at;
END;
$$;

CREATE FUNCTION public.admin_logout_session(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_record public.admin_sessions%ROWTYPE;
  admin_user public.admin_users%ROWTYPE;
  event_time timestamptz := now();
BEGIN
  SELECT * INTO session_record
  FROM public.admin_sessions
  WHERE token_hash = p_session_token_hash
    AND token_hash_key_version = p_session_token_hash_key_version
    AND device_hash = p_device_hash
    AND binding_hash_key_version = p_binding_hash_key_version
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF session_record.revoked_at IS NOT NULL THEN RETURN true; END IF;
  SELECT * INTO admin_user FROM public.admin_users
  WHERE id = session_record.admin_user_id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  UPDATE public.admin_sessions
  SET revoked_at = event_time, revoke_reason = 'LOGOUT'
  WHERE id = session_record.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.append_admin_security_audit_event(
    admin_user.login_lookup_hash, admin_user.login_hash_key_version,
    'ADMIN_SESSION_REVOKED', 'ADMIN_SESSION', session_record.token_hash
  );
  RETURN true;
END;
$$;

CREATE FUNCTION public.admin_begin_enroll_challenge(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_challenge_id uuid,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  actor_admin public.admin_users%ROWTYPE;
  event_time timestamptz := now();
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR NOT ('CREDENTIAL_SELF_MANAGE' = ANY(actor_session.permission_codes)) THEN
    RETURN false;
  END IF;
  -- Credential enrollment is a high-impact persistence action. Require the
  -- passkey-authenticated session itself to have been issued recently instead
  -- of accepting an otherwise renewable eight-hour bearer as sufficient proof.
  IF NOT EXISTS (
    SELECT 1
    FROM public.admin_sessions AS recent_session
    WHERE recent_session.id = actor_session.session_id
      AND recent_session.created_at > event_time - interval '5 minutes'
      AND recent_session.revoked_at IS NULL
  ) THEN
    RETURN false;
  END IF;
  SELECT * INTO actor_admin FROM public.admin_users
  WHERE id = actor_session.admin_user_id;
  IF p_challenge_hash !~ '^[0-9a-f]{64}$'
    OR p_challenge_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid administrator enrollment challenge material';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin-enroll-user:' || actor_admin.id::text, 0)
  );
  IF (
    SELECT count(*) >= 5
    FROM public.admin_webauthn_challenges
    WHERE purpose = 'ENROLL'
      AND admin_user_id = actor_admin.id
      AND created_at > event_time - interval '10 minutes'
  ) THEN
    RETURN false;
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  INSERT INTO public.admin_webauthn_challenges (
    id, purpose, admin_user_id, initiating_session_id,
    login_lookup_hash, login_hash_key_version,
    challenge_hash, challenge_hash_algorithm, challenge_hash_key_version,
    request_ip_hash, device_hash, binding_hash_key_version,
    created_at, expires_at, retain_until
  ) VALUES (
    p_challenge_id, 'ENROLL', actor_admin.id, actor_session.session_id,
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version,
    p_challenge_hash, 'HMAC-SHA256', p_challenge_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version,
    event_time, event_time + interval '5 minutes',
    event_time + interval '24 hours'
  );
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  RETURN true;
END;
$$;

CREATE FUNCTION public.admin_fail_enroll_challenge(
  p_challenge_id uuid,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  challenge public.admin_webauthn_challenges%ROWTYPE;
  event_time timestamptz := now();
  next_attempt_count smallint;
BEGIN
  SELECT * INTO challenge
  FROM public.admin_webauthn_challenges
  WHERE id = p_challenge_id
  FOR UPDATE;
  IF NOT FOUND
    OR challenge.purpose <> 'ENROLL'
    OR challenge.challenge_hash <> p_challenge_hash
    OR challenge.challenge_hash_key_version <> p_challenge_hash_key_version
    OR challenge.request_ip_hash <> p_request_ip_hash
    OR challenge.device_hash <> p_device_hash
    OR challenge.binding_hash_key_version <> p_binding_hash_key_version
    OR challenge.consumed_at IS NOT NULL THEN
    RETURN 'INVALID_PROOF';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  IF challenge.expires_at <= event_time THEN
    UPDATE public.admin_webauthn_challenges
    SET consumed_at = event_time, outcome = 'EXPIRED'
    WHERE id = challenge.id;
    PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
    RETURN 'EXPIRED';
  END IF;
  next_attempt_count := LEAST(
    challenge.attempt_count + 1, challenge.max_attempts
  );
  UPDATE public.admin_webauthn_challenges
  SET attempt_count = next_attempt_count,
      consumed_at = CASE
        WHEN next_attempt_count >= max_attempts THEN event_time ELSE NULL
      END,
      outcome = CASE
        WHEN next_attempt_count >= max_attempts THEN 'FAILED' ELSE NULL
      END
  WHERE id = challenge.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  RETURN CASE
    WHEN next_attempt_count >= challenge.max_attempts THEN 'FAILED'
    ELSE 'RETRY_ALLOWED'
  END;
END;
$$;

CREATE FUNCTION public.admin_complete_credential_enrollment(
  p_challenge_id uuid,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_credential_id uuid,
  p_credential_id_hash varchar,
  p_credential_hash_key_version varchar,
  p_credential_id_ciphertext bytea,
  p_credential_encryption_key_version varchar,
  p_public_key bytea,
  p_verified_origin_hash varchar,
  p_origin_hash_key_version varchar,
  p_verified_rp_id_hash varchar,
  p_rp_id_hash_key_version varchar,
  p_user_verification_performed boolean,
  p_initial_signature_counter bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  challenge public.admin_webauthn_challenges%ROWTYPE;
  admin_user public.admin_users%ROWTYPE;
  enrollment_session public.admin_sessions%ROWTYPE;
  enrollment_session_valid boolean := false;
  event_time timestamptz := now();
  failure_status text;
BEGIN
  SELECT * INTO challenge FROM public.admin_webauthn_challenges
  WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND
    OR challenge.purpose <> 'ENROLL'
    OR challenge.challenge_hash <> p_challenge_hash
    OR challenge.challenge_hash_key_version <> p_challenge_hash_key_version
    OR challenge.request_ip_hash <> p_request_ip_hash
    OR challenge.device_hash <> p_device_hash
    OR challenge.binding_hash_key_version <> p_binding_hash_key_version
    OR challenge.consumed_at IS NOT NULL THEN
    RETURN 'INVALID_PROOF';
  END IF;
  IF challenge.expires_at <= event_time THEN
    PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
    UPDATE public.admin_webauthn_challenges
    SET consumed_at = event_time, outcome = 'EXPIRED'
    WHERE id = challenge.id;
    PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
    RETURN 'EXPIRED';
  END IF;
  SELECT * INTO enrollment_session FROM public.admin_sessions
  WHERE id = challenge.initiating_session_id
  FOR UPDATE;
  enrollment_session_valid := FOUND
    AND enrollment_session.admin_user_id = challenge.admin_user_id
    AND enrollment_session.revoked_at IS NULL
    AND enrollment_session.idle_expires_at > event_time
    AND enrollment_session.absolute_expires_at > event_time;
  SELECT * INTO admin_user FROM public.admin_users
  WHERE id = challenge.admin_user_id FOR UPDATE;
  IF NOT enrollment_session_valid
    OR admin_user.status <> 'ACTIVE'
    OR NOT public.admin_actor_has_permission(
      admin_user.id, 'CREDENTIAL_SELF_MANAGE'
    )
    OR p_user_verification_performed IS DISTINCT FROM true
    OR p_credential_id_hash !~ '^[0-9a-f]{64}$'
    OR p_credential_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR octet_length(p_credential_id_ciphertext) NOT BETWEEN 16 AND 4096
    OR p_credential_encryption_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR octet_length(p_public_key) NOT BETWEEN 32 AND 4096
    OR p_verified_origin_hash !~ '^[0-9a-f]{64}$'
    OR p_origin_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_verified_rp_id_hash !~ '^[0-9a-f]{64}$'
    OR p_rp_id_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_initial_signature_counter < 0 THEN
    SELECT public.admin_fail_enroll_challenge(
      p_challenge_id, p_challenge_hash, p_challenge_hash_key_version,
      p_request_ip_hash, p_device_hash, p_binding_hash_key_version
    ) INTO failure_status;
    RETURN failure_status;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin-credential:' || p_credential_id_hash, 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.admin_mfa_credentials
    WHERE credential_id_hash = p_credential_id_hash
  ) THEN
    SELECT public.admin_fail_enroll_challenge(
      p_challenge_id, p_challenge_hash, p_challenge_hash_key_version,
      p_request_ip_hash, p_device_hash, p_binding_hash_key_version
    ) INTO failure_status;
    RETURN 'CREDENTIAL_CONFLICT';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  INSERT INTO public.admin_mfa_credentials (
    id, admin_user_id, credential_id_hash, credential_hash_algorithm,
    credential_hash_key_version, credential_id_ciphertext,
    credential_encryption_key_version, public_key, signature_counter,
    counter_mode, rp_id_hash, rp_id_hash_key_version,
    origin_hash, origin_hash_key_version, user_verification_required,
    created_at
  ) VALUES (
    p_credential_id, admin_user.id, p_credential_id_hash, 'HMAC-SHA256',
    p_credential_hash_key_version, p_credential_id_ciphertext,
    p_credential_encryption_key_version, p_public_key,
    p_initial_signature_counter,
    CASE WHEN p_initial_signature_counter > 0 THEN 'SUPPORTED' ELSE 'UNKNOWN' END,
    p_verified_rp_id_hash, p_rp_id_hash_key_version,
    p_verified_origin_hash, p_origin_hash_key_version, true, event_time
  );
  UPDATE public.admin_webauthn_challenges
  SET consumed_at = event_time, outcome = 'SUCCESS'
  WHERE id = challenge.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.append_admin_security_audit_event(
    admin_user.login_lookup_hash, admin_user.login_hash_key_version,
    'ADMIN_CREDENTIAL_ENROLLED', 'ADMIN_CREDENTIAL', p_credential_id_hash
  );
  RETURN 'ENROLLED';
END;
$$;

-- This is the only administrator creation primitive in v1. It is intentionally
-- owner-only and succeeds exactly once, after an offline verifier has completed
-- the WebAuthn ceremony and sealed the credential identifier.
CREATE FUNCTION public.admin_bootstrap_first_security_admin(
  p_admin_user_id uuid,
  p_login_lookup_hash varchar,
  p_login_hash_key_version varchar,
  p_credential_id uuid,
  p_credential_id_hash varchar,
  p_credential_hash_key_version varchar,
  p_credential_id_ciphertext bytea,
  p_credential_encryption_key_version varchar,
  p_public_key bytea,
  p_verified_origin_hash varchar,
  p_origin_hash_key_version varchar,
  p_verified_rp_id_hash varchar,
  p_rp_id_hash_key_version varchar,
  p_user_verification_performed boolean,
  p_initial_signature_counter bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  security_role_id uuid;
  event_time timestamptz := now();
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin-first-passkey-bootstrap', 0)
  );
  IF EXISTS (SELECT 1 FROM public.admin_users) THEN
    RAISE EXCEPTION 'administrator bootstrap has already been completed';
  END IF;
  IF p_login_lookup_hash !~ '^[0-9a-f]{64}$'
    OR p_login_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_credential_id_hash !~ '^[0-9a-f]{64}$'
    OR p_credential_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR octet_length(p_credential_id_ciphertext) NOT BETWEEN 16 AND 4096
    OR p_credential_encryption_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR octet_length(p_public_key) NOT BETWEEN 32 AND 4096
    OR p_verified_origin_hash !~ '^[0-9a-f]{64}$'
    OR p_origin_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_verified_rp_id_hash !~ '^[0-9a-f]{64}$'
    OR p_rp_id_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_user_verification_performed IS DISTINCT FROM true
    OR p_initial_signature_counter < 0 THEN
    RAISE EXCEPTION 'invalid offline administrator bootstrap material';
  END IF;
  SELECT id INTO security_role_id FROM public.admin_roles
  WHERE role_code = 'SECURITY_ADMIN' AND status = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'security administrator role is unavailable';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  INSERT INTO public.admin_users (
    id, login_lookup_hash, login_hash_algorithm,
    login_hash_key_version, status, created_at, status_changed_at
  ) VALUES (
    p_admin_user_id, p_login_lookup_hash, 'HMAC-SHA256',
    p_login_hash_key_version, 'ACTIVE', event_time, event_time
  );
  INSERT INTO public.admin_mfa_credentials (
    id, admin_user_id, credential_id_hash, credential_hash_algorithm,
    credential_hash_key_version, credential_id_ciphertext,
    credential_encryption_key_version, public_key, signature_counter,
    counter_mode, rp_id_hash, rp_id_hash_key_version,
    origin_hash, origin_hash_key_version, user_verification_required,
    created_at
  ) VALUES (
    p_credential_id, p_admin_user_id, p_credential_id_hash, 'HMAC-SHA256',
    p_credential_hash_key_version, p_credential_id_ciphertext,
    p_credential_encryption_key_version, p_public_key,
    p_initial_signature_counter,
    CASE WHEN p_initial_signature_counter > 0 THEN 'SUPPORTED' ELSE 'UNKNOWN' END,
    p_verified_rp_id_hash, p_rp_id_hash_key_version,
    p_verified_origin_hash, p_origin_hash_key_version, true, event_time
  );
  INSERT INTO public.admin_user_roles (
    admin_user_id, role_id, granted_at, expires_at
  ) VALUES (p_admin_user_id, security_role_id, event_time, NULL);
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.append_admin_security_audit_event(
    p_login_lookup_hash, p_login_hash_key_version,
    'ADMIN_BOOTSTRAP_COMPLETED', 'ADMIN_USER', p_login_lookup_hash
  );
  RETURN p_admin_user_id;
END;
$$;

CREATE FUNCTION public.admin_set_user_status(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_target_admin_user_id uuid,
  p_new_status varchar
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  actor_admin public.admin_users%ROWTYPE;
  target_admin public.admin_users%ROWTYPE;
  event_time timestamptz := now();
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR NOT ('SECURITY_ADMIN_WRITE' = ANY(actor_session.permission_codes)) THEN
    RETURN 'UNAUTHORIZED';
  END IF;
  SELECT * INTO actor_admin FROM public.admin_users
  WHERE id = actor_session.admin_user_id;
  SELECT * INTO target_admin FROM public.admin_users
  WHERE id = p_target_admin_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'TARGET_UNAVAILABLE'; END IF;
  IF p_new_status NOT IN ('ACTIVE', 'LOCKED', 'DISABLED') THEN
    RETURN 'INVALID_STATUS';
  END IF;
  IF target_admin.status = p_new_status THEN RETURN 'UNCHANGED'; END IF;
  IF p_new_status = 'ACTIVE' AND (
    NOT EXISTS (
      SELECT 1 FROM public.admin_mfa_credentials
      WHERE admin_user_id = target_admin.id AND revoked_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.admin_user_roles AS assignment
      JOIN public.admin_roles AS role ON role.id = assignment.role_id
      WHERE assignment.admin_user_id = target_admin.id
        AND role.status = 'ACTIVE'
        AND assignment.granted_at <= event_time
        AND (assignment.expires_at IS NULL
          OR assignment.expires_at > event_time)
    )
  ) THEN
    RETURN 'MISSING_ACTIVE_ACCESS';
  END IF;
  IF p_new_status <> 'ACTIVE'
    AND target_admin.status = 'ACTIVE'
    AND EXISTS (
      SELECT 1 FROM public.admin_user_roles AS assignment
      JOIN public.admin_roles AS role ON role.id = assignment.role_id
      WHERE assignment.admin_user_id = target_admin.id
        AND role.role_code = 'SECURITY_ADMIN'
        AND role.status = 'ACTIVE'
        AND assignment.granted_at <= event_time
        AND (assignment.expires_at IS NULL
          OR assignment.expires_at > event_time)
    ) THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('admin-security-admin-invariant', 0)
    );
    IF NOT EXISTS (
      SELECT 1
      FROM public.admin_users AS other_admin
      JOIN public.admin_user_roles AS other_assignment
        ON other_assignment.admin_user_id = other_admin.id
      JOIN public.admin_roles AS other_role
        ON other_role.id = other_assignment.role_id
      WHERE other_admin.id <> target_admin.id
        AND other_admin.status = 'ACTIVE'
        AND other_role.status = 'ACTIVE'
        AND other_role.role_code = 'SECURITY_ADMIN'
        AND other_assignment.granted_at <= event_time
        AND (other_assignment.expires_at IS NULL
          OR other_assignment.expires_at > event_time)
    ) THEN
      RETURN 'LAST_SECURITY_ADMIN';
    END IF;
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  UPDATE public.admin_users
  SET status = p_new_status,
      locked_at = CASE WHEN p_new_status = 'LOCKED' THEN event_time ELSE NULL END,
      disabled_at = CASE
        WHEN p_new_status = 'DISABLED' THEN event_time ELSE NULL
      END,
      status_changed_at = event_time
  WHERE id = target_admin.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.admin_revoke_user_sessions(
    target_admin.id, 'ADMIN_STATUS_CHANGED',
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version
  );
  PERFORM public.append_admin_security_audit_event(
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version,
    'ADMIN_STATUS_CHANGED_' || p_new_status,
    'ADMIN_USER', target_admin.login_lookup_hash
  );
  RETURN 'STATUS_CHANGED';
END;
$$;

CREATE FUNCTION public.admin_revoke_credential(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_credential_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  actor_admin public.admin_users%ROWTYPE;
  target_admin public.admin_users%ROWTYPE;
  target_credential public.admin_mfa_credentials%ROWTYPE;
  event_time timestamptz := now();
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND THEN RETURN 'UNAUTHORIZED'; END IF;
  SELECT * INTO actor_admin FROM public.admin_users
  WHERE id = actor_session.admin_user_id;
  SELECT * INTO target_credential FROM public.admin_mfa_credentials
  WHERE id = p_credential_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO target_admin FROM public.admin_users
  WHERE id = target_credential.admin_user_id FOR UPDATE;
  IF target_admin.id <> actor_admin.id
    AND NOT ('SECURITY_ADMIN_WRITE' = ANY(actor_session.permission_codes)) THEN
    RETURN 'UNAUTHORIZED';
  END IF;
  IF target_admin.id = actor_admin.id
    AND NOT ('CREDENTIAL_SELF_MANAGE' = ANY(actor_session.permission_codes)) THEN
    RETURN 'UNAUTHORIZED';
  END IF;
  IF target_credential.revoked_at IS NOT NULL THEN RETURN 'REVOKED'; END IF;
  IF target_admin.status = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM public.admin_mfa_credentials
    WHERE admin_user_id = target_admin.id
      AND id <> target_credential.id
      AND revoked_at IS NULL
  ) THEN
    RETURN 'LAST_ACTIVE_CREDENTIAL';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  UPDATE public.admin_mfa_credentials
  SET revoked_at = event_time
  WHERE id = target_credential.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.admin_revoke_user_sessions(
    target_admin.id, 'CREDENTIAL_REVOKED',
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version
  );
  PERFORM public.append_admin_security_audit_event(
    actor_admin.login_lookup_hash, actor_admin.login_hash_key_version,
    'ADMIN_CREDENTIAL_REVOKED', 'ADMIN_CREDENTIAL',
    target_credential.credential_id_hash
  );
  RETURN 'REVOKED';
END;
$$;

CREATE FUNCTION public.preview_admin_security_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT 'ADMIN_WEBAUTHN_CHALLENGE_24H'::text, count(*)::bigint
  FROM public.admin_webauthn_challenges
  WHERE retain_until <= now()
  UNION ALL
  SELECT 'ADMIN_SESSION_30D_AFTER_ABSOLUTE_EXPIRY'::text, count(*)::bigint
  FROM public.admin_sessions
  WHERE retain_until <= now();
$$;

CREATE FUNCTION public.execute_admin_security_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count bigint;
  event_time timestamptz := now();
BEGIN
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  DELETE FROM public.admin_webauthn_challenges
  WHERE retain_until <= event_time;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  policy_code := 'ADMIN_WEBAUTHN_CHALLENGE_24H';
  affected_count := deleted_count;
  RETURN NEXT;

  DELETE FROM public.admin_sessions
  WHERE retain_until <= event_time;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  policy_code := 'ADMIN_SESSION_30D_AFTER_ABSOLUTE_EXPIRY';
  affected_count := deleted_count;
  RETURN NEXT;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
END;
$$;

REVOKE ALL ON
  public.admin_users,
  public.admin_roles,
  public.admin_user_roles,
  public.admin_permissions,
  public.admin_role_permissions,
  public.admin_mfa_credentials,
  public.admin_sessions,
  public.admin_webauthn_challenges,
  public.admin_audit_log
FROM PUBLIC;

DO $$
DECLARE controlled_function regprocedure;
BEGIN
  FOR controlled_function IN
    SELECT routine.oid::regprocedure
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.proname = ANY(ARRAY[
        'protect_admin_security_state',
        'admin_actor_has_permission',
        'append_admin_security_audit_event',
        'admin_revoke_user_sessions',
        'admin_begin_login_challenge',
        'admin_get_login_credential_options',
        'admin_get_assertion_credential',
        'admin_fail_login_challenge',
        'admin_complete_login_assertion',
        'admin_authenticate_session',
        'admin_logout_session',
        'admin_begin_enroll_challenge',
        'admin_fail_enroll_challenge',
        'admin_complete_credential_enrollment',
        'admin_bootstrap_first_security_admin',
        'admin_grant_role',
        'admin_revoke_role',
        'admin_set_user_status',
        'admin_revoke_credential',
        'preview_admin_security_retention_cleanup',
        'execute_admin_security_retention_cleanup'
      ])
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC', controlled_function
    );
  END LOOP;
END;
$$;
