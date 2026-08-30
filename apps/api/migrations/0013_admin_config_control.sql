-- Fixed-key application configuration control plane.
-- Configuration values are deliberately non-secret, schema-bound JSON. The
-- administrator and ordinary API roles only reach this table through the
-- SECURITY DEFINER functions declared below.

ALTER TABLE public.app_config_versions
  ADD COLUMN change_reason text;

UPDATE public.app_config_versions
SET change_reason = 'ROUTINE_TUNING'
WHERE change_reason IS NULL;

ALTER TABLE public.app_config_versions
  ALTER COLUMN change_reason SET NOT NULL,
  ADD CONSTRAINT app_config_change_reason_fixed CHECK (change_reason IN (
    'ROUTINE_TUNING', 'INCIDENT_RESPONSE',
    'RELEASE_COMPATIBILITY', 'ROLLBACK'
  ));

DO $$
DECLARE
  legacy_metadata record;
BEGIN
  SELECT config_version.config_key::text AS config_key,
    config_version.config_schema::text AS config_schema,
    config_version.classification::text AS classification
  INTO legacy_metadata
  FROM public.app_config_versions AS config_version
  WHERE NOT (
    (config_version.config_key = 'features.ai-assistance'
      AND config_version.config_schema = 'FEATURE_FLAGS_V1'
      AND config_version.classification = 'PUBLIC')
    OR (config_version.config_key = 'recommendations.rules'
      AND config_version.config_schema = 'RECOMMENDATION_RULES_V1'
      AND config_version.classification = 'INTERNAL')
    OR (config_version.config_key = 'recommendations.prompt'
      AND config_version.config_schema = 'PROMPT_SETTINGS_V1'
      AND config_version.classification = 'INTERNAL')
    OR (config_version.config_key = 'coverage.default'
      AND config_version.config_schema = 'COVERAGE_SETTINGS_V1'
      AND config_version.classification = 'PUBLIC')
    OR (config_version.config_key = 'clients.minimum-version'
      AND config_version.config_schema = 'MINIMUM_APP_VERSION_V1'
      AND config_version.classification = 'PUBLIC')
  )
  ORDER BY config_version.config_key, config_version.version
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'legacy application configuration metadata requires manual review',
      DETAIL = pg_catalog.format(
        'config_key=%s config_schema=%s classification=%s',
        legacy_metadata.config_key,
        legacy_metadata.config_schema,
        legacy_metadata.classification
      );
  END IF;
END;
$$;

ALTER TABLE public.app_config_versions
  ADD CONSTRAINT app_config_key_schema_fixed CHECK (
    (config_key = 'features.ai-assistance'
      AND config_schema = 'FEATURE_FLAGS_V1'
      AND classification = 'PUBLIC')
    OR (config_key = 'recommendations.rules'
      AND config_schema = 'RECOMMENDATION_RULES_V1'
      AND classification = 'INTERNAL')
    OR (config_key = 'recommendations.prompt'
      AND config_schema = 'PROMPT_SETTINGS_V1'
      AND classification = 'INTERNAL')
    OR (config_key = 'coverage.default'
      AND config_schema = 'COVERAGE_SETTINGS_V1'
      AND classification = 'PUBLIC')
    OR (config_key = 'clients.minimum-version'
      AND config_schema = 'MINIMUM_APP_VERSION_V1'
      AND classification = 'PUBLIC')
  );

