import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

const ROLE_GRANTS_PATH = fileURLToPath(
	new URL("../../../../infra/postgres/role-grants.sql", import.meta.url),
);

function functionDefinition(sql: string, functionName: string): string {
	const start = sql.indexOf(`CREATE FUNCTION public.${functionName}`);
	if (start < 0) throw new Error(`missing function ${functionName}`);
	const end = sql.indexOf("\n$$;", start);
	if (end < 0) throw new Error(`missing terminator for ${functionName}`);
	return sql.slice(start, end + 4);
}

function replacedFunctionDefinition(sql: string, functionName: string): string {
	const start = sql.indexOf(
		`CREATE OR REPLACE FUNCTION public.${functionName}`,
	);
	if (start < 0)
		throw new Error(`missing replacement function ${functionName}`);
	const end = sql.indexOf("\n$$;", start);
	if (end < 0)
		throw new Error(`missing replacement terminator ${functionName}`);
	return sql.slice(start, end + 4);
}

describe("data export delivery migration", () => {
	it("records request scope, a fenced bounded lease and verified artifact metadata", async () => {
		const sql = (await loadMigrationPlan())[5]?.sql ?? "";
		for (const column of [
			"include_behavior_history boolean NOT NULL",
			"state_version bigint NOT NULL",
			"attempt_count smallint NOT NULL",
			"lease_owner_hash varchar(64)",
			"lease_owner_hash_algorithm text",
			"lease_owner_hash_key_version varchar(64)",
			"lease_expires_at timestamptz",
			"artifact_sha256 varchar(64)",
			"artifact_size_bytes bigint",
			"artifact_content_type varchar(64)",
			"ready_at timestamptz",
		]) {
			expect(sql).toContain(column);
		}
		expect(sql).toContain("attempt_count BETWEEN 0 AND 5");
		expect(sql).toContain("lease_owner_hash IS NOT NULL");
		expect(sql).toContain("lease_owner_hash_key_version IS NOT NULL");
		expect(sql).toContain("p_lease_seconds < 30 OR p_lease_seconds > 900");
		expect(sql).toContain("p_failure_code IS NULL OR p_failure_code NOT IN");
		expect(sql).toContain("artifact_size_bytes BETWEEN 1 AND 10485760");
		expect(sql).toContain("artifact_content_type = 'application/json'");
		expect(sql).toContain("failure_code IN (");
		expect(sql).toContain("'RETRY_EXHAUSTED'");
		expect(sql).toContain("'ACCOUNT_DELETION_REQUESTED'");
	});

	it("funnels the API through queue and public status primitives", async () => {
		const sql = (await loadMigrationPlan())[5]?.sql ?? "";
		const queue = functionDefinition(sql, "app_queue_data_export");
		expect(queue).toContain("p_include_behavior_history boolean");
		expect(queue).toContain("pg_advisory_xact_lock");
		expect(queue).toContain("'CREATED'::text");
		expect(queue).toContain("'REPLAY'::text");
		expect(queue).toContain("'CONFLICT'::text");
		for (const functionName of [
			"app_get_data_export_status",
			"app_get_latest_data_export_status",
		]) {
			const status = functionDefinition(sql, functionName);
			expect(status).toContain("include_behavior_history boolean");
			expect(status).toContain("WHEN job.status = 'PENDING' THEN 'QUEUED'");
			expect(status).not.toMatch(
				/artifact_locator_ciphertext|encryption_key_version/iu,
			);
		}
		expect(sql).not.toMatch(/download_grant|download_token|presigned/iu);
	});

	it("opens an artifact only for the current owner in a live READY window", async () => {
		const sql = (await loadMigrationPlan())[5]?.sql ?? "";
		const open = functionDefinition(sql, "app_open_data_export_artifact");
		expect(open).toContain("job.user_id = p_user_id");
		expect(open).toContain("account_user.status = 'ACTIVE'");
		expect(open).toContain("job.status = 'READY'");
		expect(open).toContain("job.expires_at > now()");
		expect(open).toContain("job.artifact_deleted_at IS NULL");
		expect(open).toContain("artifact_locator_ciphertext bytea");
		expect(open).toContain("chi-shen-me-data-export-");
	});

	it("requires an active fenced worker lease for build, renew, completion and failure", async () => {
		const sql = (await loadMigrationPlan())[5]?.sql ?? "";
		const claim = functionDefinition(sql, "export_claim_next_job");
		expect(claim).toContain("FOR UPDATE OF job SKIP LOCKED");
		expect(claim).toContain("attempt_count = job.attempt_count + 1");
		expect(claim).toContain("state_version = job.state_version + 1");
		expect(claim).toContain("artifact_locator_ciphertext bytea");
		const stage = functionDefinition(sql, "export_stage_job_artifact");
		expect(stage).toContain("job.state_version = p_expected_state_version");
		expect(stage).toContain("job.artifact_locator_ciphertext IS NULL");
		expect(stage).toContain("state_version = job.state_version + 1");
		expect(stage).toContain(
			"job.artifact_locator_ciphertext = p_artifact_locator_ciphertext",
		);
		for (const frozenField of [
			"artifact_sha256 = p_artifact_sha256",
			"artifact_size_bytes = p_artifact_size_bytes",
			"artifact_content_type = p_artifact_content_type",
		]) {
			expect(stage).toContain(frozenField);
		}
		for (const functionName of [
			"export_renew_job_lease",
			"export_complete_job",
			"export_fail_job",
		]) {
			const definition = functionDefinition(sql, functionName);
			expect(definition).toContain(
				"job.state_version = p_expected_state_version",
			);
			expect(definition).toContain("job.lease_owner_hash = p_worker_hash");
			expect(definition).toContain(
				"job.lease_owner_hash_key_version = p_worker_hash_key_version",
			);
			expect(definition).toContain("job.lease_expires_at > event_time");
		}
		const complete = functionDefinition(sql, "export_complete_job");
		expect(complete).not.toContain("p_artifact_locator_ciphertext");
		expect(complete).not.toMatch(/p_artifact_(?:sha256|size_bytes|content_type)/u);
		expect(complete).toContain("job.artifact_locator_ciphertext IS NOT NULL");
	});

	it("freezes the worker snapshot shape and excludes provider, auth and internal hashes", async () => {
		const sql = (await loadMigrationPlan())[5]?.sql ?? "";
		const snapshot = functionDefinition(sql, "export_build_safe_snapshot");
		for (const field of [
			"'schemaVersion', 1",
			"'generatedAt'",
			"'account'",
			"'accountId'",
			"'identities'",
			"'identityType'",
			"'maskedDisplayHint'",
			"'isPrimary'",
			"'favorites'",
			"'placeReferenceAvailable'",
			"'recommendationHistory'",
			"'action'",
			"'mealPeriod'",
			"'privateFeedback'",
			"'preferences', '{}'::jsonb",
			"'supportFeedbackEncrypted'",
			"'ciphertextBase64'",
			"'encryptionKeyVersion'",
		]) {
			expect(snapshot).toContain(field);
		}
		expect(snapshot).toContain("IF export_job.include_behavior_history THEN");
		expect(snapshot).toContain("history.retain_until > now()");
		expect(snapshot).toContain(
			"support.retain_until IS NULL OR support.retain_until > now()",
		);
		for (const budget of ["LIMIT 33", "LIMIT 1001", "LIMIT 5001", "LIMIT 2001", "LIMIT 101"]) {
			expect(snapshot).toContain(budget);
		}
		expect(snapshot.match(/USING ERRCODE = '54000'/gu)).toHaveLength(5);
		expect(snapshot).toContain("export_job.created_at AT TIME ZONE 'UTC'");
		expect(snapshot).toContain("public.active_external_place_references");
		expect(snapshot).not.toMatch(
			/(?:favorite|history|feedback)\.rights_revoked_at/gu,
		);
		expect(snapshot).toContain(
			"octet_length(support.content_ciphertext) NOT BETWEEN 16 AND 65536",
		);
		expect(snapshot).not.toMatch(
			/provider_code|provider_place_id|lookup_hash|dedup_hash|request_correlation_hash|content_fingerprint|guest_ip_hash|latitude|longitude|auth_(?:access|refresh)|otp_|admin_audit/iu,
		);
		expect(snapshot).not.toContain("'exportId'");
		expect(snapshot).not.toContain("'updatedAt'");
	});

	it("exposes only a distinct worker-only locator key coverage gate", async () => {
		const sql = (await loadMigrationPlan())[5]?.sql ?? "";
		const coverage = functionDefinition(
			sql,
			"export_artifact_required_locator_key_versions",
		);
		expect(coverage).toContain("RETURNS TABLE(key_version varchar)");
		expect(coverage).toContain("SELECT DISTINCT job.encryption_key_version");
		expect(coverage).toContain("job.artifact_deleted_at IS NULL");
		expect(coverage).toContain("SECURITY DEFINER");
		expect(coverage).toContain("SET search_path = pg_catalog, public");
		expect(coverage).not.toMatch(/artifact_locator_ciphertext\s*[,)]/u);
	});

	it("keeps artifact deletion leased and account deletion fail closed", async () => {
		const sql = (await loadMigrationPlan())[5]?.sql ?? "";
		const claimDelete = functionDefinition(
			sql,
			"export_claim_next_artifact_deletion",
		);
		expect(claimDelete).toContain("lease_purpose = 'DELETE'");
		expect(claimDelete).toContain("artifact_deleted_at IS NULL");
		expect(claimDelete).toContain("job.lease_expires_at <= event_time");
		expect(claimDelete).toContain("NOT EXISTS (");
		expect(claimDelete).toContain(
			"inactive_unstaged.artifact_locator_ciphertext IS NULL",
		);
		expect(claimDelete).toContain(
			"failure_code = 'ACCOUNT_DELETION_REQUESTED'",
		);
		expect(claimDelete).toContain(
			"state_version = inactive_unstaged.state_version + 1",
		);
		const markDelete = functionDefinition(sql, "export_mark_artifact_deleted");
		expect(markDelete).toContain(
			"job.state_version = p_expected_state_version",
		);
		expect(markDelete).toContain("job.lease_expires_at > event_time");
		const accountDelete = replacedFunctionDefinition(
			sql,
			"complete_account_deletion",
		);
		expect(accountDelete).toContain("status IN ('PENDING', 'PROCESSING')");
		expect(accountDelete).toContain("artifact_locator_ciphertext IS NOT NULL");
		expect(accountDelete).toContain("artifact_deleted_at IS NULL");
	});

	it("revokes every new function from PUBLIC and all base-table access", async () => {
		const sql = (await loadMigrationPlan())[5]?.sql ?? "";
		expect(sql).toContain("REVOKE ALL ON public.data_export_jobs FROM PUBLIC");
		for (const functionName of [
			"app_queue_data_export",
			"app_get_data_export_status",
			"app_get_latest_data_export_status",
			"app_open_data_export_artifact",
			"export_artifact_required_locator_key_versions",
			"export_claim_next_job",
			"export_renew_job_lease",
			"export_stage_job_artifact",
			"export_build_safe_snapshot",
			"export_complete_job",
			"export_fail_job",
			"export_claim_next_artifact_deletion",
			"export_mark_artifact_deleted",
		]) {
			expect(sql).toContain(
				`REVOKE EXECUTE ON FUNCTION public.${functionName}`,
			);
		}
		const grants = await readFile(ROLE_GRANTS_PATH, "utf8");
		expect(grants).not.toMatch(
			/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*ON public\.data_export_jobs/gu,
		);
	});
});
