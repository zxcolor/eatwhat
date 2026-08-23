-- Data export delivery foundation.
--
-- The public API and the dedicated export worker receive no export or personal
-- data base-table ACLs (the worker may read only the non-sensitive migration
-- ledger for its startup schema gate).
-- API functions expose only public status fields, except for the narrowly scoped
-- Bearer-authenticated artifact opener whose ciphertext result must remain inside
-- the server-side artifact store adapter. Worker functions use a fenced HMAC
-- lease and never expose provider IDs, correlation HMACs, coordinates, tokens,
-- OTPs, audit data or ciphertext in the generated JSON document.

DROP TRIGGER data_export_job_initial_state ON public.data_export_jobs;
DROP TRIGGER data_export_job_state_machine ON public.data_export_jobs;

ALTER TABLE public.data_export_jobs
  ADD COLUMN include_behavior_history boolean NOT NULL DEFAULT true,
  ADD COLUMN state_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN attempt_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN lease_purpose text,
  ADD COLUMN lease_owner_hash varchar(64),
  ADD COLUMN lease_owner_hash_algorithm text,
  ADD COLUMN lease_owner_hash_key_version varchar(64),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN failure_code text,
  ADD COLUMN artifact_sha256 varchar(64),
  ADD COLUMN artifact_size_bytes bigint,
  ADD COLUMN artifact_content_type varchar(64),
  ADD COLUMN ready_at timestamptz;

-- A pre-0006 READY row has no independently verified checksum or size. It is
-- deliberately made unavailable and retained for the deletion worker. Faking
-- metadata would turn an unverifiable legacy object into a downloadable object.
UPDATE public.data_export_jobs
SET status = 'EXPIRED',
    state_version = state_version + 1
WHERE status = 'READY';

-- A pre-0006 PROCESSING row has no fenced lease. Requeue it instead of allowing
-- an unfenced legacy process to complete it.
UPDATE public.data_export_jobs
SET status = 'PENDING',
    state_version = state_version + 1
WHERE status = 'PROCESSING';

UPDATE public.data_export_jobs
SET failure_code = 'INTERNAL_ERROR'
WHERE status = 'FAILED' AND failure_code IS NULL;

UPDATE public.data_export_jobs
SET ready_at = completed_at
WHERE status = 'EXPIRED'
  AND artifact_locator_ciphertext IS NOT NULL
  AND ready_at IS NULL
  AND completed_at >= created_at
  AND completed_at < expires_at;

ALTER TABLE public.data_export_jobs
  ADD CONSTRAINT data_export_state_version_valid CHECK (state_version >= 0),
  ADD CONSTRAINT data_export_attempt_count_valid CHECK (attempt_count BETWEEN 0 AND 5),
  ADD CONSTRAINT data_export_failure_code_valid CHECK (
    failure_code IS NULL OR failure_code IN (
      'SOURCE_READ_FAILED', 'SNAPSHOT_TOO_LARGE', 'ARTIFACT_UPLOAD_FAILED',
      'ARTIFACT_VERIFY_FAILED', 'LEASE_EXPIRED', 'RETRY_EXHAUSTED',
      'INTERNAL_ERROR', 'ACCOUNT_DELETION_REQUESTED'
    )
  ),
  ADD CONSTRAINT data_export_lease_shape CHECK (
    (
      lease_purpose IS NULL
      AND lease_owner_hash IS NULL
      AND lease_owner_hash_algorithm IS NULL
      AND lease_owner_hash_key_version IS NULL
      AND lease_expires_at IS NULL
    ) OR (
      lease_purpose IN ('BUILD', 'DELETE')
      AND lease_owner_hash IS NOT NULL
      AND lease_owner_hash ~ '^[0-9a-f]{64}$'
      AND lease_owner_hash_algorithm IS NOT NULL
      AND lease_owner_hash_algorithm = 'HMAC-SHA256'
      AND lease_owner_hash_key_version IS NOT NULL
      AND lease_owner_hash_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'
      AND lease_expires_at IS NOT NULL
      AND (
        (lease_purpose = 'BUILD' AND status = 'PROCESSING')
        OR (lease_purpose = 'DELETE' AND status = 'EXPIRED')
      )
    )
  ),
  ADD CONSTRAINT data_export_artifact_metadata_shape CHECK (
    (
      artifact_locator_ciphertext IS NULL
      AND encryption_key_version IS NULL
      AND artifact_sha256 IS NULL
      AND artifact_size_bytes IS NULL
      AND artifact_content_type IS NULL
    ) OR (
      artifact_locator_ciphertext IS NOT NULL
      AND encryption_key_version IS NOT NULL
      AND (
        (
          artifact_sha256 IS NOT NULL
          AND artifact_size_bytes IS NOT NULL
          AND artifact_content_type IS NOT NULL
          AND artifact_sha256 ~ '^[0-9a-f]{64}$'
          AND artifact_size_bytes BETWEEN 1 AND 10485760
          AND artifact_content_type = 'application/json'
        )
        OR (
          -- Only unverifiable artifacts that predate 0006 may lack frozen
          -- metadata. New stage calls always persist the complete expectation.
          status = 'EXPIRED'
          AND artifact_sha256 IS NULL
          AND artifact_size_bytes IS NULL
          AND artifact_content_type IS NULL
        )
      )
    )
  ),
  ADD CONSTRAINT data_export_ready_shape CHECK (
    status <> 'READY' OR (
      ready_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND ready_at = completed_at
      AND artifact_locator_ciphertext IS NOT NULL
      AND artifact_sha256 IS NOT NULL
      AND artifact_size_bytes IS NOT NULL
      AND artifact_content_type = 'application/json'
      AND artifact_deleted_at IS NULL
      AND failure_code IS NULL
      AND lease_purpose IS NULL
    )
  ),
  ADD CONSTRAINT data_export_failed_shape CHECK (
    status <> 'FAILED' OR (
      failure_code IS NOT NULL
      AND completed_at IS NOT NULL
      AND artifact_locator_ciphertext IS NULL
      AND lease_purpose IS NULL
    )
  ),
  ADD CONSTRAINT data_export_ready_time_valid CHECK (
    ready_at IS NULL OR (
      completed_at IS NOT NULL
      AND ready_at = completed_at
      AND ready_at >= created_at
      AND ready_at < expires_at
    )
  );

