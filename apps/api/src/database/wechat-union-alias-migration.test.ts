import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

async function migrationSql(): Promise<string> {
	const migration = (await loadMigrationPlan())[11];
	expect(migration).toMatchObject({
		version: 12,
		name: "wechat_union_aliases",
		fileName: "0012_wechat_union_aliases.sql",
	});
	return migration?.sql ?? "";
}

describe("WeChat Union alias migration", () => {
	it("keeps AppID-scoped identity and UnionID alias proofs separate", async () => {
		const sql = await migrationSql();
		expect(sql).toContain("CREATE TABLE public.wechat_union_aliases");
		expect(sql).toContain("verified_union_realm_id varchar(64)");
		expect(sql).toContain("verified_union_hash varchar(64)");
		expect(sql).toContain("oauth_union_proof_all_or_none");
		expect(sql).toContain("oauth_union_proof_wechat_only");
		expect(sql).toContain("oauth_union_proof_consumed_only");
		expect(sql).not.toMatch(/\bunionid\s+(?:varchar|text|bytea)\b/iu);
	});

	it("ties one immutable HMAC alias to one WeChat binding and one user", async () => {
		const sql = await migrationSql();
		expect(sql).toContain(
			"FOREIGN KEY (identity_binding_id, user_id)\n    REFERENCES public.identity_bindings(id, user_id) ON DELETE CASCADE",
		);
		expect(sql).toContain(
			"CONSTRAINT wechat_union_alias_user_unique UNIQUE (realm_id, user_id)",
		);
		expect(sql).toContain(
			"CONSTRAINT wechat_union_alias_hash_unique UNIQUE (realm_id, union_hash)",
		);
		expect(sql).toContain("union_hash_algorithm = 'HMAC-SHA256'");
		expect(sql).toContain("binding.identity_type = 'WECHAT'");
		expect(sql).toContain("WeChat Union alias identity fields are immutable");
	});

	it("allows alias writes only from a consumed verified WeChat state", async () => {
		const sql = await migrationSql();
		for (const functionName of [
			"consume_oauth_state_with_wechat_union",
			"record_wechat_union_alias_from_consumed_state",
			"bind_oauth_identity_with_wechat_union_from_consumed_state",
		]) {
			expect(sql).toContain(`CREATE FUNCTION public.${functionName}`);
			expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${functionName}`);
		}
		expect(sql.match(/SECURITY DEFINER/gu)).toHaveLength(3);
		expect(
			sql.match(/SET search_path = pg_catalog, public/gu)?.length,
		).toBeGreaterThanOrEqual(7);
		expect(sql).toContain(
			"oauth.consumed_at > event_time - interval '15 minutes'",
		);
		expect(sql).toContain("account_user.status = 'ACTIVE'");
		expect(sql).toContain("binding.revoked_at IS NULL");
		expect(sql).toContain("binding.lookup_hash = proof_lookup_hash");
		expect(sql).toContain(
			"binding.lookup_hash_key_version = proof_lookup_key_version",
		);
		expect(sql).toContain("binding.dedup_hash = proof_dedup_hash");
		expect(sql).toContain(
			"binding.dedup_hash_key_version = proof_dedup_key_version",
		);
		expect(sql).toContain("pg_advisory_xact_lock");
		expect(sql).toContain(
			"REVOKE ALL ON TABLE public.wechat_union_aliases FROM PUBLIC",
		);
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.validate_wechat_union_alias_insert() FROM PUBLIC",
		);
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.protect_wechat_union_alias_update() FROM PUBLIC",
		);
		expect(sql).not.toContain("GRANT SELECT ON public.wechat_union_aliases");
	});

	it("rolls a newly bound identity back when its verified alias conflicts", async () => {
		const sql = await migrationSql();
		expect(sql).toContain(
			"SELECT public.bind_oauth_identity_from_consumed_state(",
		);
		expect(sql).toContain(
			"public.record_wechat_union_alias_from_consumed_state(",
		);
		expect(sql).toContain("ERRCODE = 'CSM12'");
		expect(sql).toContain("EXCEPTION WHEN SQLSTATE 'CSM12' THEN");
	});
});
