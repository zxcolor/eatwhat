-- Keep the deployed 0003 checksum immutable while removing the ambiguity
-- between the RETURNS TABLE output variable and the locked session row.
CREATE OR REPLACE FUNCTION public.admin_authenticate_session(
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
        event_time + interval '15 minutes', session_record.absolute_expires_at
      )
  WHERE id = session_record.id;
  PERFORM set_config('chi_shen_me.admin_security_mutation', 'disabled', true);
  RETURN QUERY SELECT session_record.id, admin_user.id, permissions,
    session_record.absolute_expires_at;
END;
$$;
