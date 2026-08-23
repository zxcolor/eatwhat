import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

function functionDefinition(sql: string, functionName: string): string {
	const start = sql.indexOf(`CREATE FUNCTION public.${functionName}`);
	if (start < 0) throw new Error(`missing function ${functionName}`);
	const end = sql.indexOf("\n$$;", start);
	if (end < 0) throw new Error(`missing function terminator ${functionName}`);
	return sql.slice(start, end + 4);
}

function functionHeader(definition: string): string {
	const end = definition.indexOf("AS $$");
	if (end < 0) throw new Error("missing function body");
	return definition.slice(0, end);
}

describe("administrator API database primitives migration", () => {
	it("adds a random opaque self-service handle without exposing internal IDs", async () => {
		const sql = (await loadMigrationPlan())[3]?.sql ?? "";
		expect(sql).toContain(
			"ADD COLUMN self_service_handle varchar(43) NOT NULL DEFAULT",
		);
		expect(sql).toContain("public.gen_random_bytes(32)");
		expect(sql).toContain("self_service_handle ~ '^[A-Za-z0-9_-]{43}$'");
		expect(sql).toContain("UNIQUE (self_service_handle)");
		expect(sql).not.toMatch(
			/ADD COLUMN self_service_handle[^;]*(credential_id_hash|credential\.id)/u,
		);
	});

	it("enforces a concurrent active-credential ceiling shared by every insert", async () => {
		const sql = (await loadMigrationPlan())[3]?.sql ?? "";
		const limit = functionDefinition(
			sql,
			"enforce_admin_active_credential_limit",
		);
		expect(limit).toContain("SECURITY DEFINER");
		expect(limit).toContain("SET search_path = pg_catalog, public");
		expect(limit).toContain("pg_advisory_xact_lock(");
		expect(limit).toContain(
			"'admin-active-credential-limit:' || NEW.admin_user_id::text",
		);
		expect(limit).toContain("credential.admin_user_id = NEW.admin_user_id");
		expect(limit).toContain("credential.revoked_at IS NULL");
		expect(limit).toContain("active_credential_count >= 20");
		expect(limit).toContain("CONSTRAINT = 'admin_active_credential_limit'");
		expect(sql).toContain("BEFORE INSERT ON public.admin_mfa_credentials");
		expect(sql).toContain(
			"EXECUTE FUNCTION public.enforce_admin_active_credential_limit()",
		);
		expect(sql).toContain(
			"BEFORE UPDATE OF admin_user_id, revoked_at ON public.admin_mfa_credentials",
		);
		expect(sql).toContain("NEW.revoked_at IS NULL");
		expect(sql).toContain(
			"NEW.admin_user_id IS DISTINCT FROM OLD.admin_user_id",
		);
		expect(sql).toContain("HAVING count(*) > 20");
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.enforce_admin_active_credential_limit()",
		);
	});

	it("authenticates first and evaluates current RBAC in every runtime primitive", async () => {
		const sql = (await loadMigrationPlan())[3]?.sql ?? "";
		for (const functionName of [
			"admin_get_self_enroll_credential_options",
			"admin_list_self_credentials",
			"admin_get_self_credential_record",
			"admin_revoke_self_credential",
			"admin_list_sanitized_audit_events",
		]) {
			const definition = functionDefinition(sql, functionName);
			expect(definition).toContain("SECURITY DEFINER");
			expect(definition).toContain("SET search_path = pg_catalog, public");
			const body = definition
				.slice(definition.indexOf("BEGIN") + 5)
				.trimStart();
			expect(
				body.startsWith(
					"SELECT * INTO actor_session FROM public.admin_authenticate_session(",
				),
			).toBe(true);
		}
		expect(
			functionDefinition(sql, "admin_list_sanitized_audit_events"),
		).toContain("'AUDIT_READ' = ANY(actor_session.permission_codes)");
		for (const functionName of [
			"admin_get_self_enroll_credential_options",
			"admin_list_self_credentials",
			"admin_get_self_credential_record",
			"admin_revoke_self_credential",
		]) {
			expect(functionDefinition(sql, functionName)).toContain(
				"'CREDENTIAL_SELF_MANAGE' = ANY(actor_session.permission_codes)",
			);
		}
	});

	it("binds enrollment options to the current challenge, session and request", async () => {
		const sql = (await loadMigrationPlan())[3]?.sql ?? "";
		const options = functionDefinition(
			sql,
			"admin_get_self_enroll_credential_options",
		);
		expect(options).toContain(
			"challenge.admin_user_id = actor_session.admin_user_id",
		);
		expect(options).toContain(
			"challenge.initiating_session_id = actor_session.session_id",
		);
		expect(options).toContain("challenge.challenge_hash = p_challenge_hash");
		expect(options).toContain("challenge.request_ip_hash = p_request_ip_hash");
		expect(options).toContain("challenge.device_hash = p_device_hash");
		expect(options).toContain(
			"challenge.binding_hash_key_version = p_binding_hash_key_version",
		);
		expect(options).toContain("challenge.consumed_at IS NULL");
		expect(options).toContain("challenge.expires_at > now()");
		expect(options).toContain("active_credential.revoked_at IS NULL");
		const output = functionHeader(options).slice(
			functionHeader(options).indexOf("RETURNS TABLE"),
		);
		expect(output).toContain("credential_id_ciphertext bytea");
		expect(output).toContain("credential_encryption_key_version varchar");
		expect(output).not.toContain("credential_id uuid");
		expect(output).not.toContain("credential_id_hash");
	});

	it("keeps list and revoke strictly self-scoped behind the opaque handle", async () => {
		const sql = (await loadMigrationPlan())[3]?.sql ?? "";
		const list = functionDefinition(sql, "admin_list_self_credentials");
		const listOutput = functionHeader(list).slice(
			functionHeader(list).indexOf("RETURNS TABLE"),
		);
		expect(listOutput).toContain("credential_handle text");
		expect(listOutput).not.toContain("credential_id");
		expect(listOutput).not.toContain("hash");
		expect(list).toContain(
			"credential.admin_user_id = actor_session.admin_user_id",
		);
		expect(list).toContain("LIMIT 20");
		const exact = functionDefinition(sql, "admin_get_self_credential_record");
		const exactOutput = functionHeader(exact).slice(
			functionHeader(exact).indexOf("RETURNS TABLE"),
		);
		expect(exactOutput).toContain("credential_handle text");
		expect(exactOutput).not.toContain("credential_id");
		expect(exactOutput).not.toContain("hash");
		expect(exact).toContain(
			"credential.admin_user_id = actor_session.admin_user_id",
		);
		expect(exact).toContain("credential.id = p_internal_credential_id");
		expect(exact).toContain("credential.revoked_at IS NULL");

		const revoke = functionDefinition(sql, "admin_revoke_self_credential");
		const revokeInput = functionHeader(revoke).slice(
			0,
			functionHeader(revoke).indexOf("RETURNS"),
		);
		expect(revokeInput).toContain("p_credential_handle varchar");
		expect(revokeInput).not.toContain("uuid");
		expect(revoke).toContain(
			"credential.admin_user_id = actor_session.admin_user_id",
		);
		expect(revoke).toContain("other_credential.id <> target_credential.id");
		expect(revoke).toContain("RETURN 'LAST_ACTIVE_CREDENTIAL'");
		expect(revoke).toContain(
			"recent_session.created_at > event_time - interval '5 minutes'",
		);
		expect(revoke).toContain("public.admin_revoke_user_sessions(");
		expect(revoke).toContain("'CREDENTIAL_REVOKED'");
	});

	it("returns only the fixed sanitized audit projection with keyset pagination", async () => {
		const sql = (await loadMigrationPlan())[3]?.sql ?? "";
		const audit = functionDefinition(sql, "admin_list_sanitized_audit_events");
		const output = functionHeader(audit).slice(
			functionHeader(audit).indexOf("RETURNS TABLE"),
		);
		expect(output).toContain("event_id uuid");
		expect(output).toContain("action text");
		expect(output).toContain("target_type text");
		expect(output).toContain("created_at timestamptz");
		const projection = audit.slice(audit.indexOf("RETURN QUERY"));
		for (const forbidden of [
			"actor_admin_user_hash",
			"target_id_hash",
			"context_json",
			"hash_key_version",
		]) {
			expect(projection).not.toContain(forbidden);
		}
		expect(audit).toContain("(audit_event.occurred_at, audit_event.id)");
		expect(audit).toContain("< (p_before_created_at, p_before_event_id)");
		expect(audit).toContain(
			"ORDER BY audit_event.occurred_at DESC, audit_event.id DESC",
		);
		expect(audit).toContain("p_page_size NOT BETWEEN 1 AND 101");
		expect(sql).toContain(
			"ON public.admin_audit_log(occurred_at DESC, id DESC)",
		);
	});

	it("revokes public execution on every new security-definer function", async () => {
		const sql = (await loadMigrationPlan())[3]?.sql ?? "";
		for (const functionName of [
			"admin_get_self_enroll_credential_options",
			"admin_list_self_credentials",
			"admin_get_self_credential_record",
			"admin_revoke_self_credential",
			"admin_list_sanitized_audit_events",
		]) {
			expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${functionName}`);
		}
	});
});
