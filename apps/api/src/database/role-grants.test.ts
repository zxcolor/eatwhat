import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROLE_GRANTS_PATH = fileURLToPath(
	new URL("../../../../infra/postgres/role-grants.sql", import.meta.url),
);
const BOOTSTRAP_EXTENSIONS_PATH = fileURLToPath(
	new URL(
		"../../../../infra/postgres/bootstrap-extensions.sql",
		import.meta.url,
	),
);
const CI_WORKFLOW_PATH = fileURLToPath(
	new URL("../../../../.github/workflows/ci.yml", import.meta.url),
);

async function loadRoleGrants(): Promise<string> {
	return readFile(ROLE_GRANTS_PATH, "utf8");
}

async function loadBootstrapExtensions(): Promise<string> {
	return readFile(BOOTSTRAP_EXTENSIONS_PATH, "utf8");
}

async function loadCiWorkflow(): Promise<string> {
	return readFile(CI_WORKFLOW_PATH, "utf8");
}

function expectFailClosedPsqlBranches(
	sql: string,
	expectedBranchCount: number,
): void {
	const rejectionBranches = Array.from(
		sql.matchAll(/\\else\s+([\s\S]*?)\\endif/gu),
		(match) => match[1] ?? "",
	);

	expect(sql.startsWith("\\set ON_ERROR_STOP on\n")).toBe(true);
	expect(sql).not.toMatch(/\\quit(?:\s|$)/u);
	expect(rejectionBranches).toHaveLength(expectedBranchCount);
	for (const branch of rejectionBranches) {
		expect(branch).toContain("RAISE EXCEPTION USING");
		expect(branch).toMatch(/ERRCODE = '(?:22023|42501|55000)'/u);
		expect(branch).toMatch(/MESSAGE = '[^']+';/u);
	}
}

