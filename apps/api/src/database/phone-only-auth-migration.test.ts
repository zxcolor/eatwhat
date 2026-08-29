import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

async function migrationSql(): Promise<string> {
	const migration = (await loadMigrationPlan())[10];
	expect(migration).toMatchObject({
		version: 11,
		name: "phone_only_auth",
		fileName: "0011_phone_only_auth.sql",
	});
	return migration?.sql ?? "";
}

function functionParameterHeader(sql: string, functionName: string): string {
	const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = sql.match(
		new RegExp(
			`CREATE(?: OR REPLACE)? FUNCTION public\\.${escapedName}\\s*` +
				`\\(([\\s\\S]*?)\\)\\s*RETURNS\\b`,
		),
	);
	expect(match, `missing function declaration: ${functionName}`).not.toBeNull();
	return (match?.[1] ?? "").replace(/\s+/g, " ").trim();
}

describe("PHONE_ONLY authentication migration", () => {
	it("preserves input parameter names when replacing PostgreSQL functions", async () => {
		const migrations = await loadMigrationPlan();
		const phoneOnlySql = migrations[10]?.sql ?? "";

		for (const [functionName, previousMigrationIndex] of [
			["record_otp_verification_attempt", 6],
			["finalize_otp_delivery", 0],
		] as const) {
			expect(
				functionParameterHeader(phoneOnlySql, functionName),
				`${functionName} CREATE OR REPLACE must preserve existing parameter names`,
			).toBe(
				functionParameterHeader(
					migrations[previousMigrationIndex]?.sql ?? "",
					functionName,
				),
			);
		}
	});

	it("keeps legacy EMAIL inserts compatible but makes PHONE local hashes impossible", async () => {
		const sql = await migrationSql();
		expect(sql).toContain(
			"ADD COLUMN verification_method text DEFAULT 'LOCAL_HASH'",
		);
		expect(sql).toContain("ALTER COLUMN verification_method SET NOT NULL");
		expect(sql).toContain("verification_method = 'ALIYUN_PNVS'");
		expect(sql).toContain("verification_method = 'LEGACY_INVALIDATED'");
		expect(sql).toContain("verification_method = 'LOCAL_HASH'");
		expect(sql).toContain("AND code_hash IS NULL");
		expect(sql).toContain("AND code_hash_algorithm IS NULL");
		expect(sql).toContain("AND code_hash_key_version IS NULL");
		expect(sql).toContain("code_hash_algorithm = 'ARGON2ID-PEPPERED'");
	});

	it("permanently invalidates every pre-cutover PHONE challenge without erasing consumed audit timestamps", async () => {
		const sql = await migrationSql();
		const invalidation = sql.slice(
			sql.indexOf(
				"UPDATE public.otp_challenges\n  SET verification_method = 'LEGACY_INVALIDATED'",
			),
			sql.indexOf(
				"ALTER TABLE public.otp_challenges\n  ALTER COLUMN verification_method",
			),
		);
		expect(invalidation).toContain("delivery_status = 'FAILED'");
		expect(invalidation).toContain("provider_request_hash = NULL");
		expect(invalidation).toContain("code_hash = NULL");
		expect(invalidation).toContain("sent_at = NULL");
		expect(invalidation).toContain("expires_at = NULL");
		expect(invalidation).toContain("WHERE channel = 'PHONE'");
		expect(invalidation).not.toContain("consumed_at = NULL");
		expect(invalidation).not.toContain("registration_claimed_at = NULL");
		expect(sql).toContain(
			"ADD CONSTRAINT otp_challenges_consumption_state_check",
		);
		expect(sql).toContain("AND verification_method = 'LEGACY_INVALIDATED'");
		expect(sql).toContain("AND delivery_status = 'FAILED'");
		expect(sql).toContain(
			"could not identify the OTP consumed-state constraint",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION public.validate_otp_challenge_insert",
		);
		expect(sql).toContain(
			"NEW.verification_method IS DISTINCT FROM 'ALIYUN_PNVS'",
		);
		expect(sql).toContain(
			"NEW.verification_method IS DISTINCT FROM 'LOCAL_HASH'",
		);
	});

	it("claims one durable verification lease before PNVS and consumes atomically", async () => {
		const sql = await migrationSql();
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION public.record_otp_verification_attempt",
		);
		expect(sql).toContain("AND otp.channel = 'EMAIL'");
		expect(sql).toContain("AND otp.verification_method = 'LOCAL_HASH'");
		expect(sql).toContain("CREATE TABLE public.otp_verification_leases");
		expect(sql).toContain(
			"CREATE FUNCTION public.claim_otp_verification_lease",
		);
		expect(sql).toContain(
			"CREATE FUNCTION public.release_otp_verification_lease",
		);
		expect(sql).toContain(
			"CREATE FUNCTION public.complete_otp_verification_lease",
		);
		expect(sql).toContain("pg_catalog.pg_advisory_xact_lock");
		expect(sql).toContain("DELETE FROM public.otp_verification_leases");
		expect(sql).toContain("AND otp.verification_method = 'ALIYUN_PNVS'");
		expect(sql).toContain("AND otp.attempts < 5");
		expect(sql).toContain("attempts = attempts + 1");
		expect(sql).toContain(
			"consumed_at = CASE WHEN verification_succeeded THEN event_time ELSE NULL END",
		);
	});

	it("atomically invalidates older local PHONE challenges after a PNVS resend", async () => {
		const sql = await migrationSql();
		expect(sql).toContain(
			"CREATE FUNCTION public.supersede_phone_otp_challenges_for_send",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION public.finalize_otp_delivery",
		);
		expect(sql).toContain(
			"'pnvs-send:' || pending_challenge.destination_dedup_hash",
		);
		expect(sql).not.toContain(
			"'pnvs-send:' || pending_challenge.destination_dedup_hash\n        || ':' || pending_challenge.purpose",
		);
		expect(sql).toContain("(newer.created_at, newer.id) >");
		expect(sql).toContain(
			"DELETE FROM public.otp_verification_leases AS lease",
		);
		expect(sql).toContain("older.delivery_status IN ('PENDING', 'SENT')");
		expect(sql).toContain("older.delivery_status = 'SENT'");
		expect(sql).toContain("SET delivery_status = 'FAILED'");
		expect(sql).toContain("older.consumed_at IS NULL");
	});

	it("adds only phone registration and generic authenticated OAuth binding", async () => {
		const sql = await migrationSql();
		expect(sql).toContain(
			"CREATE FUNCTION public.register_phone_account_from_consumed_otp",
		);
		expect(sql).toContain(
			"CREATE FUNCTION public.bind_oauth_identity_from_consumed_state",
		);
		expect(sql).toContain("p_provider NOT IN ('WECHAT', 'QQ')");
		expect(sql).toContain("lookup_binding_id <> existing_binding_id");
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION public.protect_identity_binding_update",
		);
		expect(sql).toContain("dedup_hash = proof_dedup_hash");
		expect(sql).toContain("dedup_hash_key_version = proof_dedup_key_version");
		expect(sql).not.toMatch(/DROP TABLE[^;]*fusion/iu);
		expect(sql).not.toMatch(/DROP FUNCTION[^;]*fusion/iu);
	});

	it("revokes direct public access to lease and registration primitives", async () => {
		const sql = await migrationSql();
		expect(sql).toContain(
			"REVOKE ALL ON TABLE public.otp_verification_leases FROM PUBLIC",
		);
		for (const functionName of [
			"supersede_phone_otp_challenges_for_send",
			"claim_otp_verification_lease",
			"release_otp_verification_lease",
			"complete_otp_verification_lease",
			"register_phone_account_from_consumed_otp",
			"bind_oauth_identity_from_consumed_state",
		]) {
			expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${functionName}`);
		}
	});
});
