-- Support feedback submission boundary.
-- Plaintext and raw client addresses never cross into PostgreSQL. The runtime
-- role can submit only through one atomic SECURITY DEFINER function.

ALTER TABLE public.support_feedback
  ADD COLUMN submitter_kind text,
  ADD COLUMN content_fingerprint varchar(64),
  ADD COLUMN content_fingerprint_algorithm varchar(16),
  ADD COLUMN content_fingerprint_key_version varchar(64),
  ADD COLUMN guest_ip_hash varchar(64),
  ADD COLUMN guest_ip_hash_algorithm varchar(16),
  ADD COLUMN guest_ip_hash_key_version varchar(64),
  ADD COLUMN guest_ip_destroyed_at timestamptz;

-- A pre-feature database can contain rows created by controlled development
-- tooling. Preserve them, but make the runtime startup gate fail closed until
-- an offline, plaintext-aware migration has fingerprinted them.
UPDATE public.support_feedback SET submitter_kind = 'LEGACY';
ALTER TABLE public.support_feedback ALTER COLUMN submitter_kind SET NOT NULL;

ALTER TABLE public.support_feedback
  ADD CONSTRAINT support_feedback_crypto_and_submitter_shape CHECK (
    (
      submitter_kind = 'LEGACY'
      AND content_fingerprint IS NULL
      AND content_fingerprint_algorithm IS NULL
      AND content_fingerprint_key_version IS NULL
      AND guest_ip_hash IS NULL
      AND guest_ip_hash_algorithm IS NULL
      AND guest_ip_hash_key_version IS NULL
      AND guest_ip_destroyed_at IS NULL
    ) OR (
      submitter_kind IN ('ACCOUNT', 'GUEST')
      AND content_fingerprint IS NOT NULL
      AND content_fingerprint ~ '^[0-9a-f]{64}$'
      AND content_fingerprint_algorithm IS NOT NULL
      AND content_fingerprint_algorithm = 'HMAC-SHA256'
      AND content_fingerprint_key_version IS NOT NULL
      AND content_fingerprint_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'
      AND (
        (
          submitter_kind = 'ACCOUNT'
          AND guest_ip_hash IS NULL
          AND guest_ip_hash_algorithm IS NULL
          AND guest_ip_hash_key_version IS NULL
          AND guest_ip_destroyed_at IS NULL
        ) OR (
          submitter_kind = 'GUEST'
          AND user_id IS NULL
          AND (
            (
              guest_ip_hash IS NOT NULL
              AND guest_ip_hash ~ '^[0-9a-f]{64}$'
              AND guest_ip_hash_algorithm IS NOT NULL
              AND guest_ip_hash_algorithm = 'HMAC-SHA256'
              AND guest_ip_hash_key_version IS NOT NULL
              AND guest_ip_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'
              AND guest_ip_destroyed_at IS NULL
            ) OR (
              guest_ip_hash IS NULL
              AND guest_ip_hash_algorithm IS NULL
              AND guest_ip_hash_key_version IS NULL
              AND guest_ip_destroyed_at IS NOT NULL
              AND guest_ip_destroyed_at >= created_at + interval '24 hours'
            )
          )
        )
      )
    )
  );

CREATE INDEX support_feedback_account_quota_idx
  ON public.support_feedback(user_id, created_at)
  WHERE submitter_kind = 'ACCOUNT' AND user_id IS NOT NULL;
