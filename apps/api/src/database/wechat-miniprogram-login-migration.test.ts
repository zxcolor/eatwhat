import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

async function migrationSql(): Promise<string> {
	const migration = (await loadMigrationPlan())[13];
	expect(migration).toMatchObject({
		version: 14,
		name: "wechat_miniprogram_login",
		fileName: "0014_wechat_miniprogram_login.sql",
	});
	return migration?.sql ?? "";
}

describe("WeChat Mini Program account resolution migration", () => {
	it("requires a recent consumed login proof with no binding or registration target", async () => {
		const sql = await migrationSql();
		for (const required of [
			"oauth.provider = 'WECHAT'",
			"oauth.purpose = 'LOGIN'",
			"oauth.target_user_id IS NULL",
			"oauth.consumed_at > event_time - interval '15 minutes'",
			"oauth.consumed_at <= event_time",
			"oauth.consumed_at >= oauth.created_at",
			"oauth.consumed_at < oauth.expires_at",
			"oauth.registration_claimed_at IS NULL",
			"oauth.binding_claimed_at IS NULL",
			"FOR UPDATE OF oauth",
		])
			expect(sql).toContain(required);
	});

	it("resolves only the exact realm and keyed UnionID alias without creating identities", async () => {
		const sql = await migrationSql();
		for (const required of [
			"RETURNS TABLE(result text, user_id uuid)",
			"alias.realm_id = proof_record.verified_union_realm_id",
			"alias.union_hash = proof_record.verified_union_hash",
			"alias.union_hash_key_version = proof_record.verified_union_hash_key_version",
			"'SUCCESS'::text",
			"'INVALID_CREDENTIALS'::text",
			"'IDENTITY_NOT_BOUND'::text",
			"'IDENTITY_CONFLICT'::text",
		])
			expect(sql).toContain(required);
		expect(sql).not.toMatch(
			/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+public\.|EXECUTE\s+format|CREATE\s+TABLE)\b/iu,
		);
	});

	it("locks original binding and users and rejects conflicting OpenID ownership or revocation", async () => {
		const sql = await migrationSql();
		for (const required of [
			"binding.lookup_hash = proof_record.verified_subject_lookup_hash",
			"binding.dedup_hash = proof_record.verified_subject_dedup_hash",
			"binding_record.user_id IS DISTINCT FROM alias_record.user_id",
			"binding_record.revoked_at IS NOT NULL",
			"binding_record.user_status IS DISTINCT FROM 'ACTIVE'",
			"ORDER BY binding.id",
			"FOR UPDATE OF binding, account_user",
			"FOR SHARE OF alias",
		])
			expect(sql).toContain(required);
	});

	it("grants only API runtime a fixed-search-path resolver and never exposes alias tables", async () => {
		const sql = await migrationSql();
		expect(sql.match(/SECURITY DEFINER/gu)).toHaveLength(1);
		expect(sql).toContain("SET search_path = pg_catalog, public");
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.resolve_wechat_miniprogram_user_from_consumed_state(",
		);
		const grants = await readFile(
			new URL("../../../../infra/postgres/role-grants.sql", import.meta.url),
			"utf8",
		);
		expect(grants).toContain(
			"\\if :wechat_miniprogram_schema_0014\nGRANT EXECUTE ON FUNCTION public.resolve_wechat_miniprogram_user_from_consumed_state(",
		);
		expect(grants).toContain(
			"role grants require the exact 0010, 0011, 0012, 0013 or 0014 schema",
		);
		const resolverGrants =
			grants.match(
				/GRANT EXECUTE ON FUNCTION public\.resolve_wechat_miniprogram_user_from_consumed_state\([\s\S]*?;/gu,
			) ?? [];
		expect(resolverGrants).toHaveLength(1);
		expect(resolverGrants[0]).toContain('TO :"runtime_role"');
		expect(grants).not.toMatch(
			/GRANT[^;]*ON (?:TABLE )?public\.wechat_union_aliases/iu,
		);
	});
});