CREATE INDEX data_export_jobs_claim_idx
  ON public.data_export_jobs(status, created_at, id)
  WHERE status IN ('PENDING', 'PROCESSING');
CREATE INDEX data_export_jobs_artifact_delete_idx
  ON public.data_export_jobs(status, expires_at, id)
  WHERE artifact_locator_ciphertext IS NOT NULL AND artifact_deleted_at IS NULL;
CREATE INDEX support_feedback_user_export_idx
  ON public.support_feedback(user_id, created_at, id)
  WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_data_export_job_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF current_setting('chi_shen_me.data_export_transition', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'data export creation requires a restricted function';
  END IF;
  IF NEW.status <> 'PENDING'
    OR NEW.state_version <> 0
    OR NEW.attempt_count <> 0
    OR NEW.lease_purpose IS NOT NULL
    OR NEW.lease_owner_hash IS NOT NULL
    OR NEW.lease_owner_hash_algorithm IS NOT NULL
    OR NEW.lease_owner_hash_key_version IS NOT NULL
    OR NEW.lease_expires_at IS NOT NULL
    OR NEW.failure_code IS NOT NULL
    OR NEW.artifact_locator_ciphertext IS NOT NULL
    OR NEW.encryption_key_version IS NOT NULL
    OR NEW.artifact_sha256 IS NOT NULL
    OR NEW.artifact_size_bytes IS NOT NULL
    OR NEW.artifact_content_type IS NOT NULL
    OR NEW.artifact_deleted_at IS NOT NULL
    OR NEW.ready_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NEW.created_at < event_time - interval '5 minutes'
    OR NEW.created_at > event_time + interval '5 minutes'
    OR NEW.expires_at <> NEW.created_at + interval '7 days' THEN
    RAISE EXCEPTION 'data export jobs must begin in a fresh pending state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER data_export_job_initial_state
BEFORE INSERT ON public.data_export_jobs
FOR EACH ROW EXECUTE FUNCTION public.validate_data_export_job_insert();

CREATE OR REPLACE FUNCTION public.protect_data_export_job_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF current_setting('chi_shen_me.data_export_transition', true)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'data export changes require a restricted function';
  END IF;
  IF (OLD.id, OLD.user_id, OLD.include_behavior_history,
      OLD.created_at, OLD.expires_at)
      IS DISTINCT FROM
     (NEW.id, NEW.user_id, NEW.include_behavior_history,
      NEW.created_at, NEW.expires_at) THEN
    RAISE EXCEPTION 'data export issuance fields are immutable';
  END IF;
  IF NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'data export changes require a monotonic fencing version';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
    OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'FAILED', 'EXPIRED')
    OR OLD.status = 'PROCESSING' AND NEW.status IN ('PENDING', 'READY', 'FAILED', 'EXPIRED')
    OR OLD.status IN ('READY', 'FAILED') AND NEW.status = 'EXPIRED'
  ) THEN
    RAISE EXCEPTION 'data export status transition is invalid';
  END IF;
  IF NEW.attempt_count <> OLD.attempt_count
    AND NOT (
      NEW.attempt_count = OLD.attempt_count + 1
      AND NEW.status = 'PROCESSING'
      AND NEW.lease_purpose = 'BUILD'
    ) THEN
    RAISE EXCEPTION 'data export attempts advance only when a build lease is claimed';
  END IF;
  IF OLD.artifact_locator_ciphertext IS NOT NULL AND (
    NEW.artifact_locator_ciphertext IS DISTINCT FROM OLD.artifact_locator_ciphertext
    OR NEW.encryption_key_version IS DISTINCT FROM OLD.encryption_key_version
    OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
    OR NEW.artifact_size_bytes IS DISTINCT FROM OLD.artifact_size_bytes
    OR NEW.artifact_content_type IS DISTINCT FROM OLD.artifact_content_type
  ) THEN
    RAISE EXCEPTION 'staged export artifact expectation is immutable';
  END IF;
  IF OLD.artifact_locator_ciphertext IS NULL
    AND NEW.artifact_locator_ciphertext IS NOT NULL
    AND NOT (
      NEW.status = 'PROCESSING'
      AND NEW.lease_purpose = 'BUILD'
      AND NEW.artifact_sha256 IS NOT NULL
      AND NEW.artifact_sha256 ~ '^[0-9a-f]{64}$'
      AND NEW.artifact_size_bytes BETWEEN 1 AND 10485760
      AND NEW.artifact_content_type = 'application/json'
    ) THEN
    RAISE EXCEPTION 'export artifact expectations require a current build lease';
  END IF;
  IF OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at THEN
    RAISE EXCEPTION 'export ready time is immutable';
  END IF;
  IF OLD.completed_at IS NOT NULL
    AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'export completion time is immutable';
  END IF;
  IF OLD.artifact_deleted_at IS NOT NULL
    AND NEW.artifact_deleted_at IS DISTINCT FROM OLD.artifact_deleted_at THEN
    RAISE EXCEPTION 'export artifact deletion time is immutable';
  END IF;
  IF OLD.artifact_deleted_at IS NULL AND NEW.artifact_deleted_at IS NOT NULL
    AND (
      NEW.status <> 'EXPIRED'
      OR NEW.artifact_locator_ciphertext IS NULL
      OR NEW.lease_purpose IS NOT NULL
      OR NEW.artifact_deleted_at < event_time - interval '5 minutes'
      OR NEW.artifact_deleted_at > event_time + interval '5 minutes'
    ) THEN
    RAISE EXCEPTION 'artifact deletion requires a current expired export';
  END IF;
  IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
    AND (
      NEW.completed_at < event_time - interval '5 minutes'
      OR NEW.completed_at > event_time + interval '5 minutes'
    ) THEN
    RAISE EXCEPTION 'export completion must use database time';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER data_export_job_state_machine
