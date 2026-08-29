-- Persist a server-verified WeChat UnionID as a separate cross-application
-- alias. AppID + OpenID remains the application-local identity binding.

ALTER TABLE public.identity_bindings
  ADD CONSTRAINT identity_bindings_id_user_unique UNIQUE (id, user_id);

ALTER TABLE public.oauth_states
  ADD COLUMN verified_union_realm_id varchar(64),
  ADD COLUMN verified_union_hash varchar(64),
  ADD COLUMN verified_union_hash_key_version varchar(64),
  ADD CONSTRAINT oauth_union_proof_all_or_none CHECK (
    (verified_union_realm_id IS NULL) = (verified_union_hash IS NULL)
    AND (verified_union_hash IS NULL) =
      (verified_union_hash_key_version IS NULL)
  ),
  ADD CONSTRAINT oauth_union_proof_wechat_only CHECK (
    verified_union_hash IS NULL OR provider = 'WECHAT'
  ),
  ADD CONSTRAINT oauth_union_proof_consumed_only CHECK (
    verified_union_hash IS NULL OR consumed_at IS NOT NULL
  ),
  ADD CONSTRAINT oauth_union_realm_shape CHECK (
    verified_union_realm_id IS NULL
    OR verified_union_realm_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  ADD CONSTRAINT oauth_union_hash_shape CHECK (
    verified_union_hash IS NULL OR verified_union_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT oauth_union_key_version_shape CHECK (
    verified_union_hash_key_version IS NULL
    OR verified_union_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'
  );

CREATE TABLE public.wechat_union_aliases (
  identity_binding_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  realm_id varchar(64) NOT NULL,
  union_hash varchar(64) NOT NULL,
  union_hash_algorithm varchar(32) NOT NULL DEFAULT 'HMAC-SHA256',
  union_hash_key_version varchar(64) NOT NULL,
  first_verified_at timestamptz NOT NULL,
  last_verified_at timestamptz NOT NULL,
  CONSTRAINT wechat_union_alias_binding_user_fk
    FOREIGN KEY (identity_binding_id, user_id)
    REFERENCES public.identity_bindings(id, user_id) ON DELETE CASCADE,
  CONSTRAINT wechat_union_alias_user_unique UNIQUE (realm_id, user_id),
  CONSTRAINT wechat_union_alias_hash_unique UNIQUE (realm_id, union_hash),
  CONSTRAINT wechat_union_alias_realm_shape CHECK (
    realm_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT wechat_union_alias_hash_shape CHECK (
    union_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wechat_union_alias_algorithm CHECK (
    union_hash_algorithm = 'HMAC-SHA256'
  ),
  CONSTRAINT wechat_union_alias_key_version_shape CHECK (
    union_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'
  ),
  CONSTRAINT wechat_union_alias_time_order CHECK (
    last_verified_at >= first_verified_at
  )
);

CREATE FUNCTION public.validate_wechat_union_alias_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE valid_binding boolean;
BEGIN
  SELECT true INTO valid_binding
  FROM public.identity_bindings AS binding
  WHERE binding.id = NEW.identity_binding_id
    AND binding.user_id = NEW.user_id
    AND binding.identity_type = 'WECHAT';
  IF valid_binding IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'WeChat Union alias requires a matching WeChat binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wechat_union_alias_initial_state
BEFORE INSERT ON public.wechat_union_aliases
FOR EACH ROW EXECUTE FUNCTION public.validate_wechat_union_alias_insert();

CREATE FUNCTION public.protect_wechat_union_alias_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (OLD.identity_binding_id, OLD.user_id, OLD.realm_id, OLD.union_hash,
      OLD.union_hash_algorithm, OLD.union_hash_key_version,
      OLD.first_verified_at)
      IS DISTINCT FROM
     (NEW.identity_binding_id, NEW.user_id, NEW.realm_id, NEW.union_hash,
      NEW.union_hash_algorithm, NEW.union_hash_key_version,
      NEW.first_verified_at) THEN
    RAISE EXCEPTION 'WeChat Union alias identity fields are immutable';
  END IF;
  IF NEW.last_verified_at < OLD.last_verified_at THEN
    RAISE EXCEPTION 'WeChat Union alias verification time cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wechat_union_alias_immutable_identity
BEFORE UPDATE ON public.wechat_union_aliases
FOR EACH ROW EXECUTE FUNCTION public.protect_wechat_union_alias_update();

CREATE OR REPLACE FUNCTION public.validate_oauth_state_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.consumed_at IS NOT NULL
    OR NEW.verified_subject_lookup_hash IS NOT NULL
    OR NEW.verified_subject_lookup_key_version IS NOT NULL
    OR NEW.verified_subject_dedup_hash IS NOT NULL
    OR NEW.verified_subject_dedup_key_version IS NOT NULL
    OR NEW.verified_union_realm_id IS NOT NULL
    OR NEW.verified_union_hash IS NOT NULL
    OR NEW.verified_union_hash_key_version IS NOT NULL
    OR NEW.registration_claimed_at IS NOT NULL
    OR NEW.binding_claimed_at IS NOT NULL
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes'
    OR NEW.expires_at <= event_time THEN
    RAISE EXCEPTION 'OAuth state must begin fresh and unconsumed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_oauth_state_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('chi_shen_me.oauth_state_transition', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'OAuth state changes require a restricted transition function';
  END IF;
  IF (OLD.id, OLD.provider, OLD.purpose, OLD.state_hash, OLD.state_hash_algorithm,
      OLD.nonce_hash, OLD.flow_reference_hash, OLD.operation_target_hash,
      OLD.target_user_id, OLD.device_hash, OLD.pkce_verifier_ciphertext,
      OLD.encryption_key_version,
      OLD.hash_key_version, OLD.created_at, OLD.expires_at, OLD.retain_until)
      IS DISTINCT FROM
     (NEW.id, NEW.provider, NEW.purpose, NEW.state_hash, NEW.state_hash_algorithm,
      NEW.nonce_hash, NEW.flow_reference_hash, NEW.operation_target_hash,
      NEW.target_user_id, NEW.device_hash, NEW.pkce_verifier_ciphertext,
      NEW.encryption_key_version,
      NEW.hash_key_version, NEW.created_at, NEW.expires_at, NEW.retain_until) THEN
    RAISE EXCEPTION 'OAuth state issuance fields are immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'OAuth state can be consumed only once';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND (
    OLD.verified_subject_lookup_hash,
    OLD.verified_subject_lookup_key_version,
    OLD.verified_subject_dedup_hash,
    OLD.verified_subject_dedup_key_version,
    OLD.verified_union_realm_id,
    OLD.verified_union_hash,
    OLD.verified_union_hash_key_version
  ) IS DISTINCT FROM (
    NEW.verified_subject_lookup_hash,
    NEW.verified_subject_lookup_key_version,
    NEW.verified_subject_dedup_hash,
    NEW.verified_subject_dedup_key_version,
    NEW.verified_union_realm_id,
    NEW.verified_union_hash,
    NEW.verified_union_hash_key_version
  ) THEN
    RAISE EXCEPTION 'verified OAuth subject proof is immutable';
  END IF;
  IF OLD.registration_claimed_at IS NOT NULL
    AND NEW.registration_claimed_at IS DISTINCT FROM OLD.registration_claimed_at THEN
    RAISE EXCEPTION 'an OAuth registration proof can be claimed only once';
  END IF;
  IF OLD.binding_claimed_at IS NOT NULL
    AND NEW.binding_claimed_at IS DISTINCT FROM OLD.binding_claimed_at THEN
    RAISE EXCEPTION 'an OAuth identity-binding proof can be claimed only once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.consume_oauth_state_with_wechat_union(
  oauth_state_id uuid,
  expected_provider varchar,
  expected_purpose varchar,
  expected_flow_reference_hash varchar,
  expected_operation_target_hash varchar,
  expected_target_user_id uuid,
  expected_device_hash varchar,
  verified_lookup_hash varchar,
  verified_lookup_key_version varchar,
  verified_dedup_hash varchar,
  verified_dedup_key_version varchar,
  p_verified_union_realm_id varchar,
  p_verified_union_hash varchar,
  p_verified_union_hash_key_version varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  IF expected_provider IS DISTINCT FROM 'WECHAT'
    OR verified_lookup_hash IS NULL
    OR verified_lookup_hash !~ '^[0-9a-f]{64}$'
    OR verified_dedup_hash IS NULL
    OR verified_dedup_hash !~ '^[0-9a-f]{64}$'
    OR verified_lookup_key_version IS NULL
    OR verified_lookup_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR verified_dedup_key_version IS NULL
    OR verified_dedup_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR NOT (
      (p_verified_union_realm_id IS NULL
        AND p_verified_union_hash IS NULL
        AND p_verified_union_hash_key_version IS NULL)
      OR
      (p_verified_union_realm_id IS NOT NULL
        AND p_verified_union_hash IS NOT NULL
        AND p_verified_union_hash_key_version IS NOT NULL
        AND p_verified_union_realm_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
        AND p_verified_union_hash ~ '^[0-9a-f]{64}$'
        AND p_verified_union_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$')
    ) THEN
    RETURN false;
  END IF;
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'enabled', true);
  UPDATE public.oauth_states
    SET consumed_at = event_time,
      verified_subject_lookup_hash = verified_lookup_hash,
      verified_subject_lookup_key_version = verified_lookup_key_version,
      verified_subject_dedup_hash = verified_dedup_hash,
      verified_subject_dedup_key_version = verified_dedup_key_version,
      verified_union_realm_id = p_verified_union_realm_id,
      verified_union_hash = p_verified_union_hash,
      verified_union_hash_key_version = p_verified_union_hash_key_version
    WHERE id = oauth_state_id
      AND provider = expected_provider
      AND purpose = expected_purpose
      AND flow_reference_hash = expected_flow_reference_hash
      AND operation_target_hash IS NOT DISTINCT FROM expected_operation_target_hash
      AND target_user_id IS NOT DISTINCT FROM expected_target_user_id
      AND device_hash = expected_device_hash
      AND consumed_at IS NULL
      AND event_time >= created_at
      AND expires_at > event_time;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'disabled', true);
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.record_wechat_union_alias_from_consumed_state(
  p_oauth_state_id uuid,
  p_identity_binding_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  event_time timestamptz := clock_timestamp();
  proof_realm_id varchar;
  proof_union_hash varchar;
  proof_union_key_version varchar;
  proof_lookup_hash varchar;
  proof_lookup_key_version varchar;
  proof_dedup_hash varchar;
  proof_dedup_key_version varchar;
  binding_user_id uuid;
  hash_binding_id uuid;
  hash_user_id uuid;
  hash_key_version varchar;
  user_binding_id uuid;
  user_union_hash varchar;
  user_key_version varchar;
BEGIN
  SELECT oauth.verified_union_realm_id, oauth.verified_union_hash,
      oauth.verified_union_hash_key_version,
      oauth.verified_subject_lookup_hash,
      oauth.verified_subject_lookup_key_version,
      oauth.verified_subject_dedup_hash,
      oauth.verified_subject_dedup_key_version
    INTO proof_realm_id, proof_union_hash, proof_union_key_version,
      proof_lookup_hash, proof_lookup_key_version,
      proof_dedup_hash, proof_dedup_key_version
    FROM public.oauth_states AS oauth
    WHERE oauth.id = p_oauth_state_id
      AND oauth.provider = 'WECHAT'
      AND oauth.consumed_at > event_time - interval '15 minutes';
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT binding.user_id
    INTO binding_user_id
    FROM public.identity_bindings AS binding
    JOIN public.users AS account_user ON account_user.id = binding.user_id
    WHERE binding.id = p_identity_binding_id
      AND binding.identity_type = 'WECHAT'
      AND binding.lookup_hash = proof_lookup_hash
      AND binding.lookup_hash_key_version = proof_lookup_key_version
      AND binding.dedup_hash = proof_dedup_hash
      AND binding.dedup_hash_key_version = proof_dedup_key_version
      AND binding.revoked_at IS NULL
      AND account_user.status = 'ACTIVE'
    FOR UPDATE OF binding, account_user;
  IF NOT FOUND THEN RETURN false; END IF;
  IF proof_union_hash IS NULL THEN RETURN true; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'wechat-union:' || proof_realm_id || ':' || proof_union_hash, 0
  ));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'wechat-user:' || proof_realm_id || ':' || binding_user_id::text, 0
  ));

  SELECT alias.identity_binding_id, alias.user_id,
      alias.union_hash_key_version
    INTO hash_binding_id, hash_user_id, hash_key_version
    FROM public.wechat_union_aliases AS alias
    WHERE alias.realm_id = proof_realm_id
      AND alias.union_hash = proof_union_hash
    FOR UPDATE;
  IF hash_binding_id IS NOT NULL AND (
    hash_binding_id <> p_identity_binding_id
    OR hash_user_id <> binding_user_id
    OR hash_key_version <> proof_union_key_version
  ) THEN
    RETURN false;
  END IF;

  SELECT alias.identity_binding_id, alias.union_hash,
      alias.union_hash_key_version
    INTO user_binding_id, user_union_hash, user_key_version
    FROM public.wechat_union_aliases AS alias
    WHERE alias.realm_id = proof_realm_id
      AND alias.user_id = binding_user_id
    FOR UPDATE;
  IF user_binding_id IS NOT NULL AND (
    user_binding_id <> p_identity_binding_id
    OR user_union_hash <> proof_union_hash
    OR user_key_version <> proof_union_key_version
  ) THEN
    RETURN false;
  END IF;

  IF hash_binding_id IS NULL AND user_binding_id IS NULL THEN
    INSERT INTO public.wechat_union_aliases (
      identity_binding_id, user_id, realm_id, union_hash,
      union_hash_algorithm, union_hash_key_version,
      first_verified_at, last_verified_at
    ) VALUES (
      p_identity_binding_id, binding_user_id, proof_realm_id, proof_union_hash,
      'HMAC-SHA256', proof_union_key_version, event_time, event_time
    );
  ELSE
    UPDATE public.wechat_union_aliases
      SET last_verified_at = GREATEST(last_verified_at, event_time)
      WHERE identity_binding_id = p_identity_binding_id;
  END IF;
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false;
END;
$$;

