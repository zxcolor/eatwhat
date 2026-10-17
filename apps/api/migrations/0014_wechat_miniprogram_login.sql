-- Resolve a server-verified Mini Program login to the already-bound account.
-- The caller consumes the one-use state and inserts the session in the same
-- transaction. This function never creates users, bindings or UnionID aliases.
CREATE FUNCTION public.resolve_wechat_miniprogram_user_from_consumed_state(
  p_oauth_state_id uuid
)
RETURNS TABLE(result text, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  event_time timestamptz := clock_timestamp();
  proof_record record;
  alias_record record;
  binding_record record;
  original_binding_valid boolean := false;
BEGIN
  SELECT oauth.verified_union_realm_id, oauth.verified_union_hash,
      oauth.verified_union_hash_key_version,
      oauth.verified_subject_lookup_hash,
      oauth.verified_subject_lookup_key_version,
      oauth.verified_subject_dedup_hash,
      oauth.verified_subject_dedup_key_version
    INTO proof_record
    FROM public.oauth_states AS oauth
    WHERE oauth.id = p_oauth_state_id
      AND oauth.provider = 'WECHAT'
      AND oauth.purpose = 'LOGIN'
      AND oauth.target_user_id IS NULL
      AND oauth.consumed_at > event_time - interval '15 minutes'
      AND oauth.consumed_at <= event_time
      AND oauth.consumed_at >= oauth.created_at
      AND oauth.consumed_at < oauth.expires_at
      AND oauth.registration_claimed_at IS NULL
      AND oauth.binding_claimed_at IS NULL
      AND oauth.verified_subject_lookup_hash IS NOT NULL
      AND oauth.verified_subject_lookup_key_version IS NOT NULL
      AND oauth.verified_subject_dedup_hash IS NOT NULL
      AND oauth.verified_subject_dedup_key_version IS NOT NULL
    FOR UPDATE OF oauth;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID_CREDENTIALS'::text, NULL::uuid;
    RETURN;
  END IF;
  IF proof_record.verified_union_realm_id IS NULL
    OR proof_record.verified_union_hash IS NULL
    OR proof_record.verified_union_hash_key_version IS NULL THEN
    RETURN QUERY SELECT 'IDENTITY_NOT_BOUND'::text, NULL::uuid;
    RETURN;
  END IF;

  -- Alias identity columns are immutable. Read its binding first, then lock
  -- binding/user rows before the alias, matching the existing 0012 writer.
  SELECT alias.identity_binding_id, alias.user_id, alias.union_hash_key_version
    INTO alias_record
    FROM public.wechat_union_aliases AS alias
    WHERE alias.realm_id = proof_record.verified_union_realm_id
      AND alias.union_hash = proof_record.verified_union_hash;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'IDENTITY_NOT_BOUND'::text, NULL::uuid;
    RETURN;
  END IF;
  IF alias_record.union_hash_key_version IS DISTINCT FROM
      proof_record.verified_union_hash_key_version THEN
    RETURN QUERY SELECT 'IDENTITY_CONFLICT'::text, NULL::uuid;
    RETURN;
  END IF;

  -- Lock every existing OpenID owner as well as the original alias binding.
  -- No provider ID, caller-supplied user ID or dynamic SQL can select an owner.
  FOR binding_record IN
    SELECT binding.id, binding.user_id, binding.identity_type,
        binding.lookup_hash, binding.lookup_hash_key_version,
        binding.dedup_hash, binding.dedup_hash_key_version,
        binding.revoked_at, account_user.status AS user_status
      FROM public.identity_bindings AS binding
      JOIN public.users AS account_user ON account_user.id = binding.user_id
      WHERE binding.id = alias_record.identity_binding_id
        OR (binding.identity_type = 'WECHAT' AND (
          binding.lookup_hash = proof_record.verified_subject_lookup_hash
          OR binding.dedup_hash = proof_record.verified_subject_dedup_hash
        ))
      ORDER BY binding.id
      FOR UPDATE OF binding, account_user
  LOOP
    IF binding_record.user_id IS DISTINCT FROM alias_record.user_id
      OR binding_record.identity_type IS DISTINCT FROM 'WECHAT'
      OR (binding_record.lookup_hash = proof_record.verified_subject_lookup_hash
        AND binding_record.lookup_hash_key_version IS DISTINCT FROM
          proof_record.verified_subject_lookup_key_version)
      OR (binding_record.dedup_hash = proof_record.verified_subject_dedup_hash
        AND binding_record.dedup_hash_key_version IS DISTINCT FROM
          proof_record.verified_subject_dedup_key_version) THEN
      RETURN QUERY SELECT 'IDENTITY_CONFLICT'::text, NULL::uuid;
      RETURN;
    END IF;
    IF binding_record.revoked_at IS NOT NULL
      OR binding_record.user_status IS DISTINCT FROM 'ACTIVE' THEN
      RETURN QUERY SELECT 'INVALID_CREDENTIALS'::text, NULL::uuid;
      RETURN;
    END IF;
    IF binding_record.id = alias_record.identity_binding_id THEN
      original_binding_valid := true;
    END IF;
  END LOOP;
  IF NOT original_binding_valid THEN
    RETURN QUERY SELECT 'INVALID_CREDENTIALS'::text, NULL::uuid;
    RETURN;
  END IF;

  PERFORM 1 FROM public.wechat_union_aliases AS alias
    WHERE alias.identity_binding_id = alias_record.identity_binding_id
      AND alias.user_id = alias_record.user_id
      AND alias.realm_id = proof_record.verified_union_realm_id
      AND alias.union_hash = proof_record.verified_union_hash
      AND alias.union_hash_key_version = proof_record.verified_union_hash_key_version
    FOR SHARE OF alias;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID_CREDENTIALS'::text, NULL::uuid;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'SUCCESS'::text, alias_record.user_id::uuid;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_wechat_miniprogram_user_from_consumed_state(
  uuid
) FROM PUBLIC;
