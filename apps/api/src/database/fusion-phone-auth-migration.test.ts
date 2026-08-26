import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

describe("fusion phone authentication migration", () => {
	it("stores only versioned hashes and a masked phone proof", async () => {
		const migration = (await loadMigrationPlan())[9];
		expect(migration).toMatchObject({
			version: 10,
			name: "fusion_phone_auth",
		});
		const sql = migration?.sql ?? "";
		const table = sql.slice(
			sql.indexOf("CREATE TABLE public.fusion_auth_flows"),
			sql.indexOf("CREATE INDEX fusion_auth_flows_device_idx"),
		);
		expect(table).toContain("verify_token_hash varchar(64)");
		expect(table).toContain("verified_phone_lookup_hash varchar(64)");
		expect(table).toContain("verified_phone_dedup_hash varchar(64)");
		expect(table).toContain("masked_phone varchar(32)");
		expect(table).toContain("registration_flow_reference_hash varchar(64)");
		expect(table).toContain("request_ip_hash varchar(64) NOT NULL");
		expect(table).toContain("device_hash varchar(64) NOT NULL");
		expect(table).not.toMatch(
			/^\s*(phone_number|raw_phone|auth_token|verify_token|access_key)\s+/imu,
		);
	});

	it("binds, bounds and consumes each purpose through restricted primitives", async () => {
		const sql = (await loadMigrationPlan())[9]?.sql ?? "";
		expect(sql).toContain("purpose IN ('LOGIN', 'REGISTER')");
		expect(sql).toContain("attempts BETWEEN 0 AND 5");
		expect(sql).toContain(
			"CREATE FUNCTION public.claim_fusion_auth_verify_token",
		);
		expect(sql).toContain("CREATE FUNCTION public.record_fusion_auth_result");
		expect(sql).toContain("attempts = attempts + 1");
		expect(sql).toContain("event_time + interval '1 second'");
		expect(sql).toContain(
			"LEAST(expires_at, event_time + interval '5 minutes')",
		);
		expect(sql).toContain("p_consume_on_success");
		expect(sql).toContain("CREATE FUNCTION public.register_fusion_phone_wechat_account");
		expect(sql).toContain("flow.proof_expires_at > event_time");
		expect(sql).toContain("flow.device_hash = p_device_hash");
		expect(sql).toContain("oauth.device_hash = p_device_hash");
		expect(sql).toContain("FOR UPDATE");
		expect(sql).toContain("SECURITY DEFINER");
		expect(sql).toContain("SET search_path = pg_catalog, public");
		expect(sql).toContain("fusion authentication flow can be consumed only once");
	});

	it("claims each VerifyToken globally before provider verification", async () => {
		const sql = (await loadMigrationPlan())[9]?.sql ?? "";
		expect(sql).toContain(
			"CREATE TABLE public.fusion_auth_verify_token_claims",
		);
		expect(sql).toContain(
			"UNIQUE (verify_token_hash_key_version, verify_token_hash)",
		);
		expect(sql).toContain("cardinality(p_verify_token_hashes) NOT BETWEEN 1 AND 3");
		expect(sql).toContain("p_verify_token_hash_key_versions");
		expect(sql).toContain("INSERT INTO public.fusion_auth_verify_token_claims");
		expect(sql).toContain("EXCEPTION WHEN unique_violation");
		expect(sql).toContain("AND verify_token_hash IS NULL");
		expect(sql).toContain("AND attempts = 0");
		expect(sql).toContain("consumed_at = event_time");
		const claimFunction = sql.slice(
			sql.indexOf("CREATE FUNCTION public.claim_fusion_auth_verify_token"),
			sql.indexOf("CREATE FUNCTION public.record_fusion_auth_result"),
		);
		expect(claimFunction).not.toContain("RAISE EXCEPTION");
	});

	it("revokes PUBLIC and exposes fixed count-only retention entrypoints", async () => {
		const sql = (await loadMigrationPlan())[9]?.sql ?? "";
		expect(sql).toContain("REVOKE ALL ON public.fusion_auth_flows FROM PUBLIC");
		expect(sql).toContain(
			"REVOKE ALL ON public.fusion_auth_verify_token_claims FROM PUBLIC",
		);
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.claim_fusion_auth_verify_token",
		);
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.record_fusion_auth_result",
		);
		expect(sql).toContain(
			"CREATE FUNCTION public.preview_fusion_auth_retention_cleanup()",
		);
		expect(sql).toContain(
			"CREATE FUNCTION public.execute_fusion_auth_retention_cleanup()",
		);
		expect(sql).toContain("'FUSION_AUTH_24H'");
	});
});
