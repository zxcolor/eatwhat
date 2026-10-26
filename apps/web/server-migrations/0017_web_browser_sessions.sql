-- Browser PHONE/EMAIL sessions use their own platform without impersonating
-- Android or WeChat. Preserve all existing rows, identities and platform values.
-- The migration runner owns the transaction and checksum ledger.
ALTER TABLE public.auth_session_families
  DROP CONSTRAINT auth_session_families_platform_check;
ALTER TABLE public.auth_session_families
  ADD CONSTRAINT auth_session_families_platform_check
  CHECK (platform IN ('ANDROID', 'IOS', 'MINIPROGRAM', 'WEB'));