CREATE FUNCTION public.bind_oauth_identity_with_wechat_union_from_consumed_state(
  p_target_user_id uuid,
  p_oauth_state_id uuid,
  p_provider varchar,
  p_expected_flow_reference_hash varchar,
  p_expected_operation_target_hash varchar,
  p_expected_device_hash varchar
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE resulting_binding_id uuid;
BEGIN
  IF p_provider <> 'WECHAT' THEN RETURN NULL; END IF;
  SELECT public.bind_oauth_identity_from_consumed_state(
    p_target_user_id,
    p_oauth_state_id,
    p_provider,
    p_expected_flow_reference_hash,
    p_expected_operation_target_hash,
    p_expected_device_hash
  ) INTO resulting_binding_id;
  IF resulting_binding_id IS NULL THEN RETURN NULL; END IF;
  IF NOT public.record_wechat_union_alias_from_consumed_state(
    p_oauth_state_id, resulting_binding_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'CSM12',
      MESSAGE = 'WeChat Union alias conflicts with the verified binding';
  END IF;
  RETURN resulting_binding_id;
EXCEPTION WHEN SQLSTATE 'CSM12' THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON TABLE public.wechat_union_aliases FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_wechat_union_alias_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_wechat_union_alias_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_oauth_state_with_wechat_union(
  uuid, varchar, varchar, varchar, varchar, uuid, varchar,
  varchar, varchar, varchar, varchar, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_wechat_union_alias_from_consumed_state(
  uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_oauth_identity_with_wechat_union_from_consumed_state(
  uuid, uuid, varchar, varchar, varchar, varchar
) FROM PUBLIC;
