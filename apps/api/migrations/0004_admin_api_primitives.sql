-- Minimal database primitives consumed by the administrator API.
-- The runtime role never receives administrator base-table access. Every
-- runtime API function authenticates the current session first and evaluates the
-- permissions returned by that authentication in the same database request.

-- A self-service credential handle is a random public reference. It is not the
-- internal row UUID, the WebAuthn credential ID, or a hash of either value.
-- The default keeps the existing, already-reviewed enrollment completion
-- primitive compatible while generating 32 bytes of entropy for every row.
ALTER TABLE public.admin_mfa_credentials
  ADD COLUMN self_service_handle varchar(43) NOT NULL DEFAULT
    translate(
      rtrim(encode(public.gen_random_bytes(32), 'base64'), '='),
      '+/', '-_'
    ),
  ADD CONSTRAINT admin_credential_self_service_handle_shape CHECK (
    self_service_handle ~ '^[A-Za-z0-9_-]{43}$'
  ),
  ADD CONSTRAINT admin_credential_self_service_handle_unique
    UNIQUE (self_service_handle);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.admin_mfa_credentials AS credential
    WHERE credential.revoked_at IS NULL
    GROUP BY credential.admin_user_id
    HAVING count(*) > 20
  ) THEN
    RAISE EXCEPTION 'administrator active credential limit requires manual review';
  END IF;
END;
$$;

-- Serialize every active credential insertion for the same administrator.
-- This table-level boundary covers both the offline bootstrap and the online
-- enrollment completion primitive, including concurrent ceremonies.
CREATE FUNCTION public.enforce_admin_active_credential_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_credential_count bigint;
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'admin-active-credential-limit:' || NEW.admin_user_id::text, 0
    )
  );
  SELECT count(*) INTO active_credential_count
  FROM public.admin_mfa_credentials AS credential
  WHERE credential.admin_user_id = NEW.admin_user_id
    AND credential.revoked_at IS NULL;
  IF active_credential_count >= 20 THEN
    RAISE EXCEPTION 'administrator active credential limit reached'
      USING ERRCODE = '23514',
        CONSTRAINT = 'admin_active_credential_limit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER admin_credentials_active_count_limit
BEFORE INSERT ON public.admin_mfa_credentials
FOR EACH ROW EXECUTE FUNCTION public.enforce_admin_active_credential_limit();

CREATE TRIGGER admin_credentials_active_count_limit_on_update
BEFORE UPDATE OF admin_user_id, revoked_at ON public.admin_mfa_credentials
FOR EACH ROW
WHEN (
  NEW.revoked_at IS NULL
  AND (OLD.revoked_at IS NOT NULL
    OR NEW.admin_user_id IS DISTINCT FROM OLD.admin_user_id)
)
EXECUTE FUNCTION public.enforce_admin_active_credential_limit();

CREATE INDEX admin_audit_keyset_idx
  ON public.admin_audit_log(occurred_at DESC, id DESC);