CREATE OR REPLACE FUNCTION public.app_config_value_is_valid(
  schema_name text,
  input_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  item record;
  key_count integer;
  numeric_text text;
  rules_total numeric;
BEGIN
  IF jsonb_typeof(input_value) <> 'object' THEN
    RETURN false;
  END IF;
  SELECT count(*)::integer INTO key_count
  FROM pg_catalog.jsonb_object_keys(input_value);

  FOR item IN
    SELECT entry.field_key, entry.field_value
    FROM pg_catalog.jsonb_each(input_value) AS entry(field_key, field_value)
  LOOP
    IF schema_name = 'FEATURE_FLAGS_V1' THEN
      IF item.field_key = 'enabled' THEN
        IF jsonb_typeof(item.field_value) <> 'boolean' THEN RETURN false; END IF;
      ELSE
        RETURN false;
      END IF;
    ELSIF schema_name = 'RECOMMENDATION_RULES_V1' THEN
      IF item.field_key NOT IN (
          'qualityWeight', 'timeWeight', 'budgetWeight', 'intentWeight',
          'diversityWeight', 'operationsAdjustmentMaximum'
        ) OR jsonb_typeof(item.field_value) <> 'number' THEN
        RETURN false;
      END IF;
      numeric_text := item.field_value #>> '{}';
      IF numeric_text !~ '^(0|[1-9][0-9]*)([.][0-9]{1,4})?$' THEN
        RETURN false;
      END IF;
      IF item.field_key = 'operationsAdjustmentMaximum' THEN
        IF numeric_text::numeric NOT BETWEEN 0 AND 5 THEN RETURN false; END IF;
      ELSIF numeric_text::numeric NOT BETWEEN 0 AND 95 THEN
        RETURN false;
      END IF;
    ELSIF schema_name = 'PROMPT_SETTINGS_V1' THEN
      IF item.field_key = 'enabled' THEN
        IF jsonb_typeof(item.field_value) <> 'boolean' THEN RETURN false; END IF;
      ELSIF item.field_key = 'promptVersion' THEN
		IF jsonb_typeof(item.field_value) <> 'string'
		  OR (item.field_value #>> '{}') <> 'intent-prompt-v1' THEN
		  RETURN false;
		END IF;
	  ELSIF item.field_key = 'modelVersion' THEN
		IF jsonb_typeof(item.field_value) <> 'string'
		  OR (item.field_value #>> '{}')
			<> 'qwen3.7-flash-2026-07-15' THEN
		  RETURN false;
		END IF;
      ELSIF item.field_key = 'timeoutMs' THEN
        numeric_text := item.field_value #>> '{}';
        IF jsonb_typeof(item.field_value) <> 'number'
          OR numeric_text !~ '^[0-9]+$'
          OR numeric_text::numeric NOT BETWEEN 500 AND 2500 THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
      END IF;
    ELSIF schema_name = 'COVERAGE_SETTINGS_V1' THEN
      IF item.field_key IN ('defaultRadiusMeters', 'maximumRadiusMeters') THEN
        numeric_text := item.field_value #>> '{}';
        IF jsonb_typeof(item.field_value) <> 'number'
          OR numeric_text !~ '^[0-9]+$'
          OR numeric_text::numeric NOT BETWEEN 200 AND 10000 THEN
          RETURN false;
        END IF;
      ELSIF item.field_key = 'areaCode' THEN
        IF jsonb_typeof(item.field_value) <> 'string'
          OR (item.field_value #>> '{}') <> 'NATIONWIDE' THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
      END IF;
    ELSIF schema_name = 'MINIMUM_APP_VERSION_V1' THEN
      IF item.field_key NOT IN ('android', 'ios', 'miniprogram')
        OR jsonb_typeof(item.field_value) <> 'string'
        OR (item.field_value #>> '{}')
          !~ '^(0|[1-9][0-9]{0,3})[.](0|[1-9][0-9]{0,3})[.](0|[1-9][0-9]{0,3})$' THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;

  IF schema_name = 'RECOMMENDATION_RULES_V1' AND key_count = 6 THEN
    rules_total :=
      (input_value ->> 'qualityWeight')::numeric
      + (input_value ->> 'timeWeight')::numeric
      + (input_value ->> 'budgetWeight')::numeric
      + (input_value ->> 'intentWeight')::numeric
      + (input_value ->> 'diversityWeight')::numeric;
  END IF;

  RETURN CASE schema_name
    WHEN 'FEATURE_FLAGS_V1' THEN
      key_count = 1 AND input_value ? 'enabled'
    WHEN 'RECOMMENDATION_RULES_V1' THEN
      key_count = 6 AND rules_total = 95
    WHEN 'PROMPT_SETTINGS_V1' THEN
      key_count = 4
      AND input_value ?& ARRAY[
        'enabled', 'promptVersion', 'modelVersion', 'timeoutMs'
      ]
    WHEN 'COVERAGE_SETTINGS_V1' THEN
      key_count = 3
      AND input_value ?& ARRAY[
        'defaultRadiusMeters', 'maximumRadiusMeters', 'areaCode'
      ]
      AND (input_value ->> 'defaultRadiusMeters')::integer
        <= (input_value ->> 'maximumRadiusMeters')::integer
    WHEN 'MINIMUM_APP_VERSION_V1' THEN
      key_count BETWEEN 1 AND 3 AND input_value ? 'android'
    ELSE false
  END;
END;
$$;

DO $$
DECLARE
  legacy_value record;
BEGIN
  SELECT config_version.config_key::text AS config_key,
    config_version.config_schema::text AS config_schema,
    config_version.classification::text AS classification,
    config_version.version
  INTO legacy_value
  FROM public.app_config_versions AS config_version
  WHERE NOT public.app_config_value_is_valid(
    config_version.config_schema,
    config_version.value_json
  )
  ORDER BY config_version.config_key, config_version.version
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'legacy application configuration value requires manual review',
      DETAIL = pg_catalog.format(
        'config_key=%s config_schema=%s classification=%s version=%s',
        legacy_value.config_key,
        legacy_value.config_schema,
        legacy_value.classification,
        legacy_value.version
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_context_is_valid(
  event_action text,
  value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_key text;
  count_text text;
  key_count bigint;
  new_version_text text;
  source_version_text text;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
  IF event_action IN ('ADMIN_CONFIG_PUBLISHED', 'ADMIN_CONFIG_ROLLED_BACK') THEN
    SELECT count(*) INTO key_count
    FROM pg_catalog.jsonb_object_keys(value);
    IF key_count <> 4
      OR NOT value ?& ARRAY[
        'configKey', 'newVersion', 'sourceVersion', 'changeReason'
      ]
      OR jsonb_typeof(value -> 'configKey') <> 'string'
      OR (value ->> 'configKey') NOT IN (
        'features.ai-assistance', 'recommendations.rules',
        'recommendations.prompt', 'coverage.default',
        'clients.minimum-version'
      )
      OR jsonb_typeof(value -> 'newVersion') <> 'number'
      OR jsonb_typeof(value -> 'changeReason') <> 'string' THEN
      RETURN false;
    END IF;
    new_version_text := value ->> 'newVersion';
    IF new_version_text !~ '^[1-9][0-9]{0,9}$'
      OR new_version_text::numeric > 2147483647 THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(value -> 'sourceVersion') = 'number' THEN
      source_version_text := value ->> 'sourceVersion';
      IF source_version_text !~ '^[1-9][0-9]{0,9}$'
        OR source_version_text::numeric > 2147483647 THEN
        RETURN false;
      END IF;
    ELSIF jsonb_typeof(value -> 'sourceVersion') <> 'null' THEN
      RETURN false;
    END IF;
    IF event_action = 'ADMIN_CONFIG_PUBLISHED' THEN
      RETURN (value ->> 'changeReason') IN (
        'ROUTINE_TUNING', 'INCIDENT_RESPONSE', 'RELEASE_COMPATIBILITY'
      );
    END IF;
    RETURN (value ->> 'changeReason') = 'ROLLBACK';
  END IF;

  expected_key := CASE event_action
    WHEN 'DATA_RIGHTS_AUTHORIZATION_REVOKED' THEN 'removedReferenceCount'
    WHEN 'INACTIVE_EXTERNAL_REFERENCES_PURGED' THEN 'removedReferenceCount'
    WHEN 'AUDIT_RETENTION_PURGE' THEN 'deletedCount'
    WHEN 'RETENTION_CLEANUP_COMPLETED' THEN 'affectedCount'
    ELSE NULL
  END;
  IF expected_key IS NULL THEN RETURN value = '{}'::jsonb; END IF;
  SELECT count(*) INTO key_count
  FROM pg_catalog.jsonb_object_keys(value);
  IF key_count <> 1
    OR NOT value ? expected_key
    OR jsonb_typeof(value -> expected_key) <> 'number' THEN RETURN false; END IF;
  count_text := value ->> expected_key;
  RETURN count_text ~ '^(0|[1-9][0-9]{0,17})$';
END;
$$;

DO $$
DECLARE
  legacy_audit record;
BEGIN
  SELECT audit_event.id, audit_event.action_type::text AS action_type,
    audit_event.target_type::text AS target_type
  INTO legacy_audit
  FROM public.admin_audit_log AS audit_event
  WHERE NOT public.audit_context_is_valid(
    audit_event.action_type,
    audit_event.context_json
  )
  ORDER BY audit_event.occurred_at, audit_event.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'legacy administrator audit context requires manual review',
      DETAIL = pg_catalog.format(
        'event_id=%s action_type=%s target_type=%s',
        legacy_audit.id,
        legacy_audit.action_type,
        legacy_audit.target_type
      );
  END IF;
END;
$$;

CREATE FUNCTION public.reject_direct_app_config_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('chi_shen_me.app_config_mutation', true)
    IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'application configuration mutations require a controlled function';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSIF TG_OP = 'TRUNCATE' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_config_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.app_config_versions
FOR EACH ROW EXECUTE FUNCTION public.reject_direct_app_config_mutation();

CREATE TRIGGER app_config_forbid_direct_truncate
BEFORE TRUNCATE ON public.app_config_versions
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_direct_app_config_mutation();

CREATE FUNCTION public.runtime_list_active_app_config()
RETURNS TABLE(
  config_key text,
  version integer,
  value_json jsonb,
  config_schema text,
  classification text,
  created_at timestamptz,
  activated_at timestamptz,
  change_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT config_version.config_key::text,
    config_version.version,
    config_version.value_json,
    config_version.config_schema::text,
    config_version.classification::text,
    config_version.created_at,
    config_version.activated_at,
    config_version.change_reason::text
  FROM public.app_config_versions AS config_version
  WHERE config_version.activated_at IS NOT NULL
    AND config_version.retired_at IS NULL
  ORDER BY config_version.config_key;
$$;

CREATE FUNCTION public.admin_list_sanitized_audit_events_v2(
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
  created_at timestamptz,
  config_key text,
  new_version integer,
  source_version integer,
  change_reason text
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
  IF p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 101
    OR ((p_before_created_at IS NULL) <> (p_before_event_id IS NULL)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT audit_event.id, audit_event.action_type::text,
    audit_event.target_type::text, audit_event.occurred_at,
    CASE WHEN audit_event.target_type = 'APP_CONFIG'
      AND audit_event.action_type IN (
        'ADMIN_CONFIG_PUBLISHED', 'ADMIN_CONFIG_ROLLED_BACK'
      ) THEN audit_event.context_json ->> 'configKey' ELSE NULL END,
    CASE WHEN audit_event.target_type = 'APP_CONFIG'
      AND audit_event.action_type IN (
        'ADMIN_CONFIG_PUBLISHED', 'ADMIN_CONFIG_ROLLED_BACK'
      ) THEN (audit_event.context_json ->> 'newVersion')::integer
      ELSE NULL END,
    CASE WHEN audit_event.target_type = 'APP_CONFIG'
      AND audit_event.action_type IN (
        'ADMIN_CONFIG_PUBLISHED', 'ADMIN_CONFIG_ROLLED_BACK'
      ) AND jsonb_typeof(audit_event.context_json -> 'sourceVersion') = 'number'
      THEN (audit_event.context_json ->> 'sourceVersion')::integer
      ELSE NULL END,
    CASE WHEN audit_event.target_type = 'APP_CONFIG'
      AND audit_event.action_type IN (
        'ADMIN_CONFIG_PUBLISHED', 'ADMIN_CONFIG_ROLLED_BACK'
      ) THEN audit_event.context_json ->> 'changeReason' ELSE NULL END
  FROM public.admin_audit_log AS audit_event
  WHERE p_before_created_at IS NULL
    OR (audit_event.occurred_at, audit_event.id)
      < (p_before_created_at, p_before_event_id)
  ORDER BY audit_event.occurred_at DESC, audit_event.id DESC
  LIMIT p_page_size;
END;
$$;

CREATE FUNCTION public.admin_list_active_app_config(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar
)
RETURNS TABLE(
  config_key text,
  config_schema text,
  classification text,
  version integer,
  value_json jsonb,
  change_reason text,
  created_at timestamptz,
  activated_at timestamptz
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
    OR ('ALGORITHM_CONFIG_READ' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT config_version.config_key::text,
    config_version.config_schema::text,
    config_version.classification::text,
    config_version.version,
    config_version.value_json,
    config_version.change_reason::text,
    config_version.created_at,
    config_version.activated_at
  FROM public.app_config_versions AS config_version
  WHERE config_version.activated_at IS NOT NULL
    AND config_version.retired_at IS NULL
  ORDER BY config_version.config_key;
END;
$$;

CREATE FUNCTION public.admin_list_app_config_history(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_config_key varchar,
  p_page_size integer
)
RETURNS TABLE(
  config_key text,
  config_schema text,
  classification text,
  version integer,
  value_json jsonb,
  change_reason text,
  created_at timestamptz,
  activated_at timestamptz
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
    OR ('ALGORITHM_CONFIG_READ' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    RETURN;
  END IF;
  IF p_config_key NOT IN (
      'features.ai-assistance', 'recommendations.rules',
      'recommendations.prompt', 'coverage.default',
      'clients.minimum-version'
    ) OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 100 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT config_version.config_key::text,
    config_version.config_schema::text,
    config_version.classification::text,
    config_version.version,
    config_version.value_json,
    config_version.change_reason::text,
    config_version.created_at,
    config_version.activated_at
  FROM public.app_config_versions AS config_version
  WHERE config_version.config_key = p_config_key
    AND config_version.activated_at IS NOT NULL
  ORDER BY config_version.version DESC
  LIMIT p_page_size;
END;
$$;

CREATE FUNCTION public.admin_publish_app_config(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_config_key varchar,
  p_expected_active_version integer,
  p_value_json jsonb,
  p_change_reason varchar
)
RETURNS TABLE(
  status text,
  config_key text,
  config_schema text,
  classification text,
  version integer,
  value_json jsonb,
  change_reason text,
  created_at timestamptz,
  activated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  actor_admin public.admin_users%ROWTYPE;
  active_record public.app_config_versions%ROWTYPE;
  published_record public.app_config_versions%ROWTYPE;
  expected_schema text;
  expected_classification text;
  next_version bigint;
  active_found boolean;
  event_time timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR ('ALGORITHM_CONFIG_WRITE' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    status := 'UNAUTHORIZED';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT active_admin.* INTO actor_admin
  FROM public.admin_users AS active_admin
  WHERE active_admin.id = actor_session.admin_user_id
    AND active_admin.status = 'ACTIVE';
  IF NOT FOUND THEN
    status := 'UNAUTHORIZED';
    RETURN NEXT;
    RETURN;
  END IF;

  expected_schema := CASE p_config_key
    WHEN 'features.ai-assistance' THEN 'FEATURE_FLAGS_V1'
    WHEN 'recommendations.rules' THEN 'RECOMMENDATION_RULES_V1'
    WHEN 'recommendations.prompt' THEN 'PROMPT_SETTINGS_V1'
    WHEN 'coverage.default' THEN 'COVERAGE_SETTINGS_V1'
    WHEN 'clients.minimum-version' THEN 'MINIMUM_APP_VERSION_V1'
    ELSE NULL
  END;
  expected_classification := CASE p_config_key
    WHEN 'features.ai-assistance' THEN 'PUBLIC'
    WHEN 'recommendations.rules' THEN 'INTERNAL'
    WHEN 'recommendations.prompt' THEN 'INTERNAL'
    WHEN 'coverage.default' THEN 'PUBLIC'
    WHEN 'clients.minimum-version' THEN 'PUBLIC'
    ELSE NULL
  END;
  IF expected_schema IS NULL THEN
    status := 'INVALID_CONFIG_KEY';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_change_reason NOT IN (
      'ROUTINE_TUNING', 'INCIDENT_RESPONSE', 'RELEASE_COMPATIBILITY'
    ) THEN
    status := 'INVALID_CHANGE_REASON';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_value_json IS NULL
    OR NOT public.app_config_value_is_valid(expected_schema, p_value_json) THEN
    status := 'INVALID_VALUE';
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app-config:' || p_config_key, 0)
  );
  SELECT * INTO active_record
  FROM public.app_config_versions AS config_version
  WHERE config_version.config_key = p_config_key
    AND config_version.activated_at IS NOT NULL
    AND config_version.retired_at IS NULL
  FOR UPDATE;
  active_found := FOUND;
  IF (active_found
      AND p_expected_active_version IS DISTINCT FROM active_record.version)
    OR (NOT active_found AND p_expected_active_version IS NOT NULL) THEN
    status := 'VERSION_CONFLICT';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(config_version.version)::bigint, 0) + 1
  INTO next_version
  FROM public.app_config_versions AS config_version
  WHERE config_version.config_key = p_config_key;
  IF next_version IS NULL OR next_version NOT BETWEEN 1 AND 2147483647 THEN
    status := 'VERSION_EXHAUSTED';
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM set_config('chi_shen_me.app_config_mutation', 'enabled', true);
  IF active_found THEN
    UPDATE public.app_config_versions AS config_version
    SET retired_at = event_time
    WHERE config_version.id = active_record.id;
  END IF;
  INSERT INTO public.app_config_versions (
    config_key, version, value_json, config_schema, classification,
    created_by_admin_user_id, created_at, activated_at, change_reason
  ) VALUES (
    p_config_key, next_version::integer, p_value_json, expected_schema,
    expected_classification, actor_admin.id, event_time, event_time,
    p_change_reason
  )
  RETURNING * INTO published_record;
  PERFORM set_config('chi_shen_me.app_config_mutation', 'disabled', true);

  PERFORM public.append_admin_audit_event(
    actor_admin.login_lookup_hash,
    actor_admin.login_hash_key_version,
    'ADMIN_CONFIG_PUBLISHED',
    'APP_CONFIG',
    pg_catalog.encode(
      public.digest(pg_catalog.convert_to(p_config_key, 'UTF8'), 'sha256'),
      'hex'
    ),
    pg_catalog.jsonb_build_object(
      'configKey', p_config_key,
      'newVersion', published_record.version,
      'sourceVersion', CASE WHEN active_found THEN active_record.version ELSE NULL END,
      'changeReason', p_change_reason
    )
  );

  status := 'PUBLISHED';
  config_key := published_record.config_key::text;
  config_schema := published_record.config_schema::text;
  classification := published_record.classification::text;
  version := published_record.version;
  value_json := published_record.value_json;
  change_reason := published_record.change_reason::text;
  created_at := published_record.created_at;
  activated_at := published_record.activated_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.admin_rollback_app_config(
  p_session_token_hash varchar,
  p_session_token_hash_key_version varchar,
  p_request_ip_hash varchar,
  p_device_hash varchar,
  p_binding_hash_key_version varchar,
  p_config_key varchar,
  p_expected_active_version integer,
  p_target_version integer,
  p_change_reason varchar
)
RETURNS TABLE(
  status text,
  config_key text,
  config_schema text,
  classification text,
  version integer,
  value_json jsonb,
  change_reason text,
  created_at timestamptz,
  activated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session record;
  actor_admin public.admin_users%ROWTYPE;
  active_record public.app_config_versions%ROWTYPE;
  target_record public.app_config_versions%ROWTYPE;
  published_record public.app_config_versions%ROWTYPE;
  next_version bigint;
  event_time timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO actor_session FROM public.admin_authenticate_session(
    p_session_token_hash, p_session_token_hash_key_version,
    p_request_ip_hash, p_device_hash, p_binding_hash_key_version
  );
  IF NOT FOUND
    OR ('ALGORITHM_CONFIG_WRITE' = ANY(actor_session.permission_codes))
      IS DISTINCT FROM true THEN
    status := 'UNAUTHORIZED';
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT active_admin.* INTO actor_admin
  FROM public.admin_users AS active_admin
  WHERE active_admin.id = actor_session.admin_user_id
    AND active_admin.status = 'ACTIVE';
  IF NOT FOUND THEN
    status := 'UNAUTHORIZED';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_config_key NOT IN (
      'features.ai-assistance', 'recommendations.rules',
      'recommendations.prompt', 'coverage.default',
      'clients.minimum-version'
    ) THEN
    status := 'INVALID_CONFIG_KEY';
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_change_reason IS DISTINCT FROM 'ROLLBACK' THEN
    status := 'INVALID_CHANGE_REASON';
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app-config:' || p_config_key, 0)
  );
  SELECT * INTO active_record
  FROM public.app_config_versions AS config_version
  WHERE config_version.config_key = p_config_key
    AND config_version.activated_at IS NOT NULL
    AND config_version.retired_at IS NULL
  FOR UPDATE;
  IF NOT FOUND
    OR p_expected_active_version IS DISTINCT FROM active_record.version THEN
    status := 'VERSION_CONFLICT';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO target_record
  FROM public.app_config_versions AS config_version
  WHERE config_version.config_key = p_config_key
    AND config_version.version = p_target_version
    AND config_version.activated_at IS NOT NULL
    AND config_version.retired_at IS NOT NULL;
  IF NOT FOUND THEN
    status := 'TARGET_NOT_FOUND';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(config_version.version)::bigint, 0) + 1
  INTO next_version
  FROM public.app_config_versions AS config_version
  WHERE config_version.config_key = p_config_key;
  IF next_version IS NULL OR next_version NOT BETWEEN 1 AND 2147483647 THEN
    status := 'VERSION_EXHAUSTED';
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM set_config('chi_shen_me.app_config_mutation', 'enabled', true);
  UPDATE public.app_config_versions AS config_version
  SET retired_at = event_time
  WHERE config_version.id = active_record.id;
  INSERT INTO public.app_config_versions (
    config_key, version, value_json, config_schema, classification,
    created_by_admin_user_id, created_at, activated_at, change_reason
  ) VALUES (
    target_record.config_key, next_version::integer, target_record.value_json,
    target_record.config_schema, target_record.classification,
    actor_admin.id, event_time, event_time, p_change_reason
  )
  RETURNING * INTO published_record;
  PERFORM set_config('chi_shen_me.app_config_mutation', 'disabled', true);

  PERFORM public.append_admin_audit_event(
    actor_admin.login_lookup_hash,
    actor_admin.login_hash_key_version,
    'ADMIN_CONFIG_ROLLED_BACK',
    'APP_CONFIG',
    pg_catalog.encode(
      public.digest(pg_catalog.convert_to(p_config_key, 'UTF8'), 'sha256'),
      'hex'
    ),
    pg_catalog.jsonb_build_object(
      'configKey', p_config_key,
      'newVersion', published_record.version,
      'sourceVersion', target_record.version,
      'changeReason', p_change_reason
    )
  );

  status := 'ROLLED_BACK';
  config_key := published_record.config_key::text;
  config_schema := published_record.config_schema::text;
  classification := published_record.classification::text;
  version := published_record.version;
  value_json := published_record.value_json;
  change_reason := published_record.change_reason::text;
  created_at := published_record.created_at;
  activated_at := published_record.activated_at;
  RETURN NEXT;
END;
$$;

-- Schema 0012 granted api_runtime direct SELECT access to this table. Revoke
-- every known service role inside the migration transaction so a later
-- role-grant failure cannot leave schema 0013 with the legacy base-table ACL.
DO $revoke_legacy_app_config_acl$
DECLARE
  service_role text;
  config_columns text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.quote_ident(attribute.attname),
    ', ' ORDER BY attribute.attnum
  )
  INTO config_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.app_config_versions'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR service_role IN
    SELECT role.rolname::text
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname IN (
      'api_runtime',
      'retention_worker',
      'admin_api_runtime',
      'data_export_worker'
    )
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.app_config_versions FROM %I',
      service_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.app_config_versions FROM %I',
      config_columns,
      service_role
    );
  END LOOP;
END;
$revoke_legacy_app_config_acl$;

REVOKE ALL ON public.app_config_versions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_config_value_is_valid(text, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_direct_app_config_mutation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.runtime_list_active_app_config()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_sanitized_audit_events_v2(
  varchar, varchar, varchar, varchar, varchar, timestamptz, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_active_app_config(
  varchar, varchar, varchar, varchar, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_app_config_history(
  varchar, varchar, varchar, varchar, varchar, varchar, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_publish_app_config(
  varchar, varchar, varchar, varchar, varchar, varchar, integer, jsonb, varchar
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_rollback_app_config(
  varchar, varchar, varchar, varchar, varchar, varchar, integer, integer, varchar
) FROM PUBLIC;