BEFORE UPDATE ON public.data_export_jobs
FOR EACH ROW EXECUTE FUNCTION public.protect_data_export_job_update();

CREATE FUNCTION public.app_queue_data_export(
  p_user_id uuid,
  p_export_id uuid,
  p_include_behavior_history boolean
)
RETURNS TABLE(
  outcome text,
  export_id uuid,
  export_status text,
  include_behavior_history boolean,
  requested_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  failure_code text,
  artifact_size_bytes bigint,
  artifact_sha256 varchar
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_job public.data_export_jobs%ROWTYPE;
  inserted_job public.data_export_jobs%ROWTYPE;
  event_time timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_export_id IS NULL
    OR p_include_behavior_history IS NULL THEN
    RETURN QUERY SELECT 'INVALID_USER'::text, NULL::uuid, NULL::text,
      NULL::boolean, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
      NULL::text, NULL::bigint, NULL::varchar;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('data-export:' || p_user_id::text, 0)
  );
  event_time := clock_timestamp();
  PERFORM 1 FROM public.users
    WHERE id = p_user_id AND status = 'ACTIVE'
    FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID_USER'::text, NULL::uuid, NULL::text,
      NULL::boolean, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
      NULL::text, NULL::bigint, NULL::varchar;
    RETURN;
  END IF;
  SELECT job.* INTO existing_job
  FROM public.data_export_jobs AS job
  WHERE job.user_id = p_user_id
    AND job.status IN ('PENDING', 'PROCESSING', 'READY')
    AND job.expires_at > event_time
  ORDER BY job.created_at DESC, job.id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT
      CASE
        WHEN existing_job.status = 'PENDING'
          AND existing_job.include_behavior_history = p_include_behavior_history
          THEN 'REPLAY'::text
        ELSE 'CONFLICT'::text
      END,
      existing_job.id,
      CASE existing_job.status
        WHEN 'PENDING' THEN 'QUEUED'::text
        ELSE existing_job.status
      END,
      existing_job.include_behavior_history,
      existing_job.created_at,
      existing_job.ready_at,
      existing_job.expires_at,
      existing_job.failure_code,
      existing_job.artifact_size_bytes,
      existing_job.artifact_sha256;
    RETURN;
  END IF;

  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);
  INSERT INTO public.data_export_jobs (
    id, user_id, include_behavior_history, created_at, expires_at
  ) VALUES (
    p_export_id, p_user_id, p_include_behavior_history,
    event_time, event_time + interval '7 days'
  )
  RETURNING * INTO inserted_job;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);

  RETURN QUERY SELECT 'CREATED'::text, inserted_job.id, 'QUEUED'::text,
    inserted_job.include_behavior_history, inserted_job.created_at,
    inserted_job.ready_at, inserted_job.expires_at, inserted_job.failure_code,
    inserted_job.artifact_size_bytes, inserted_job.artifact_sha256;
END;
$$;

