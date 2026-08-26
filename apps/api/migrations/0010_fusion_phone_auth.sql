-- Alibaba Cloud fusion authentication proofs. Provider tokens and plaintext
-- phone numbers are deliberately absent from this table.
CREATE TABLE public.fusion_auth_flows (
  id uuid PRIMARY KEY,
  purpose varchar(16) NOT NULL CHECK (purpose IN ('LOGIN', 'REGISTER')),
  registration_flow_reference_hash varchar(64),
  request_ip_hash varchar(64) NOT NULL CHECK (request_ip_hash ~ '^[0-9a-f]{64}$'),
  device_hash varchar(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  hash_key_version varchar(64) NOT NULL
    CHECK (hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  verify_token_hash varchar(64),
  verify_token_hash_key_version varchar(64),
  verified_phone_lookup_hash varchar(64),
  verified_phone_lookup_key_version varchar(64),
  verified_phone_dedup_hash varchar(64),
  verified_phone_dedup_key_version varchar(64),
  masked_phone varchar(32),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  proof_expires_at timestamptz,
  consumed_at timestamptz,
  retain_until timestamptz NOT NULL,
  CHECK ((purpose = 'REGISTER') = (registration_flow_reference_hash IS NOT NULL)),
  CHECK (registration_flow_reference_hash IS NULL
    OR registration_flow_reference_hash ~ '^[0-9a-f]{64}$'),
  CHECK ((verify_token_hash IS NULL) = (verify_token_hash_key_version IS NULL)),
  CHECK ((verified_phone_lookup_hash IS NULL) =
    (verified_phone_lookup_key_version IS NULL)),
  CHECK ((verified_phone_dedup_hash IS NULL) =
    (verified_phone_dedup_key_version IS NULL)),
  CHECK (verified_at IS NULL OR verify_token_hash IS NOT NULL),
  CHECK ((verified_at IS NULL) = (verified_phone_lookup_hash IS NULL)),
  CHECK ((verified_at IS NULL) = (verified_phone_dedup_hash IS NULL)),
  CHECK ((verified_at IS NULL) = (masked_phone IS NULL)),
  CHECK ((verified_at IS NULL) = (proof_expires_at IS NULL)),
  CHECK (verify_token_hash IS NULL OR verify_token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (verified_phone_lookup_hash IS NULL
    OR verified_phone_lookup_hash ~ '^[0-9a-f]{64}$'),
  CHECK (verified_phone_dedup_hash IS NULL
    OR verified_phone_dedup_hash ~ '^[0-9a-f]{64}$'),
  CHECK (verify_token_hash_key_version IS NULL
    OR verify_token_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  CHECK (verified_phone_lookup_key_version IS NULL
    OR verified_phone_lookup_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  CHECK (verified_phone_dedup_key_version IS NULL
    OR verified_phone_dedup_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  CHECK (masked_phone IS NULL OR masked_phone ~ '^\+861[0-9]{2}\*{4}[0-9]{4}$'),
  CHECK (expires_at > created_at),
  CHECK (verified_at IS NULL OR verified_at >= created_at),
  CHECK (proof_expires_at IS NULL OR (
    proof_expires_at > verified_at AND proof_expires_at <= expires_at
  )),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (retain_until >= expires_at),
  CHECK (retain_until <= created_at + interval '24 hours')
);

CREATE INDEX fusion_auth_flows_device_idx
  ON public.fusion_auth_flows(device_hash, created_at DESC);
CREATE INDEX fusion_auth_flows_expiry_idx
  ON public.fusion_auth_flows(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX fusion_auth_flows_retention_idx
  ON public.fusion_auth_flows(retain_until);
-- Every current/retiring hash-key version is claimed before the upstream
-- verification call. This prevents a VerifyToken from being replayed across
-- flows while a key rotates; operators must keep retiring versions configured
-- for at least the maximum fusion-token/flow lifetime before removal.
CREATE TABLE public.fusion_auth_verify_token_claims (
  flow_id uuid NOT NULL REFERENCES public.fusion_auth_flows(id) ON DELETE CASCADE,
  verify_token_hash varchar(64) NOT NULL
    CHECK (verify_token_hash ~ '^[0-9a-f]{64}$'),
  verify_token_hash_key_version varchar(64) NOT NULL
    CHECK (verify_token_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  claimed_at timestamptz NOT NULL,
  PRIMARY KEY (flow_id, verify_token_hash_key_version),
  UNIQUE (verify_token_hash_key_version, verify_token_hash)
);
CREATE INDEX fusion_auth_verify_token_claims_flow_idx
  ON public.fusion_auth_verify_token_claims(flow_id);

CREATE FUNCTION public.validate_fusion_auth_flow_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.attempts <> 0
    OR NEW.verify_token_hash IS NOT NULL
    OR NEW.verified_phone_lookup_hash IS NOT NULL
    OR NEW.verified_phone_dedup_hash IS NOT NULL
    OR NEW.masked_phone IS NOT NULL
    OR NEW.verified_at IS NOT NULL
    OR NEW.proof_expires_at IS NOT NULL
    OR NEW.consumed_at IS NOT NULL
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes'
    OR NEW.expires_at <= event_time THEN
    RAISE EXCEPTION 'fusion authentication flow must begin fresh and unverified';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fusion_auth_flow_initial_state
BEFORE INSERT ON public.fusion_auth_flows
FOR EACH ROW EXECUTE FUNCTION public.validate_fusion_auth_flow_insert();

CREATE FUNCTION public.protect_fusion_auth_flow_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('chi_shen_me.fusion_auth_transition', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'fusion authentication state requires a restricted transition';
  END IF;
  IF (OLD.id, OLD.purpose, OLD.registration_flow_reference_hash,
      OLD.request_ip_hash, OLD.device_hash, OLD.hash_key_version,
      OLD.created_at, OLD.expires_at, OLD.retain_until)
      IS DISTINCT FROM
     (NEW.id, NEW.purpose, NEW.registration_flow_reference_hash,
      NEW.request_ip_hash, NEW.device_hash, NEW.hash_key_version,
      NEW.created_at, NEW.expires_at, NEW.retain_until) THEN
    RAISE EXCEPTION 'fusion authentication issuance fields are immutable';
  END IF;
  IF OLD.verified_at IS NOT NULL AND (
      OLD.verify_token_hash, OLD.verify_token_hash_key_version,
      OLD.verified_phone_lookup_hash, OLD.verified_phone_lookup_key_version,
      OLD.verified_phone_dedup_hash, OLD.verified_phone_dedup_key_version,
      OLD.masked_phone, OLD.verified_at, OLD.proof_expires_at
    ) IS DISTINCT FROM (
      NEW.verify_token_hash, NEW.verify_token_hash_key_version,
      NEW.verified_phone_lookup_hash, NEW.verified_phone_lookup_key_version,
      NEW.verified_phone_dedup_hash, NEW.verified_phone_dedup_key_version,
      NEW.masked_phone, NEW.verified_at, NEW.proof_expires_at
    ) THEN
    RAISE EXCEPTION 'verified fusion phone proof is immutable';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'fusion authentication attempts are monotonic';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'fusion authentication flow can be consumed only once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fusion_auth_flow_state_machine
BEFORE UPDATE ON public.fusion_auth_flows
FOR EACH ROW EXECUTE FUNCTION public.protect_fusion_auth_flow_update();

CREATE FUNCTION public.claim_fusion_auth_verify_token(
  p_flow_id uuid,
  p_expected_purpose varchar,
  p_expected_device_hash varchar,
  p_expected_hash_key_version varchar,
  p_verify_token_hashes varchar[],
  p_verify_token_hash_key_versions varchar[],
  p_primary_verify_token_hash varchar,
  p_primary_verify_token_hash_key_version varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  IF p_expected_purpose NOT IN ('LOGIN', 'REGISTER')
    OR p_verify_token_hashes IS NULL
    OR p_verify_token_hash_key_versions IS NULL
    OR cardinality(p_verify_token_hashes) NOT BETWEEN 1 AND 3
    OR cardinality(p_verify_token_hashes)
      IS DISTINCT FROM cardinality(p_verify_token_hash_key_versions)
    OR p_primary_verify_token_hash !~ '^[0-9a-f]{64}$'
    OR p_primary_verify_token_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR EXISTS (
      SELECT 1
      FROM unnest(
        p_verify_token_hashes,
        p_verify_token_hash_key_versions
      ) AS claim(verify_token_hash, key_version)
      WHERE claim.verify_token_hash !~ '^[0-9a-f]{64}$'
        OR claim.key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    )
    OR (
      SELECT count(DISTINCT claim.key_version)
      FROM unnest(p_verify_token_hash_key_versions) AS claim(key_version)
    ) <> cardinality(p_verify_token_hash_key_versions)
    OR NOT EXISTS (
      SELECT 1
      FROM unnest(
        p_verify_token_hashes,
        p_verify_token_hash_key_versions
      ) AS claim(verify_token_hash, key_version)
      WHERE claim.verify_token_hash = p_primary_verify_token_hash
        AND claim.key_version = p_primary_verify_token_hash_key_version
    ) THEN
    RETURN false;
  END IF;

  PERFORM set_config('chi_shen_me.fusion_auth_transition', 'enabled', true);
  BEGIN
    UPDATE public.fusion_auth_flows
    SET attempts = attempts + 1,
        verify_token_hash = p_primary_verify_token_hash,
        verify_token_hash_key_version = p_primary_verify_token_hash_key_version
    WHERE id = p_flow_id
      AND purpose = p_expected_purpose
      AND device_hash = p_expected_device_hash
      AND hash_key_version = p_expected_hash_key_version
      AND verify_token_hash IS NULL
      AND verified_at IS NULL AND consumed_at IS NULL
      AND attempts = 0 AND event_time >= created_at
      AND expires_at > event_time + interval '1 second';
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    IF changed_count = 1 THEN
      INSERT INTO public.fusion_auth_verify_token_claims (
        flow_id, verify_token_hash, verify_token_hash_key_version, claimed_at
      )
      SELECT
        p_flow_id, claim.verify_token_hash, claim.key_version, event_time
      FROM unnest(
        p_verify_token_hashes,
        p_verify_token_hash_key_versions
      ) AS claim(verify_token_hash, key_version);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- The same VerifyToken was already claimed by another flow. Consume only
    -- this replaying flow and return a generic failure; never expose the token,
    -- its HMAC, the winning flow or provider details.
    UPDATE public.fusion_auth_flows
    SET attempts = attempts + 1,
        consumed_at = event_time
    WHERE id = p_flow_id
      AND purpose = p_expected_purpose
      AND device_hash = p_expected_device_hash
      AND hash_key_version = p_expected_hash_key_version
      AND verify_token_hash IS NULL
      AND verified_at IS NULL AND consumed_at IS NULL
      AND attempts = 0 AND event_time >= created_at
      AND expires_at > event_time + interval '1 second';
    PERFORM set_config('chi_shen_me.fusion_auth_transition', 'disabled', true);
    RETURN false;
  END;
  PERFORM set_config('chi_shen_me.fusion_auth_transition', 'disabled', true);
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.record_fusion_auth_result(
  p_flow_id uuid,
  p_expected_purpose varchar,
  p_expected_device_hash varchar,
  p_expected_hash_key_version varchar,
  p_verify_token_hash varchar,
  p_verify_token_hash_key_version varchar,
  p_verification_succeeded boolean,
  p_consume_on_success boolean,
  p_phone_lookup_hash varchar,
  p_phone_lookup_key_version varchar,
  p_phone_dedup_hash varchar,
  p_phone_dedup_key_version varchar,
  p_masked_phone varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  IF p_expected_purpose NOT IN ('LOGIN', 'REGISTER')
    OR (p_consume_on_success IS DISTINCT FROM (p_expected_purpose = 'LOGIN'))
    OR p_verify_token_hash !~ '^[0-9a-f]{64}$'
    OR p_verify_token_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$' THEN
    RETURN false;
  END IF;
  IF p_verification_succeeded THEN
    IF p_phone_lookup_hash !~ '^[0-9a-f]{64}$'
      OR p_phone_dedup_hash !~ '^[0-9a-f]{64}$'
      OR p_phone_lookup_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
      OR p_phone_dedup_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
      OR p_masked_phone !~ '^\+861[0-9]{2}\*{4}[0-9]{4}$' THEN
      RETURN false;
    END IF;
  ELSIF p_phone_lookup_hash IS NOT NULL
    OR p_phone_lookup_key_version IS NOT NULL
    OR p_phone_dedup_hash IS NOT NULL
    OR p_phone_dedup_key_version IS NOT NULL
    OR p_masked_phone IS NOT NULL THEN
    RETURN false;
  END IF;

  PERFORM set_config('chi_shen_me.fusion_auth_transition', 'enabled', true);
  UPDATE public.fusion_auth_flows
  SET verified_phone_lookup_hash = CASE WHEN p_verification_succeeded THEN p_phone_lookup_hash ELSE NULL END,
      verified_phone_lookup_key_version = CASE WHEN p_verification_succeeded THEN p_phone_lookup_key_version ELSE NULL END,
      verified_phone_dedup_hash = CASE WHEN p_verification_succeeded THEN p_phone_dedup_hash ELSE NULL END,
      verified_phone_dedup_key_version = CASE WHEN p_verification_succeeded THEN p_phone_dedup_key_version ELSE NULL END,
      masked_phone = CASE WHEN p_verification_succeeded THEN p_masked_phone ELSE NULL END,
      verified_at = CASE WHEN p_verification_succeeded THEN event_time ELSE NULL END,
      proof_expires_at = CASE WHEN p_verification_succeeded
        THEN LEAST(expires_at, event_time + interval '5 minutes') ELSE NULL END,
      consumed_at = CASE
        WHEN p_verification_succeeded AND p_consume_on_success THEN event_time
        WHEN NOT p_verification_succeeded THEN event_time
        ELSE consumed_at
      END
  WHERE id = p_flow_id
    AND purpose = p_expected_purpose
    AND device_hash = p_expected_device_hash
    AND hash_key_version = p_expected_hash_key_version
    AND verify_token_hash = p_verify_token_hash
    AND verify_token_hash_key_version = p_verify_token_hash_key_version
    AND verified_at IS NULL AND consumed_at IS NULL
    AND attempts = 1 AND event_time >= created_at
    AND expires_at > event_time + interval '1 second';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.fusion_auth_transition', 'disabled', true);
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.register_fusion_phone_wechat_account(
  p_user_id uuid,
  p_phone_proof_id uuid,
  p_oauth_state_id uuid,
  p_registration_flow_hash varchar,
  p_device_hash varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  event_time timestamptz := clock_timestamp();
  phone_proof public.fusion_auth_flows%ROWTYPE;
  oauth_proof public.oauth_states%ROWTYPE;
BEGIN
  SELECT * INTO phone_proof FROM public.fusion_auth_flows AS flow
    WHERE flow.id = p_phone_proof_id
      AND flow.purpose = 'REGISTER'
      AND flow.registration_flow_reference_hash = p_registration_flow_hash
      AND flow.device_hash = p_device_hash
      AND flow.verified_at IS NOT NULL
      AND flow.proof_expires_at > event_time
      AND flow.consumed_at IS NULL
    FOR UPDATE;
  SELECT * INTO oauth_proof FROM public.oauth_states AS oauth
    WHERE oauth.id = p_oauth_state_id
      AND oauth.provider = 'WECHAT' AND oauth.purpose = 'REGISTER'
      AND oauth.flow_reference_hash = p_registration_flow_hash
      AND oauth.device_hash = p_device_hash
      AND oauth.consumed_at > event_time - interval '15 minutes'
      AND oauth.registration_claimed_at IS NULL
    FOR UPDATE;
  IF phone_proof.id IS NULL OR oauth_proof.id IS NULL THEN RETURN false; END IF;

  PERFORM set_config('chi_shen_me.fusion_auth_transition', 'enabled', true);
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'enabled', true);
  UPDATE public.fusion_auth_flows SET consumed_at = event_time
    WHERE id = p_phone_proof_id AND consumed_at IS NULL;
  UPDATE public.oauth_states SET registration_claimed_at = event_time
    WHERE id = p_oauth_state_id AND registration_claimed_at IS NULL;
  PERFORM set_config('chi_shen_me.fusion_auth_transition', 'disabled', true);
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'disabled', true);

  INSERT INTO public.users (id) VALUES (p_user_id);
  INSERT INTO public.identity_bindings (
    user_id, identity_type, lookup_hash, lookup_hash_algorithm,
    lookup_hash_key_version, dedup_hash, dedup_hash_algorithm,
    dedup_hash_key_version, masked_display_hint, is_primary, verified_at
  ) VALUES (
    p_user_id, 'PHONE', phone_proof.verified_phone_lookup_hash, 'HMAC-SHA256',
    phone_proof.verified_phone_lookup_key_version,
    phone_proof.verified_phone_dedup_hash, 'HMAC-SHA256',
    phone_proof.verified_phone_dedup_key_version,
    phone_proof.masked_phone, true, phone_proof.verified_at
  );
  INSERT INTO public.identity_bindings (
    user_id, identity_type, lookup_hash, lookup_hash_algorithm,
    lookup_hash_key_version, dedup_hash, dedup_hash_algorithm,
    dedup_hash_key_version, masked_display_hint, is_primary, verified_at
  ) VALUES (
    p_user_id, 'WECHAT', oauth_proof.verified_subject_lookup_hash, 'HMAC-SHA256',
    oauth_proof.verified_subject_lookup_key_version,
    oauth_proof.verified_subject_dedup_hash, 'HMAC-SHA256',
    oauth_proof.verified_subject_dedup_key_version,
    '微信账号', false, oauth_proof.consumed_at
  );
  RETURN true;
END;
$$;

CREATE FUNCTION public.preview_fusion_auth_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT 'FUSION_AUTH_24H'::text, count(*)::bigint
  FROM public.fusion_auth_flows WHERE retain_until <= now()
$$;

CREATE FUNCTION public.execute_fusion_auth_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.fusion_auth_flows WHERE retain_until <= clock_timestamp();
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'FUSION_AUTH_24H';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON public.fusion_auth_flows FROM PUBLIC;
REVOKE ALL ON public.fusion_auth_verify_token_claims FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_fusion_auth_flow_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_fusion_auth_flow_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_fusion_auth_verify_token(
  uuid, varchar, varchar, varchar, varchar[], varchar[], varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_fusion_auth_result(
  uuid, varchar, varchar, varchar, varchar, varchar, boolean, boolean,
  varchar, varchar, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_fusion_phone_wechat_account(
  uuid, uuid, uuid, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preview_fusion_auth_retention_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_fusion_auth_retention_cleanup() FROM PUBLIC;
