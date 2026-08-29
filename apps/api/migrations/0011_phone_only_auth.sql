-- Replace the retired Fusion + WeChat registration flow with ordinary PNVS
-- SMS verification. Historical Fusion tables from 0010 are intentionally kept
-- for rollback/retention safety, but no new runtime code is granted access.

DROP TRIGGER otp_challenge_state_machine ON public.otp_challenges;
ALTER TABLE public.otp_challenges
  ADD COLUMN verification_method text DEFAULT 'LOCAL_HASH';
ALTER TABLE public.otp_challenges
  ALTER COLUMN code_hash DROP NOT NULL,
  ALTER COLUMN code_hash_algorithm DROP NOT NULL,
  ALTER COLUMN code_hash_key_version DROP NOT NULL;
ALTER TABLE public.otp_challenges
  DROP CONSTRAINT IF EXISTS otp_challenges_code_hash_check,
  DROP CONSTRAINT IF EXISTS otp_challenges_code_hash_algorithm_check,
  DROP CONSTRAINT IF EXISTS otp_challenges_code_hash_key_version_check;

-- Locate the original anonymous consumed-state check without depending on its
-- generated PostgreSQL name. The replacement below preserves consumed audit
-- timestamps while allowing an explicit failed legacy state.
DO $migration$
DECLARE
  matching_constraints integer;
  consumed_state_constraint name;
BEGIN
  SELECT count(*), min(constraint_record.conname::text)::name
    INTO matching_constraints, consumed_state_constraint
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.otp_challenges'::regclass
      AND constraint_record.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
        LIKE '%consumed_at IS NULL%'
      AND pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
        LIKE '%delivery_status%'
      AND pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
        LIKE '%sent_at%'
      AND pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
        LIKE '%expires_at%';
  IF matching_constraints <> 1 OR consumed_state_constraint IS NULL THEN
    RAISE EXCEPTION 'could not identify the OTP consumed-state constraint';
  END IF;
  EXECUTE pg_catalog.format(
    'ALTER TABLE public.otp_challenges DROP CONSTRAINT %I',
    consumed_state_constraint
  );
END;
$migration$;

-- Invalidate every pre-cutover phone code, including a recently consumed but
-- not-yet-claimed registration proof. Keep the historical consumed/claimed
-- timestamps for audit, but clear all verification/delivery material and move
-- the row to a state no runtime verification or registration function accepts.
UPDATE public.otp_challenges
  SET verification_method = 'LEGACY_INVALIDATED',
      code_hash = NULL,
      code_hash_algorithm = NULL,
      code_hash_key_version = NULL,
      delivery_status = 'FAILED',
      provider_request_hash = NULL,
      sent_at = NULL,
      expires_at = NULL
  WHERE channel = 'PHONE';

UPDATE public.otp_challenges
  SET verification_method = 'LOCAL_HASH'
  WHERE channel = 'EMAIL';

ALTER TABLE public.otp_challenges
  ALTER COLUMN verification_method SET NOT NULL;
