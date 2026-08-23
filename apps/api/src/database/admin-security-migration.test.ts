import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

function tableBody(sql: string, tableName: string): string {
	const match = new RegExp(
		`CREATE TABLE public\\.${tableName} \\(([\\s\\S]*?)\\n\\);`,
		"u",
	).exec(sql);
	if (match?.[1] === undefined) throw new Error(`missing table ${tableName}`);
	return match[1];
}

function functionDefinition(sql: string, functionName: string): string {
	const start = sql.indexOf(`CREATE FUNCTION public.${functionName}`);
	if (start < 0) throw new Error(`missing function ${functionName}`);
	const end = sql.indexOf("\n$$;", start);
	if (end < 0) throw new Error(`missing function terminator ${functionName}`);
	return sql.slice(start, end + 4);
}

describe("administrator passkey security migration", () => {
	it("stores only sealed login, challenge, network and session material", async () => {
		const sql = (await loadMigrationPlan())[2]?.sql ?? "";
		const challenges = tableBody(sql, "admin_webauthn_challenges");
		const sessions = tableBody(sql, "admin_sessions");
		const credentials = sql.slice(
			sql.indexOf("ALTER TABLE public.admin_mfa_credentials"),
			sql.indexOf("CREATE TABLE public.admin_sessions"),
		);
		expect(credentials.length).toBeGreaterThan(0);
		expect(challenges).toContain("challenge_hash varchar(64) NOT NULL UNIQUE");
		expect(challenges).toContain("login_lookup_hash varchar(64) NOT NULL");
		expect(challenges).toContain("request_ip_hash varchar(64) NOT NULL");
		expect(challenges).toContain("device_hash varchar(64) NOT NULL");
		expect(challenges).not.toMatch(
			/^\s*(challenge|login|ip_address|user_agent|raw_user_agent)\s+/imu,
		);
		expect(sessions).toContain("token_hash varchar(64) NOT NULL UNIQUE");
		expect(sessions).not.toMatch(/^\s*(token|session_token)\s+/imu);
		expect(sessions).toContain("interval '15 minutes'");
		expect(sessions).toContain("interval '8 hours'");
		expect(credentials).toContain("credential_id_ciphertext bytea");
		expect(credentials).toContain("origin_hash varchar(64)");
		expect(credentials).toContain("rp_id_hash varchar(64)");
		expect(credentials).not.toMatch(
			/^\s*ADD COLUMN credential_id\s+(text|varchar|bytea)/imu,
		);
	});

	it("uses fixed RBAC roles and checks expiration against database time", async () => {
		const sql = (await loadMigrationPlan())[2]?.sql ?? "";
		for (const role of [
			"AUDITOR",
			"OPERATOR",
			"ALGORITHM_ADMIN",
			"SECURITY_ADMIN",
		]) {
			expect(sql).toContain(`'${role}'`);
		}
		for (const permission of [
			"AUDIT_READ",
			"OPERATIONS_READ",
			"FEEDBACK_MANAGE",
			"PLACE_DATA_MANAGE",
			"ALGORITHM_CONFIG_READ",
			"ALGORITHM_CONFIG_WRITE",
			"SECURITY_ADMIN_READ",
			"SECURITY_ADMIN_WRITE",
			"CREDENTIAL_SELF_MANAGE",
		]) {
			expect(sql).toContain(`'${permission}'`);
		}
		const permissionCheck = functionDefinition(
			sql,
			"admin_actor_has_permission",
		);
		expect(
			permissionCheck.slice(0, permissionCheck.indexOf("RETURNS")),
		).not.toContain("timestamptz");
		expect(permissionCheck).toContain("user_role.expires_at > now()");
		const authentication = functionDefinition(
			sql,
			"admin_authenticate_session",
		);
		expect(authentication).toContain("user_role.expires_at > event_time");
		expect(authentication).toContain("admin_user.status <> 'ACTIVE'");
		expect(authentication).toContain("role.status = 'ACTIVE'");
	});

	it("atomically consumes challenges and treats counter rollback as compromise", async () => {
		const sql = (await loadMigrationPlan())[2]?.sql ?? "";
		const beginLogin = functionDefinition(sql, "admin_begin_login_challenge");
		expect(beginLogin).toContain("p_login_lookup_hashes varchar[]");
		expect(beginLogin).toContain("p_login_hash_key_versions varchar[]");
		expect(beginLogin).toContain(
			"cardinality(p_login_lookup_hashes) NOT BETWEEN 1 AND 3",
		);
		expect(beginLogin).toContain("WITH ORDINALITY");
		expect(beginLogin).toContain("effective_login_lookup_hash");
		const completeLogin = functionDefinition(
			sql,
			"admin_complete_login_assertion",
		);
		expect(completeLogin).toContain("FOR UPDATE");
		expect(completeLogin).toContain("challenge.consumed_at IS NOT NULL");
		expect(completeLogin).toContain(
			"p_user_verification_performed IS DISTINCT FROM true",
		);
		expect(completeLogin).toContain(
			"p_new_signature_counter <= credential.signature_counter",
		);
		expect(completeLogin).toContain("outcome = 'COUNTER_ROLLBACK'");
		expect(completeLogin).toContain("status = 'LOCKED'");
		expect(completeLogin).toContain("'COUNTER_ROLLBACK'");
		const loginFailure = functionDefinition(sql, "admin_fail_login_challenge");
		expect(loginFailure).toContain("LEAST(");
		expect(loginFailure).toContain("challenge.attempt_count + 1");
		expect(loginFailure).toContain("challenge.max_attempts");
		const enrollment = functionDefinition(
			sql,
			"admin_complete_credential_enrollment",
		);
		expect(enrollment).toContain("enrollment_session.revoked_at IS NULL");
		expect(enrollment).toContain("admin_actor_has_permission(");
		expect(enrollment).toContain("admin_fail_enroll_challenge(");
		const beginEnrollment = functionDefinition(
			sql,
			"admin_begin_enroll_challenge",
		);
		expect(beginEnrollment).toContain(
			"recent_session.created_at > event_time - interval '5 minutes'",
		);
	});

	it("keeps bootstrap and internal mutation helpers out of runtime grants", async () => {
		const sql = (await loadMigrationPlan())[2]?.sql ?? "";
		const bootstrap = functionDefinition(
			sql,
			"admin_bootstrap_first_security_admin",
		);
		expect(bootstrap).toContain("pg_advisory_xact_lock");
		expect(bootstrap).toContain("IF EXISTS (SELECT 1 FROM public.admin_users)");
		expect(bootstrap).toContain(
			"p_user_verification_performed IS DISTINCT FROM true",
		);
		expect(bootstrap).toContain("'SECURITY_ADMIN'");
		expect(sql).toContain("'REVOKE ALL ON FUNCTION %s FROM PUBLIC'");
		for (const functionName of [
			"admin_bootstrap_first_security_admin",
			"admin_actor_has_permission",
			"admin_revoke_user_sessions",
			"append_admin_security_audit_event",
		]) {
			expect(sql).toContain(`'${functionName}'`);
		}
	});

	it("uses fixed-shape audit calls and append-only retention", async () => {
		const sql = (await loadMigrationPlan())[2]?.sql ?? "";
		const audit = functionDefinition(sql, "append_admin_security_audit_event");
		expect(audit.slice(0, audit.indexOf("RETURNS"))).not.toContain("jsonb");
		expect(audit).toContain("invalid administrator audit event shape");
		expect(audit).toContain("'{}'::jsonb");
		expect(sql).toContain("ADMIN_LOGIN_FAILED");
		expect(sql).toContain("ADMIN_LOGIN_SUCCEEDED");
		expect(sql).toContain("ADMIN_SESSION_REVOKED");
		expect(sql).toContain("ADMIN_CREDENTIAL_REVOKED");
		expect(sql).toContain("ADMIN_ROLE_GRANTED_SECURITY_ADMIN");
		expect(sql).toContain("ADMIN_ROLE_REVOKED_SECURITY_ADMIN");
		expect(sql).toContain("ADMIN_WEBAUTHN_CHALLENGE_24H");
		expect(sql).toContain("ADMIN_SESSION_30D_AFTER_ABSOLUTE_EXPIRY");
		expect(
			sql.indexOf("DELETE FROM public.admin_webauthn_challenges"),
		).toBeLessThan(sql.indexOf("DELETE FROM public.admin_sessions"));
	});
});
