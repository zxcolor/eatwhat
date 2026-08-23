-- Provider-neutral persistence API foundation.
-- Public resources retain only App-owned IDs and user-owned product state.
-- Provider codes and provider place IDs remain behind SECURITY DEFINER calls.

ALTER TABLE public.favorites
  DROP CONSTRAINT favorites_external_place_reference_id_fkey;
ALTER TABLE public.favorites
  ALTER COLUMN external_place_reference_id DROP NOT NULL;
ALTER TABLE public.favorites
  ADD CONSTRAINT favorites_external_place_reference_id_fkey
  FOREIGN KEY (external_place_reference_id)
  REFERENCES public.external_place_references(id) ON DELETE SET NULL;
ALTER TABLE public.favorites
  ADD COLUMN rights_revoked_at timestamptz;
ALTER TABLE public.favorites
  ADD CONSTRAINT favorites_reference_or_tombstone CHECK (
    (external_place_reference_id IS NOT NULL AND rights_revoked_at IS NULL)
    OR (external_place_reference_id IS NULL AND rights_revoked_at IS NOT NULL)
  );

ALTER TABLE public.recommendation_history
  ADD COLUMN rights_revoked_at timestamptz;
ALTER TABLE public.recommendation_history
  ADD CONSTRAINT recommendation_history_revocation_shape CHECK (
    rights_revoked_at IS NULL OR external_place_reference_id IS NULL
  );

ALTER TABLE public.private_recommendation_feedback
  ADD COLUMN rights_revoked_at timestamptz;
ALTER TABLE public.private_recommendation_feedback
  ADD CONSTRAINT private_feedback_reference_or_tombstone CHECK (
    (external_place_reference_id IS NOT NULL AND rights_revoked_at IS NULL)
    OR (external_place_reference_id IS NULL AND rights_revoked_at IS NOT NULL)
  );

CREATE INDEX favorites_user_cursor_idx
  ON public.favorites(user_id, created_at DESC, id DESC);
CREATE INDEX recommendation_history_user_cursor_idx
  ON public.recommendation_history(user_id, occurred_at DESC, id DESC);