CREATE FUNCTION public.app_get_data_export_status(
  p_user_id uuid,
  p_export_id uuid
)
RETURNS TABLE(
  export_id uuid,
  export_status text,
  include_behavior_history boolean,
  requested_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  failure_code text,
  artifact_size_bytes bigint,
  artifact_sha256 varchar
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT job.id,
    CASE
      WHEN job.expires_at <= now() THEN 'EXPIRED'::text
      WHEN job.status = 'PENDING' THEN 'QUEUED'::text
      ELSE job.status
    END,
    job.include_behavior_history, job.created_at, job.ready_at,
    job.expires_at, job.failure_code, job.artifact_size_bytes,
    job.artifact_sha256
  FROM public.data_export_jobs AS job
  WHERE job.id = p_export_id AND job.user_id = p_user_id;
$$;

CREATE FUNCTION public.app_get_latest_data_export_status(p_user_id uuid)
RETURNS TABLE(
  export_id uuid,
  export_status text,
  include_behavior_history boolean,
  requested_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  failure_code text,
  artifact_size_bytes bigint,
  artifact_sha256 varchar
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT job.id,
    CASE
      WHEN job.expires_at <= now() THEN 'EXPIRED'::text
      WHEN job.status = 'PENDING' THEN 'QUEUED'::text
      ELSE job.status
    END,
    job.include_behavior_history, job.created_at, job.ready_at,
    job.expires_at, job.failure_code, job.artifact_size_bytes,
    job.artifact_sha256
  FROM public.data_export_jobs AS job
  WHERE job.user_id = p_user_id
  ORDER BY job.created_at DESC, job.id DESC
  LIMIT 1;
$$;

-- This is the only API primitive that can reveal the encrypted app-owned
-- locator. Callers must already have authenticated the same Bearer subject and
-- must pass the result directly to the private artifact store adapter. The
-- controller must never serialize these internal columns.
CREATE FUNCTION public.app_open_data_export_artifact(
  p_user_id uuid,
  p_export_id uuid
)
RETURNS TABLE(
  artifact_locator_ciphertext bytea,
  artifact_encryption_key_version varchar,
  artifact_size_bytes bigint,
  artifact_sha256 varchar,
  artifact_content_type varchar,
  artifact_filename text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT job.artifact_locator_ciphertext, job.encryption_key_version,
    job.artifact_size_bytes, job.artifact_sha256, job.artifact_content_type,
    ('chi-shen-me-data-export-' || job.id::text || '.json')::text
  FROM public.data_export_jobs AS job
  JOIN public.users AS account_user ON account_user.id = job.user_id
  WHERE job.id = p_export_id
    AND job.user_id = p_user_id
    AND account_user.status = 'ACTIVE'
    AND job.status = 'READY'
    AND job.ready_at IS NOT NULL
    AND job.expires_at > now()
    AND job.artifact_locator_ciphertext IS NOT NULL
    AND job.artifact_deleted_at IS NULL;
$$;

-- Startup-only crypto coverage gate. It leaks only the distinct locator key
-- versions still needed to delete or open an App-owned artifact. The dedicated
-- export worker must prove that its bounded key ring covers this entire set
-- before it claims any work.
CREATE FUNCTION public.export_artifact_required_locator_key_versions()
RETURNS TABLE(key_version varchar)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT job.encryption_key_version
  FROM public.data_export_jobs AS job
  WHERE job.artifact_locator_ciphertext IS NOT NULL
    AND job.artifact_deleted_at IS NULL
  ORDER BY job.encryption_key_version;
$$;

CREATE FUNCTION public.export_claim_next_job(
  p_worker_hash varchar,
  p_worker_hash_key_version varchar,
  p_lease_seconds integer
)
RETURNS TABLE(
  export_id uuid,
  user_id uuid,
  include_behavior_history boolean,
  state_version bigint,
  attempt_number smallint,
  lease_expires_at timestamptz,
  artifact_locator_ciphertext bytea,
  artifact_encryption_key_version varchar,
  artifact_sha256 varchar,
  artifact_size_bytes bigint,
  artifact_content_type varchar
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF p_worker_hash IS NULL OR p_worker_hash !~ '^[0-9a-f]{64}$'
    OR p_worker_hash_key_version IS NULL
    OR p_worker_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid export worker lease request';
  END IF;

  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);
  UPDATE public.data_export_jobs AS exhausted
  SET status = CASE
        WHEN exhausted.artifact_locator_ciphertext IS NOT NULL
          OR exhausted.expires_at <= event_time THEN 'EXPIRED'
        ELSE 'FAILED'
      END,
      completed_at = event_time,
      failure_code = 'RETRY_EXHAUSTED',
      lease_purpose = NULL,
      lease_owner_hash = NULL,
      lease_owner_hash_algorithm = NULL,
      lease_owner_hash_key_version = NULL,
      lease_expires_at = NULL,
      state_version = exhausted.state_version + 1
  WHERE exhausted.status = 'PROCESSING'
    AND exhausted.lease_purpose = 'BUILD'
    AND exhausted.lease_expires_at <= event_time
    AND exhausted.attempt_count >= 5;

  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
    FROM public.data_export_jobs AS job
    JOIN public.users AS account_user ON account_user.id = job.user_id
    WHERE account_user.status = 'ACTIVE'
      AND job.expires_at > event_time
      AND job.attempt_count < 5
      AND (
        job.status = 'PENDING'
        OR (
          job.status = 'PROCESSING'
          AND job.lease_purpose = 'BUILD'
          AND job.lease_expires_at <= event_time
        )
      )
    ORDER BY job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE public.data_export_jobs AS job
    SET status = 'PROCESSING',
        attempt_count = job.attempt_count + 1,
        lease_purpose = 'BUILD',
        lease_owner_hash = p_worker_hash,
        lease_owner_hash_algorithm = 'HMAC-SHA256',
        lease_owner_hash_key_version = p_worker_hash_key_version,
        lease_expires_at = event_time + make_interval(secs => p_lease_seconds),
        failure_code = CASE
          WHEN job.status = 'PROCESSING' THEN 'LEASE_EXPIRED'
          ELSE job.failure_code
        END,
        state_version = job.state_version + 1
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.id, job.user_id, job.include_behavior_history,
      job.state_version, job.attempt_count, job.lease_expires_at,
      job.artifact_locator_ciphertext, job.encryption_key_version,
      job.artifact_sha256, job.artifact_size_bytes, job.artifact_content_type
  )
  SELECT claimed.id, claimed.user_id, claimed.include_behavior_history,
    claimed.state_version, claimed.attempt_count, claimed.lease_expires_at,
    claimed.artifact_locator_ciphertext, claimed.encryption_key_version,
    claimed.artifact_sha256, claimed.artifact_size_bytes,
    claimed.artifact_content_type
  FROM claimed;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
END;
$$;

CREATE FUNCTION public.export_renew_job_lease(
  p_export_id uuid,
  p_worker_hash varchar,
  p_worker_hash_key_version varchar,
  p_expected_state_version bigint,
  p_lease_seconds integer
)
RETURNS TABLE(
  new_state_version bigint,
  lease_purpose text,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF p_lease_seconds IS NULL
    OR p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid export lease duration';
  END IF;
  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);

  RETURN QUERY
  UPDATE public.data_export_jobs AS job
  SET lease_expires_at = event_time + make_interval(secs => p_lease_seconds),
      state_version = job.state_version + 1
  WHERE job.id = p_export_id
    AND job.state_version = p_expected_state_version
    AND job.lease_owner_hash = p_worker_hash
    AND job.lease_owner_hash_key_version = p_worker_hash_key_version
    AND job.lease_owner_hash_algorithm = 'HMAC-SHA256'
    AND job.lease_purpose IN ('BUILD', 'DELETE')
    AND job.lease_expires_at > event_time
    AND job.expires_at > CASE
      WHEN job.lease_purpose = 'BUILD' THEN event_time
      ELSE job.created_at
    END
  RETURNING job.state_version, job.lease_purpose, job.lease_expires_at;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
END;
$$;

-- Persist the encrypted deterministic locator before the worker uploads any
-- bytes. If the subsequent upload or completion loses its lease, the object is
-- still visible to account-deletion and artifact-cleanup gates. An exact retry
-- is idempotent for both a lost response and a locator retained across attempts.
CREATE FUNCTION public.export_stage_job_artifact(
  p_export_id uuid,
  p_worker_hash varchar,
  p_worker_hash_key_version varchar,
  p_expected_state_version bigint,
  p_artifact_locator_ciphertext bytea,
  p_artifact_encryption_key_version varchar,
  p_artifact_sha256 varchar,
  p_artifact_size_bytes bigint,
  p_artifact_content_type varchar
)
RETURNS TABLE(new_state_version bigint, lease_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF p_artifact_locator_ciphertext IS NULL
    OR octet_length(p_artifact_locator_ciphertext) NOT BETWEEN 16 AND 4096
    OR p_artifact_encryption_key_version IS NULL
    OR p_artifact_encryption_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_artifact_sha256 IS NULL
    OR p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    OR p_artifact_size_bytes IS NULL
    OR p_artifact_size_bytes NOT BETWEEN 1 AND 10485760
    OR p_artifact_content_type IS NULL
    OR p_artifact_content_type <> 'application/json' THEN
    RAISE EXCEPTION 'invalid staged export artifact expectation';
  END IF;
  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);
  RETURN QUERY
  UPDATE public.data_export_jobs AS job
  SET artifact_locator_ciphertext = p_artifact_locator_ciphertext,
      encryption_key_version = p_artifact_encryption_key_version,
      artifact_sha256 = p_artifact_sha256,
      artifact_size_bytes = p_artifact_size_bytes,
      artifact_content_type = p_artifact_content_type,
      state_version = job.state_version + 1
  WHERE job.id = p_export_id
    AND job.status = 'PROCESSING'
    AND job.state_version = p_expected_state_version
    AND job.lease_purpose = 'BUILD'
    AND job.lease_owner_hash = p_worker_hash
    AND job.lease_owner_hash_key_version = p_worker_hash_key_version
    AND job.lease_owner_hash_algorithm = 'HMAC-SHA256'
    AND job.lease_expires_at > event_time
    AND job.expires_at > event_time
    AND job.artifact_locator_ciphertext IS NULL
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = job.user_id AND status = 'ACTIVE'
    )
  RETURNING job.state_version, job.lease_expires_at;
  IF FOUND THEN
    PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
    RETURN;
  END IF;

  -- Lost-response replay (expected + 1) and a new-attempt replay (expected)
  -- both return the already staged locator's fencing version without mutation.
  RETURN QUERY
  SELECT job.state_version, job.lease_expires_at
  FROM public.data_export_jobs AS job
  WHERE job.id = p_export_id
    AND job.status = 'PROCESSING'
    AND job.state_version IN (p_expected_state_version, p_expected_state_version + 1)
    AND job.lease_purpose = 'BUILD'
    AND job.lease_owner_hash = p_worker_hash
    AND job.lease_owner_hash_key_version = p_worker_hash_key_version
    AND job.lease_owner_hash_algorithm = 'HMAC-SHA256'
    AND job.lease_expires_at > event_time
    AND job.expires_at > event_time
    AND job.artifact_locator_ciphertext = p_artifact_locator_ciphertext
    AND job.encryption_key_version = p_artifact_encryption_key_version
    AND job.artifact_sha256 = p_artifact_sha256
    AND job.artifact_size_bytes = p_artifact_size_bytes
    AND job.artifact_content_type = p_artifact_content_type;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
END;
$$;

CREATE FUNCTION public.export_build_safe_snapshot(
  p_export_id uuid,
  p_worker_hash varchar,
  p_worker_hash_key_version varchar
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  export_job public.data_export_jobs%ROWTYPE;
  account_user public.users%ROWTYPE;
  identity_items jsonb;
  favorite_items jsonb;
  history_items jsonb := '[]'::jsonb;
  private_feedback_items jsonb := '[]'::jsonb;
  encrypted_support_feedback_items jsonb;
  snapshot_item_count integer;
BEGIN
  SELECT job.* INTO export_job
  FROM public.data_export_jobs AS job
  WHERE job.id = p_export_id
    AND job.status = 'PROCESSING'
    AND job.lease_purpose = 'BUILD'
    AND job.lease_owner_hash = p_worker_hash
    AND job.lease_owner_hash_key_version = p_worker_hash_key_version
    AND job.lease_owner_hash_algorithm = 'HMAC-SHA256'
    AND job.lease_expires_at > now()
    AND job.expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'data export build lease is not current';
  END IF;

  SELECT account.* INTO account_user
  FROM public.users AS account
  WHERE account.id = export_job.user_id AND account.status = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'data export subject is not active';
  END IF;

  SELECT count(*) INTO snapshot_item_count
  FROM (
    SELECT binding.id
    FROM public.identity_bindings AS binding
    WHERE binding.user_id = export_job.user_id
    LIMIT 33
  ) AS bounded_identities;
  IF snapshot_item_count > 32 THEN
    RAISE EXCEPTION 'data export identity item budget exceeded'
      USING ERRCODE = '54000';
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'identityType', binding.identity_type,
        'maskedDisplayHint', binding.masked_display_hint,
        'isPrimary', binding.is_primary,
        'verifiedAt', to_char(
          binding.verified_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'createdAt', to_char(
          binding.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'revokedAt', CASE WHEN binding.revoked_at IS NULL THEN NULL ELSE to_char(
          binding.revoked_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) END
      )) ORDER BY binding.created_at, binding.id
    ),
    '[]'::jsonb
  ) INTO identity_items
  FROM public.identity_bindings AS binding
  WHERE binding.user_id = export_job.user_id;

  SELECT count(*) INTO snapshot_item_count
  FROM (
    SELECT favorite.id
    FROM public.favorites AS favorite
    WHERE favorite.user_id = export_job.user_id
    LIMIT 1001
  ) AS bounded_favorites;
  IF snapshot_item_count > 1000 THEN
    RAISE EXCEPTION 'data export favorite item budget exceeded'
      USING ERRCODE = '54000';
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'favoriteId', favorite.id,
        'group', favorite.favorite_group,
        'createdAt', to_char(
          favorite.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'placeReferenceAvailable',
          favorite.external_place_reference_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.active_external_place_references AS active_reference
            WHERE active_reference.id = favorite.external_place_reference_id
          )
      ) ORDER BY favorite.created_at, favorite.id
    ),
    '[]'::jsonb
  ) INTO favorite_items
  FROM public.favorites AS favorite
  WHERE favorite.user_id = export_job.user_id;

  IF export_job.include_behavior_history THEN
    SELECT count(*) INTO snapshot_item_count
    FROM (
      SELECT history.id
      FROM public.recommendation_history AS history
      WHERE history.user_id = export_job.user_id
        AND history.retain_until > now()
      LIMIT 5001
    ) AS bounded_history;
    IF snapshot_item_count > 5000 THEN
      RAISE EXCEPTION 'data export history item budget exceeded'
        USING ERRCODE = '54000';
    END IF;
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'historyId', history.id,
          'action', history.event_type,
          'mealPeriod', history.meal_period,
          'occurredAt', to_char(
            history.occurred_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'placeReferenceAvailable',
            history.external_place_reference_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.active_external_place_references AS active_reference
              WHERE active_reference.id = history.external_place_reference_id
            )
        ) ORDER BY history.occurred_at, history.id
      ),
      '[]'::jsonb
    ) INTO history_items
    FROM public.recommendation_history AS history
    WHERE history.user_id = export_job.user_id
      AND history.retain_until > now();

    SELECT count(*) INTO snapshot_item_count
    FROM (
      SELECT feedback.id
      FROM public.private_recommendation_feedback AS feedback
      WHERE feedback.user_id = export_job.user_id
      LIMIT 2001
    ) AS bounded_private_feedback;
    IF snapshot_item_count > 2000 THEN
      RAISE EXCEPTION 'data export private feedback item budget exceeded'
        USING ERRCODE = '54000';
    END IF;
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'feedbackId', feedback.id,
          'type', feedback.feedback_type,
          'createdAt', to_char(
            feedback.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'placeReferenceAvailable',
            feedback.external_place_reference_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.active_external_place_references AS active_reference
              WHERE active_reference.id = feedback.external_place_reference_id
            )
        ) ORDER BY feedback.created_at, feedback.id
      ),
      '[]'::jsonb
    ) INTO private_feedback_items
    FROM public.private_recommendation_feedback AS feedback
    WHERE feedback.user_id = export_job.user_id;
  END IF;

  SELECT count(*) INTO snapshot_item_count
  FROM (
    SELECT support.id
    FROM public.support_feedback AS support
    WHERE support.user_id = export_job.user_id
      AND (support.retain_until IS NULL OR support.retain_until > now())
    LIMIT 101
  ) AS bounded_support_feedback;
  IF snapshot_item_count > 100 THEN
    RAISE EXCEPTION 'data export support feedback item budget exceeded'
      USING ERRCODE = '54000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.support_feedback AS support
    WHERE support.user_id = export_job.user_id
      AND (support.retain_until IS NULL OR support.retain_until > now())
      AND octet_length(support.content_ciphertext) NOT BETWEEN 16 AND 65536
  ) THEN
    RAISE EXCEPTION 'support feedback ciphertext exceeds export bounds';
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'feedbackId', support.id,
        'category', support.category,
        'status', support.status,
        'createdAt', to_char(
          support.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'closedAt', CASE WHEN support.closed_at IS NULL THEN NULL ELSE to_char(
          support.closed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) END,
        'ciphertextBase64', replace(
          encode(support.content_ciphertext, 'base64'), E'\n', ''
        ),
        'encryptionKeyVersion', support.encryption_key_version
      )) ORDER BY support.created_at, support.id
    ),
    '[]'::jsonb
  ) INTO encrypted_support_feedback_items
  FROM public.support_feedback AS support
  WHERE support.user_id = export_job.user_id
    AND (support.retain_until IS NULL OR support.retain_until > now());

  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', to_char(
      export_job.created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'account', jsonb_build_object(
      'accountId', account_user.id,
      'status', account_user.status,
      'createdAt', to_char(
        account_user.created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    ),
    'identities', identity_items,
    'favorites', favorite_items,
    'recommendationHistory', history_items,
    'privateFeedback', private_feedback_items,
    -- Android 1.0 preferences are local-only. Keep an explicit empty object so
    -- consumers do not mistake the absence of a server table for an omission.
    'preferences', '{}'::jsonb,
    -- Worker-only intermediate material. The worker must decrypt and rebuild a
    -- strict public `supportFeedback` array; these three crypto fields are
    -- forbidden in the uploaded artifact.
    'supportFeedbackEncrypted', encrypted_support_feedback_items
  );
