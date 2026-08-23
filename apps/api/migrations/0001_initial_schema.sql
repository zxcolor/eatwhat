-- PostgreSQL 17 + PostGIS 3.5 initial schema for 吃什么.
-- This migration contains no user coordinates, raw request bodies, plaintext
-- credentials, third-party OAuth tokens, or plaintext OTP/refresh tokens.

DO $$
DECLARE
  pgcrypto_version text;
  postgis_version text;
BEGIN
  SELECT extversion INTO pgcrypto_version
    FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto';
  SELECT extversion INTO postgis_version
    FROM pg_catalog.pg_extension WHERE extname = 'postgis';
  IF pgcrypto_version IS DISTINCT FROM '1.3'
    OR postgis_version IS NULL
    OR postgis_version !~ '^3[.]5([.]|$)' THEN
    RAISE EXCEPTION 'required bootstrap extensions are missing or incompatible';
  END IF;
END;
$$;

CREATE FUNCTION public.app_config_value_is_valid(schema_name text, input_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  item record;
BEGIN
  IF jsonb_typeof(input_value) <> 'object' THEN
    RETURN false;
  END IF;
  FOR item IN
    SELECT entry.field_key, entry.field_value
    FROM pg_catalog.jsonb_each(input_value) AS entry(field_key, field_value)
  LOOP
    IF schema_name = 'FEATURE_FLAGS_V1' THEN
      IF item.field_key = 'enabled' THEN
        IF jsonb_typeof(item.field_value) <> 'boolean' THEN RETURN false; END IF;
      ELSIF item.field_key = 'rolloutPercentage' THEN
        IF jsonb_typeof(item.field_value) <> 'number'
          OR (item.field_value #>> '{}') !~ '^(100|[0-9]{1,2})$' THEN RETURN false; END IF;
      ELSE RETURN false;
      END IF;
    ELSIF schema_name = 'RECOMMENDATION_RULES_V1' THEN
      IF item.field_key NOT IN (
          'qualityWeight', 'timeWeight', 'budgetWeight', 'intentWeight',
          'diversityWeight', 'operationsAdjustmentMaximum'
        ) OR jsonb_typeof(item.field_value) <> 'number'
        OR (item.field_value #>> '{}') !~ '^[0-9]+([.][0-9]{1,4})?$' THEN RETURN false; END IF;
    ELSIF schema_name = 'PROMPT_SETTINGS_V1' THEN
      IF item.field_key = 'enabled' THEN
        IF jsonb_typeof(item.field_value) <> 'boolean' THEN RETURN false; END IF;
      ELSIF item.field_key IN ('promptVersion', 'modelVersion') THEN
        IF jsonb_typeof(item.field_value) <> 'string'
          OR (item.field_value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' THEN RETURN false; END IF;
      ELSIF item.field_key = 'timeoutMs' THEN
        IF jsonb_typeof(item.field_value) <> 'number'
          OR (item.field_value #>> '{}') !~ '^[1-9][0-9]{2,4}$' THEN RETURN false; END IF;
      ELSE RETURN false;
      END IF;
    ELSIF schema_name = 'COVERAGE_SETTINGS_V1' THEN
      IF item.field_key IN ('defaultRadiusMeters', 'maximumRadiusMeters') THEN
        IF jsonb_typeof(item.field_value) <> 'number'
          OR (item.field_value #>> '{}') !~ '^[1-9][0-9]{1,5}$' THEN RETURN false; END IF;
      ELSIF item.field_key = 'areaCode' THEN
        IF jsonb_typeof(item.field_value) <> 'string'
          OR (item.field_value #>> '{}') !~ '^[A-Z][A-Z0-9_]{1,63}$' THEN RETURN false; END IF;
      ELSE RETURN false;
      END IF;
    ELSIF schema_name = 'MINIMUM_APP_VERSION_V1' THEN
      IF item.field_key NOT IN ('android', 'ios', 'miniprogram')
        OR jsonb_typeof(item.field_value) <> 'string'
        OR (item.field_value #>> '{}') !~ '^[0-9]{1,4}[.][0-9]{1,4}[.][0-9]{1,4}$' THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN CASE schema_name
    WHEN 'FEATURE_FLAGS_V1' THEN input_value ? 'enabled'
    WHEN 'RECOMMENDATION_RULES_V1' THEN jsonb_object_length(input_value) = 6
    WHEN 'PROMPT_SETTINGS_V1' THEN input_value ?& ARRAY['enabled', 'promptVersion', 'modelVersion', 'timeoutMs']
    WHEN 'COVERAGE_SETTINGS_V1' THEN input_value ?& ARRAY['defaultRadiusMeters', 'maximumRadiusMeters', 'areaCode']
    WHEN 'MINIMUM_APP_VERSION_V1' THEN input_value ? 'android'
    ELSE false
  END;
END;
$$;

CREATE FUNCTION public.audit_context_is_valid(event_action text, value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_key text;
  count_text text;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
  expected_key := CASE event_action
    WHEN 'DATA_RIGHTS_AUTHORIZATION_REVOKED' THEN 'removedReferenceCount'
    WHEN 'INACTIVE_EXTERNAL_REFERENCES_PURGED' THEN 'removedReferenceCount'
    WHEN 'AUDIT_RETENTION_PURGE' THEN 'deletedCount'
    WHEN 'RETENTION_CLEANUP_COMPLETED' THEN 'affectedCount'
    ELSE NULL
  END;
  IF expected_key IS NULL THEN RETURN value = '{}'::jsonb; END IF;
  IF jsonb_object_length(value) <> 1
    OR NOT value ? expected_key
    OR jsonb_typeof(value -> expected_key) <> 'number' THEN RETURN false; END IF;
  count_text := value ->> expected_key;
  RETURN count_text ~ '^(0|[1-9][0-9]{0,17})$';
END;
$$;

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'LOCKED', 'DELETION_PENDING', 'DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK (updated_at >= created_at),
  CHECK (disabled_at IS NULL OR disabled_at >= created_at),
  CHECK (
    (status IN ('DELETION_PENDING', 'DELETED') AND disabled_at IS NOT NULL)
    OR (status IN ('ACTIVE', 'LOCKED') AND disabled_at IS NULL)
  )
);

CREATE FUNCTION public.validate_user_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.status <> 'ACTIVE' OR NEW.disabled_at IS NOT NULL
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes'
    OR NEW.updated_at < NEW.created_at
    OR NEW.updated_at > event_time + interval '5 minutes' THEN
    RAISE EXCEPTION 'users must begin in a fresh active state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_initial_state
BEFORE INSERT ON public.users
FOR EACH ROW EXECUTE FUNCTION public.validate_user_insert();

CREATE FUNCTION public.protect_user_lifecycle_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.id <> NEW.id OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'user identity and creation time are immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'user update time cannot move backwards';
  END IF;
  IF NEW.updated_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'user update time must use database time';
  END IF;
  IF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
    RAISE EXCEPTION 'user disablement time is immutable';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
    OLD.status = 'ACTIVE' AND NEW.status IN ('LOCKED', 'DELETION_PENDING')
    OR OLD.status = 'LOCKED' AND NEW.status IN ('ACTIVE', 'DELETION_PENDING')
    OR OLD.status = 'DELETION_PENDING' AND NEW.status = 'DELETED'
  ) THEN
    RAISE EXCEPTION 'user lifecycle transition is invalid';
  END IF;
  IF OLD.status IN ('ACTIVE', 'LOCKED') AND NEW.status = 'DELETION_PENDING'
    AND current_setting('chi_shen_me.account_deletion_transition', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'account deletion requires the restricted transition function';
  END IF;
  IF OLD.status = 'DELETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'deleted users are terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_lifecycle_state_machine
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.protect_user_lifecycle_update();

CREATE TABLE public.identity_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  identity_type text NOT NULL
    CHECK (identity_type IN ('PHONE', 'WECHAT', 'QQ', 'EMAIL', 'APPLE')),
  lookup_hash varchar(64) NOT NULL CHECK (lookup_hash ~ '^[0-9a-f]{64}$'),
  lookup_hash_algorithm text NOT NULL CHECK (lookup_hash_algorithm = 'HMAC-SHA256'),
  lookup_hash_key_version varchar(64) NOT NULL
    CHECK (lookup_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  dedup_hash varchar(64) NOT NULL CHECK (dedup_hash ~ '^[0-9a-f]{64}$'),
  dedup_hash_algorithm text NOT NULL CHECK (dedup_hash_algorithm = 'HMAC-SHA256'),
  dedup_hash_key_version varchar(64) NOT NULL
    CHECK (dedup_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  masked_display_hint varchar(254) NOT NULL CHECK (
    masked_display_hint = btrim(masked_display_hint)
    AND masked_display_hint !~ '[[:cntrl:]]'
    AND (
      (identity_type = 'PHONE' AND masked_display_hint ~ '^\+861[0-9]{2}[*]{4}[0-9]{4}$')
      OR (identity_type = 'EMAIL' AND masked_display_hint ~ '^[^@[:space:]]*[*]+[^@[:space:]]*@[A-Za-z0-9.-]{1,190}$')
      OR (identity_type = 'WECHAT' AND masked_display_hint = '微信账号')
      OR (identity_type = 'QQ' AND masked_display_hint = 'QQ 账号')
      OR (identity_type = 'APPLE' AND masked_display_hint = 'Apple 账号')
    )
  ),
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (identity_type, lookup_hash),
  UNIQUE (identity_type, dedup_hash),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (NOT is_primary OR identity_type = 'PHONE')
);
CREATE INDEX identity_bindings_user_idx ON public.identity_bindings(user_id);
CREATE UNIQUE INDEX identity_one_active_primary_idx
  ON public.identity_bindings(user_id)
  WHERE is_primary AND revoked_at IS NULL;
CREATE UNIQUE INDEX identity_one_active_per_type_idx
  ON public.identity_bindings(user_id, identity_type)
  WHERE revoked_at IS NULL;

CREATE FUNCTION public.validate_identity_binding_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE user_status text; event_time timestamptz := clock_timestamp();
BEGIN
  SELECT status INTO user_status FROM public.users
    WHERE id = NEW.user_id FOR SHARE;
  IF user_status IS DISTINCT FROM 'ACTIVE'
    OR NEW.revoked_at IS NOT NULL
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes'
    OR NEW.verified_at < event_time - interval '15 minutes'
    OR NEW.verified_at > event_time + interval '5 minutes' THEN
    RAISE EXCEPTION 'identity binding requires a current active user and proof';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_binding_initial_state
BEFORE INSERT ON public.identity_bindings
FOR EACH ROW EXECUTE FUNCTION public.validate_identity_binding_insert();

CREATE FUNCTION public.protect_identity_binding_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.user_id <> NEW.user_id
    OR OLD.identity_type <> NEW.identity_type
    OR OLD.dedup_hash <> NEW.dedup_hash
    OR OLD.dedup_hash_key_version <> NEW.dedup_hash_key_version
    OR OLD.created_at <> NEW.created_at
    OR OLD.is_primary <> NEW.is_primary THEN
    RAISE EXCEPTION 'identity ownership, stable deduplication and primary state are immutable';
  END IF;
  IF (OLD.lookup_hash, OLD.lookup_hash_algorithm, OLD.lookup_hash_key_version,
      OLD.masked_display_hint, OLD.verified_at)
      IS DISTINCT FROM
     (NEW.lookup_hash, NEW.lookup_hash_algorithm, NEW.lookup_hash_key_version,
      NEW.masked_display_hint, NEW.verified_at)
    AND current_setting('chi_shen_me.identity_reactivation', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'identity lookup and display fields require a verified rotation';
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

CREATE TRIGGER protect_identity_binding_updates
BEFORE UPDATE ON public.identity_bindings
FOR EACH ROW EXECUTE FUNCTION public.protect_identity_binding_update();

CREATE TABLE public.otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('PHONE', 'EMAIL')),
  purpose text NOT NULL
    CHECK (purpose IN ('REGISTER', 'LOGIN', 'BIND', 'RECOVERY')),
  destination_hash varchar(64) NOT NULL CHECK (destination_hash ~ '^[0-9a-f]{64}$'),
  destination_hash_algorithm text NOT NULL CHECK (destination_hash_algorithm = 'HMAC-SHA256'),
  destination_hash_key_version varchar(64) NOT NULL
    CHECK (destination_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  destination_dedup_hash varchar(64) NOT NULL
    CHECK (destination_dedup_hash ~ '^[0-9a-f]{64}$'),
  destination_dedup_hash_algorithm text NOT NULL
    CHECK (destination_dedup_hash_algorithm = 'HMAC-SHA256'),
  destination_dedup_key_version varchar(64) NOT NULL
    CHECK (destination_dedup_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  masked_destination varchar(254) NOT NULL CHECK (
    (channel = 'PHONE' AND masked_destination ~ '^\+861[0-9]{2}[*]{4}[0-9]{4}$')
    OR (channel = 'EMAIL' AND masked_destination ~ '^[^@[:space:]]*[*]+[^@[:space:]]*@[A-Za-z0-9.-]{1,190}$')
  ),
  operation_target_hash varchar(64) CHECK (operation_target_hash ~ '^[0-9a-f]{64}$'),
  target_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  registration_flow_reference_hash varchar(64)
    CHECK (registration_flow_reference_hash ~ '^[0-9a-f]{64}$'),
  code_hash varchar(128) NOT NULL CHECK (length(code_hash) BETWEEN 32 AND 128),
  code_hash_algorithm text NOT NULL CHECK (code_hash_algorithm = 'ARGON2ID-PEPPERED'),
  code_hash_key_version varchar(64) NOT NULL
    CHECK (code_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  idempotency_key_hash varchar(64) NOT NULL UNIQUE
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  provider_request_hash varchar(64) CHECK (provider_request_hash ~ '^[0-9a-f]{64}$'),
  hash_key_version varchar(64) NOT NULL
    CHECK (hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  request_ip_hash varchar(64) NOT NULL CHECK (request_ip_hash ~ '^[0-9a-f]{64}$'),
  device_hash varchar(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  delivery_status text NOT NULL DEFAULT 'PENDING'
    CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED')),
  send_attempts smallint NOT NULL DEFAULT 0 CHECK (send_attempts BETWEEN 0 AND 5),
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  expires_at timestamptz,
  consumed_at timestamptz,
  registration_claimed_at timestamptz,
  binding_claimed_at timestamptz,
  retain_until timestamptz NOT NULL,
  CHECK (last_attempt_at IS NULL OR last_attempt_at >= created_at),
  CHECK (
    (delivery_status = 'SENT' AND sent_at IS NOT NULL AND expires_at IS NOT NULL)
    OR (delivery_status IN ('PENDING', 'FAILED') AND sent_at IS NULL AND expires_at IS NULL)
  ),
  CHECK (sent_at IS NULL OR sent_at >= created_at),
  CHECK (expires_at IS NULL OR sent_at IS NOT NULL AND expires_at > sent_at),
  CHECK (consumed_at IS NULL OR (
    delivery_status = 'SENT' AND sent_at IS NOT NULL AND expires_at IS NOT NULL
    AND consumed_at >= sent_at AND consumed_at < expires_at
  )),
  CHECK (registration_claimed_at IS NULL OR (
    purpose = 'REGISTER' AND consumed_at IS NOT NULL
    AND registration_claimed_at >= consumed_at
  )),
  CHECK (binding_claimed_at IS NULL OR (
    purpose IN ('BIND', 'RECOVERY') AND consumed_at IS NOT NULL
    AND binding_claimed_at >= consumed_at
  )),
  CHECK (expires_at IS NULL OR retain_until >= expires_at),
  CHECK (retain_until > created_at AND retain_until <= created_at + interval '24 hours'),
  CHECK (channel <> 'EMAIL' OR purpose <> 'REGISTER'),
  CHECK ((purpose = 'REGISTER') = (registration_flow_reference_hash IS NOT NULL)),
  CHECK (
    (purpose IN ('BIND', 'RECOVERY'))
      = (operation_target_hash IS NOT NULL AND target_user_id IS NOT NULL)
  )
);
CREATE INDEX otp_challenges_destination_rate_limit_idx
  ON public.otp_challenges(destination_dedup_hash, purpose, created_at DESC);
CREATE INDEX otp_challenges_ip_rate_limit_idx
  ON public.otp_challenges(request_ip_hash, created_at DESC)
  WHERE request_ip_hash IS NOT NULL;
CREATE INDEX otp_challenges_device_rate_limit_idx
  ON public.otp_challenges(device_hash, created_at DESC);
CREATE INDEX otp_challenges_expiry_idx
  ON public.otp_challenges(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX otp_challenges_retention_idx ON public.otp_challenges(retain_until);

CREATE FUNCTION public.validate_otp_challenge_insert()
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
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes' THEN
    RAISE EXCEPTION 'OTP challenges must begin in a fresh pending state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER otp_challenge_initial_state
BEFORE INSERT ON public.otp_challenges
FOR EACH ROW EXECUTE FUNCTION public.validate_otp_challenge_insert();

CREATE FUNCTION public.protect_otp_challenge_update()
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
      OLD.registration_flow_reference_hash, OLD.code_hash,
      OLD.code_hash_algorithm, OLD.code_hash_key_version,
      OLD.idempotency_key_hash, OLD.hash_key_version, OLD.request_ip_hash,
      OLD.device_hash, OLD.created_at, OLD.retain_until)
      IS DISTINCT FROM
     (NEW.id, NEW.channel, NEW.purpose, NEW.destination_hash,
      NEW.destination_hash_algorithm, NEW.destination_hash_key_version,
      NEW.destination_dedup_hash, NEW.destination_dedup_hash_algorithm,
      NEW.destination_dedup_key_version, NEW.masked_destination,
      NEW.operation_target_hash, NEW.target_user_id,
      NEW.registration_flow_reference_hash, NEW.code_hash,
      NEW.code_hash_algorithm, NEW.code_hash_key_version,
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

CREATE FUNCTION public.finalize_otp_delivery(
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
DECLARE changed_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  IF outcome NOT IN ('SENT', 'FAILED')
    OR (outcome = 'SENT' AND (
      valid_until IS NULL OR valid_until <= event_time
      OR valid_until > event_time + interval '15 minutes'
    ))
    OR (outcome = 'FAILED' AND valid_until IS NOT NULL) THEN RETURN false; END IF;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  UPDATE public.otp_challenges
    SET delivery_status = outcome,
      provider_request_hash = provider_message_hash,
      send_attempts = send_attempts + 1,
      last_attempt_at = event_time,
      sent_at = CASE WHEN outcome = 'SENT' THEN event_time ELSE NULL END,
      expires_at = CASE WHEN outcome = 'SENT' THEN valid_until ELSE NULL END
    WHERE id = challenge_id
      AND delivery_status = 'PENDING'
      AND send_attempts < 5
      AND event_time >= created_at;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.record_otp_verification_attempt(
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
  UPDATE public.otp_challenges
    SET attempts = attempts + 1,
      consumed_at = CASE WHEN verification_succeeded THEN event_time ELSE NULL END
    WHERE id = challenge_id
      AND purpose = expected_purpose
      AND target_user_id IS NOT DISTINCT FROM expected_target_user_id
      AND operation_target_hash IS NOT DISTINCT FROM expected_operation_target_hash
      AND device_hash = expected_device_hash
      AND delivery_status = 'SENT'
      AND consumed_at IS NULL
      AND expires_at > event_time
      AND event_time >= sent_at
      AND attempts < 10;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN verification_succeeded AND changed_count = 1;
END;
$$;

CREATE FUNCTION public.revoke_non_primary_identity_binding(
  p_target_binding_id uuid,
  p_target_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed_count integer;
BEGIN
  UPDATE public.identity_bindings
    SET revoked_at = now()
    WHERE id = p_target_binding_id
      AND user_id = p_target_user_id
      AND revoked_at IS NULL
      AND NOT is_primary
      AND identity_type IN ('EMAIL', 'QQ');
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.bind_email_identity_from_consumed_otp(
  p_target_user_id uuid,
  p_verified_challenge_id uuid,
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
  challenge_record record;
  existing_binding_id uuid;
  existing_user_id uuid;
  existing_revoked_at timestamptz;
  resulting_binding_id uuid;
BEGIN
  SELECT challenge.destination_hash, challenge.destination_hash_key_version,
      challenge.destination_dedup_hash, challenge.destination_dedup_key_version,
      challenge.masked_destination, challenge.consumed_at
    INTO challenge_record
    FROM public.otp_challenges AS challenge
    JOIN public.users AS account_user ON account_user.id = challenge.target_user_id
    WHERE challenge.id = p_verified_challenge_id
      AND challenge.channel = 'EMAIL'
      AND challenge.purpose = 'BIND'
      AND challenge.target_user_id = p_target_user_id
      AND challenge.operation_target_hash = p_expected_operation_target_hash
      AND challenge.device_hash = p_expected_device_hash
      AND challenge.consumed_at > event_time - interval '15 minutes'
      AND challenge.binding_claimed_at IS NULL
      AND account_user.status = 'ACTIVE'
    FOR UPDATE OF challenge, account_user;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT binding.id, binding.user_id, binding.revoked_at
    INTO existing_binding_id, existing_user_id, existing_revoked_at
    FROM public.identity_bindings AS binding
    WHERE binding.identity_type = 'EMAIL'
      AND binding.dedup_hash = challenge_record.destination_dedup_hash
    FOR UPDATE;
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
      p_target_user_id, 'EMAIL', challenge_record.destination_hash, 'HMAC-SHA256',
      challenge_record.destination_hash_key_version,
      challenge_record.destination_dedup_hash, 'HMAC-SHA256',
      challenge_record.destination_dedup_key_version,
      challenge_record.masked_destination, false, challenge_record.consumed_at
    ) RETURNING id INTO resulting_binding_id;
  ELSE
    PERFORM set_config('chi_shen_me.identity_reactivation', 'enabled', true);
    UPDATE public.identity_bindings
      SET lookup_hash = challenge_record.destination_hash,
        lookup_hash_algorithm = 'HMAC-SHA256',
        lookup_hash_key_version = challenge_record.destination_hash_key_version,
        masked_display_hint = challenge_record.masked_destination,
        verified_at = challenge_record.consumed_at,
        revoked_at = NULL
      WHERE id = existing_binding_id AND revoked_at IS NOT NULL
      RETURNING id INTO resulting_binding_id;
    PERFORM set_config('chi_shen_me.identity_reactivation', 'disabled', true);
  END IF;
  IF resulting_binding_id IS NULL THEN RETURN NULL; END IF;

  PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  UPDATE public.otp_challenges
    SET binding_claimed_at = event_time
    WHERE id = p_verified_challenge_id AND binding_claimed_at IS NULL;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN resulting_binding_id;
END;
$$;

CREATE FUNCTION public.reactivate_phone_email_identity_binding(
  p_target_binding_id uuid,
  p_target_user_id uuid,
  p_verified_challenge_id uuid,
  p_expected_operation_target_hash varchar,
  p_expected_device_hash varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed_count integer;
  proof_claim_count integer;
  event_time timestamptz := clock_timestamp();
  challenge_record record;
BEGIN
  SELECT challenge.channel, challenge.destination_hash,
      challenge.destination_hash_algorithm,
      challenge.destination_hash_key_version,
      challenge.destination_dedup_hash,
      challenge.destination_dedup_key_version,
      challenge.masked_destination,
      challenge.consumed_at
    INTO challenge_record
    FROM public.otp_challenges AS challenge
    JOIN public.users AS active_user ON active_user.id = challenge.target_user_id
    WHERE challenge.id = p_verified_challenge_id
      AND challenge.purpose IN ('BIND', 'RECOVERY')
      AND challenge.target_user_id = p_target_user_id
      AND challenge.operation_target_hash = p_expected_operation_target_hash
      AND challenge.device_hash = p_expected_device_hash
      AND challenge.consumed_at > event_time - interval '15 minutes'
      AND challenge.binding_claimed_at IS NULL
      AND active_user.status = 'ACTIVE'
    FOR UPDATE OF challenge, active_user;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM set_config('chi_shen_me.identity_reactivation', 'enabled', true);
  UPDATE public.identity_bindings
    SET lookup_hash = challenge_record.destination_hash,
      lookup_hash_algorithm = challenge_record.destination_hash_algorithm,
      lookup_hash_key_version = challenge_record.destination_hash_key_version,
      masked_display_hint = challenge_record.masked_destination,
      verified_at = challenge_record.consumed_at,
      revoked_at = NULL
    WHERE id = p_target_binding_id
      AND user_id = p_target_user_id
      AND revoked_at IS NOT NULL
      AND identity_type = challenge_record.channel
      AND dedup_hash = challenge_record.destination_dedup_hash
      AND dedup_hash_key_version = challenge_record.destination_dedup_key_version;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.identity_reactivation', 'disabled', true);
  IF changed_count <> 1 THEN RETURN false; END IF;

  PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  UPDATE public.otp_challenges
    SET binding_claimed_at = event_time
    WHERE id = p_verified_challenge_id AND binding_claimed_at IS NULL;
  GET DIAGNOSTICS proof_claim_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  IF proof_claim_count <> 1 THEN
    RAISE EXCEPTION 'identity reactivation proof claim failed';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_non_primary_identity_binding(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reactivate_phone_email_identity_binding(
  uuid, uuid, uuid, varchar, varchar
)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_email_identity_from_consumed_otp(
  uuid, uuid, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_otp_delivery(
  uuid, varchar, varchar, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_otp_verification_attempt(
  uuid, varchar, uuid, varchar, varchar, boolean
) FROM PUBLIC;

CREATE TABLE public.auth_session_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED', 'COMPROMISED')),
  device_label varchar(80) NOT NULL CHECK (
		length(device_label) BETWEEN 1 AND 80
    AND device_label = btrim(device_label)
    AND device_label !~ '[<>&[:cntrl:]]'
  ),
  platform text NOT NULL CHECK (platform IN ('ANDROID', 'IOS', 'MINIPROGRAM')),
  device_hash varchar(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  last_ip_hash varchar(64) CHECK (last_ip_hash ~ '^[0-9a-f]{64}$'),
  hash_key_version varchar(64) NOT NULL
    CHECK (hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  refresh_expires_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  compromised_at timestamptz,
  revoked_at timestamptz,
  CHECK (refresh_expires_at > created_at),
  CHECK (refresh_expires_at <= created_at + interval '30 days'),
  CHECK (retain_until >= refresh_expires_at),
  CHECK (retain_until <= refresh_expires_at + interval '30 days'),
  CHECK (last_seen_at >= created_at),
  CHECK (compromised_at IS NULL OR compromised_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (status = 'ACTIVE' AND compromised_at IS NULL AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND compromised_at IS NULL AND revoked_at IS NOT NULL)
    OR (status = 'COMPROMISED' AND compromised_at IS NOT NULL AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX auth_session_families_user_idx
  ON public.auth_session_families(user_id, last_seen_at DESC);
CREATE INDEX auth_session_families_expiry_idx
  ON public.auth_session_families(refresh_expires_at);
CREATE INDEX auth_session_families_retention_idx
  ON public.auth_session_families(retain_until);

CREATE FUNCTION public.validate_auth_session_family_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp(); user_status text;
BEGIN
  SELECT status INTO user_status FROM public.users
    WHERE id = NEW.user_id FOR SHARE;
  IF NEW.status <> 'ACTIVE' OR NEW.revoked_at IS NOT NULL
    OR NEW.compromised_at IS NOT NULL
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes'
    OR NEW.last_seen_at < NEW.created_at
    OR NEW.last_seen_at > event_time + interval '5 minutes'
    OR NEW.refresh_expires_at <= event_time
    OR user_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'session families must begin active and unexpired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_session_family_initial_state
BEFORE INSERT ON public.auth_session_families
FOR EACH ROW EXECUTE FUNCTION public.validate_auth_session_family_insert();

-- The runtime role intentionally has no UPDATE privilege on users.  This
-- trigger must nevertheless take a row lock while it verifies that a session
-- is issued only for an ACTIVE account, so execute that narrow check as the
-- migration owner instead of broadening the runtime role's table privileges.
REVOKE ALL ON FUNCTION public.validate_auth_session_family_insert() FROM PUBLIC;

CREATE FUNCTION public.protect_auth_session_family_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (OLD.id, OLD.user_id, OLD.device_label, OLD.platform, OLD.device_hash,
      OLD.hash_key_version, OLD.created_at, OLD.refresh_expires_at, OLD.retain_until)
      IS DISTINCT FROM
     (NEW.id, NEW.user_id, NEW.device_label, NEW.platform, NEW.device_hash,
      NEW.hash_key_version, NEW.created_at, NEW.refresh_expires_at, NEW.retain_until) THEN
    RAISE EXCEPTION 'session family issuance fields are immutable';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'session last-seen time cannot move backwards';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
    OLD.status = 'ACTIVE' AND NEW.status IN ('REVOKED', 'COMPROMISED')
    OR OLD.status = 'REVOKED' AND NEW.status = 'COMPROMISED'
  ) THEN
    RAISE EXCEPTION 'session family status transition is invalid';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'session revocation time is immutable';
  END IF;
  IF OLD.compromised_at IS NOT NULL
    AND NEW.compromised_at IS DISTINCT FROM OLD.compromised_at THEN
    RAISE EXCEPTION 'session compromise time is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_session_family_state_machine
BEFORE UPDATE ON public.auth_session_families
FOR EACH ROW EXECUTE FUNCTION public.protect_auth_session_family_update();

CREATE TABLE public.auth_refresh_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_family_id uuid NOT NULL
    REFERENCES public.auth_session_families(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation >= 0),
  token_hash varchar(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hash_algorithm text NOT NULL CHECK (token_hash_algorithm = 'HMAC-SHA256'),
  token_hash_key_version varchar(64) NOT NULL
    CHECK (token_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  replaced_by_id uuid REFERENCES public.auth_refresh_credentials(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  replay_detected_at timestamptz,
  UNIQUE (session_family_id, generation),
  CHECK (expires_at > issued_at),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (replay_detected_at IS NULL OR replay_detected_at >= issued_at)
);
CREATE INDEX auth_refresh_family_idx
  ON public.auth_refresh_credentials(session_family_id, generation DESC);
CREATE INDEX auth_refresh_expiry_idx ON public.auth_refresh_credentials(expires_at);

CREATE FUNCTION public.protect_auth_refresh_credential_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('chi_shen_me.refresh_state_transition', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'refresh credential changes require a restricted transition function';
  END IF;
  IF (OLD.id, OLD.session_family_id, OLD.generation, OLD.token_hash,
      OLD.token_hash_algorithm, OLD.token_hash_key_version, OLD.issued_at, OLD.expires_at)
      IS DISTINCT FROM
     (NEW.id, NEW.session_family_id, NEW.generation, NEW.token_hash,
      NEW.token_hash_algorithm, NEW.token_hash_key_version, NEW.issued_at, NEW.expires_at) THEN
    RAISE EXCEPTION 'refresh credential issuance fields are immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'refresh credential consumption is immutable';
  END IF;
  IF OLD.replaced_by_id IS NOT NULL
    AND NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id THEN
    RAISE EXCEPTION 'refresh replacement link is immutable';
  END IF;
  IF OLD.replay_detected_at IS NOT NULL
    AND NEW.replay_detected_at IS DISTINCT FROM OLD.replay_detected_at THEN
    RAISE EXCEPTION 'refresh replay evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.auth_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_family_id uuid NOT NULL
    REFERENCES public.auth_session_families(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hash_algorithm text NOT NULL CHECK (token_hash_algorithm = 'HMAC-SHA256'),
  token_hash_key_version varchar(64) NOT NULL
    CHECK (token_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '30 minutes'),
  CHECK (retain_until >= expires_at),
  CHECK (retain_until <= expires_at + interval '24 hours'),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX auth_access_family_idx ON public.auth_access_tokens(session_family_id);
CREATE INDEX auth_access_expiry_idx ON public.auth_access_tokens(expires_at);
CREATE INDEX auth_access_retention_idx ON public.auth_access_tokens(retain_until);

CREATE FUNCTION public.validate_auth_refresh_credential()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  family_expiry timestamptz;
  family_status text;
  replacement_family uuid;
  replacement_generation integer;
BEGIN
  SELECT refresh_expires_at, status INTO family_expiry, family_status
    FROM public.auth_session_families WHERE id = NEW.session_family_id
    FOR SHARE;
  IF family_expiry IS NULL OR NEW.expires_at > family_expiry THEN
    RAISE EXCEPTION 'refresh credential exceeds session family expiry';
  END IF;
  IF NEW.replay_detected_at IS NOT NULL AND family_status <> 'COMPROMISED' THEN
    RAISE EXCEPTION 'refresh replay requires a compromised session family';
  END IF;
  IF TG_OP = 'INSERT' AND (
    family_status <> 'ACTIVE' OR family_expiry <= clock_timestamp()
    OR NEW.issued_at < clock_timestamp() - interval '5 minutes'
    OR NEW.issued_at > clock_timestamp() + interval '5 minutes'
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.consumed_at IS NOT NULL OR NEW.replaced_by_id IS NOT NULL
    OR NEW.replay_detected_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'refresh credentials require a current active session family';
  END IF;
  IF NEW.replaced_by_id IS NOT NULL THEN
    IF NEW.consumed_at IS NULL THEN
      RAISE EXCEPTION 'refresh replacement requires prior consumption';
    END IF;
    SELECT session_family_id, generation
      INTO replacement_family, replacement_generation
      FROM public.auth_refresh_credentials WHERE id = NEW.replaced_by_id;
    IF replacement_family IS NULL
      OR replacement_family <> NEW.session_family_id
      OR replacement_generation <> NEW.generation + 1 THEN
      RAISE EXCEPTION 'refresh replacement must be the next generation in the same family';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_refresh_credential_invariants
BEFORE INSERT OR UPDATE ON public.auth_refresh_credentials
FOR EACH ROW EXECUTE FUNCTION public.validate_auth_refresh_credential();

CREATE TRIGGER auth_refresh_credential_state_machine
BEFORE UPDATE ON public.auth_refresh_credentials
FOR EACH ROW EXECUTE FUNCTION public.protect_auth_refresh_credential_update();

CREATE FUNCTION public.rotate_auth_refresh_credential(
  current_credential_id uuid,
  expected_session_family_id uuid,
  replacement_credential_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('chi_shen_me.refresh_state_transition', 'enabled', true);
  UPDATE public.auth_refresh_credentials AS credential
    SET consumed_at = event_time,
      replaced_by_id = replacement_credential_id
    WHERE credential.id = current_credential_id
      AND credential.session_family_id = expected_session_family_id
      AND credential.consumed_at IS NULL
      AND credential.replaced_by_id IS NULL
      AND credential.expires_at > event_time
      AND EXISTS (
        SELECT 1 FROM public.auth_session_families AS family
        WHERE family.id = expected_session_family_id
          AND family.status = 'ACTIVE'
          AND family.refresh_expires_at > event_time
      );
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.refresh_state_transition', 'disabled', true);
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.mark_auth_refresh_replay(
  target_session_family_id uuid,
  replayed_credential_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE family_count integer; credential_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  PERFORM 1 FROM public.auth_refresh_credentials
    WHERE id = replayed_credential_id
      AND session_family_id = target_session_family_id
      AND consumed_at IS NOT NULL
      AND replay_detected_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.auth_session_families
    SET status = 'COMPROMISED',
      compromised_at = COALESCE(compromised_at, event_time),
      revoked_at = COALESCE(revoked_at, event_time)
    WHERE id = target_session_family_id
      AND status IN ('ACTIVE', 'REVOKED', 'COMPROMISED');
  GET DIAGNOSTICS family_count = ROW_COUNT;
  IF family_count <> 1 THEN
    RAISE EXCEPTION 'refresh replay family transition failed';
  END IF;
  PERFORM set_config('chi_shen_me.refresh_state_transition', 'enabled', true);
  UPDATE public.auth_refresh_credentials
    SET replay_detected_at = event_time
    WHERE id = replayed_credential_id
      AND session_family_id = target_session_family_id
      AND consumed_at IS NOT NULL
      AND replay_detected_at IS NULL;
  GET DIAGNOSTICS credential_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.refresh_state_transition', 'disabled', true);
  IF credential_count <> 1 THEN
    RAISE EXCEPTION 'refresh replay evidence transition failed';
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.validate_auth_access_token()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  family_expiry timestamptz;
  family_status text;
BEGIN
  SELECT refresh_expires_at, status INTO family_expiry, family_status
    FROM public.auth_session_families WHERE id = NEW.session_family_id
    FOR SHARE;
  IF family_expiry IS NULL OR NEW.expires_at > family_expiry THEN
    RAISE EXCEPTION 'access token exceeds session family expiry';
  END IF;
  IF TG_OP = 'INSERT' AND (
    family_status <> 'ACTIVE' OR family_expiry <= clock_timestamp()
    OR NEW.issued_at < clock_timestamp() - interval '5 minutes'
    OR NEW.issued_at > clock_timestamp() + interval '5 minutes'
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'access tokens require a current active session family';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_access_token_invariants
BEFORE INSERT OR UPDATE ON public.auth_access_tokens
FOR EACH ROW EXECUTE FUNCTION public.validate_auth_access_token();

CREATE FUNCTION public.protect_auth_access_token_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (OLD.id, OLD.session_family_id, OLD.token_hash, OLD.token_hash_algorithm,
      OLD.token_hash_key_version, OLD.issued_at, OLD.expires_at, OLD.retain_until)
      IS DISTINCT FROM
     (NEW.id, NEW.session_family_id, NEW.token_hash, NEW.token_hash_algorithm,
      NEW.token_hash_key_version, NEW.issued_at, NEW.expires_at, NEW.retain_until) THEN
    RAISE EXCEPTION 'access token issuance fields are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'access token revocation is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_access_token_state_machine
BEFORE UPDATE ON public.auth_access_tokens
FOR EACH ROW EXECUTE FUNCTION public.protect_auth_access_token_update();

CREATE TABLE public.oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('WECHAT', 'QQ')),
  purpose text NOT NULL CHECK (purpose IN ('REGISTER', 'LOGIN', 'BIND')),
  state_hash varchar(64) NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  state_hash_algorithm text NOT NULL CHECK (state_hash_algorithm = 'HMAC-SHA256'),
  nonce_hash varchar(64) CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  flow_reference_hash varchar(64) NOT NULL CHECK (flow_reference_hash ~ '^[0-9a-f]{64}$'),
  operation_target_hash varchar(64) CHECK (operation_target_hash ~ '^[0-9a-f]{64}$'),
  target_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  device_hash varchar(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  pkce_verifier_ciphertext bytea,
  encryption_key_version varchar(64),
  hash_key_version varchar(64) NOT NULL
    CHECK (hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  verified_subject_lookup_hash varchar(64)
    CHECK (verified_subject_lookup_hash ~ '^[0-9a-f]{64}$'),
  verified_subject_lookup_key_version varchar(64)
    CHECK (verified_subject_lookup_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  verified_subject_dedup_hash varchar(64)
    CHECK (verified_subject_dedup_hash ~ '^[0-9a-f]{64}$'),
  verified_subject_dedup_key_version varchar(64)
    CHECK (verified_subject_dedup_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  registration_claimed_at timestamptz,
  binding_claimed_at timestamptz,
  retain_until timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '15 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at AND consumed_at < expires_at),
  CHECK (
    (consumed_at IS NULL
      AND verified_subject_lookup_hash IS NULL
      AND verified_subject_lookup_key_version IS NULL
      AND verified_subject_dedup_hash IS NULL
      AND verified_subject_dedup_key_version IS NULL)
    OR (consumed_at IS NOT NULL
      AND verified_subject_lookup_hash IS NOT NULL
      AND verified_subject_lookup_key_version IS NOT NULL
      AND verified_subject_dedup_hash IS NOT NULL
      AND verified_subject_dedup_key_version IS NOT NULL)
  ),
  CHECK (registration_claimed_at IS NULL OR (
    purpose = 'REGISTER' AND consumed_at IS NOT NULL
    AND registration_claimed_at >= consumed_at
  )),
  CHECK (binding_claimed_at IS NULL OR (
    purpose = 'BIND' AND consumed_at IS NOT NULL
    AND binding_claimed_at >= consumed_at
  )),
  CHECK (retain_until >= expires_at),
  CHECK (retain_until <= created_at + interval '24 hours'),
  CHECK ((pkce_verifier_ciphertext IS NULL) = (encryption_key_version IS NULL)),
  CHECK (pkce_verifier_ciphertext IS NULL OR octet_length(pkce_verifier_ciphertext) BETWEEN 16 AND 4096),
  CHECK (encryption_key_version IS NULL OR encryption_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  CHECK ((purpose = 'BIND') = (target_user_id IS NOT NULL)),
  CHECK (purpose <> 'BIND' OR operation_target_hash IS NOT NULL),
  CHECK (provider <> 'QQ' OR purpose <> 'REGISTER')
);
CREATE INDEX oauth_states_expiry_idx ON public.oauth_states(expires_at);
CREATE INDEX oauth_states_retention_idx ON public.oauth_states(retain_until);

CREATE FUNCTION public.validate_oauth_state_insert()
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

CREATE TRIGGER oauth_state_initial_state
BEFORE INSERT ON public.oauth_states
FOR EACH ROW EXECUTE FUNCTION public.validate_oauth_state_insert();

CREATE FUNCTION public.protect_oauth_state_update()
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
    OLD.verified_subject_dedup_key_version
  ) IS DISTINCT FROM (
    NEW.verified_subject_lookup_hash,
    NEW.verified_subject_lookup_key_version,
    NEW.verified_subject_dedup_hash,
    NEW.verified_subject_dedup_key_version
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

CREATE FUNCTION public.bind_qq_identity_from_consumed_oauth_state(
  p_target_user_id uuid,
  p_oauth_state_id uuid,
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
  resulting_binding_id uuid;
BEGIN
  SELECT oauth.consumed_at, oauth.verified_subject_lookup_hash,
      oauth.verified_subject_lookup_key_version,
      oauth.verified_subject_dedup_hash,
      oauth.verified_subject_dedup_key_version
    INTO proof_consumed_at, proof_lookup_hash, proof_lookup_key_version,
      proof_dedup_hash, proof_dedup_key_version
    FROM public.oauth_states AS oauth
    JOIN public.users AS account_user ON account_user.id = oauth.target_user_id
    WHERE oauth.id = p_oauth_state_id
      AND oauth.provider = 'QQ'
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
    WHERE binding.identity_type = 'QQ' AND binding.dedup_hash = proof_dedup_hash
    FOR UPDATE;
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
      p_target_user_id, 'QQ', proof_lookup_hash, 'HMAC-SHA256',
      proof_lookup_key_version, proof_dedup_hash, 'HMAC-SHA256',
      proof_dedup_key_version, 'QQ 账号', false, proof_consumed_at
    ) RETURNING id INTO resulting_binding_id;
  ELSE
    PERFORM set_config('chi_shen_me.identity_reactivation', 'enabled', true);
    UPDATE public.identity_bindings
      SET lookup_hash = proof_lookup_hash,
        lookup_hash_algorithm = 'HMAC-SHA256',
        lookup_hash_key_version = proof_lookup_key_version,
        masked_display_hint = 'QQ 账号',
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
END;
$$;

CREATE TRIGGER oauth_state_state_machine
BEFORE UPDATE ON public.oauth_states
FOR EACH ROW EXECUTE FUNCTION public.protect_oauth_state_update();

CREATE FUNCTION public.consume_oauth_state(
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
  verified_dedup_key_version varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  IF verified_lookup_hash !~ '^[0-9a-f]{64}$'
    OR verified_dedup_hash !~ '^[0-9a-f]{64}$'
    OR verified_lookup_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR verified_dedup_key_version !~ '^[A-Za-z0-9_.-]{1,64}$' THEN
    RETURN false;
  END IF;
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'enabled', true);
  UPDATE public.oauth_states
    SET consumed_at = event_time,
      verified_subject_lookup_hash = verified_lookup_hash,
      verified_subject_lookup_key_version = verified_lookup_key_version,
      verified_subject_dedup_hash = verified_dedup_hash,
      verified_subject_dedup_key_version = verified_dedup_key_version
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

CREATE FUNCTION public.claim_phone_wechat_registration_flow(
  p_otp_challenge_id uuid,
  p_oauth_state_id uuid,
  p_expected_flow_reference_hash varchar,
  p_expected_device_hash varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp(); otp_found boolean; oauth_found boolean;
BEGIN
  SELECT true INTO otp_found FROM public.otp_challenges AS otp
    WHERE otp.id = p_otp_challenge_id
      AND otp.channel = 'PHONE' AND otp.purpose = 'REGISTER'
      AND otp.registration_flow_reference_hash = p_expected_flow_reference_hash
      AND otp.device_hash = p_expected_device_hash
      AND otp.consumed_at > event_time - interval '15 minutes'
      AND otp.registration_claimed_at IS NULL
    FOR UPDATE;
  SELECT true INTO oauth_found FROM public.oauth_states AS oauth
    WHERE oauth.id = p_oauth_state_id
      AND oauth.provider = 'WECHAT' AND oauth.purpose = 'REGISTER'
      AND oauth.flow_reference_hash = p_expected_flow_reference_hash
      AND oauth.device_hash = p_expected_device_hash
      AND oauth.consumed_at > event_time - interval '15 minutes'
      AND oauth.registration_claimed_at IS NULL
    FOR UPDATE;
  IF otp_found IS DISTINCT FROM true OR oauth_found IS DISTINCT FROM true THEN
    RETURN false;
  END IF;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'enabled', true);
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'enabled', true);
  UPDATE public.otp_challenges SET registration_claimed_at = event_time
    WHERE id = p_otp_challenge_id AND registration_claimed_at IS NULL;
  UPDATE public.oauth_states SET registration_claimed_at = event_time
    WHERE id = p_oauth_state_id AND registration_claimed_at IS NULL;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  PERFORM set_config('chi_shen_me.oauth_state_transition', 'disabled', true);
  RETURN true;
END;
$$;

CREATE FUNCTION public.register_phone_wechat_account(
  p_user_id uuid,
  p_otp_challenge_id uuid,
  p_oauth_state_id uuid,
  p_registration_flow_hash varchar,
  p_device_hash varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE proof_claimed boolean;
BEGIN
  SELECT public.claim_phone_wechat_registration_flow(
    p_otp_challenge_id, p_oauth_state_id,
    p_registration_flow_hash, p_device_hash
  ) INTO proof_claimed;
  IF proof_claimed IS DISTINCT FROM true THEN RETURN false; END IF;
  INSERT INTO public.users (id) VALUES (p_user_id);
  INSERT INTO public.identity_bindings (
    user_id, identity_type, lookup_hash, lookup_hash_algorithm,
    lookup_hash_key_version, dedup_hash, dedup_hash_algorithm,
    dedup_hash_key_version, masked_display_hint, is_primary, verified_at
  )
  SELECT p_user_id, 'PHONE', otp.destination_hash, 'HMAC-SHA256',
    otp.destination_hash_key_version, otp.destination_dedup_hash,
    'HMAC-SHA256', otp.destination_dedup_key_version,
    otp.masked_destination, true, otp.consumed_at
  FROM public.otp_challenges AS otp WHERE otp.id = p_otp_challenge_id;
  INSERT INTO public.identity_bindings (
    user_id, identity_type, lookup_hash, lookup_hash_algorithm,
    lookup_hash_key_version, dedup_hash, dedup_hash_algorithm,
    dedup_hash_key_version, masked_display_hint, is_primary, verified_at
  )
  SELECT p_user_id, 'WECHAT', oauth.verified_subject_lookup_hash, 'HMAC-SHA256',
    oauth.verified_subject_lookup_key_version,
    oauth.verified_subject_dedup_hash, 'HMAC-SHA256',
    oauth.verified_subject_dedup_key_version,
    '微信账号', false, oauth.consumed_at
  FROM public.oauth_states AS oauth WHERE oauth.id = p_oauth_state_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_auth_refresh_credential(
  uuid, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_auth_refresh_replay(
  uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_oauth_state(
  uuid, varchar, varchar, varchar, varchar, uuid, varchar,
  varchar, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_qq_identity_from_consumed_oauth_state(
  uuid, uuid, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_phone_wechat_registration_flow(
  uuid, uuid, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_phone_wechat_account(
  uuid, uuid, uuid, varchar, varchar
) FROM PUBLIC;

-- The row below is an engineering record of an authorization review, not proof
-- that a legal grant exists. Production activation also requires the externally
-- controlled contract/evidence workflow documented in the release gate.
CREATE TABLE public.data_rights_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(32) NOT NULL
    CHECK (provider_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  authorization_reference_hash varchar(64) NOT NULL UNIQUE
    CHECK (authorization_reference_hash ~ '^[0-9a-f]{64}$'),
  reference_hash_algorithm text NOT NULL CHECK (reference_hash_algorithm = 'HMAC-SHA256'),
  reference_hash_key_version varchar(64) NOT NULL
    CHECK (reference_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  evidence_locator_ciphertext bytea NOT NULL
    CHECK (octet_length(evidence_locator_ciphertext) BETWEEN 16 AND 4096),
  encryption_key_version varchar(64) NOT NULL
    CHECK (encryption_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reviewed_by_admin_user_hash varchar(64) NOT NULL
    CHECK (reviewed_by_admin_user_hash ~ '^[0-9a-f]{64}$'),
  reviewer_hash_key_version varchar(64) NOT NULL
    CHECK (reviewer_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, provider_code),
  CHECK (expires_at > effective_at),
  CHECK (revoked_at IS NULL OR revoked_at >= effective_at)
);
CREATE INDEX data_rights_authorizations_active_idx
  ON public.data_rights_authorizations(provider_code, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE public.data_rights_authorization_operations (
  authorization_id uuid NOT NULL
    REFERENCES public.data_rights_authorizations(id) ON DELETE CASCADE,
  operation_code text NOT NULL CHECK (operation_code IN (
    'DISPLAY_LIVE_RESULT', 'RESORT_LIVE_RESULT', 'PERSIST_PLACE_REFERENCE',
    'MODEL_PROCESS_PLACE_DATA', 'DISPLAY_OWN_SUITABILITY'
  )),
  PRIMARY KEY (authorization_id, operation_code)
);

CREATE FUNCTION public.data_rights_authorization_allows(
  p_authorization_id uuid,
  p_provider_code varchar,
  p_operation_code text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_operation_code IN (
      'DISPLAY_LIVE_RESULT', 'RESORT_LIVE_RESULT', 'PERSIST_PLACE_REFERENCE',
      'MODEL_PROCESS_PLACE_DATA', 'DISPLAY_OWN_SUITABILITY'
    )
    AND EXISTS (
      SELECT 1
      FROM public.data_rights_authorizations AS rights_authorization
      JOIN public.data_rights_authorization_operations AS operation
        ON operation.authorization_id = rights_authorization.id
      WHERE rights_authorization.id = p_authorization_id
        AND p_provider_code IS NOT NULL
        AND rights_authorization.provider_code = p_provider_code
        AND rights_authorization.effective_at <= now()
        AND rights_authorization.expires_at > now()
        AND rights_authorization.revoked_at IS NULL
        AND operation.operation_code = p_operation_code
    );
$$;

REVOKE ALL ON FUNCTION public.data_rights_authorization_allows(
  uuid, varchar, text
) FROM PUBLIC;

-- A provider reference is persistable only through an active authorization row
-- with PERSIST_PLACE_REFERENCE. LIVE_DISPLAY_ONLY cannot satisfy these constraints.
CREATE TABLE public.external_place_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(32) NOT NULL
    CHECK (provider_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  provider_place_id varchar(256) NOT NULL
    CHECK (length(provider_place_id) BETWEEN 1 AND 256),
  rights_mode text NOT NULL CHECK (rights_mode = 'LICENSED_ENRICHMENT'),
  authorization_id uuid NOT NULL,
  referenced_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  FOREIGN KEY (authorization_id, provider_code)
    REFERENCES public.data_rights_authorizations(id, provider_code) ON DELETE RESTRICT,
  CHECK (retain_until > referenced_at),
  UNIQUE (provider_code, provider_place_id, authorization_id)
);
CREATE INDEX external_place_references_expiry_idx
  ON public.external_place_references(retain_until);

CREATE FUNCTION public.validate_external_place_reference_rights()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authorization_effective timestamptz;
  authorization_expiry timestamptz;
  authorization_revoked timestamptz;
  persist_granted boolean := false;
BEGIN
  SELECT effective_at, expires_at, revoked_at
    INTO authorization_effective, authorization_expiry, authorization_revoked
    FROM public.data_rights_authorizations
    WHERE id = NEW.authorization_id AND provider_code = NEW.provider_code
    FOR SHARE;
  SELECT true INTO persist_granted
    FROM public.data_rights_authorization_operations
    WHERE authorization_id = NEW.authorization_id
      AND operation_code = 'PERSIST_PLACE_REFERENCE'
    FOR SHARE;
  IF authorization_effective IS NULL
    OR authorization_effective > NEW.referenced_at
    OR authorization_effective > now()
    OR authorization_expiry <= NEW.referenced_at
    OR authorization_expiry <= now()
    OR authorization_revoked IS NOT NULL
    OR persist_granted IS DISTINCT FROM true
    OR NEW.retain_until <= now()
    OR NEW.retain_until > authorization_expiry THEN
    RAISE EXCEPTION 'external place reference lacks an active persistence grant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_place_reference_rights
BEFORE INSERT OR UPDATE ON public.external_place_references
FOR EACH ROW EXECUTE FUNCTION public.validate_external_place_reference_rights();

CREATE VIEW public.active_external_place_references
WITH (security_barrier = true)
AS
SELECT reference.id, reference.provider_code, reference.provider_place_id,
  reference.authorization_id, reference.referenced_at, reference.retain_until
FROM public.external_place_references AS reference
JOIN public.data_rights_authorizations AS rights_authorization
  ON rights_authorization.id = reference.authorization_id
JOIN public.data_rights_authorization_operations AS operation
  ON operation.authorization_id = rights_authorization.id
  AND operation.operation_code = 'PERSIST_PLACE_REFERENCE'
WHERE reference.rights_mode = 'LICENSED_ENRICHMENT'
  AND rights_authorization.effective_at <= now()
  AND rights_authorization.expires_at > now()
  AND rights_authorization.revoked_at IS NULL
  AND reference.retain_until > now();

CREATE TABLE public.favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  external_place_reference_id uuid NOT NULL
    REFERENCES public.external_place_references(id) ON DELETE RESTRICT,
  favorite_group text NOT NULL DEFAULT 'WANT_TO_GO'
    CHECK (favorite_group IN ('WANT_TO_GO', 'REGULAR')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, external_place_reference_id)
);
CREATE INDEX favorites_user_created_idx ON public.favorites(user_id, created_at DESC);

CREATE FUNCTION public.require_fresh_created_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes' THEN
    RAISE EXCEPTION 'event creation time must use database time';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER favorites_fresh_created_at
BEFORE INSERT ON public.favorites
FOR EACH ROW EXECUTE FUNCTION public.require_fresh_created_at();

CREATE VIEW public.active_favorites
WITH (security_barrier = true)
AS
SELECT favorite.id, favorite.user_id, favorite.favorite_group, favorite.created_at,
  reference.id AS external_place_reference_id,
  reference.provider_code, reference.provider_place_id
FROM public.favorites AS favorite
JOIN public.active_external_place_references AS reference
  ON reference.id = favorite.external_place_reference_id;

CREATE TABLE public.recommendation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  external_place_reference_id uuid
    REFERENCES public.external_place_references(id) ON DELETE SET NULL,
  request_correlation_hash varchar(64) NOT NULL
    CHECK (request_correlation_hash ~ '^[0-9a-f]{64}$'),
  hash_key_version varchar(64) NOT NULL
    CHECK (hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  event_type text NOT NULL
    CHECK (event_type IN ('IMPRESSION', 'DETAIL', 'FAVORITE', 'NAVIGATION', 'CALL', 'REROLL')),
  meal_period text NOT NULL CHECK (meal_period IN ('BREAKFAST', 'LUNCH', 'DINNER')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  CHECK (retain_until = occurred_at + interval '90 days')
);
CREATE INDEX recommendation_history_user_time_idx
  ON public.recommendation_history(user_id, occurred_at DESC);
CREATE INDEX recommendation_history_retention_idx
  ON public.recommendation_history(retain_until);

CREATE FUNCTION public.require_fresh_recommendation_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.occurred_at < event_time - interval '5 minutes'
    OR NEW.occurred_at > event_time + interval '5 minutes'
    OR NEW.retain_until > event_time + interval '90 days 5 minutes' THEN
    RAISE EXCEPTION 'recommendation history time must use database time';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recommendation_history_fresh_event
BEFORE INSERT ON public.recommendation_history
FOR EACH ROW EXECUTE FUNCTION public.require_fresh_recommendation_event();

CREATE VIEW public.recommendation_history_active_places
WITH (security_barrier = true)
AS
SELECT history.id, history.user_id, history.request_correlation_hash,
  history.event_type, history.meal_period, history.occurred_at, history.retain_until,
  reference.provider_code, reference.provider_place_id
FROM public.recommendation_history AS history
LEFT JOIN public.active_external_place_references AS reference
  ON reference.id = history.external_place_reference_id;

CREATE TABLE public.private_recommendation_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  external_place_reference_id uuid
    REFERENCES public.external_place_references(id) ON DELETE SET NULL,
  request_correlation_hash varchar(64) NOT NULL
    CHECK (request_correlation_hash ~ '^[0-9a-f]{64}$'),
  hash_key_version varchar(64) NOT NULL
    CHECK (hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  feedback_type text NOT NULL CHECK (feedback_type IN (
    'WANT_TO_EAT', 'ATE', 'LIKE', 'DISLIKE', 'TOO_FAR', 'TOO_EXPENSIVE',
    'ATE_RECENTLY', 'EXCLUDE_CUISINE'
  )),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX private_feedback_user_time_idx
  ON public.private_recommendation_feedback(user_id, created_at DESC);

CREATE TRIGGER private_feedback_fresh_created_at
BEFORE INSERT ON public.private_recommendation_feedback
FOR EACH ROW EXECUTE FUNCTION public.require_fresh_created_at();

CREATE FUNCTION public.require_active_external_place_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  reference_expiry timestamptz;
  event_time timestamptz;
BEGIN
  IF NEW.external_place_reference_id IS NULL THEN
    RETURN NEW;
  END IF;
  event_time := COALESCE(
    (to_jsonb(NEW) ->> 'occurred_at')::timestamptz,
    (to_jsonb(NEW) ->> 'created_at')::timestamptz,
    now()
  );
  SELECT LEAST(reference.retain_until, rights_authorization.expires_at)
    INTO reference_expiry
    FROM public.external_place_references AS reference
    JOIN public.data_rights_authorizations AS rights_authorization
      ON rights_authorization.id = reference.authorization_id
    JOIN public.data_rights_authorization_operations AS operation
      ON operation.authorization_id = rights_authorization.id
      AND operation.operation_code = 'PERSIST_PLACE_REFERENCE'
    WHERE reference.id = NEW.external_place_reference_id
      AND reference.rights_mode = 'LICENSED_ENRICHMENT'
      AND rights_authorization.effective_at <= event_time
      AND rights_authorization.expires_at > event_time
      AND rights_authorization.effective_at <= now()
      AND rights_authorization.expires_at > now()
      AND reference.retain_until > now()
      AND rights_authorization.revoked_at IS NULL;
  IF reference_expiry IS NULL OR reference_expiry <= event_time THEN
    RAISE EXCEPTION 'external place reference authorization is not active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER favorites_require_active_rights
BEFORE INSERT OR UPDATE
ON public.favorites
FOR EACH ROW EXECUTE FUNCTION public.require_active_external_place_reference();

CREATE TRIGGER history_require_active_rights
BEFORE INSERT OR UPDATE
ON public.recommendation_history
FOR EACH ROW EXECUTE FUNCTION public.require_active_external_place_reference();

CREATE TRIGGER feedback_require_active_rights
BEFORE INSERT OR UPDATE
ON public.private_recommendation_feedback
FOR EACH ROW EXECUTE FUNCTION public.require_active_external_place_reference();

CREATE TABLE public.support_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('PRODUCT', 'PLACE_CORRECTION', 'PRIVACY', 'COMPLAINT')),
  content_ciphertext bytea NOT NULL CHECK (octet_length(content_ciphertext) BETWEEN 16 AND 65536),
  encryption_key_version varchar(64) NOT NULL CHECK (length(encryption_key_version) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_REVIEW', 'CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  retain_until timestamptz,
  CHECK ((closed_at IS NULL AND retain_until IS NULL) OR (
    closed_at IS NOT NULL AND retain_until IS NOT NULL
    AND closed_at >= created_at
    AND retain_until = closed_at + interval '180 days'
  )),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE INDEX support_feedback_status_idx ON public.support_feedback(status, created_at);
CREATE INDEX support_feedback_retention_idx
  ON public.support_feedback(retain_until) WHERE retain_until IS NOT NULL;

CREATE FUNCTION public.validate_support_feedback_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.status <> 'OPEN' OR NEW.closed_at IS NOT NULL OR NEW.retain_until IS NOT NULL
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes' THEN
    RAISE EXCEPTION 'support feedback must begin open';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER support_feedback_initial_state
BEFORE INSERT ON public.support_feedback
FOR EACH ROW EXECUTE FUNCTION public.validate_support_feedback_insert();

CREATE FUNCTION public.protect_support_feedback_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF (OLD.id, OLD.category, OLD.content_ciphertext, OLD.encryption_key_version,
      OLD.created_at) IS DISTINCT FROM
     (NEW.id, NEW.category, NEW.content_ciphertext, NEW.encryption_key_version,
      NEW.created_at) THEN
    RAISE EXCEPTION 'support feedback issuance fields are immutable';
  END IF;
  IF OLD.user_id IS NULL AND NEW.user_id IS NOT NULL
    OR OLD.user_id IS NOT NULL AND NEW.user_id IS NOT NULL
      AND OLD.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'support feedback ownership cannot be reassigned';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
    OLD.status = 'OPEN' AND NEW.status IN ('IN_REVIEW', 'CLOSED')
    OR OLD.status = 'IN_REVIEW' AND NEW.status = 'CLOSED'
  ) THEN
    RAISE EXCEPTION 'support feedback status transition is invalid';
  END IF;
  IF OLD.closed_at IS NOT NULL AND (
    NEW.closed_at IS DISTINCT FROM OLD.closed_at
    OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
  ) THEN RAISE EXCEPTION 'closed support feedback is terminal'; END IF;
  IF OLD.status <> 'CLOSED' AND NEW.status = 'CLOSED'
    AND (NEW.closed_at < event_time - interval '5 minutes'
      OR NEW.closed_at > event_time + interval '5 minutes') THEN
    RAISE EXCEPTION 'support feedback close time must use database time';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER support_feedback_state_machine
BEFORE UPDATE ON public.support_feedback
FOR EACH ROW EXECUTE FUNCTION public.protect_support_feedback_update();

CREATE TABLE public.data_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED')),
  artifact_locator_ciphertext bytea,
  encryption_key_version varchar(64),
  artifact_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = created_at + interval '7 days'),
  CHECK ((artifact_locator_ciphertext IS NULL) = (encryption_key_version IS NULL)),
  CHECK (artifact_locator_ciphertext IS NULL OR octet_length(artifact_locator_ciphertext) BETWEEN 16 AND 4096),
  CHECK (encryption_key_version IS NULL OR encryption_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  CHECK (status <> 'READY' OR artifact_locator_ciphertext IS NOT NULL),
  CHECK (artifact_deleted_at IS NULL OR artifact_deleted_at >= created_at),
  CHECK (
    (status IN ('READY', 'FAILED', 'EXPIRED') AND completed_at IS NOT NULL)
    OR (status IN ('PENDING', 'PROCESSING') AND completed_at IS NULL)
  )
);
CREATE INDEX data_export_jobs_user_idx ON public.data_export_jobs(user_id, created_at DESC);
CREATE INDEX data_export_jobs_expiry_idx ON public.data_export_jobs(expires_at);

CREATE FUNCTION public.validate_data_export_job_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.status <> 'PENDING' OR NEW.artifact_locator_ciphertext IS NOT NULL
    OR NEW.encryption_key_version IS NOT NULL OR NEW.artifact_deleted_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes' THEN
    RAISE EXCEPTION 'data export jobs must begin pending';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER data_export_job_initial_state
BEFORE INSERT ON public.data_export_jobs
FOR EACH ROW EXECUTE FUNCTION public.validate_data_export_job_insert();

CREATE FUNCTION public.protect_data_export_job_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF (OLD.id, OLD.user_id, OLD.created_at, OLD.expires_at)
      IS DISTINCT FROM (NEW.id, NEW.user_id, NEW.created_at, NEW.expires_at) THEN
    RAISE EXCEPTION 'data export job issuance fields are immutable';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
    OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'FAILED')
    OR OLD.status = 'PROCESSING' AND NEW.status IN ('READY', 'FAILED')
    OR OLD.status = 'READY' AND NEW.status = 'EXPIRED'
  ) THEN RAISE EXCEPTION 'data export status transition is invalid'; END IF;
  IF OLD.artifact_locator_ciphertext IS NOT NULL AND (
    NEW.artifact_locator_ciphertext IS DISTINCT FROM OLD.artifact_locator_ciphertext
    OR NEW.encryption_key_version IS DISTINCT FROM OLD.encryption_key_version
  ) THEN RAISE EXCEPTION 'export artifact locator is immutable'; END IF;
  IF OLD.artifact_locator_ciphertext IS NULL
    AND NEW.artifact_locator_ciphertext IS NOT NULL
    AND NEW.status <> 'READY' THEN
    RAISE EXCEPTION 'export artifact can be attached only when becoming ready';
  END IF;
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'export completion time is immutable';
  END IF;
  IF OLD.artifact_deleted_at IS NOT NULL
    AND NEW.artifact_deleted_at IS DISTINCT FROM OLD.artifact_deleted_at THEN
    RAISE EXCEPTION 'export artifact deletion time is immutable';
  END IF;
  IF NEW.completed_at IS NOT NULL AND (
    NEW.completed_at < event_time - interval '5 minutes'
    OR NEW.completed_at > event_time + interval '5 minutes'
  ) AND OLD.completed_at IS NULL THEN
    RAISE EXCEPTION 'export completion must use database time';
  END IF;
  IF NEW.artifact_deleted_at IS NOT NULL AND (
    NEW.artifact_deleted_at < event_time - interval '5 minutes'
    OR NEW.artifact_deleted_at > event_time + interval '5 minutes'
  ) AND OLD.artifact_deleted_at IS NULL THEN
    RAISE EXCEPTION 'artifact deletion must use database time';
  END IF;
  IF OLD.artifact_deleted_at IS NULL AND NEW.artifact_deleted_at IS NOT NULL
    AND NEW.status <> 'EXPIRED' THEN
    RAISE EXCEPTION 'artifact deletion requires an expired export job';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER data_export_job_state_machine
BEFORE UPDATE ON public.data_export_jobs
FOR EACH ROW EXECUTE FUNCTION public.protect_data_export_job_update();

CREATE TABLE public.account_deletion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  subject_hash varchar(64) NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  subject_hash_algorithm text NOT NULL CHECK (subject_hash_algorithm = 'HMAC-SHA256'),
  subject_hash_key_version varchar(64) NOT NULL
    CHECK (subject_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  purge_due_at timestamptz NOT NULL,
  completed_at timestamptz,
  retain_until timestamptz,
  CHECK (purge_due_at > requested_at),
  CHECK (purge_due_at <= requested_at + interval '30 days'),
  CHECK (completed_at IS NULL OR completed_at >= requested_at),
  CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL AND retain_until IS NOT NULL
      AND retain_until = completed_at + interval '30 days')
    OR (status <> 'COMPLETED' AND completed_at IS NULL AND retain_until IS NULL)
  )
);
CREATE INDEX account_deletion_jobs_status_idx
  ON public.account_deletion_jobs(status, purge_due_at);
CREATE INDEX account_deletion_jobs_retention_idx
  ON public.account_deletion_jobs(retain_until) WHERE retain_until IS NOT NULL;

CREATE FUNCTION public.validate_account_deletion_job_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF NEW.user_id IS NULL OR NEW.status <> 'PENDING'
    OR NEW.completed_at IS NOT NULL OR NEW.retain_until IS NOT NULL
    OR NEW.requested_at < event_time - interval '5 minutes'
    OR NEW.requested_at > event_time + interval '5 minutes'
    OR NEW.purge_due_at <= event_time THEN
    RAISE EXCEPTION 'account deletion jobs must begin pending for an active subject';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_deletion_job_initial_state
BEFORE INSERT ON public.account_deletion_jobs
FOR EACH ROW EXECUTE FUNCTION public.validate_account_deletion_job_insert();

CREATE FUNCTION public.protect_account_deletion_job_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF (OLD.id, OLD.subject_hash, OLD.subject_hash_algorithm,
      OLD.subject_hash_key_version, OLD.requested_at, OLD.purge_due_at)
      IS DISTINCT FROM
     (NEW.id, NEW.subject_hash, NEW.subject_hash_algorithm,
      NEW.subject_hash_key_version, NEW.requested_at, NEW.purge_due_at) THEN
    RAISE EXCEPTION 'account deletion job issuance fields are immutable';
  END IF;
  IF OLD.user_id IS NULL AND NEW.user_id IS NOT NULL
    OR OLD.user_id IS NOT NULL AND NEW.user_id IS NOT NULL
      AND OLD.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'account deletion subject cannot be reassigned';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
    OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'FAILED')
    OR OLD.status = 'PROCESSING' AND NEW.status IN ('COMPLETED', 'FAILED')
    OR OLD.status = 'FAILED' AND NEW.status = 'PROCESSING'
  ) THEN RAISE EXCEPTION 'account deletion status transition is invalid'; END IF;
  IF OLD.completed_at IS NOT NULL AND (
    NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
  ) THEN RAISE EXCEPTION 'completed account deletion is terminal'; END IF;
  IF OLD.status <> 'COMPLETED' AND NEW.status = 'COMPLETED'
    AND (NEW.completed_at < event_time - interval '5 minutes'
      OR NEW.completed_at > event_time + interval '5 minutes') THEN
    RAISE EXCEPTION 'account deletion completion must use database time';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_deletion_job_state_machine
BEFORE UPDATE ON public.account_deletion_jobs
FOR EACH ROW EXECUTE FUNCTION public.protect_account_deletion_job_update();

CREATE FUNCTION public.begin_account_deletion(
  p_user_id uuid,
  p_job_id uuid,
  p_subject_hash varchar,
  p_subject_hash_key_version varchar,
  p_purge_due_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE current_status text; event_time timestamptz := clock_timestamp();
BEGIN
  SELECT status INTO current_status FROM public.users
    WHERE id = p_user_id FOR UPDATE;
  IF current_status NOT IN ('ACTIVE', 'LOCKED')
    OR p_purge_due_at <= event_time
    OR p_purge_due_at > event_time + interval '30 days' THEN RETURN false; END IF;
  PERFORM set_config('chi_shen_me.account_deletion_transition', 'enabled', true);
  UPDATE public.users SET status = 'DELETION_PENDING', updated_at = event_time,
    disabled_at = event_time WHERE id = p_user_id;
  INSERT INTO public.account_deletion_jobs (
    id, user_id, subject_hash, subject_hash_algorithm,
    subject_hash_key_version, requested_at, purge_due_at
  ) VALUES (
    p_job_id, p_user_id, p_subject_hash, 'HMAC-SHA256',
    p_subject_hash_key_version, event_time, p_purge_due_at
  );
  UPDATE public.auth_session_families
    SET status = 'REVOKED', revoked_at = event_time
    WHERE user_id = p_user_id AND status = 'ACTIVE';
  UPDATE public.auth_access_tokens AS access_token
    SET revoked_at = event_time
    FROM public.auth_session_families AS family
    WHERE access_token.session_family_id = family.id
      AND family.user_id = p_user_id
      AND access_token.revoked_at IS NULL;
  PERFORM set_config('chi_shen_me.account_deletion_transition', 'disabled', true);
  RETURN true;
END;
$$;

CREATE FUNCTION public.lock_user_account(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer;
BEGIN
  UPDATE public.users SET status = 'LOCKED', updated_at = clock_timestamp()
    WHERE id = p_user_id AND status = 'ACTIVE';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.unlock_user_account(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer;
BEGIN
  UPDATE public.users SET status = 'ACTIVE', updated_at = clock_timestamp()
    WHERE id = p_user_id AND status = 'LOCKED';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END;
$$;

CREATE FUNCTION public.complete_account_deletion(
  p_job_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed_count integer; event_time timestamptz := clock_timestamp();
BEGIN
  PERFORM 1
    FROM public.account_deletion_jobs AS deletion_job
    JOIN public.users AS account_user ON account_user.id = deletion_job.user_id
    WHERE deletion_job.id = p_job_id
      AND deletion_job.user_id = p_user_id
      AND deletion_job.status IN ('PENDING', 'PROCESSING', 'FAILED')
      AND account_user.status = 'DELETION_PENDING'
    FOR UPDATE OF deletion_job, account_user;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.data_export_jobs
    WHERE user_id = p_user_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.data_export_jobs
    WHERE user_id = p_user_id
      AND artifact_locator_ciphertext IS NOT NULL
      AND artifact_deleted_at IS NULL
  ) THEN RETURN false; END IF;
  UPDATE public.account_deletion_jobs SET status = 'PROCESSING'
    WHERE id = p_job_id AND status IN ('PENDING', 'FAILED');
  DELETE FROM public.users WHERE id = p_user_id AND status = 'DELETION_PENDING';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 1 THEN RAISE EXCEPTION 'account subject purge failed'; END IF;
  UPDATE public.account_deletion_jobs
    SET status = 'COMPLETED', completed_at = event_time,
      retain_until = event_time + interval '30 days'
    WHERE id = p_job_id AND user_id IS NULL AND status = 'PROCESSING';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 1 THEN RAISE EXCEPTION 'account deletion tombstone failed'; END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_account_deletion(
  uuid, uuid, varchar, varchar, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_user_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unlock_user_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_account_deletion(uuid, uuid) FROM PUBLIC;

CREATE TABLE public.admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_lookup_hash varchar(64) NOT NULL UNIQUE
    CHECK (login_lookup_hash ~ '^[0-9a-f]{64}$'),
  login_hash_algorithm text NOT NULL CHECK (login_hash_algorithm = 'HMAC-SHA256'),
  login_hash_key_version varchar(64) NOT NULL
    CHECK (login_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE public.admin_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code varchar(64) NOT NULL UNIQUE CHECK (role_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_user_roles (
  admin_user_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.admin_roles(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (admin_user_id, role_id),
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);

-- WebAuthn public keys provide MFA without storing a recoverable TOTP secret.
CREATE TABLE public.admin_mfa_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
  credential_id_hash varchar(64) NOT NULL UNIQUE
    CHECK (credential_id_hash ~ '^[0-9a-f]{64}$'),
  credential_hash_algorithm text NOT NULL CHECK (credential_hash_algorithm = 'HMAC-SHA256'),
  credential_hash_key_version varchar(64) NOT NULL
    CHECK (credential_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 32 AND 4096),
  signature_counter bigint NOT NULL DEFAULT 0 CHECK (signature_counter >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX admin_mfa_user_idx ON public.admin_mfa_credentials(admin_user_id);

CREATE TABLE public.app_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key varchar(120) NOT NULL CHECK (config_key ~ '^[a-z][a-z0-9_.-]{1,119}$'),
  version integer NOT NULL CHECK (version > 0),
  value_json jsonb NOT NULL,
  config_schema text NOT NULL CHECK (config_schema IN (
    'FEATURE_FLAGS_V1', 'RECOMMENDATION_RULES_V1', 'PROMPT_SETTINGS_V1',
    'COVERAGE_SETTINGS_V1', 'MINIMUM_APP_VERSION_V1'
  )),
  classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL')),
  created_by_admin_user_id uuid NOT NULL
    REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  UNIQUE (config_key, version),
  CHECK (public.app_config_value_is_valid(config_schema, value_json)),
  CHECK (pg_column_size(value_json) <= 32768),
  CHECK (activated_at IS NULL OR activated_at >= created_at),
  CHECK (retired_at IS NULL OR activated_at IS NOT NULL AND retired_at >= activated_at)
);
CREATE UNIQUE INDEX app_config_one_active_idx
  ON public.app_config_versions(config_key) WHERE activated_at IS NOT NULL AND retired_at IS NULL;

-- This geometry stores a generalized product service boundary only. It is not a
-- user position, visit trace, route, or recommendation request location.
CREATE TABLE public.coverage_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_code varchar(64) NOT NULL UNIQUE CHECK (area_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  display_name varchar(120) NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  boundary geometry(MultiPolygon, 4326) NOT NULL,
  precision_class text NOT NULL CHECK (precision_class = 'GENERALIZED_SERVICE_BOUNDARY'),
  source_reference varchar(240) NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 240),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  CHECK (ST_IsValid(boundary)),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX coverage_areas_boundary_gist ON public.coverage_areas USING gist(boundary);

CREATE TABLE public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_admin_user_hash varchar(64) NOT NULL
    CHECK (actor_admin_user_hash ~ '^[0-9a-f]{64}$'),
  hash_key_version varchar(64) NOT NULL
    CHECK (hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  action_type varchar(120) NOT NULL CHECK (action_type ~ '^[A-Z][A-Z0-9_]{1,119}$'),
  target_type varchar(120) NOT NULL CHECK (target_type ~ '^[A-Z][A-Z0-9_]{1,119}$'),
  target_id_hash varchar(64) CHECK (target_id_hash ~ '^[0-9a-f]{64}$'),
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (public.audit_context_is_valid(action_type, context_json)),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  CHECK (retain_until > occurred_at),
  CHECK (retain_until <= occurred_at + interval '180 days'),
  CHECK (pg_column_size(context_json) <= 8192)
);
CREATE INDEX admin_audit_time_idx ON public.admin_audit_log(occurred_at DESC);
CREATE INDEX admin_audit_retention_idx ON public.admin_audit_log(retain_until);

CREATE FUNCTION public.reject_admin_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('chi_shen_me.audit_retention_purge', true) = 'enabled'
      AND OLD.retain_until <= now() THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'admin audit records are append-only';
END;
$$;

CREATE TRIGGER admin_audit_append_only
BEFORE UPDATE OR DELETE ON public.admin_audit_log
FOR EACH ROW EXECUTE FUNCTION public.reject_admin_audit_mutation();

CREATE TRIGGER admin_audit_forbid_truncate
BEFORE TRUNCATE ON public.admin_audit_log
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_admin_audit_mutation();

CREATE FUNCTION public.append_admin_audit_event(
  actor_hash varchar,
  event_hash_key_version varchar,
  event_action varchar,
  event_target_type varchar,
  event_target_hash varchar,
  event_context jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_id uuid;
  event_time timestamptz := now();
BEGIN
  INSERT INTO public.admin_audit_log (
    actor_admin_user_hash,
    hash_key_version,
    action_type,
    target_type,
    target_id_hash,
    context_json,
    occurred_at,
    retain_until
  ) VALUES (
    actor_hash,
    event_hash_key_version,
    event_action,
    event_target_type,
    event_target_hash,
    COALESCE(event_context, '{}'::jsonb),
    event_time,
    event_time + interval '180 days'
  ) RETURNING id INTO inserted_id;
  RETURN inserted_id;
END;
$$;

CREATE FUNCTION public.purge_expired_admin_audit_events()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count bigint;
  event_time timestamptz := now();
BEGIN
  PERFORM set_config('chi_shen_me.audit_retention_purge', 'enabled', true);
  DELETE FROM public.admin_audit_log WHERE retain_until <= event_time;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  INSERT INTO public.admin_audit_log (
    actor_admin_user_hash,
    hash_key_version,
    action_type,
    target_type,
    context_json,
    occurred_at,
    retain_until
  ) VALUES (
    repeat('0', 64),
    'SYSTEM',
    'AUDIT_RETENTION_PURGE',
    'ADMIN_AUDIT_LOG',
    jsonb_build_object('deletedCount', deleted_count),
    event_time,
    event_time + interval '180 days'
  );
  PERFORM set_config('chi_shen_me.audit_retention_purge', 'disabled', true);
  RETURN deleted_count;
END;
$$;

CREATE FUNCTION public.protect_data_rights_authorization_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'data rights authorization tables cannot be truncated';
  END IF;
  IF current_setting('chi_shen_me.rights_authorization_mutation', true) = 'enabled' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'data rights authorization records require the restricted mutation function';
END;
$$;

CREATE TRIGGER protect_data_rights_authorizations
BEFORE UPDATE OR DELETE ON public.data_rights_authorizations
FOR EACH ROW EXECUTE FUNCTION public.protect_data_rights_authorization_mutation();

CREATE TRIGGER protect_data_rights_operations
BEFORE UPDATE OR DELETE ON public.data_rights_authorization_operations
FOR EACH ROW EXECUTE FUNCTION public.protect_data_rights_authorization_mutation();

CREATE TRIGGER forbid_data_rights_authorizations_truncate
BEFORE TRUNCATE ON public.data_rights_authorizations
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_data_rights_authorization_mutation();

CREATE TRIGGER forbid_data_rights_operations_truncate
BEFORE TRUNCATE ON public.data_rights_authorization_operations
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_data_rights_authorization_mutation();

CREATE FUNCTION public.revoke_data_rights_authorization(
  target_authorization_id uuid,
  actor_hash varchar,
  actor_hash_key_version varchar
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  already_revoked timestamptz;
  affected_references bigint;
  event_time timestamptz := now();
BEGIN
  SELECT revoked_at INTO already_revoked
    FROM public.data_rights_authorizations
    WHERE id = target_authorization_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'data rights authorization does not exist';
  END IF;
  IF already_revoked IS NOT NULL THEN
    RETURN 0;
  END IF;
  PERFORM set_config('chi_shen_me.rights_authorization_mutation', 'enabled', true);
  DELETE FROM public.favorites AS favorite
    USING public.external_place_references AS reference
    WHERE favorite.external_place_reference_id = reference.id
      AND reference.authorization_id = target_authorization_id;
  UPDATE public.recommendation_history AS history
    SET external_place_reference_id = NULL
    FROM public.external_place_references AS reference
    WHERE history.external_place_reference_id = reference.id
      AND reference.authorization_id = target_authorization_id;
  UPDATE public.private_recommendation_feedback AS feedback
    SET external_place_reference_id = NULL
    FROM public.external_place_references AS reference
    WHERE feedback.external_place_reference_id = reference.id
      AND reference.authorization_id = target_authorization_id;
  DELETE FROM public.external_place_references
    WHERE authorization_id = target_authorization_id;
  GET DIAGNOSTICS affected_references = ROW_COUNT;
  UPDATE public.data_rights_authorizations
    SET revoked_at = event_time
    WHERE id = target_authorization_id;
  PERFORM public.append_admin_audit_event(
    actor_hash,
    actor_hash_key_version,
    'DATA_RIGHTS_AUTHORIZATION_REVOKED',
    'DATA_RIGHTS_AUTHORIZATION',
    NULL,
    jsonb_build_object('removedReferenceCount', affected_references)
  );
  PERFORM set_config('chi_shen_me.rights_authorization_mutation', 'disabled', true);
  RETURN affected_references;
END;
$$;

CREATE FUNCTION public.purge_inactive_external_place_references()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inactive_ids uuid[];
  affected_references bigint := 0;
  event_time timestamptz := now();
BEGIN
  SELECT array_agg(reference.id) INTO inactive_ids
  FROM public.external_place_references AS reference
  JOIN public.data_rights_authorizations AS rights_authorization
    ON rights_authorization.id = reference.authorization_id
  WHERE reference.retain_until <= event_time
    OR rights_authorization.effective_at > event_time
    OR rights_authorization.expires_at <= event_time
    OR rights_authorization.revoked_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.data_rights_authorization_operations AS operation
      WHERE operation.authorization_id = rights_authorization.id
        AND operation.operation_code = 'PERSIST_PLACE_REFERENCE'
    );
  IF inactive_ids IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM public.favorites
    WHERE external_place_reference_id = ANY(inactive_ids);
  UPDATE public.recommendation_history
    SET external_place_reference_id = NULL
    WHERE external_place_reference_id = ANY(inactive_ids);
  UPDATE public.private_recommendation_feedback
    SET external_place_reference_id = NULL
    WHERE external_place_reference_id = ANY(inactive_ids);
  DELETE FROM public.external_place_references WHERE id = ANY(inactive_ids);
  GET DIAGNOSTICS affected_references = ROW_COUNT;
  PERFORM public.append_admin_audit_event(
    repeat('0', 64),
    'SYSTEM',
    'INACTIVE_EXTERNAL_REFERENCES_PURGED',
    'EXTERNAL_PLACE_REFERENCE',
    NULL,
    jsonb_build_object('removedReferenceCount', affected_references)
  );
  RETURN affected_references;
END;
$$;

CREATE FUNCTION public.persist_licensed_external_place_reference(
  source_provider_code varchar,
  source_provider_place_id varchar,
  source_authorization_id uuid,
  requested_retain_until timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_id uuid;
BEGIN
  INSERT INTO public.external_place_references (
    provider_code,
    provider_place_id,
    rights_mode,
    authorization_id,
    referenced_at,
    retain_until
  ) VALUES (
    source_provider_code,
    source_provider_place_id,
    'LICENSED_ENRICHMENT',
    source_authorization_id,
    now(),
    requested_retain_until
  )
  ON CONFLICT (provider_code, provider_place_id, authorization_id)
  DO UPDATE SET retain_until = GREATEST(
    public.external_place_references.retain_until,
    EXCLUDED.retain_until
  )
  WHERE public.external_place_references.retain_until > now()
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    RAISE EXCEPTION 'expired external place references must be purged before reuse';
  END IF;
  RETURN inserted_id;
END;
$$;

CREATE FUNCTION public.preview_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY SELECT 'RECOMMENDATION_HISTORY_90D', count(*)::bigint
    FROM public.recommendation_history WHERE retain_until <= now();
  RETURN QUERY SELECT 'CLOSED_SUPPORT_FEEDBACK_180D', count(*)::bigint
    FROM public.support_feedback WHERE retain_until IS NOT NULL AND retain_until <= now();
  RETURN QUERY SELECT 'EXPORT_METADATA_7D', count(*)::bigint
    FROM public.data_export_jobs
    WHERE expires_at <= now()
      AND (artifact_locator_ciphertext IS NULL OR artifact_deleted_at IS NOT NULL);
  RETURN QUERY SELECT 'ACCOUNT_DELETION_TOMBSTONE_30D', count(*)::bigint
    FROM public.account_deletion_jobs WHERE retain_until IS NOT NULL AND retain_until <= now();
  RETURN QUERY SELECT 'OTP_24H', count(*)::bigint
    FROM public.otp_challenges WHERE retain_until <= now();
  RETURN QUERY SELECT 'OAUTH_STATE_24H', count(*)::bigint
    FROM public.oauth_states WHERE retain_until <= now();
  RETURN QUERY SELECT 'ACCESS_TOKEN_24H_AFTER_EXPIRY', count(*)::bigint
    FROM public.auth_access_tokens WHERE retain_until <= now();
  RETURN QUERY SELECT 'SESSION_FAMILY_30D_AFTER_EXPIRY', count(*)::bigint
    FROM public.auth_session_families WHERE retain_until <= now();
  RETURN QUERY SELECT 'INACTIVE_EXTERNAL_REFERENCES', count(*)::bigint
    FROM public.external_place_references AS reference
    JOIN public.data_rights_authorizations AS rights_authorization
      ON rights_authorization.id = reference.authorization_id
    WHERE reference.retain_until <= now()
      OR rights_authorization.effective_at > now()
      OR rights_authorization.expires_at <= now()
      OR rights_authorization.revoked_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.data_rights_authorization_operations AS operation
        WHERE operation.authorization_id = rights_authorization.id
          AND operation.operation_code = 'PERSIST_PLACE_REFERENCE'
      );
  RETURN QUERY SELECT 'ADMIN_AUDIT_180D', count(*)::bigint
    FROM public.admin_audit_log WHERE retain_until <= now();
END;
$$;

CREATE FUNCTION public.execute_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  total_affected bigint := 0;
BEGIN
  DELETE FROM public.recommendation_history WHERE retain_until <= now();
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'RECOMMENDATION_HISTORY_90D'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.support_feedback WHERE retain_until IS NOT NULL AND retain_until <= now();
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'CLOSED_SUPPORT_FEEDBACK_180D'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.data_export_jobs
    WHERE expires_at <= now()
      AND (artifact_locator_ciphertext IS NULL OR artifact_deleted_at IS NOT NULL);
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'EXPORT_METADATA_7D'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.account_deletion_jobs
    WHERE retain_until IS NOT NULL AND retain_until <= now();
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'ACCOUNT_DELETION_TOMBSTONE_30D'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.otp_challenges WHERE retain_until <= now();
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'OTP_24H'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.oauth_states WHERE retain_until <= now();
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'OAUTH_STATE_24H'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.auth_access_tokens WHERE retain_until <= now();
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'ACCESS_TOKEN_24H_AFTER_EXPIRY'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.auth_session_families WHERE retain_until <= now();
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'SESSION_FAMILY_30D_AFTER_EXPIRY'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  SELECT public.purge_inactive_external_place_references() INTO affected_count;
  policy_code := 'INACTIVE_EXTERNAL_REFERENCES'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  SELECT public.purge_expired_admin_audit_events() INTO affected_count;
  policy_code := 'ADMIN_AUDIT_180D'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  PERFORM public.append_admin_audit_event(
    repeat('0', 64),
    'SYSTEM',
    'RETENTION_CLEANUP_COMPLETED',
    'DATABASE_RETENTION',
    NULL,
    jsonb_build_object('affectedCount', total_affected)
  );
END;
$$;

REVOKE ALL ON public.admin_audit_log FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_admin_audit_event(varchar, varchar, varchar, varchar, varchar, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_admin_audit_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_data_rights_authorization(uuid, varchar, varchar)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_inactive_external_place_references() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_licensed_external_place_reference(
  varchar, varchar, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preview_retention_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_retention_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_external_place_reference_rights() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_active_external_place_reference() FROM PUBLIC;
