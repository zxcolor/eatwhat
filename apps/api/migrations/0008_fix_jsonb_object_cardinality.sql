-- PostgreSQL exposes JSONB object keys as a set rather than through a direct
-- cardinality function. Keep the already-applied 0001 checksum immutable and
-- replace only the two validators that used the unsupported call.
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
  key_count bigint;
BEGIN
  IF jsonb_typeof(input_value) <> 'object' THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO key_count
  FROM pg_catalog.jsonb_object_keys(input_value);
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
    WHEN 'RECOMMENDATION_RULES_V1' THEN key_count = 6
    WHEN 'PROMPT_SETTINGS_V1' THEN input_value ?& ARRAY['enabled', 'promptVersion', 'modelVersion', 'timeoutMs']
    WHEN 'COVERAGE_SETTINGS_V1' THEN input_value ?& ARRAY['defaultRadiusMeters', 'maximumRadiusMeters', 'areaCode']
    WHEN 'MINIMUM_APP_VERSION_V1' THEN input_value ? 'android'
    ELSE false
  END;
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
  SELECT count(*) INTO key_count
  FROM pg_catalog.jsonb_object_keys(value);
  IF key_count <> 1
    OR NOT value ? expected_key
    OR jsonb_typeof(value -> expected_key) <> 'number' THEN RETURN false; END IF;
  count_text := value ->> expected_key;
  RETURN count_text ~ '^(0|[1-9][0-9]{0,17})$';
END;
$$;