END;
$$;

CREATE FUNCTION public.export_complete_job(
  p_export_id uuid,
  p_worker_hash varchar,
  p_worker_hash_key_version varchar,
  p_expected_state_version bigint
)
RETURNS TABLE(new_state_version bigint, ready_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);
  RETURN QUERY
  UPDATE public.data_export_jobs AS job
  SET status = 'READY',
      ready_at = event_time,
      completed_at = event_time,
      failure_code = NULL,
      lease_purpose = NULL,
      lease_owner_hash = NULL,
      lease_owner_hash_algorithm = NULL,
      lease_owner_hash_key_version = NULL,
      lease_expires_at = NULL,
      state_version = job.state_version + 1
  WHERE job.id = p_export_id
    AND job.status = 'PROCESSING'
    AND job.state_version = p_expected_state_version
    AND job.lease_purpose = 'BUILD'
    AND job.lease_owner_hash = p_worker_hash
    AND job.lease_owner_hash_key_version = p_worker_hash_key_version
    AND job.lease_owner_hash_algorithm = 'HMAC-SHA256'
    AND job.lease_expires_at > event_time
    AND job.expires_at > event_time
    AND job.artifact_locator_ciphertext IS NOT NULL
    AND job.encryption_key_version IS NOT NULL
    AND job.artifact_sha256 ~ '^[0-9a-f]{64}$'
    AND job.artifact_size_bytes BETWEEN 1 AND 10485760
    AND job.artifact_content_type = 'application/json'
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = job.user_id AND status = 'ACTIVE'
    )
  RETURNING job.state_version, job.ready_at, job.expires_at;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