ALTER TABLE public.otp_challenges
  ADD CONSTRAINT otp_challenges_consumption_state_check CHECK (
    consumed_at IS NULL
    OR (
      delivery_status = 'SENT'
      AND sent_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND consumed_at >= sent_at
      AND consumed_at < expires_at
    )
    OR (
      channel = 'PHONE'
      AND verification_method = 'LEGACY_INVALIDATED'
      AND delivery_status = 'FAILED'
    )
  ),
  ADD CONSTRAINT otp_challenges_verification_material_check CHECK (
    (channel = 'PHONE'
      AND verification_method = 'ALIYUN_PNVS'
      AND code_hash IS NULL
      AND code_hash_algorithm IS NULL
      AND code_hash_key_version IS NULL)
    OR
    (channel = 'PHONE'
      AND verification_method = 'LEGACY_INVALIDATED'
      AND delivery_status = 'FAILED'
      AND provider_request_hash IS NULL
      AND code_hash IS NULL
      AND code_hash_algorithm IS NULL
      AND code_hash_key_version IS NULL)
    OR
    (channel = 'EMAIL'
      AND verification_method = 'LOCAL_HASH'
      AND length(code_hash) BETWEEN 32 AND 128
      AND code_hash_algorithm = 'ARGON2ID-PEPPERED'
      AND code_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$')
  );

-- Sentinels are migration-only. Every newly issued challenge must select the
-- one live verifier for its channel before it can enter the PENDING state.
CREATE OR REPLACE FUNCTION public.validate_otp_challenge_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.delivery_status <> 'PENDING'
    OR NEW.attempts <> 0 OR NEW.send_attempts <> 0
    OR NEW.sent_at IS NOT NULL OR NEW.expires_at IS NOT NULL
    OR NEW.consumed_at IS NOT NULL OR NEW.registration_claimed_at IS NOT NULL
    OR NEW.binding_claimed_at IS NOT NULL
    OR NEW.provider_request_hash IS NOT NULL
    OR (NEW.channel = 'PHONE'
      AND NEW.verification_method IS DISTINCT FROM 'ALIYUN_PNVS')
    OR (NEW.channel = 'EMAIL'
      AND NEW.verification_method IS DISTINCT FROM 'LOCAL_HASH')
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes' THEN
    RAISE EXCEPTION 'OTP challenges must begin with the channel verifier in a fresh pending state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_otp_challenge_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('chi_shen_me.otp_state_transition', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'OTP state changes require a restricted transition function';
  END IF;
  IF (OLD.id, OLD.channel, OLD.purpose, OLD.destination_hash,
      OLD.destination_hash_algorithm, OLD.destination_hash_key_version,
      OLD.destination_dedup_hash, OLD.destination_dedup_hash_algorithm,
      OLD.destination_dedup_key_version, OLD.masked_destination,
      OLD.operation_target_hash, OLD.target_user_id,
      OLD.registration_flow_reference_hash, OLD.verification_method,
      OLD.code_hash, OLD.code_hash_algorithm, OLD.code_hash_key_version,
      OLD.idempotency_key_hash, OLD.hash_key_version, OLD.request_ip_hash,
      OLD.device_hash, OLD.created_at, OLD.retain_until)
      IS DISTINCT FROM
     (NEW.id, NEW.channel, NEW.purpose, NEW.destination_hash,
      NEW.destination_hash_algorithm, NEW.destination_hash_key_version,
      NEW.destination_dedup_hash, NEW.destination_dedup_hash_algorithm,
      NEW.destination_dedup_key_version, NEW.masked_destination,
      NEW.operation_target_hash, NEW.target_user_id,
      NEW.registration_flow_reference_hash, NEW.verification_method,
      NEW.code_hash, NEW.code_hash_algorithm, NEW.code_hash_key_version,
      NEW.idempotency_key_hash, NEW.hash_key_version, NEW.request_ip_hash,
      NEW.device_hash, NEW.created_at, NEW.retain_until) THEN
    RAISE EXCEPTION 'OTP issuance fields are immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'an OTP challenge can be consumed only once';
  END IF;
  IF OLD.registration_claimed_at IS NOT NULL
    AND NEW.registration_claimed_at IS DISTINCT FROM OLD.registration_claimed_at THEN
    RAISE EXCEPTION 'a registration OTP proof can be claimed only once';
  END IF;
  IF OLD.binding_claimed_at IS NOT NULL
    AND NEW.binding_claimed_at IS DISTINCT FROM OLD.binding_claimed_at THEN
    RAISE EXCEPTION 'an identity-binding OTP proof can be claimed only once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER otp_challenge_state_machine
BEFORE UPDATE ON public.otp_challenges
FOR EACH ROW EXECUTE FUNCTION public.protect_otp_challenge_update();

-- The legacy local-verification primitive remains available for EMAIL only.
-- PHONE challenges must pass through the durable PNVS lease functions below;
-- otherwise a runtime caller could mark a supplier code as verified locally.
CREATE OR REPLACE FUNCTION public.record_otp_verification_attempt(
  challenge_id uuid,
  expected_purpose varchar,
  expected_target_user_id uuid,
  expected_operation_target_hash varchar,
  expected_device_hash varchar,
  verification_succeeded boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  IF verification_succeeded IS NULL THEN RETURN false; END IF;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  UPDATE public.otp_challenges AS otp
    SET attempts = otp.attempts + 1,
      consumed_at = CASE WHEN verification_succeeded THEN event_time ELSE NULL END
    WHERE otp.id = challenge_id
      AND otp.channel = 'EMAIL'
      AND otp.verification_method = 'LOCAL_HASH'
      AND otp.purpose = expected_purpose
      AND otp.target_user_id IS NOT DISTINCT FROM expected_target_user_id
      AND otp.operation_target_hash IS NOT DISTINCT FROM expected_operation_target_hash
      AND otp.device_hash = expected_device_hash
      AND otp.delivery_status = 'SENT'
      AND otp.consumed_at IS NULL
      AND otp.expires_at > event_time
      AND event_time >= otp.sent_at
      AND otp.attempts < 5;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN verification_succeeded AND changed_count = 1;
END;
$$;

CREATE TABLE public.otp_verification_leases (
  challenge_id uuid PRIMARY KEY
    REFERENCES public.otp_challenges(id) ON DELETE CASCADE,
  claim_hash varchar(64) NOT NULL UNIQUE
    CHECK (claim_hash ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > claimed_at),
  CHECK (expires_at <= claimed_at + interval '1 minute')
);

CREATE INDEX otp_verification_leases_expiry_idx
  ON public.otp_verification_leases(expires_at);

-- A replacement PNVS send invalidates the supplier's previous code before the
-- request returns. Retire every older local challenge in the same default
-- supplier scene before making that request; a failed send never revives it.
CREATE FUNCTION public.supersede_phone_otp_challenges_for_send(
  p_new_challenge_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE pending_challenge public.otp_challenges%ROWTYPE;
BEGIN
  SELECT * INTO pending_challenge
    FROM public.otp_challenges
    WHERE id = p_new_challenge_id
      AND channel = 'PHONE'
      AND verification_method = 'ALIYUN_PNVS'
      AND delivery_status = 'PENDING'
      AND consumed_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'pnvs-send:' || pending_challenge.destination_dedup_hash,
    0
  ));
  DELETE FROM public.otp_verification_leases AS lease
    USING public.otp_challenges AS older
    WHERE lease.challenge_id = older.id
      AND older.id <> pending_challenge.id
      AND older.channel = 'PHONE'
      AND older.verification_method = 'ALIYUN_PNVS'
      AND older.destination_dedup_hash = pending_challenge.destination_dedup_hash
      AND older.delivery_status IN ('PENDING', 'SENT')
      AND older.consumed_at IS NULL;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  UPDATE public.otp_challenges AS older
    SET delivery_status = 'FAILED',
      provider_request_hash = NULL,
      sent_at = NULL,
      expires_at = NULL
    WHERE older.id <> pending_challenge.id
      AND older.channel = 'PHONE'
      AND older.verification_method = 'ALIYUN_PNVS'
      AND older.destination_dedup_hash = pending_challenge.destination_dedup_hash
      AND older.delivery_status IN ('PENDING', 'SENT')
      AND older.consumed_at IS NULL;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN true;
END;
$$;

-- PNVS DuplicatePolicy=1 makes an earlier code for the same destination and
-- default scene unusable at the supplier. Mirror that behavior atomically: after a
-- newer successful send, no older local challenge may still claim a supplier
-- code. A late response for an older request is failed closed instead of
-- reviving it over a newer SENT challenge.
CREATE OR REPLACE FUNCTION public.finalize_otp_delivery(
  challenge_id uuid,
  outcome varchar,
  provider_message_hash varchar,
  valid_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed_count integer;
  event_time timestamptz := clock_timestamp();
  pending_challenge public.otp_challenges%ROWTYPE;
BEGIN
  IF outcome NOT IN ('SENT', 'FAILED')
    OR (outcome = 'SENT' AND (
      valid_until IS NULL OR valid_until <= event_time
      OR valid_until > event_time + interval '15 minutes'
    ))
    OR (outcome = 'FAILED' AND valid_until IS NOT NULL) THEN
    RETURN false;
  END IF;

  SELECT * INTO pending_challenge
    FROM public.otp_challenges
    WHERE id = challenge_id
      AND delivery_status = 'PENDING'
      AND send_attempts < 5
      AND event_time >= created_at
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF outcome = 'SENT'
    AND pending_challenge.channel = 'PHONE'
    AND pending_challenge.verification_method = 'ALIYUN_PNVS' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'pnvs-send:' || pending_challenge.destination_dedup_hash,
      0
    ));
    IF EXISTS (
      SELECT 1 FROM public.otp_challenges AS newer
      WHERE newer.id <> pending_challenge.id
        AND newer.channel = 'PHONE'
        AND newer.verification_method = 'ALIYUN_PNVS'
        AND newer.destination_dedup_hash = pending_challenge.destination_dedup_hash
        AND newer.delivery_status = 'SENT'
        AND newer.consumed_at IS NULL
        AND (newer.created_at, newer.id) >
          (pending_challenge.created_at, pending_challenge.id)
    ) THEN
      PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
      UPDATE public.otp_challenges
        SET delivery_status = 'FAILED',
          provider_request_hash = NULL,
          send_attempts = send_attempts + 1,
          last_attempt_at = event_time,
          sent_at = NULL,
          expires_at = NULL
        WHERE id = pending_challenge.id AND delivery_status = 'PENDING';
      PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
      RETURN false;
    END IF;

    DELETE FROM public.otp_verification_leases AS lease
      USING public.otp_challenges AS older
      WHERE lease.challenge_id = older.id
        AND older.id <> pending_challenge.id
        AND older.channel = 'PHONE'
        AND older.verification_method = 'ALIYUN_PNVS'
        AND older.destination_dedup_hash = pending_challenge.destination_dedup_hash
        AND older.delivery_status = 'SENT'
        AND older.consumed_at IS NULL;
    PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
    UPDATE public.otp_challenges AS older
      SET delivery_status = 'FAILED',
        provider_request_hash = NULL,
        sent_at = NULL,
        expires_at = NULL
      WHERE older.id <> pending_challenge.id
        AND older.channel = 'PHONE'
        AND older.verification_method = 'ALIYUN_PNVS'
        AND older.destination_dedup_hash = pending_challenge.destination_dedup_hash
        AND older.delivery_status = 'SENT'
        AND older.consumed_at IS NULL;
  ELSE
    PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  END IF;

  UPDATE public.otp_challenges
    SET delivery_status = outcome,
      provider_request_hash = provider_message_hash,
      send_attempts = send_attempts + 1,
      last_attempt_at = event_time,
      sent_at = CASE WHEN outcome = 'SENT' THEN event_time ELSE NULL END,
      expires_at = CASE WHEN outcome = 'SENT' THEN valid_until ELSE NULL END
    WHERE id = pending_challenge.id AND delivery_status = 'PENDING';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.claim_otp_verification_lease(
  p_challenge_id uuid,
  p_expected_purpose varchar,
  p_expected_target_user_id uuid,
  p_expected_operation_target_hash varchar,
  p_expected_device_hash varchar,
  p_claim_hash varchar,
  p_lease_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp(); changed_count integer;
BEGIN
  IF p_claim_hash !~ '^[0-9a-f]{64}$'
    OR p_lease_until <= event_time
    OR p_lease_until > event_time + interval '1 minute' THEN
    RETURN false;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('otp-verify:' || p_challenge_id::text, 0)
  );
  DELETE FROM public.otp_verification_leases
    WHERE challenge_id = p_challenge_id AND expires_at <= event_time;
  IF EXISTS (
    SELECT 1 FROM public.otp_verification_leases
    WHERE challenge_id = p_challenge_id
  ) THEN RETURN false; END IF;
  INSERT INTO public.otp_verification_leases (
    challenge_id, claim_hash, claimed_at, expires_at
  )
  SELECT otp.id, p_claim_hash, event_time, p_lease_until
    FROM public.otp_challenges AS otp
    WHERE otp.id = p_challenge_id
      AND otp.channel = 'PHONE'
      AND otp.verification_method = 'ALIYUN_PNVS'
      AND otp.purpose = p_expected_purpose
      AND otp.target_user_id IS NOT DISTINCT FROM p_expected_target_user_id
      AND otp.operation_target_hash IS NOT DISTINCT FROM p_expected_operation_target_hash
      AND otp.device_hash = p_expected_device_hash
      AND otp.delivery_status = 'SENT'
      AND otp.consumed_at IS NULL
      AND otp.expires_at > event_time
      AND event_time >= otp.sent_at
      AND otp.attempts < 5;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.release_otp_verification_lease(
  p_challenge_id uuid,
  p_claim_hash varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer;
BEGIN
  DELETE FROM public.otp_verification_leases
    WHERE challenge_id = p_challenge_id AND claim_hash = p_claim_hash;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.complete_otp_verification_lease(
  p_challenge_id uuid,
  p_expected_purpose varchar,
  p_expected_target_user_id uuid,
  p_expected_operation_target_hash varchar,
  p_expected_device_hash varchar,
  p_claim_hash varchar,
  p_verification_succeeded boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp(); changed_count integer;
BEGIN
  IF p_verification_succeeded IS NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('otp-verify:' || p_challenge_id::text, 0)
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.otp_verification_leases
    WHERE challenge_id = p_challenge_id
      AND claim_hash = p_claim_hash
      AND expires_at > event_time
    FOR UPDATE
  ) THEN RETURN false; END IF;

  PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  UPDATE public.otp_challenges
    SET attempts = attempts + 1,
      consumed_at = CASE WHEN p_verification_succeeded THEN event_time ELSE NULL END
    WHERE id = p_challenge_id
      AND channel = 'PHONE'
      AND verification_method = 'ALIYUN_PNVS'
      AND purpose = p_expected_purpose
      AND target_user_id IS NOT DISTINCT FROM p_expected_target_user_id
      AND operation_target_hash IS NOT DISTINCT FROM p_expected_operation_target_hash
      AND device_hash = p_expected_device_hash
      AND delivery_status = 'SENT'
      AND consumed_at IS NULL
      AND expires_at > event_time
      AND event_time >= sent_at
      AND attempts < 5;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  DELETE FROM public.otp_verification_leases
    WHERE challenge_id = p_challenge_id AND claim_hash = p_claim_hash;
  RETURN p_verification_succeeded AND changed_count = 1;
END;
$$;

CREATE FUNCTION public.register_phone_account_from_consumed_otp(
  p_user_id uuid,
  p_otp_challenge_id uuid,
  p_expected_device_hash varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  event_time timestamptz := clock_timestamp();
  proof public.otp_challenges%ROWTYPE;
  changed_count integer;
BEGIN
  SELECT * INTO proof
    FROM public.otp_challenges AS otp
    WHERE otp.id = p_otp_challenge_id
      AND otp.channel = 'PHONE'
      AND otp.verification_method = 'ALIYUN_PNVS'
      AND otp.purpose = 'REGISTER'
      AND otp.device_hash = p_expected_device_hash
      AND otp.consumed_at > event_time - interval '15 minutes'
      AND otp.registration_claimed_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF EXISTS (
    SELECT 1 FROM public.identity_bindings AS binding
    WHERE binding.identity_type = 'PHONE'
      AND binding.dedup_hash = proof.destination_dedup_hash
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.users (id) VALUES (p_user_id);
  INSERT INTO public.identity_bindings (
    user_id, identity_type, lookup_hash, lookup_hash_algorithm,
    lookup_hash_key_version, dedup_hash, dedup_hash_algorithm,
    dedup_hash_key_version, masked_display_hint, is_primary, verified_at
  ) VALUES (
    p_user_id, 'PHONE', proof.destination_hash, 'HMAC-SHA256',
    proof.destination_hash_key_version, proof.destination_dedup_hash,
    'HMAC-SHA256', proof.destination_dedup_key_version,
    proof.masked_destination, true, proof.consumed_at
  );

  PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  UPDATE public.otp_challenges
    SET registration_claimed_at = event_time
    WHERE id = p_otp_challenge_id AND registration_claimed_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN changed_count = 1;
EXCEPTION WHEN unique_violation THEN
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN false;
END;
$$;

-- A verified OAuth rebind can rotate both its app-scoped lookup key and its
-- stable provider dedup key. Ownership, identity type and primary state remain
-- immutable, and direct runtime table updates are still forbidden by grants.
CREATE OR REPLACE FUNCTION public.protect_identity_binding_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.user_id <> NEW.user_id
    OR OLD.identity_type <> NEW.identity_type
    OR OLD.created_at <> NEW.created_at
    OR OLD.is_primary <> NEW.is_primary THEN
    RAISE EXCEPTION 'identity ownership, type and primary state are immutable';
  END IF;
  IF (OLD.lookup_hash, OLD.lookup_hash_algorithm, OLD.lookup_hash_key_version,
      OLD.dedup_hash, OLD.dedup_hash_algorithm, OLD.dedup_hash_key_version,
      OLD.masked_display_hint, OLD.verified_at)
      IS DISTINCT FROM
     (NEW.lookup_hash, NEW.lookup_hash_algorithm, NEW.lookup_hash_key_version,
      NEW.dedup_hash, NEW.dedup_hash_algorithm, NEW.dedup_hash_key_version,
      NEW.masked_display_hint, NEW.verified_at)
    AND current_setting('chi_shen_me.identity_reactivation', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'identity hashes and display fields require a verified rotation';
  END IF;
  IF OLD.is_primary AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'the primary identity cannot be unbound';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
    AND current_setting('chi_shen_me.identity_reactivation', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'identity reactivation requires a verified challenge';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.bind_oauth_identity_from_consumed_state(
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
DECLARE
  event_time timestamptz := clock_timestamp();
  proof_consumed_at timestamptz;
  proof_lookup_hash varchar;
  proof_lookup_key_version varchar;
  proof_dedup_hash varchar;
  proof_dedup_key_version varchar;
  existing_binding_id uuid;
  existing_user_id uuid;
  existing_revoked_at timestamptz;
  lookup_binding_id uuid;
  lookup_user_id uuid;
  lookup_revoked_at timestamptz;
  resulting_binding_id uuid;
  display_hint varchar;
BEGIN
  IF p_provider NOT IN ('WECHAT', 'QQ') THEN RETURN NULL; END IF;
  display_hint := CASE p_provider WHEN 'WECHAT' THEN '微信账号' ELSE 'QQ 账号' END;

  SELECT oauth.consumed_at, oauth.verified_subject_lookup_hash,
      oauth.verified_subject_lookup_key_version,
      oauth.verified_subject_dedup_hash,
      oauth.verified_subject_dedup_key_version
    INTO proof_consumed_at, proof_lookup_hash, proof_lookup_key_version,
      proof_dedup_hash, proof_dedup_key_version
    FROM public.oauth_states AS oauth
    JOIN public.users AS account_user ON account_user.id = oauth.target_user_id
    WHERE oauth.id = p_oauth_state_id
      AND oauth.provider = p_provider
      AND oauth.purpose = 'BIND'
      AND oauth.target_user_id = p_target_user_id
      AND oauth.flow_reference_hash = p_expected_flow_reference_hash
      AND oauth.operation_target_hash = p_expected_operation_target_hash
      AND oauth.device_hash = p_expected_device_hash
      AND oauth.consumed_at > event_time - interval '15 minutes'
      AND oauth.binding_claimed_at IS NULL
      AND account_user.status = 'ACTIVE'
    FOR UPDATE OF oauth, account_user;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT binding.id, binding.user_id, binding.revoked_at
    INTO existing_binding_id, existing_user_id, existing_revoked_at
    FROM public.identity_bindings AS binding
    WHERE binding.identity_type = p_provider
      AND binding.dedup_hash = proof_dedup_hash
    FOR UPDATE;

  SELECT binding.id, binding.user_id, binding.revoked_at
    INTO lookup_binding_id, lookup_user_id, lookup_revoked_at
    FROM public.identity_bindings AS binding
    WHERE binding.identity_type = p_provider
      AND binding.lookup_hash = proof_lookup_hash
    FOR UPDATE;

  -- OpenID/app-scope lookup and UnionID/stable dedup must never resolve to
  -- different rows. Such a state needs explicit operator reconciliation; this
  -- function will not merge or transfer identity ownership.
  IF lookup_binding_id IS NOT NULL
    AND existing_binding_id IS NOT NULL
    AND lookup_binding_id <> existing_binding_id THEN
    RETURN NULL;
  END IF;
  IF existing_binding_id IS NULL AND lookup_binding_id IS NOT NULL THEN
    existing_binding_id := lookup_binding_id;
    existing_user_id := lookup_user_id;
    existing_revoked_at := lookup_revoked_at;
  END IF;
  IF existing_binding_id IS NOT NULL
    AND (existing_user_id <> p_target_user_id OR existing_revoked_at IS NULL) THEN
    RETURN NULL;
  END IF;

  IF existing_binding_id IS NULL THEN
    INSERT INTO public.identity_bindings (
      user_id, identity_type, lookup_hash, lookup_hash_algorithm,
      lookup_hash_key_version, dedup_hash, dedup_hash_algorithm,
      dedup_hash_key_version, masked_display_hint, is_primary, verified_at
    ) VALUES (
      p_target_user_id, p_provider, proof_lookup_hash, 'HMAC-SHA256',
      proof_lookup_key_version, proof_dedup_hash, 'HMAC-SHA256',
      proof_dedup_key_version, display_hint, false, proof_consumed_at
    ) RETURNING id INTO resulting_binding_id;
  ELSE
    PERFORM set_config('chi_shen_me.identity_reactivation', 'enabled', true);
    UPDATE public.identity_bindings
      SET lookup_hash = proof_lookup_hash,
        lookup_hash_algorithm = 'HMAC-SHA256',
        lookup_hash_key_version = proof_lookup_key_version,
        dedup_hash = proof_dedup_hash,
        dedup_hash_algorithm = 'HMAC-SHA256',
        dedup_hash_key_version = proof_dedup_key_version,
        masked_display_hint = display_hint,
        verified_at = proof_consumed_at,
        revoked_at = NULL
      WHERE id = existing_binding_id AND revoked_at IS NOT NULL
      RETURNING id INTO resulting_binding_id;
    PERFORM set_config('chi_shen_me.identity_reactivation', 'disabled', true);
  END IF;
  IF resulting_binding_id IS NULL THEN RETURN NULL; END IF;

  PERFORM set_config('chi_shen_me.oauth_state_transition', 'enabled', true);
  UPDATE public.oauth_states
    SET binding_claimed_at = event_time
    WHERE id = p_oauth_state_id AND binding_claimed_at IS NULL;
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'disabled', true);
  RETURN resulting_binding_id;
EXCEPTION WHEN unique_violation THEN
  PERFORM set_config('chi_shen_me.identity_reactivation', 'disabled', true);
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'disabled', true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_non_primary_identity_binding(
  p_target_binding_id uuid,
  p_target_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer;
BEGIN
  UPDATE public.identity_bindings
    SET revoked_at = now()
    WHERE id = p_target_binding_id
      AND user_id = p_target_user_id
      AND revoked_at IS NULL
      AND NOT is_primary
      AND identity_type IN ('EMAIL', 'WECHAT', 'QQ');
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.register_phone_account_from_consumed_otp(
  uuid, uuid, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_otp_verification_attempt(
  uuid, varchar, uuid, varchar, varchar, boolean
) FROM PUBLIC;
REVOKE ALL ON TABLE public.otp_verification_leases FROM PUBLIC;
REVOKE ALL ON FUNCTION public.supersede_phone_otp_challenges_for_send(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_otp_verification_lease(
  uuid, varchar, uuid, varchar, varchar, varchar, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_otp_verification_lease(
  uuid, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_otp_verification_lease(
  uuid, varchar, uuid, varchar, varchar, varchar, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_oauth_identity_from_consumed_state(
  uuid, uuid, varchar, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_non_primary_identity_binding(
  uuid, uuid
) FROM PUBLIC;