describe("database role grant deployment gate", () => {
	it("fails closed and changes privileges in one transaction", async () => {
		const sql = await loadRoleGrants();
		expectFailClosedPsqlBranches(sql, 8);
		expect(sql.indexOf("BEGIN;")).toBeLessThan(sql.indexOf("REVOKE CREATE"));
		expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
		expect(sql).toContain("declared_roles_are_distinct");
		expect(sql).toContain("least_privilege_roles");
		expect(sql).toContain("rolsuper");
		expect(sql).toContain("rolbypassrls");
		expect(sql).toContain("'MEMBER'");
		expect(sql).toContain("'USAGE'");
		expect(sql).toContain("export_worker_role psql variable is required");
		expect(sql).toContain(":'admin_runtime_role' <> :'export_worker_role'");
	});

	it("fails extension bootstrap validation with server errors", async () => {
		const sql = await loadBootstrapExtensions();
		expectFailClosedPsqlBranches(sql, 4);
		expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
		expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS postgis");
		expect(sql).toContain("extensions_are_isolated");
	});

	it("fails CI psql assertions with real server errors", async () => {
		const workflow = await loadCiWorkflow();
		const assertionFailures =
			workflow.match(
				/DO \$ci_fail\$ BEGIN RAISE EXCEPTION USING MESSAGE = 'CI assertion failed: [^']+'; END \$ci_fail\$;/gu,
			) ?? [];

		expect(workflow).not.toMatch(/\\q(?:uit)?[\t ]+\S/u);
		expect(assertionFailures).toHaveLength(31);
	});

	it("isolates export generation behind a dedicated function-only role", async () => {
		const sql = await loadRoleGrants();
		const grants = sql.match(/GRANT[\s\S]*?;/gu) ?? [];
		const workerGrants = grants.filter((grant) =>
			grant.includes('TO :"export_worker_role"'),
		);
		expect(workerGrants).toHaveLength(12);
		expect(workerGrants.join("\n")).toContain(
			"SELECT ON public.schema_migrations",
		);
		expect(workerGrants.join("\n")).not.toMatch(
			/ON public\.(?:users|identity_bindings|favorites|recommendation_history|private_recommendation_feedback|support_feedback|data_export_jobs)(?:\s|,|;)/u,
		);
		for (const functionName of [
			"export_artifact_required_locator_key_versions",
			"support_feedback_required_key_versions",
			"export_claim_next_job",
			"export_renew_job_lease",
			"export_stage_job_artifact",
			"export_build_safe_snapshot",
			"export_complete_job",
			"export_fail_job",
			"export_claim_next_artifact_deletion",
			"export_mark_artifact_deleted",
		]) {
			expect(workerGrants.join("\n")).toContain(`public.${functionName}`);
		}
		for (const forbiddenFunction of [
			"app_open_data_export_artifact",
			"submit_support_feedback",
			"admin_authenticate_session",
			"complete_account_deletion",
		]) {
			expect(workerGrants.join("\n")).not.toContain(forbiddenFunction);
		}
	});

	it("converges before applying a least-privilege whitelist", async () => {
		const sql = await loadRoleGrants();
		const revokeIndex = sql.indexOf("REVOKE ALL PRIVILEGES ON TABLE %I.%I");
		const firstGrantIndex = sql.indexOf("GRANT USAGE ON SCHEMA public");
		expect(revokeIndex).toBeGreaterThan(0);
		expect(firstGrantIndex).toBeGreaterThan(revokeIndex);
		expect(sql).toContain("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
		expect(sql).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
		expect(sql).toContain("REVOKE ALL PRIVILEGES (%s) ON TABLE");
		expect(sql).toContain("owner_role.rolname = :'migration_owner'");
	});

	it("gives maintenance no sensitive base-table DML", async () => {
		const sql = await loadRoleGrants();
		const grants = sql.match(/GRANT[\s\S]*?;/gu) ?? [];
		const maintenanceGrants = grants.filter((grant) =>
			grant.includes('TO :"maintenance_role"'),
		);
		expect(maintenanceGrants).toHaveLength(11);
		expect(maintenanceGrants.join("\n")).not.toMatch(
			/otp_challenges|auth_refresh_credentials|auth_access_tokens|DELETE|INSERT|UPDATE/u,
		);
		expect(maintenanceGrants.join("\n")).not.toMatch(
			/submit_support_feedback|support_feedback_required_key_versions/u,
		);
		expect(maintenanceGrants.join("\n")).toContain("preview_retention_cleanup");
		expect(maintenanceGrants.join("\n")).toContain("execute_retention_cleanup");
		expect(maintenanceGrants.join("\n")).toContain("complete_account_deletion");
		expect(maintenanceGrants.join("\n")).toContain(
			"preview_admin_security_retention_cleanup",
		);
		expect(maintenanceGrants.join("\n")).toContain(
			"execute_admin_security_retention_cleanup",
		);
		expect(maintenanceGrants.join("\n")).toContain("rewrap_support_feedback");
		expect(maintenanceGrants.join("\n")).toContain(
			"anonymize_expired_support_feedback_guest_ip_hashes",
		);
	});

	it("isolates the administrator runtime behind passkey-only functions", async () => {
		const sql = await loadRoleGrants();
		expect(sql).toContain("admin_runtime_role psql variable is required");
		expect(sql).toContain(":'runtime_role' <> :'admin_runtime_role'");
		expect(sql).toContain(":'maintenance_role' <> :'admin_runtime_role'");
		const grants = sql.match(/GRANT[\s\S]*?;/gu) ?? [];
		const adminGrants = grants.filter((grant) =>
			grant.includes('TO :"admin_runtime_role"'),
		);
		expect(adminGrants).toHaveLength(21);
		expect(adminGrants.join("\n")).not.toMatch(
			/ON public\.(admin_users|admin_roles|admin_user_roles|admin_mfa_credentials|admin_sessions|admin_webauthn_challenges)/u,
		);
		for (const functionName of [
			"admin_begin_login_challenge",
			"admin_get_login_credential_options",
			"admin_get_assertion_credential",
			"admin_complete_login_assertion",
			"admin_authenticate_session",
			"admin_begin_enroll_challenge",
			"admin_complete_credential_enrollment",
			"admin_get_self_enroll_credential_options",
			"admin_list_self_credentials",
			"admin_get_self_credential_record",
			"admin_revoke_self_credential",
			"admin_list_sanitized_audit_events",
			"admin_grant_role",
			"admin_revoke_role",
			"admin_set_user_status",
		]) {
			expect(adminGrants.join("\n")).toContain(`public.${functionName}`);
		}
		for (const forbiddenFunction of [
			"admin_bootstrap_first_security_admin",
			"admin_actor_has_permission",
			"admin_revoke_user_sessions",
			"admin_revoke_credential",
			"append_admin_security_audit_event",
			"append_admin_audit_event",
		]) {
			expect(adminGrants.join("\n")).not.toContain(forbiddenFunction);
			expect(sql).toContain(
				`REVOKE EXECUTE ON FUNCTION public.${forbiddenFunction}`,
			);
		}
	});

	it("forces runtime authentication and provider writes through restricted functions", async () => {
		const sql = await loadRoleGrants();
		expect(sql).not.toContain(
			"GRANT EXECUTE ON FUNCTION public.append_admin_audit_event",
		);
		expect(sql).toContain("GRANT SELECT, INSERT ON\n  public.otp_challenges");
		expect(sql).toContain(
			"GRANT UPDATE (revoked_at) ON public.auth_access_tokens",
		);
		for (const functionName of [
			"register_phone_wechat_account",
			"bind_email_identity_from_consumed_otp",
			"bind_qq_identity_from_consumed_oauth_state",
			"finalize_otp_delivery",
			"record_otp_verification_attempt",
			"rotate_auth_refresh_credential",
			"mark_auth_refresh_replay",
			"consume_oauth_state",
			"persistence_insert_favorite",
			"persistence_record_history",
			"persistence_insert_private_feedback",
			"submit_support_feedback",
			"support_feedback_required_key_versions",
			"app_queue_data_export",
			"app_get_data_export_status",
			"app_get_latest_data_export_status",
			"app_open_data_export_artifact",
		]) {
			expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${functionName}`);
		}
		expect(sql).not.toContain(
			"GRANT EXECUTE ON FUNCTION public.persist_licensed_external_place_reference",
		);
		expect(sql).not.toContain(
			"GRANT SELECT, INSERT, DELETE ON public.favorites",
		);
		expect(sql).not.toContain(
			'GRANT EXECUTE ON FUNCTION public.unlock_user_account(uuid) TO :"runtime_role"',
		);
		expect(sql).not.toContain(
			"GRANT EXECUTE ON FUNCTION public.reactivate_phone_email_identity_binding",
		);
		expect(sql).toContain(
			"REVOKE EXECUTE ON FUNCTION public.reactivate_phone_email_identity_binding",
		);
		expect(sql).not.toContain(
			"GRANT INSERT ON public.users, public.identity_bindings",
		);
		expect(sql).not.toMatch(/GRANT[\s\S]*?UPDATE[\s\S]*?ON public\.users/gu);
		expect(sql).not.toMatch(
			/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*ON public\.data_export_jobs/gu,
		);
		const runtimeGrantStatements = sql
			.split(";")
			.map((statement) => statement.trim())
			.filter(
				(statement) =>
					statement.startsWith("GRANT ") &&
					statement.includes('TO :"runtime_role"'),
			);
		expect(
			runtimeGrantStatements.some((statement) =>
				/ON\s+(?:TABLE\s+)?public\.support_feedback\b/u.test(statement),
			),
		).toBe(false);
		expect(sql).toContain(
			"REVOKE EXECUTE ON FUNCTION public.rewrap_support_feedback",
		);
		expect(sql).toContain(
			"REVOKE EXECUTE ON FUNCTION public.anonymize_expired_support_feedback_guest_ip_hashes",
		);
	});
});