END;
$$;

CREATE FUNCTION public.export_fail_job(
  p_export_id uuid,
  p_worker_hash varchar,
  p_worker_hash_key_version varchar,
  p_expected_state_version bigint,
  p_failure_code varchar,
  p_retryable boolean
)
RETURNS TABLE(export_status text, new_state_version bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF p_failure_code IS NULL OR p_failure_code NOT IN (
      'SOURCE_READ_FAILED', 'SNAPSHOT_TOO_LARGE', 'ARTIFACT_UPLOAD_FAILED',
      'ARTIFACT_VERIFY_FAILED', 'LEASE_EXPIRED', 'RETRY_EXHAUSTED',
      'INTERNAL_ERROR'
    ) OR p_retryable IS NULL THEN
    RAISE EXCEPTION 'invalid export failure result';
  END IF;
  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);
  RETURN QUERY
  UPDATE public.data_export_jobs AS job
  SET status = CASE
        WHEN job.expires_at <= event_time THEN 'EXPIRED'
        WHEN p_retryable AND job.attempt_count < 5 AND EXISTS (
          SELECT 1 FROM public.users
          WHERE id = job.user_id AND status = 'ACTIVE'
        ) THEN 'PENDING'
        WHEN job.artifact_locator_ciphertext IS NOT NULL THEN 'EXPIRED'
        ELSE 'FAILED'
      END,
      completed_at = CASE
        WHEN job.expires_at <= event_time THEN event_time
        WHEN p_retryable AND job.attempt_count < 5 AND EXISTS (
          SELECT 1 FROM public.users
          WHERE id = job.user_id AND status = 'ACTIVE'
        ) THEN NULL
        ELSE event_time
      END,
      failure_code = p_failure_code,
      lease_purpose = NULL,
      lease_owner_hash = NULL,
      lease_owner_hash_algorithm = NULL,
      lease_owner_hash_key_version = NULL,
      lease_expires_at = NULL,
      state_version = job.state_version + 1
  WHERE job.id = p_export_id
    AND job.status = 'PROCESSING'
    AND job.state_version = p_expected_state_version
    AND job.lease_purpose = 'BUILD'
    AND job.lease_owner_hash = p_worker_hash
    AND job.lease_owner_hash_key_version = p_worker_hash_key_version
    AND job.lease_owner_hash_algorithm = 'HMAC-SHA256'
    AND job.lease_expires_at > event_time
  RETURNING CASE job.status WHEN 'PENDING' THEN 'QUEUED' ELSE job.status END,
    job.state_version;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