CREATE INDEX support_feedback_guest_quota_idx
  ON public.support_feedback(guest_ip_hash_key_version, guest_ip_hash, created_at)
  WHERE submitter_kind = 'GUEST' AND guest_ip_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.protect_support_feedback_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF (OLD.id, OLD.category, OLD.created_at, OLD.submitter_kind) IS DISTINCT FROM
     (NEW.id, NEW.category, NEW.created_at, NEW.submitter_kind) THEN
    RAISE EXCEPTION 'support feedback identity fields are immutable';
  END IF;
  IF (
      OLD.content_ciphertext,
      OLD.encryption_key_version,
      OLD.content_fingerprint,
      OLD.content_fingerprint_algorithm,
      OLD.content_fingerprint_key_version
    ) IS DISTINCT FROM (
      NEW.content_ciphertext,
      NEW.encryption_key_version,
      NEW.content_fingerprint,
      NEW.content_fingerprint_algorithm,
      NEW.content_fingerprint_key_version
    ) AND pg_catalog.current_setting(
      'chi_shen_me.support_feedback_rewrap', true
    ) IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'support feedback crypto fields require controlled rewrap';
  END IF;
  IF (
      OLD.guest_ip_hash,
      OLD.guest_ip_hash_algorithm,
      OLD.guest_ip_hash_key_version,
      OLD.guest_ip_destroyed_at
    ) IS DISTINCT FROM (
      NEW.guest_ip_hash,
      NEW.guest_ip_hash_algorithm,
      NEW.guest_ip_hash_key_version,
      NEW.guest_ip_destroyed_at
    ) AND pg_catalog.current_setting(
      'chi_shen_me.support_feedback_rewrap', true
    ) IS DISTINCT FROM 'enabled'
      AND pg_catalog.current_setting(
        'chi_shen_me.support_feedback_guest_ip_anonymization', true
      ) IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'support feedback guest scope requires controlled mutation';
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

