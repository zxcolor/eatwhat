import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

function functionDefinition(sql: string, functionName: string): string {
	const start = sql.indexOf(`CREATE FUNCTION public.${functionName}`);
	if (start < 0) throw new Error(`missing function ${functionName}`);
	const end = sql.indexOf("\n$$;", start);
	if (end < 0) throw new Error(`missing function terminator ${functionName}`);
	return sql.slice(start, end + 4);
}

describe("support feedback security migration", () => {
	it("stores only versioned HMAC fingerprints and no raw guest address", async () => {
		const sql = (await loadMigrationPlan())[4]?.sql ?? "";
		expect(sql).toContain("content_fingerprint_algorithm = 'HMAC-SHA256'");
		expect(sql).toContain("content_fingerprint_key_version");
		expect(sql).toContain("guest_ip_hash_algorithm = 'HMAC-SHA256'");
		expect(sql).toContain("guest_ip_hash_key_version");
		expect(sql).toContain("guest_ip_destroyed_at");
		expect(sql).not.toMatch(/\b(raw_ip|client_ip|ip_address)\b/iu);
	});

	it("serializes idempotency and quota in one atomic submission function", async () => {
		const sql = (await loadMigrationPlan())[4]?.sql ?? "";
		const submit = functionDefinition(sql, "submit_support_feedback");
		expect(submit).toContain("SECURITY DEFINER");
		expect(submit).toContain("SET search_path = pg_catalog, public");
		expect(submit).toContain("pg_advisory_xact_lock(");
		expect(submit).toContain("FOR UPDATE");
		expect(submit).toContain("RETURN 'INSERTED'");
		expect(submit).toContain("RETURN 'REPLAY'");
		expect(submit).toContain("RETURN 'MISMATCH'");
		expect(submit).toContain("account_daily_quota constant integer := 20");
		expect(submit).toContain("guest_daily_quota constant integer := 5");
		expect(submit).toContain("ERRCODE = 'P5100'");
		expect(submit).toContain("p_content_fingerprint_candidates");
		expect(submit).toContain("p_guest_ip_hash_candidates");
		expect(submit).toContain(
			"existing_feedback.guest_ip_destroyed_at IS NOT NULL",
		);
		expect(submit).toContain(
			"guest_ip_destroyed_at = existing_feedback.guest_ip_destroyed_at",
		);
	});

	it("keeps table rows hidden and key rotation behind bounded primitives", async () => {
		const sql = (await loadMigrationPlan())[4]?.sql ?? "";
		const coverage = functionDefinition(
			sql,
			"support_feedback_required_key_versions",
		);
		expect(coverage).toContain("SECURITY DEFINER");
		expect(coverage).not.toContain("content_ciphertext");
		expect(coverage).not.toContain("content_fingerprint,");
		const rewrap = functionDefinition(sql, "rewrap_support_feedback");
		expect(rewrap).toContain("p_expected_content_fingerprint");
		expect(rewrap).toContain("IS DISTINCT FROM p_expected_content_fingerprint");
		expect(rewrap).toContain("RETURN 'STALE'");
		expect(rewrap).not.toContain("RETURN QUERY");
		const anonymize = functionDefinition(
			sql,
			"anonymize_expired_support_feedback_guest_ip_hashes",
		);
		expect(anonymize).toContain(
			"created_at <= event_time - interval '24 hours'",
		);
		expect(anonymize).toContain("guest_ip_hash = NULL");
		expect(anonymize).toContain("guest_ip_destroyed_at = event_time");
		expect(anonymize).not.toContain("content_ciphertext =");
		expect(sql).toContain("REVOKE ALL ON public.support_feedback FROM PUBLIC");
		for (const functionName of [
			"submit_support_feedback",
			"support_feedback_required_key_versions",
			"rewrap_support_feedback",
			"anonymize_expired_support_feedback_guest_ip_hashes",
		]) {
			expect(sql).toContain(
				`REVOKE EXECUTE ON FUNCTION public.${functionName}`,
			);
		}
	});
});