END;
$$;

CREATE FUNCTION public.export_claim_next_artifact_deletion(
  p_worker_hash varchar,
  p_worker_hash_key_version varchar,
  p_lease_seconds integer
)
RETURNS TABLE(
  export_id uuid,
  state_version bigint,
  artifact_locator_ciphertext bytea,
  artifact_encryption_key_version varchar,
  artifact_sha256 varchar,
  artifact_size_bytes bigint,
  artifact_content_type varchar,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  IF p_worker_hash IS NULL OR p_worker_hash !~ '^[0-9a-f]{64}$'
    OR p_worker_hash_key_version IS NULL
    OR p_worker_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_lease_seconds IS NULL
    OR p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid artifact deletion lease request';
  END IF;
  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);

  -- An account can enter DELETION_PENDING after queue/claim but before stage.
  -- No object can legally have been uploaded because stage is mandatory first,
  -- so cancel these rows immediately and advance the fencing version. Any row
  -- with a locator is deliberately excluded and must follow OSS deletion.
  UPDATE public.data_export_jobs AS inactive_unstaged
  SET status = 'FAILED',
      completed_at = event_time,
      failure_code = 'ACCOUNT_DELETION_REQUESTED',
      lease_purpose = NULL,
      lease_owner_hash = NULL,
      lease_owner_hash_algorithm = NULL,
      lease_owner_hash_key_version = NULL,
      lease_expires_at = NULL,
      state_version = inactive_unstaged.state_version + 1
  WHERE inactive_unstaged.status IN ('PENDING', 'PROCESSING')
    AND inactive_unstaged.artifact_locator_ciphertext IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.users
      WHERE id = inactive_unstaged.user_id AND status = 'ACTIVE'
    );

  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
    FROM public.data_export_jobs AS job
    WHERE job.artifact_locator_ciphertext IS NOT NULL
      AND job.artifact_deleted_at IS NULL
      AND (
        (
          job.status = 'READY'
          AND (
            job.expires_at <= event_time
            OR NOT EXISTS (
              SELECT 1 FROM public.users
              WHERE id = job.user_id AND status = 'ACTIVE'
            )
          )
        )
        OR (
          job.status = 'EXPIRED'
          AND (job.lease_purpose IS NULL OR job.lease_expires_at <= event_time)
        )
        OR (
          job.status = 'PENDING'
          AND (
            job.expires_at <= event_time
            OR NOT EXISTS (
              SELECT 1 FROM public.users
              WHERE id = job.user_id AND status = 'ACTIVE'
            )
          )
        )
        OR (
          job.status = 'PROCESSING'
          AND job.lease_purpose = 'BUILD'
          AND job.lease_expires_at <= event_time
          AND (
            job.expires_at <= event_time
            OR job.attempt_count >= 5
            OR NOT EXISTS (
              SELECT 1 FROM public.users
              WHERE id = job.user_id AND status = 'ACTIVE'
            )
          )
        )
      )
    ORDER BY job.expires_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE public.data_export_jobs AS job
    SET status = 'EXPIRED',
        completed_at = COALESCE(job.completed_at, event_time),
        lease_purpose = 'DELETE',
        lease_owner_hash = p_worker_hash,
        lease_owner_hash_algorithm = 'HMAC-SHA256',
        lease_owner_hash_key_version = p_worker_hash_key_version,
        lease_expires_at = event_time + make_interval(secs => p_lease_seconds),
        state_version = job.state_version + 1
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.id, job.state_version, job.artifact_locator_ciphertext,
      job.encryption_key_version, job.artifact_sha256, job.artifact_size_bytes,
      job.artifact_content_type, job.lease_expires_at
  )
  SELECT claimed.id, claimed.state_version,
    claimed.artifact_locator_ciphertext, claimed.encryption_key_version,
    claimed.artifact_sha256, claimed.artifact_size_bytes,
    claimed.artifact_content_type, claimed.lease_expires_at
  FROM claimed;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