CREATE FUNCTION public.submit_support_feedback(
  p_feedback_id uuid,
  p_user_id uuid,
  p_submitter_kind varchar,
  p_category varchar,
  p_content_ciphertext bytea,
  p_encryption_key_version varchar,
  p_content_fingerprint varchar,
  p_fingerprint_key_version varchar,
  p_content_fingerprint_candidates jsonb,
  p_guest_ip_hash varchar,
  p_guest_ip_hash_key_version varchar,
  p_guest_ip_hash_candidates jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_feedback public.support_feedback%ROWTYPE;
  candidate record;
  candidate_count integer;
  valid_candidate_count integer;
  recent_submission_count bigint;
  event_time timestamptz := now();
  account_daily_quota constant integer := 20;
  guest_daily_quota constant integer := 5;
BEGIN
  IF p_feedback_id IS NULL
    OR p_submitter_kind IS NULL
    OR p_submitter_kind NOT IN ('ACCOUNT', 'GUEST')
    OR p_category IS NULL
    OR p_category NOT IN ('PRODUCT', 'PLACE_CORRECTION', 'PRIVACY', 'COMPLAINT')
    OR p_content_ciphertext IS NULL
    OR octet_length(p_content_ciphertext) NOT BETWEEN 16 AND 65536
    OR p_encryption_key_version IS NULL
    OR p_encryption_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_content_fingerprint IS NULL
    OR p_content_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_fingerprint_key_version IS NULL
    OR p_fingerprint_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_content_fingerprint_candidates IS NULL
    OR jsonb_typeof(p_content_fingerprint_candidates) <> 'object' THEN
    RAISE EXCEPTION 'invalid support feedback submission';
  END IF;

  SELECT count(*), count(*) FILTER (
    WHERE key ~ '^[A-Za-z0-9_.-]{1,64}$'
      AND pg_catalog.jsonb_typeof(value) = 'string'
      AND (value #>> '{}') ~ '^[0-9a-f]{64}$'
  )
    INTO candidate_count, valid_candidate_count
    FROM pg_catalog.jsonb_each(p_content_fingerprint_candidates);
  IF candidate_count NOT BETWEEN 1 AND 3
    OR valid_candidate_count <> candidate_count
    OR p_content_fingerprint_candidates ->> p_fingerprint_key_version
      IS DISTINCT FROM p_content_fingerprint THEN
    RAISE EXCEPTION 'invalid support feedback fingerprint candidates';
  END IF;

  IF p_submitter_kind = 'ACCOUNT' THEN
    IF p_user_id IS NULL
      OR p_guest_ip_hash IS NOT NULL
      OR p_guest_ip_hash_key_version IS NOT NULL
      OR p_guest_ip_hash_candidates IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = p_user_id AND status = 'ACTIVE'
      ) THEN
      RAISE EXCEPTION 'invalid account support feedback scope';
    END IF;
  ELSE
    IF p_user_id IS NOT NULL
      OR p_guest_ip_hash IS NULL
      OR p_guest_ip_hash !~ '^[0-9a-f]{64}$'
      OR p_guest_ip_hash_key_version IS NULL
      OR p_guest_ip_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
      OR p_guest_ip_hash_candidates IS NULL
      OR jsonb_typeof(p_guest_ip_hash_candidates) <> 'object' THEN
      RAISE EXCEPTION 'invalid guest support feedback scope';
    END IF;
    SELECT count(*), count(*) FILTER (
      WHERE key ~ '^[A-Za-z0-9_.-]{1,64}$'
        AND pg_catalog.jsonb_typeof(value) = 'string'
        AND (value #>> '{}') ~ '^[0-9a-f]{64}$'
    )
      INTO candidate_count, valid_candidate_count
      FROM pg_catalog.jsonb_each(p_guest_ip_hash_candidates);
    IF candidate_count NOT BETWEEN 1 AND 3
      OR valid_candidate_count <> candidate_count
      OR p_guest_ip_hash_candidates ->> p_guest_ip_hash_key_version
        IS DISTINCT FROM p_guest_ip_hash THEN
      RAISE EXCEPTION 'invalid guest support feedback hash candidates';
    END IF;
  END IF;

  -- The caller-controlled UUID is a 122-bit random idempotency key. Serialize
  -- first use and replay before quota accounting so an exact network retry is
  -- always free and cannot race into two rows.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('support-feedback:id:' || p_feedback_id::text, 0)
  );
  SELECT * INTO existing_feedback
    FROM public.support_feedback
    WHERE id = p_feedback_id
    FOR UPDATE;
  IF FOUND THEN
    IF existing_feedback.submitter_kind = p_submitter_kind
      AND existing_feedback.category = p_category
      AND (
        (p_submitter_kind = 'ACCOUNT'
          AND existing_feedback.user_id = p_user_id)
        OR (p_submitter_kind = 'GUEST'
          AND (
            -- After the 24-hour quota scope is destroyed, exact idempotency is
            -- still safe to prove with the secret content HMAC and random UUID.
            -- Never recreate the destroyed network identifier on such a retry.
            existing_feedback.guest_ip_destroyed_at IS NOT NULL
            OR p_guest_ip_hash_candidates
              ->> existing_feedback.guest_ip_hash_key_version
                = existing_feedback.guest_ip_hash
          ))
      )
      AND p_content_fingerprint_candidates
        ->> existing_feedback.content_fingerprint_key_version
          = existing_feedback.content_fingerprint THEN
      -- An exact retry is also a safe opportunistic rewrap. It
      -- gradually retires old crypto versions without disclosing old content.
      IF existing_feedback.encryption_key_version
          IS DISTINCT FROM p_encryption_key_version
        OR existing_feedback.content_fingerprint_key_version
          IS DISTINCT FROM p_fingerprint_key_version
        OR (p_submitter_kind = 'GUEST'
          AND existing_feedback.guest_ip_destroyed_at IS NULL AND (
          existing_feedback.guest_ip_hash_key_version
            IS DISTINCT FROM p_guest_ip_hash_key_version
          OR existing_feedback.guest_ip_hash IS DISTINCT FROM p_guest_ip_hash
        )) THEN
        PERFORM pg_catalog.set_config(
          'chi_shen_me.support_feedback_rewrap', 'enabled', true
        );
        UPDATE public.support_feedback
          SET content_ciphertext = p_content_ciphertext,
              encryption_key_version = p_encryption_key_version,
              content_fingerprint = p_content_fingerprint,
              content_fingerprint_algorithm = 'HMAC-SHA256',
              content_fingerprint_key_version = p_fingerprint_key_version,
              guest_ip_hash = CASE WHEN p_submitter_kind = 'GUEST'
                  AND existing_feedback.guest_ip_destroyed_at IS NULL
                THEN p_guest_ip_hash ELSE NULL END,
              guest_ip_hash_algorithm = CASE WHEN p_submitter_kind = 'GUEST'
                  AND existing_feedback.guest_ip_destroyed_at IS NULL
                THEN 'HMAC-SHA256' ELSE NULL END,
              guest_ip_hash_key_version = CASE WHEN p_submitter_kind = 'GUEST'
                  AND existing_feedback.guest_ip_destroyed_at IS NULL
                THEN p_guest_ip_hash_key_version ELSE NULL END,
              guest_ip_destroyed_at = existing_feedback.guest_ip_destroyed_at
          WHERE id = p_feedback_id;
      END IF;
      RETURN 'REPLAY';
    END IF;
    RETURN 'MISMATCH';
  END IF;

  IF p_submitter_kind = 'ACCOUNT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'support-feedback:quota:account:' || p_user_id::text, 0
      )
    );
    SELECT count(*) INTO recent_submission_count
      FROM public.support_feedback
      WHERE submitter_kind = 'ACCOUNT'
        AND user_id = p_user_id
        AND created_at > event_time - interval '24 hours';
    IF recent_submission_count >= account_daily_quota THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P5100', MESSAGE = 'support feedback quota exceeded';
    END IF;
  ELSE
    -- Lock every retained candidate in deterministic version order. During a
    -- staged rotation, old and new instances share at least one lock and count
    -- rows written under either key version.
    FOR candidate IN
      SELECT key, value
      FROM pg_catalog.jsonb_each_text(p_guest_ip_hash_candidates)
      ORDER BY key
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'support-feedback:quota:guest:' || candidate.key || ':' || candidate.value,
          0
        )
      );
    END LOOP;
    SELECT count(*) INTO recent_submission_count
      FROM public.support_feedback AS feedback
      WHERE feedback.submitter_kind = 'GUEST'
        AND feedback.created_at > event_time - interval '24 hours'
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_each_text(p_guest_ip_hash_candidates) AS scope
          WHERE scope.key = feedback.guest_ip_hash_key_version
            AND scope.value = feedback.guest_ip_hash
        );
    IF recent_submission_count >= guest_daily_quota THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P5100', MESSAGE = 'support feedback quota exceeded';
    END IF;
  END IF;

  INSERT INTO public.support_feedback (
    id, user_id, submitter_kind, category,
    content_ciphertext, encryption_key_version,
    content_fingerprint, content_fingerprint_algorithm,
    content_fingerprint_key_version,
    guest_ip_hash, guest_ip_hash_algorithm, guest_ip_hash_key_version,
    guest_ip_destroyed_at,
    status, created_at
  ) VALUES (
    p_feedback_id, p_user_id, p_submitter_kind, p_category,
    p_content_ciphertext, p_encryption_key_version,
    p_content_fingerprint, 'HMAC-SHA256', p_fingerprint_key_version,
    p_guest_ip_hash,
    CASE WHEN p_submitter_kind = 'GUEST' THEN 'HMAC-SHA256' ELSE NULL END,
    p_guest_ip_hash_key_version, NULL,
    'OPEN', event_time
  );
  RETURN 'INSERTED';
