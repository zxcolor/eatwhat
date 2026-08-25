import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

function tableBody(sql: string, table: string): string {
	const match = new RegExp(
		`CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`,
		"u",
	).exec(sql);
	if (match?.[1] === undefined) throw new Error(`missing table ${table}`);
	return match[1];
}

function functionBody(sql: string, functionName: string): string {
	const functionStart = sql.indexOf(`CREATE FUNCTION public.${functionName}`);
	if (functionStart < 0) throw new Error(`missing function ${functionName}`);
	const bodyStart = sql.indexOf("AS $$", functionStart);
	const bodyEnd = sql.indexOf("\n$$;", bodyStart);
	if (bodyStart < 0 || bodyEnd < 0) {
		throw new Error(`missing body for function ${functionName}`);
	}
	return sql.slice(bodyStart, bodyEnd);
}

describe("initial schema privacy and governance scan", () => {
	it("contains every Android 1.0 persistence domain without user coordinates", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		for (const table of [
			"users",
			"identity_bindings",
			"otp_challenges",
			"auth_session_families",
			"auth_refresh_credentials",
			"auth_access_tokens",
			"oauth_states",
			"favorites",
			"recommendation_history",
			"private_recommendation_feedback",
			"support_feedback",
			"data_export_jobs",
			"account_deletion_jobs",
			"app_config_versions",
			"admin_users",
			"admin_roles",
			"admin_mfa_credentials",
			"admin_audit_log",
		]) {
			expect(sql).toContain(`CREATE TABLE public.${table}`);
		}
		for (const [, table] of sql.matchAll(/CREATE TABLE public\.(\w+)/gu)) {
			if (table === "coverage_areas") continue;
			const body = tableBody(sql, table ?? "");
			expect(body).not.toMatch(
				/^\s*(lat|lng|latitude|longitude|coordinate|coordinates|position|precise_location)\s+/imu,
			);
			expect(body).not.toMatch(/^\s*(raw_body|request_body|oauth_code)\s+/imu);
		}
		expect(tableBody(sql, "coverage_areas")).toContain(
			"precision_class = 'GENERALIZED_SERVICE_BOUNDARY'",
		);
		expect(sql).toContain("USING gist(boundary)");
	});

	it("stores OTP and opaque session credentials only as versioned protected hashes", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		const otp = tableBody(sql, "otp_challenges");
		expect(otp).toContain("code_hash");
		expect(otp).toContain("ARGON2ID-PEPPERED");
		expect(otp).toContain("purpose");
		expect(otp).toContain("destination_dedup_hash");
		expect(otp).toContain("masked_destination");
		expect(otp).toContain("target_user_id");
		expect(otp).toContain("request_ip_hash varchar(64) NOT NULL");
		expect(otp).toContain("device_hash varchar(64) NOT NULL");
		expect(otp).not.toMatch(/^\s*(code|otp|verification_code)\s+/imu);
		for (const table of ["auth_refresh_credentials", "auth_access_tokens"]) {
			const body = tableBody(sql, table);
			expect(body).toContain("token_hash");
			expect(body).toContain("HMAC-SHA256");
			expect(body).not.toMatch(/^\s*(token|refresh_token|access_token)\s+/imu);
		}
		expect(tableBody(sql, "oauth_states")).not.toMatch(
			/^\s*(authorization_code|access_token|refresh_token)\s+/imu,
		);
	});

	it("keeps public purpose and recommendation event enums exact", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		expect(tableBody(sql, "otp_challenges")).toContain(
			"purpose IN ('REGISTER', 'LOGIN', 'BIND', 'RECOVERY')",
		);
		expect(tableBody(sql, "oauth_states")).toContain(
			"purpose IN ('REGISTER', 'LOGIN', 'BIND')",
		);
		expect(tableBody(sql, "recommendation_history")).toContain(
			"'IMPRESSION', 'DETAIL', 'FAVORITE', 'NAVIGATION', 'CALL', 'REROLL'",
		);
		expect(sql).not.toContain("BIND_IDENTITY");
		expect(sql).not.toContain("'NAVIGATE'");
		expect(sql).not.toContain("'REFRESH'");
	});

	it("stores only contract-compatible masked identity display values", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		const identities = tableBody(sql, "identity_bindings");
		expect(identities).toContain("masked_display_hint varchar(254)");
		expect(identities).toContain("identity_type = 'PHONE'");
		expect(identities).toContain("[*]{4}");
		expect(identities).toContain("identity_type = 'EMAIL'");
		expect(identities).toContain("masked_display_hint = '微信账号'");
		expect(identities).toContain("masked_display_hint = 'QQ 账号'");
		expect(identities).toContain("masked_display_hint = 'Apple 账号'");
		expect(identities).toContain("NOT is_primary OR identity_type = 'PHONE'");
		expect(sql).toContain("IS DISTINCT FROM 'enabled'");
		expect(sql).toContain("AND identity_type IN ('EMAIL', 'QQ')");
		expect(sql).toContain("challenge.target_user_id = p_target_user_id");
		expect(sql).toContain(
			"challenge.operation_target_hash = p_expected_operation_target_hash",
		);
		expect(sql).toContain("challenge.device_hash = p_expected_device_hash");
		const reactivation = functionBody(
			sql,
			"reactivate_phone_email_identity_binding",
		);
		expect(reactivation).toContain("challenge.binding_claimed_at IS NULL");
		expect(reactivation).toContain("SET binding_claimed_at = event_time");
		expect(reactivation).toContain(
			"challenge.operation_target_hash = p_expected_operation_target_hash",
		);
		expect(reactivation).toContain(
			"challenge.device_hash = p_expected_device_hash",
		);
		expect(reactivation).toContain("identity reactivation proof claim failed");
		expect(sql).toContain(
			"CREATE FUNCTION public.bind_email_identity_from_consumed_otp",
		);
		expect(sql).toContain(
			"CREATE FUNCTION public.bind_qq_identity_from_consumed_oauth_state",
		);
		expect(sql).toContain("binding_claimed_at timestamptz");
	});

	it("makes authentication state one-way behind restricted transition functions", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		for (const functionName of [
			"protect_otp_challenge_update",
			"finalize_otp_delivery",
			"record_otp_verification_attempt",
			"protect_auth_refresh_credential_update",
			"rotate_auth_refresh_credential",
			"mark_auth_refresh_replay",
			"protect_oauth_state_update",
			"consume_oauth_state",
		]) {
			expect(sql).toContain(`CREATE FUNCTION public.${functionName}`);
		}
		expect(sql).toContain("OTP issuance fields are immutable");
		expect(sql).toContain("an OTP challenge can be consumed only once");
		expect(sql).toContain("refresh credential issuance fields are immutable");
		expect(sql).toContain("ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE");
		expect(sql).not.toContain(
			"replaced_by_id uuid REFERENCES public.auth_refresh_credentials(id) ON DELETE SET NULL",
		);
		expect(sql).toContain("OAuth state can be consumed only once");
		expect(sql).toContain("otp_challenges_destination_rate_limit_idx");
		expect(sql).toContain("otp_challenges_ip_rate_limit_idx");
		expect(sql).toContain("otp_challenges_device_rate_limit_idx");
		expect(sql).toContain(
			"CREATE FUNCTION public.register_phone_wechat_account",
		);
		expect(sql).toContain("verified_subject_lookup_hash");
		expect(sql).toContain("verified_subject_dedup_hash");
		expect(sql).toContain("oauth.verified_subject_lookup_hash");
		expect(sql).toContain("oauth.verified_subject_dedup_hash");
		expect(sql).not.toContain("p_wechat_lookup_hash");
		expect(sql).not.toContain("p_wechat_dedup_hash");
		expect(sql).toContain(
			"otp.registration_flow_reference_hash = p_expected_flow_reference_hash",
		);
		expect(sql).toContain(
			"oauth.flow_reference_hash = p_expected_flow_reference_hash",
		);
		expect(sql).toContain("oauth.device_hash = p_expected_device_hash");
		const sessionInsertValidator = sql.slice(
			sql.indexOf("CREATE FUNCTION public.validate_auth_session_family_insert"),
			sql.indexOf("CREATE TRIGGER auth_session_family_initial_state"),
		);
		expect(sessionInsertValidator).toContain("SECURITY DEFINER");
		expect(sessionInsertValidator).toContain(
			"SET search_path = pg_catalog, public",
		);
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.validate_auth_session_family_insert() FROM PUBLIC",
		);
	});

	it("gates account deletion artifacts and refresh lifetime", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		expect(sql).toContain(
			"refresh_expires_at <= created_at + interval '30 days'",
		);
		expect(sql).toContain("CREATE FUNCTION public.begin_account_deletion");
		expect(sql).toContain("CREATE FUNCTION public.complete_account_deletion");
		expect(sql).toContain("artifact_locator_ciphertext IS NOT NULL");
		expect(sql).toContain("artifact_deleted_at IS NULL");
	});

	it("allows provider IDs only behind a licensed authorization and active views", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		const references = tableBody(sql, "external_place_references");
		expect(references).toContain("provider_place_id");
		expect(references).toContain("rights_mode = 'LICENSED_ENRICHMENT'");
		expect(references).toContain("authorization_id");
		expect(sql).toContain("PERSIST_PLACE_REFERENCE");
		expect(sql).toContain("FOR SHARE");
		expect(sql).toContain("rights_authorization.expires_at > now()");
		expect(sql).toContain("p_provider_code IS NOT NULL");
		expect(sql).toContain(
			"rights_authorization.provider_code = p_provider_code",
		);
		expect(sql).toContain("reference.retain_until > now()");
		expect(sql).toContain(
			"ON CONFLICT (provider_code, provider_place_id, authorization_id)",
		);
		expect(sql).toContain(
			"CREATE VIEW public.active_external_place_references",
		);
		expect(sql).toContain(
			"CREATE FUNCTION public.revoke_data_rights_authorization",
		);
		expect(sql).toContain(
			"CREATE FUNCTION public.purge_inactive_external_place_references",
		);
		expect(tableBody(sql, "favorites")).not.toContain("provider_place_id");
		expect(tableBody(sql, "recommendation_history")).not.toContain(
			"provider_place_id",
		);
	});

	it("allows only schema-shaped configuration and count-only audit context", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		expect(sql).toContain("CREATE FUNCTION public.app_config_value_is_valid");
		expect(sql).toContain("pg_catalog.jsonb_each(input_value)");
		expect(sql).toContain("CREATE FUNCTION public.audit_context_is_valid");
		expect(sql).toContain("DATA_RIGHTS_AUTHORIZATION_REVOKED");
		expect(sql).toContain("OR NOT value ? expected_key");
		expect(sql).toContain("count_text ~ '^(0|[1-9][0-9]{0,17})$'");
		expect(sql).not.toContain("safe_metadata_json");
	});

	it("enforces append-only audit writes and fixed retention purge entrypoints", async () => {
		const sql = (await loadMigrationPlan())[0]?.sql ?? "";
		expect(sql).toContain("CREATE TRIGGER admin_audit_append_only");
		expect(sql).toContain("CREATE TRIGGER admin_audit_forbid_truncate");
		expect(sql).toContain("CREATE FUNCTION public.append_admin_audit_event");
		expect(sql).toContain(
			"CREATE FUNCTION public.purge_expired_admin_audit_events",
		);
		expect(sql).toContain("REVOKE ALL ON public.admin_audit_log FROM PUBLIC");
		expect(tableBody(sql, "admin_audit_log")).toContain(
			"retain_until <= occurred_at + interval '180 days'",
		);
	});
});