END;
$$;

CREATE FUNCTION public.export_mark_artifact_deleted(
  p_export_id uuid,
  p_worker_hash varchar,
  p_worker_hash_key_version varchar,
  p_expected_state_version bigint
)
RETURNS TABLE(new_state_version bigint, artifact_deleted_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE event_time timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);
  RETURN QUERY
  UPDATE public.data_export_jobs AS job
  SET artifact_deleted_at = event_time,
      lease_purpose = NULL,
      lease_owner_hash = NULL,
      lease_owner_hash_algorithm = NULL,
      lease_owner_hash_key_version = NULL,
      lease_expires_at = NULL,
      state_version = job.state_version + 1
  WHERE job.id = p_export_id
    AND job.status = 'EXPIRED'
    AND job.state_version = p_expected_state_version
    AND job.artifact_locator_ciphertext IS NOT NULL
    AND job.artifact_deleted_at IS NULL
    AND job.lease_purpose = 'DELETE'
    AND job.lease_owner_hash = p_worker_hash
    AND job.lease_owner_hash_key_version = p_worker_hash_key_version
    AND job.lease_owner_hash_algorithm = 'HMAC-SHA256'
    AND job.lease_expires_at > event_time
  RETURNING job.state_version, job.artifact_deleted_at;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
END;
$$;

-- Account purging must not race a pending/leased build, and must never cascade
-- away the only record of an app-owned object that has not been deleted.
CREATE OR REPLACE FUNCTION public.complete_account_deletion(
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
      AND (
        status IN ('PENDING', 'PROCESSING')
        OR (
          artifact_locator_ciphertext IS NOT NULL
          AND artifact_deleted_at IS NULL
        )
      )
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

CREATE OR REPLACE FUNCTION public.preview_retention_cleanup()
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

CREATE OR REPLACE FUNCTION public.execute_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  total_affected bigint := 0;
  event_time timestamptz := clock_timestamp();
BEGIN
  DELETE FROM public.recommendation_history WHERE retain_until <= event_time;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'RECOMMENDATION_HISTORY_90D'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.support_feedback
    WHERE retain_until IS NOT NULL AND retain_until <= event_time;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'CLOSED_SUPPORT_FEEDBACK_180D'; total_affected := total_affected + affected_count;
  RETURN NEXT;

  -- Fence every expired in-flight job before metadata deletion. A stale worker
  -- then receives zero rows from complete/fail and must delete its own rejected
  -- upload instead of creating an untracked object.
  PERFORM set_config('chi_shen_me.data_export_transition', 'enabled', true);
  UPDATE public.data_export_jobs AS job
  SET status = 'EXPIRED',
      completed_at = COALESCE(job.completed_at, event_time),
      lease_purpose = NULL,
      lease_owner_hash = NULL,
      lease_owner_hash_algorithm = NULL,
      lease_owner_hash_key_version = NULL,
      lease_expires_at = NULL,
      state_version = job.state_version + 1
  WHERE job.expires_at <= event_time AND job.status <> 'EXPIRED';
  DELETE FROM public.data_export_jobs
    WHERE expires_at <= event_time
      AND (artifact_locator_ciphertext IS NULL OR artifact_deleted_at IS NOT NULL);
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.data_export_transition', 'disabled', true);
  policy_code := 'EXPORT_METADATA_7D'; total_affected := total_affected + affected_count;
  RETURN NEXT;

  DELETE FROM public.account_deletion_jobs
    WHERE retain_until IS NOT NULL AND retain_until <= event_time;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'ACCOUNT_DELETION_TOMBSTONE_30D'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.otp_challenges WHERE retain_until <= event_time;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'OTP_24H'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.oauth_states WHERE retain_until <= event_time;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'OAUTH_STATE_24H'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.auth_access_tokens WHERE retain_until <= event_time;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  policy_code := 'ACCESS_TOKEN_24H_AFTER_EXPIRY'; total_affected := total_affected + affected_count;
  RETURN NEXT;
  DELETE FROM public.auth_session_families WHERE retain_until <= event_time;
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

REVOKE ALL ON public.data_export_jobs FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_data_export_job_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protect_data_export_job_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_queue_data_export(uuid, uuid, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_get_data_export_status(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_get_latest_data_export_status(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.app_open_data_export_artifact(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_artifact_required_locator_key_versions()
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_claim_next_job(varchar, varchar, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_renew_job_lease(
  uuid, varchar, varchar, bigint, integer
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_stage_job_artifact(
  uuid, varchar, varchar, bigint, bytea, varchar, varchar, bigint, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_build_safe_snapshot(uuid, varchar, varchar)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_complete_job(
  uuid, varchar, varchar, bigint
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_fail_job(
  uuid, varchar, varchar, bigint, varchar, boolean
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_claim_next_artifact_deletion(
  varchar, varchar, integer
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_mark_artifact_deleted(
  uuid, varchar, varchar, bigint
) FROM PUBLIC;