END;
$$;

-- Guest IP HMACs exist only for the rolling 24-hour abuse quota. Destroying
-- them after that window avoids retaining an irreversible network identifier
-- for the potentially much longer support-ticket lifecycle.
CREATE FUNCTION public.anonymize_expired_support_feedback_guest_ip_hashes()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_rows bigint;
  event_time timestamptz := now();
BEGIN
  PERFORM pg_catalog.set_config(
    'chi_shen_me.support_feedback_guest_ip_anonymization', 'enabled', true
  );
  UPDATE public.support_feedback
    SET guest_ip_hash = NULL,
        guest_ip_hash_algorithm = NULL,
        guest_ip_hash_key_version = NULL,
        guest_ip_destroyed_at = event_time
    WHERE submitter_kind = 'GUEST'
      AND guest_ip_hash IS NOT NULL
      AND guest_ip_destroyed_at IS NULL
      AND created_at <= event_time - interval '24 hours';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

-- Exposes metadata only. API startup fails closed if a configured key ring no
-- longer covers any version referenced by retained ciphertext or HMAC values.
CREATE FUNCTION public.support_feedback_required_key_versions()
RETURNS TABLE(key_purpose text, key_version varchar, record_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT 'ENCRYPTION'::text, feedback.encryption_key_version,
    count(*)::bigint
  FROM public.support_feedback AS feedback
  GROUP BY feedback.encryption_key_version
  UNION ALL
  SELECT 'HMAC'::text, versions.key_version, count(*)::bigint
  FROM (
    SELECT feedback.content_fingerprint_key_version AS key_version
    FROM public.support_feedback AS feedback
    WHERE feedback.content_fingerprint_key_version IS NOT NULL
    UNION ALL
    SELECT feedback.guest_ip_hash_key_version AS key_version
    FROM public.support_feedback AS feedback
    WHERE feedback.guest_ip_hash_key_version IS NOT NULL
  ) AS versions
  GROUP BY versions.key_version
  UNION ALL
  SELECT 'LEGACY'::text, NULL::varchar, count(*)::bigint
  FROM public.support_feedback AS feedback
  WHERE feedback.submitter_kind = 'LEGACY'
     OR feedback.content_fingerprint IS NULL
     OR feedback.content_fingerprint_key_version IS NULL
  HAVING count(*) > 0;
$$;

-- Offline crypto maintenance must already know the plaintext-derived old HMAC.
-- The primitive reveals no row and uses optimistic old-version/fingerprint
-- checks, so possession of maintenance DB credentials alone cannot select or
-- blindly rewrite support content.
CREATE FUNCTION public.rewrap_support_feedback(
  p_feedback_id uuid,
  p_expected_encryption_key_version varchar,
  p_expected_content_fingerprint varchar,
  p_expected_fingerprint_key_version varchar,
  p_new_content_ciphertext bytea,
  p_new_encryption_key_version varchar,
  p_new_content_fingerprint varchar,
  p_new_fingerprint_key_version varchar
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE current_feedback public.support_feedback%ROWTYPE;
BEGIN
  IF p_feedback_id IS NULL
    OR p_expected_encryption_key_version IS NULL
    OR p_expected_encryption_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_expected_content_fingerprint IS NULL
    OR p_expected_content_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_expected_fingerprint_key_version IS NULL
    OR p_expected_fingerprint_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_new_content_ciphertext IS NULL
    OR octet_length(p_new_content_ciphertext) NOT BETWEEN 16 AND 65536
    OR p_new_encryption_key_version IS NULL
    OR p_new_encryption_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_new_content_fingerprint IS NULL
    OR p_new_content_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_new_fingerprint_key_version IS NULL
    OR p_new_fingerprint_key_version !~ '^[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid support feedback rewrap';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('support-feedback:id:' || p_feedback_id::text, 0)
  );
  SELECT * INTO current_feedback
    FROM public.support_feedback
    WHERE id = p_feedback_id
    FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF current_feedback.encryption_key_version
      IS DISTINCT FROM p_expected_encryption_key_version
    OR current_feedback.content_fingerprint
      IS DISTINCT FROM p_expected_content_fingerprint
    OR current_feedback.content_fingerprint_key_version
      IS DISTINCT FROM p_expected_fingerprint_key_version THEN
    RETURN 'STALE';
  END IF;
  PERFORM pg_catalog.set_config(
    'chi_shen_me.support_feedback_rewrap', 'enabled', true
  );
  UPDATE public.support_feedback
    SET content_ciphertext = p_new_content_ciphertext,
        encryption_key_version = p_new_encryption_key_version,
        content_fingerprint = p_new_content_fingerprint,
        content_fingerprint_algorithm = 'HMAC-SHA256',
        content_fingerprint_key_version = p_new_fingerprint_key_version
    WHERE id = p_feedback_id;
  RETURN 'REWRAPPED';
END;
$$;

REVOKE ALL ON public.support_feedback FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_support_feedback(
  uuid, uuid, varchar, varchar, bytea, varchar, varchar, varchar,
  jsonb, varchar, varchar, jsonb
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.support_feedback_required_key_versions()
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rewrap_support_feedback(
  uuid, varchar, varchar, varchar, bytea, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.anonymize_expired_support_feedback_guest_ip_hashes()
  FROM PUBLIC;