CREATE INDEX private_feedback_user_cursor_idx
  ON public.private_recommendation_feedback(user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX recommendation_history_event_dedup_idx
  ON public.recommendation_history(
    user_id, request_correlation_hash, event_type, external_place_reference_id
  ) NULLS NOT DISTINCT;

CREATE TABLE public.persistence_idempotency_records (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  operation_code text NOT NULL CHECK (operation_code IN (
    'CREATE_FAVORITE', 'UPDATE_FAVORITE_GROUP', 'CREATE_PRIVATE_FEEDBACK'
  )),
  idempotency_key_hash varchar(64) NOT NULL
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key_version varchar(64) NOT NULL
    CHECK (idempotency_key_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  PRIMARY KEY (user_id, operation_code, idempotency_key_hash),
  CHECK (retain_until = created_at + interval '24 hours')
);
CREATE INDEX persistence_idempotency_retention_idx
  ON public.persistence_idempotency_records(retain_until);

CREATE FUNCTION public.claim_persistence_idempotency(
  p_user_id uuid,
  p_operation_code varchar,
  p_idempotency_key_hash varchar,
  p_idempotency_key_version varchar,
  p_request_hash varchar,
  p_proposed_resource_id uuid
)
RETURNS TABLE(outcome text, claimed_resource_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  stored_request_hash varchar;
  stored_resource_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'persistence requires an active user';
  END IF;
  IF p_operation_code NOT IN (
      'CREATE_FAVORITE', 'UPDATE_FAVORITE_GROUP', 'CREATE_PRIVATE_FEEDBACK'
    )
    OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    OR p_idempotency_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_proposed_resource_id IS NULL THEN
    RAISE EXCEPTION 'invalid persistence idempotency claim';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || p_operation_code || ':' || p_idempotency_key_hash,
      0
    )
  );
  DELETE FROM public.persistence_idempotency_records
    WHERE user_id = p_user_id
      AND operation_code = p_operation_code
      AND idempotency_key_hash = p_idempotency_key_hash
      AND retain_until <= now();

  SELECT record.request_hash, record.resource_id
    INTO stored_request_hash, stored_resource_id
    FROM public.persistence_idempotency_records AS record
    WHERE record.user_id = p_user_id
      AND record.operation_code = p_operation_code
      AND record.idempotency_key_hash = p_idempotency_key_hash
    FOR UPDATE;
  IF FOUND THEN
    outcome := CASE
      WHEN stored_request_hash = p_request_hash THEN 'REPLAY'
      ELSE 'CONFLICT'
    END;
    claimed_resource_id := stored_resource_id;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.persistence_idempotency_records (
    user_id, operation_code, idempotency_key_hash,
    idempotency_key_version, request_hash, resource_id,
    created_at, retain_until
  ) VALUES (
    p_user_id, p_operation_code, p_idempotency_key_hash,
    p_idempotency_key_version, p_request_hash, p_proposed_resource_id,
    now(), now() + interval '24 hours'
  );
  outcome := 'CLAIMED';
  claimed_resource_id := p_proposed_resource_id;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.complete_persistence_idempotency_resource(
  p_user_id uuid,
  p_operation_code varchar,
  p_idempotency_key_hash varchar,
  p_request_hash varchar,
  p_proposed_resource_id uuid,
  p_actual_resource_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_operation_code <> 'CREATE_FAVORITE'
    OR NOT EXISTS (
      SELECT 1 FROM public.favorites
      WHERE id = p_actual_resource_id AND user_id = p_user_id
    ) THEN
    RETURN false;
  END IF;
  UPDATE public.persistence_idempotency_records AS record
    SET resource_id = p_actual_resource_id
    WHERE record.user_id = p_user_id
      AND record.operation_code = p_operation_code
      AND record.idempotency_key_hash = p_idempotency_key_hash
      AND record.request_hash = p_request_hash
      AND record.resource_id = p_proposed_resource_id
      AND record.retain_until > now();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.persistence_insert_favorite(
  p_user_id uuid,
  p_favorite_id uuid,
  p_provider_code varchar,
  p_provider_place_id varchar,
  p_authorization_id uuid,
  p_retain_until timestamptz,
  p_favorite_group varchar
)
RETURNS TABLE(
  favorite_id uuid,
  favorite_group text,
  created_at timestamptz,
  rights_revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  place_reference_id uuid;
BEGIN
  IF p_favorite_group NOT IN ('WANT_TO_GO', 'REGULAR')
    OR NOT EXISTS (
      SELECT 1 FROM public.users
      WHERE id = p_user_id AND status = 'ACTIVE'
    ) THEN
    RAISE EXCEPTION 'invalid favorite creation';
  END IF;
  place_reference_id := public.persist_licensed_external_place_reference(
    p_provider_code,
    p_provider_place_id,
    p_authorization_id,
    p_retain_until
  );
  RETURN QUERY
  INSERT INTO public.favorites (
    id, user_id, external_place_reference_id, favorite_group, created_at
  ) VALUES (
    p_favorite_id, p_user_id, place_reference_id, p_favorite_group, now()
  )
  ON CONFLICT (user_id, external_place_reference_id)
  DO UPDATE SET favorite_group = EXCLUDED.favorite_group
  RETURNING public.favorites.id, public.favorites.favorite_group,
    public.favorites.created_at, public.favorites.rights_revoked_at;
END;
$$;

CREATE FUNCTION public.persistence_update_favorite_group(
  p_user_id uuid,
  p_favorite_id uuid,
  p_favorite_group varchar
)
RETURNS TABLE(
  favorite_id uuid,
  favorite_group text,
  created_at timestamptz,
  rights_revoked_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.favorites AS favorite
    SET favorite_group = p_favorite_group
    WHERE favorite.id = p_favorite_id
      AND favorite.user_id = p_user_id
      AND favorite.external_place_reference_id IS NOT NULL
      AND favorite.rights_revoked_at IS NULL
      AND p_favorite_group IN ('WANT_TO_GO', 'REGULAR')
  RETURNING favorite.id, favorite.favorite_group,
    favorite.created_at, favorite.rights_revoked_at;
$$;

CREATE FUNCTION public.persistence_get_favorite(
  p_user_id uuid,
  p_favorite_id uuid
)
RETURNS TABLE(
  favorite_id uuid,
  favorite_group text,
  created_at timestamptz,
  rights_revoked_at timestamptz,
  provider_code varchar,
  provider_place_id varchar
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT favorite.id, favorite.favorite_group, favorite.created_at,
    favorite.rights_revoked_at, reference.provider_code,
    reference.provider_place_id
  FROM public.favorites AS favorite
  LEFT JOIN public.active_external_place_references AS reference
    ON reference.id = favorite.external_place_reference_id
  WHERE favorite.user_id = p_user_id AND favorite.id = p_favorite_id;
$$;

CREATE FUNCTION public.persistence_list_favorites(
  p_user_id uuid,
  p_before_created_at timestamptz,
  p_before_id uuid,
  p_limit integer,
  p_favorite_group varchar
)
RETURNS TABLE(
  favorite_id uuid,
  favorite_group text,
  created_at timestamptz,
  rights_revoked_at timestamptz,
  provider_code varchar,
  provider_place_id varchar
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 51
    OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL))
    OR (p_favorite_group IS NOT NULL
      AND p_favorite_group NOT IN ('WANT_TO_GO', 'REGULAR')) THEN
    RAISE EXCEPTION 'invalid favorite page request';
  END IF;
  RETURN QUERY
  SELECT favorite.id, favorite.favorite_group, favorite.created_at,
    favorite.rights_revoked_at, reference.provider_code,
    reference.provider_place_id
  FROM public.favorites AS favorite
  LEFT JOIN public.active_external_place_references AS reference
    ON reference.id = favorite.external_place_reference_id
  WHERE favorite.user_id = p_user_id
    AND (p_favorite_group IS NULL OR favorite.favorite_group = p_favorite_group)
    AND (
      p_before_created_at IS NULL
      OR (favorite.created_at, favorite.id) < (p_before_created_at, p_before_id)
    )
  ORDER BY favorite.created_at DESC, favorite.id DESC
  LIMIT p_limit;
END;
$$;

CREATE FUNCTION public.persistence_delete_favorite(
  p_user_id uuid,
  p_favorite_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.favorites
    WHERE user_id = p_user_id AND id = p_favorite_id;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.persistence_record_history(
  p_user_id uuid,
  p_history_id uuid,
  p_provider_code varchar,
  p_provider_place_id varchar,
  p_authorization_id uuid,
  p_reference_retain_until timestamptz,
  p_request_correlation_hash varchar,
  p_hash_key_version varchar,
  p_event_type varchar,
  p_meal_period varchar
)
RETURNS TABLE(history_id uuid, occurred_at timestamptz, retain_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  place_reference_id uuid;
  event_time timestamptz := now();
BEGIN
  IF p_request_correlation_hash !~ '^[0-9a-f]{64}$'
    OR p_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_event_type NOT IN (
      'IMPRESSION', 'DETAIL', 'FAVORITE', 'NAVIGATION', 'CALL', 'REROLL'
    )
    OR p_meal_period NOT IN ('BREAKFAST', 'LUNCH', 'DINNER')
    OR NOT EXISTS (
      SELECT 1 FROM public.users
      WHERE id = p_user_id AND status = 'ACTIVE'
    ) THEN
    RAISE EXCEPTION 'invalid recommendation history event';
  END IF;
  place_reference_id := public.persist_licensed_external_place_reference(
    p_provider_code,
    p_provider_place_id,
    p_authorization_id,
    p_reference_retain_until
  );
  RETURN QUERY
  INSERT INTO public.recommendation_history (
    id, user_id, external_place_reference_id, request_correlation_hash,
    hash_key_version, event_type, meal_period, occurred_at, retain_until
  ) VALUES (
    p_history_id, p_user_id, place_reference_id, p_request_correlation_hash,
    p_hash_key_version, p_event_type, p_meal_period,
    event_time, event_time + interval '90 days'
  )
  ON CONFLICT (
    user_id, request_correlation_hash, event_type, external_place_reference_id
  ) DO UPDATE SET request_correlation_hash = EXCLUDED.request_correlation_hash
  RETURNING public.recommendation_history.id,
    public.recommendation_history.occurred_at,
    public.recommendation_history.retain_until;
END;
$$;

CREATE FUNCTION public.persistence_list_history(
  p_user_id uuid,
  p_before_occurred_at timestamptz,
  p_before_id uuid,
  p_limit integer,
  p_event_type varchar
)
RETURNS TABLE(
  history_id uuid,
  event_type text,
  meal_period text,
  occurred_at timestamptz,
  retain_until timestamptz,
  rights_revoked_at timestamptz,
  provider_code varchar,
  provider_place_id varchar
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 51
    OR ((p_before_occurred_at IS NULL) <> (p_before_id IS NULL))
    OR (p_event_type IS NOT NULL AND p_event_type NOT IN (
      'IMPRESSION', 'DETAIL', 'FAVORITE', 'NAVIGATION', 'CALL', 'REROLL'
    )) THEN
    RAISE EXCEPTION 'invalid recommendation history page request';
  END IF;
  RETURN QUERY
  SELECT history.id, history.event_type, history.meal_period,
    history.occurred_at, history.retain_until, history.rights_revoked_at,
    reference.provider_code, reference.provider_place_id
  FROM public.recommendation_history AS history
  LEFT JOIN public.active_external_place_references AS reference
    ON reference.id = history.external_place_reference_id
  WHERE history.user_id = p_user_id
    AND history.retain_until > now()
    AND (p_event_type IS NULL OR history.event_type = p_event_type)
    AND (
      p_before_occurred_at IS NULL
      OR (history.occurred_at, history.id) < (p_before_occurred_at, p_before_id)
    )
  ORDER BY history.occurred_at DESC, history.id DESC
  LIMIT p_limit;
END;
$$;

CREATE FUNCTION public.persistence_clear_history(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE affected_rows bigint;
BEGIN
  DELETE FROM public.recommendation_history WHERE user_id = p_user_id;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

CREATE FUNCTION public.persistence_insert_private_feedback(
  p_user_id uuid,
  p_feedback_id uuid,
  p_provider_code varchar,
  p_provider_place_id varchar,
  p_authorization_id uuid,
  p_retain_until timestamptz,
  p_request_correlation_hash varchar,
  p_hash_key_version varchar,
  p_feedback_type varchar
)
RETURNS TABLE(feedback_id uuid, feedback_type text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE place_reference_id uuid;
BEGIN
  IF p_request_correlation_hash !~ '^[0-9a-f]{64}$'
    OR p_hash_key_version !~ '^[A-Za-z0-9_.-]{1,64}$'
    OR p_feedback_type NOT IN (
      'WANT_TO_EAT', 'ATE', 'LIKE', 'DISLIKE', 'TOO_FAR', 'TOO_EXPENSIVE',
      'ATE_RECENTLY', 'EXCLUDE_CUISINE'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.users
      WHERE id = p_user_id AND status = 'ACTIVE'
    ) THEN
    RAISE EXCEPTION 'invalid private recommendation feedback';
  END IF;
  place_reference_id := public.persist_licensed_external_place_reference(
    p_provider_code,
    p_provider_place_id,
    p_authorization_id,
    p_retain_until
  );
  RETURN QUERY
  INSERT INTO public.private_recommendation_feedback (
    id, user_id, external_place_reference_id, request_correlation_hash,
    hash_key_version, feedback_type, created_at
  ) VALUES (
    p_feedback_id, p_user_id, place_reference_id,
    p_request_correlation_hash, p_hash_key_version, p_feedback_type, now()
  )
  RETURNING public.private_recommendation_feedback.id,
    public.private_recommendation_feedback.feedback_type,
    public.private_recommendation_feedback.created_at;
END;
$$;

CREATE FUNCTION public.persistence_get_private_feedback(
  p_user_id uuid,
  p_feedback_id uuid
)
RETURNS TABLE(
  feedback_id uuid,
  feedback_type text,
  created_at timestamptz,
  rights_revoked_at timestamptz,
  provider_code varchar,
  provider_place_id varchar
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT feedback.id, feedback.feedback_type, feedback.created_at,
    feedback.rights_revoked_at, reference.provider_code,
    reference.provider_place_id
  FROM public.private_recommendation_feedback AS feedback
  LEFT JOIN public.active_external_place_references AS reference
    ON reference.id = feedback.external_place_reference_id
  WHERE feedback.user_id = p_user_id AND feedback.id = p_feedback_id;
$$;

CREATE FUNCTION public.persistence_list_private_feedback(
  p_user_id uuid,
  p_before_created_at timestamptz,
  p_before_id uuid,
  p_limit integer,
  p_feedback_type varchar
)
RETURNS TABLE(
  feedback_id uuid,
  feedback_type text,
  created_at timestamptz,
  rights_revoked_at timestamptz,
  provider_code varchar,
  provider_place_id varchar
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 51
    OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL))
    OR (p_feedback_type IS NOT NULL AND p_feedback_type NOT IN (
      'WANT_TO_EAT', 'ATE', 'LIKE', 'DISLIKE', 'TOO_FAR', 'TOO_EXPENSIVE',
      'ATE_RECENTLY', 'EXCLUDE_CUISINE'
    )) THEN
    RAISE EXCEPTION 'invalid private feedback page request';
  END IF;
  RETURN QUERY
  SELECT feedback.id, feedback.feedback_type, feedback.created_at,
    feedback.rights_revoked_at, reference.provider_code,
    reference.provider_place_id
  FROM public.private_recommendation_feedback AS feedback
  LEFT JOIN public.active_external_place_references AS reference
    ON reference.id = feedback.external_place_reference_id
  WHERE feedback.user_id = p_user_id
    AND (p_feedback_type IS NULL OR feedback.feedback_type = p_feedback_type)
    AND (
      p_before_created_at IS NULL
      OR (feedback.created_at, feedback.id) < (p_before_created_at, p_before_id)
    )
  ORDER BY feedback.created_at DESC, feedback.id DESC
  LIMIT p_limit;
END;
$$;

CREATE FUNCTION public.persistence_delete_private_feedback(
  p_user_id uuid,
  p_feedback_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.private_recommendation_feedback
    WHERE user_id = p_user_id AND id = p_feedback_id;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.persistence_clear_private_feedback(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE affected_rows bigint;
BEGIN
  DELETE FROM public.private_recommendation_feedback WHERE user_id = p_user_id;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

-- Rights loss must not strand user-owned delete controls. Keep only App-owned
-- resource IDs and product state; remove every provider reference atomically.
CREATE OR REPLACE FUNCTION public.revoke_data_rights_authorization(
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
  UPDATE public.favorites AS favorite
    SET external_place_reference_id = NULL,
        rights_revoked_at = event_time
    FROM public.external_place_references AS reference
    WHERE favorite.external_place_reference_id = reference.id
      AND reference.authorization_id = target_authorization_id;
  UPDATE public.recommendation_history AS history
    SET external_place_reference_id = NULL,
        rights_revoked_at = event_time
    FROM public.external_place_references AS reference
    WHERE history.external_place_reference_id = reference.id
      AND reference.authorization_id = target_authorization_id;
  UPDATE public.private_recommendation_feedback AS feedback
    SET external_place_reference_id = NULL,
        rights_revoked_at = event_time
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

CREATE OR REPLACE FUNCTION public.purge_inactive_external_place_references()
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
  UPDATE public.favorites
    SET external_place_reference_id = NULL,
        rights_revoked_at = event_time
    WHERE external_place_reference_id = ANY(inactive_ids);
  UPDATE public.recommendation_history
    SET external_place_reference_id = NULL,
        rights_revoked_at = event_time
    WHERE external_place_reference_id = ANY(inactive_ids);
  UPDATE public.private_recommendation_feedback
    SET external_place_reference_id = NULL,
        rights_revoked_at = event_time
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

CREATE FUNCTION public.preview_persistence_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT 'PERSISTENCE_IDEMPOTENCY_24H'::text, count(*)::bigint
  FROM public.persistence_idempotency_records
  WHERE retain_until <= now();
$$;

CREATE FUNCTION public.execute_persistence_retention_cleanup()
RETURNS TABLE(policy_code text, affected_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE removed_count bigint;
BEGIN
  DELETE FROM public.persistence_idempotency_records WHERE retain_until <= now();
  GET DIAGNOSTICS removed_count = ROW_COUNT;
  RETURN QUERY SELECT 'PERSISTENCE_IDEMPOTENCY_24H'::text, removed_count;
END;
$$;

REVOKE ALL ON public.persistence_idempotency_records FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_persistence_idempotency(
  uuid, varchar, varchar, varchar, varchar, uuid
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_persistence_idempotency_resource(
  uuid, varchar, varchar, varchar, uuid, uuid
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_insert_favorite(
  uuid, uuid, varchar, varchar, uuid, timestamptz, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_update_favorite_group(
  uuid, uuid, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_get_favorite(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_list_favorites(
  uuid, timestamptz, uuid, integer, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_delete_favorite(uuid, uuid)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_record_history(
  uuid, uuid, varchar, varchar, uuid, timestamptz,
  varchar, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_list_history(
  uuid, timestamptz, uuid, integer, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_clear_history(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_insert_private_feedback(
  uuid, uuid, varchar, varchar, uuid, timestamptz,
  varchar, varchar, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_get_private_feedback(uuid, uuid)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_list_private_feedback(
  uuid, timestamptz, uuid, integer, varchar
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_delete_private_feedback(uuid, uuid)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.persistence_clear_private_feedback(uuid)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.preview_persistence_retention_cleanup()
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.execute_persistence_retention_cleanup()
  FROM PUBLIC;
