-- Bring the public PHONE/EMAIL OTP primitive in line with the documented
-- Android 1.0 security boundary: at most five verification attempts per
-- challenge. Existing rows are left intact; the transition function and
-- runtime proof lookup both reject attempt six and later.
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
      AND attempts < 5;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('chi_shen_me.otp_state_transition', 'disabled', true);
  RETURN verification_succeeded AND changed_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.record_otp_verification_attempt(
  uuid, varchar, uuid, varchar, varchar, boolean
) FROM PUBLIC;