CREATE FUNCTION public.admin_get_self_enroll_credential_options(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_challenge_id uuid,
  p_challenge_hash varchar,
  p_challenge_hash_key_version varchar
)
RETURNS TABLE(
  credential_id_ciphertext bytea,
  credential_encryption_key_version varchar
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  enrollment_challenge public.admin_webauthn_challenges%ROWTYPE;
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR ('CREDENTIAL_SELF_MANAGE' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    RETURN;
  END IF;

  SELECT * INTO enrollment_challenge
  FROM public.admin_webauthn_challenges AS challenge
  WHERE challenge.id = p_challenge_id
    AND challenge.purpose = 'ENROLL'
    AND challenge.admin_user_id = actor_session.admin_user_id
    AND challenge.initiating_session_id = actor_session.session_id
    AND challenge.challenge_hash = p_challenge_hash
    AND challenge.challenge_hash_key_version = p_challenge_hash_key_version
    AND challenge.request_ip_hash = p_request_ip_hash
    AND challenge.device_hash = p_device_hash
    AND challenge.binding_hash_key_version = p_binding_hash_key_version
    AND challenge.consumed_at IS NULL
    AND challenge.expires_at > now()
    AND challenge.attempt_count < challenge.max_attempts;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.admin_mfa_credentials AS active_credential
    WHERE active_credential.admin_user_id = actor_session.admin_user_id
      AND active_credential.revoked_at IS NULL
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT credential.credential_id_ciphertext,
    credential.credential_encryption_key_version
  FROM public.admin_mfa_credentials AS credential
  WHERE credential.admin_user_id = actor_session.admin_user_id
    AND credential.revoked_at IS NULL
  ORDER BY credential.created_at, credential.id
  LIMIT 20;
END;
$$;

CREATE FUNCTION public.admin_list_self_credentials(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS TABLE(
  credential_handle text,
  created_at timestamptz,
  last_used_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR ('CREDENTIAL_SELF_MANAGE' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT credential.self_service_handle::text,
    credential.created_at, credential.last_used_at
  FROM public.admin_mfa_credentials AS credential
  WHERE credential.admin_user_id = actor_session.admin_user_id
    AND credential.revoked_at IS NULL
  ORDER BY credential.created_at, credential.id
  LIMIT 20;
END;
$$;

-- The internal UUID is supplied only by the server immediately after a
-- successful enrollment. It is never returned, and the row must belong to the
-- currently authenticated administrator and still be active.
CREATE FUNCTION public.admin_get_self_credential_record(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_internal_credential_id uuid
)
RETURNS TABLE(
  credential_handle text,
  created_at timestamptz,
  last_used_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR ('CREDENTIAL_SELF_MANAGE' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT credential.self_service_handle::text,
    credential.created_at, credential.last_used_at
  FROM public.admin_mfa_credentials AS credential
  WHERE credential.admin_user_id = actor_session.admin_user_id
    AND credential.id = p_internal_credential_id
    AND credential.revoked_at IS NULL;
END;
$$;

CREATE FUNCTION public.admin_revoke_self_credential(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_credential_handle varchar
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  actor_admin public.admin_users%ROWTYPE;
  target_credential public.admin_mfa_credentials%ROWTYPE;
  event_time timestamptz;
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR ('CREDENTIAL_SELF_MANAGE' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    RETURN 'UNAUTHORIZED';
  END IF;
  event_time := now();
  IF NOT EXISTS (
    SELECT 1
    FROM public.admin_sessions AS recent_session
    WHERE recent_session.id = actor_session.session_id
      AND recent_session.created_at > event_time - interval '5 minutes'
      AND recent_session.revoked_at IS NULL
  ) THEN
    RETURN 'UNAUTHORIZED';
  END IF;

  -- The user row lock serializes revocations across different sessions so two
  -- concurrent requests cannot each observe the other credential as active.
  SELECT * INTO actor_admin
  FROM public.admin_users
  WHERE id = actor_session.admin_user_id
  FOR UPDATE;
  IF NOT FOUND OR actor_admin.status <> 'ACTIVE' THEN
    RETURN 'UNAUTHORIZED';
  END IF;
  IF p_credential_handle IS NULL
    OR p_credential_handle !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN 'NOT_FOUND';
  END IF;
  SELECT * INTO target_credential
  FROM public.admin_mfa_credentials AS credential
  WHERE credential.admin_user_id = actor_session.admin_user_id
    AND credential.self_service_handle = p_credential_handle
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF target_credential.revoked_at IS NOT NULL THEN RETURN 'REVOKED'; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.admin_mfa_credentials AS other_credential
    WHERE other_credential.admin_user_id = actor_session.admin_user_id
      AND other_credential.id <> target_credential.id
      AND other_credential.revoked_at IS NULL
  ) THEN
    RETURN 'LAST_ACTIVE_CREDENTIAL';
  END IF;

  PERFORM set_config('chi_shen_me.admin_security_mutation', 'enabled', true);
  UPDATE public.admin_mfa_credentials
  SET revoked_at = event_time
  WHERE id = target_credential.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  PERFORM public.admin_revoke_user_sessions(
    actor_admin.id, 'CREDENTIAL_REVOKED',
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

CREATE FUNCTION public.admin_list_sanitized_audit_events(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_before_created_at timestamptz,
  p_before_event_id uuid,
  p_page_size integer
)
RETURNS TABLE(
  event_id uuid,
  action text,
  target_type text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR ('AUDIT_READ' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    RETURN;
  END IF;
  -- The HTTP contract exposes at most 100 items; one extra row is accepted so
  -- the service can determine has-next without manufacturing an empty page.
  IF p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 101
    OR ((p_before_created_at IS NULL) <> (p_before_event_id IS NULL)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT audit_event.id, audit_event.action_type::text,
    audit_event.target_type::text, audit_event.occurred_at
  FROM public.admin_audit_log AS audit_event
  WHERE p_before_created_at IS NULL
    OR (audit_event.occurred_at, audit_event.id)
      < (p_before_created_at, p_before_event_id)
  ORDER BY audit_event.occurred_at DESC, audit_event.id DESC
  LIMIT p_page_size;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_self_enroll_credential_options(
  varchar, varchar, varchar, varchar, varchar, uuid, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_admin_active_credential_limit()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_self_credentials(
  varchar, varchar, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_get_self_credential_record(
  varchar, varchar, varchar, varchar, varchar, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_revoke_self_credential(
  varchar, varchar, varchar, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_sanitized_audit_events(
  varchar, varchar, varchar, varchar, varchar, timestamptz, uuid, integer
) FROM PUBLIC;
