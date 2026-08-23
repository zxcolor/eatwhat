import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

const ROLE_GRANTS_PATH = fileURLToPath(
	new URL("../../../../infra/postgres/role-grants.sql", import.meta.url),
);

describe("provider-neutral persistence migration", () => {
	it("keeps only app-owned tombstones after provider rights are lost", async () => {
		const migration = (await loadMigrationPlan())[1]?.sql ?? "";
		expect(migration).toContain("ADD COLUMN rights_revoked_at timestamptz");
		expect(migration).toContain("SET external_place_reference_id = NULL");
		expect(migration).not.toMatch(
			/ADD COLUMN (provider_code|provider_place_id|name|address|phone|latitude|longitude)/u,
		);
		const revoke = migration.slice(
			migration.indexOf(
				"CREATE OR REPLACE FUNCTION public.revoke_data_rights_authorization",
			),
			migration.indexOf(
				"CREATE OR REPLACE FUNCTION public.purge_inactive_external_place_references",
			),
		);
		expect(revoke).toContain("UPDATE public.favorites");
		expect(revoke).not.toContain("DELETE FROM public.favorites");
		expect(revoke).toContain("rights_revoked_at = event_time");
	});

	it("funnels runtime writes through scoped security-definer functions", async () => {
		const migration = (await loadMigrationPlan())[1]?.sql ?? "";
		const grants = await readFile(ROLE_GRANTS_PATH, "utf8");
		for (const functionName of [
			"claim_persistence_idempotency",
			"persistence_insert_favorite",
			"persistence_record_history",
			"persistence_insert_private_feedback",
			"persistence_delete_favorite",
			"persistence_clear_history",
			"persistence_clear_private_feedback",
		]) {
			expect(migration).toContain(`CREATE FUNCTION public.${functionName}`);
			expect(grants).toContain(
				`GRANT EXECUTE ON FUNCTION public.${functionName}`,
			);
		}
		expect(grants).not.toContain(
			"GRANT SELECT, INSERT, DELETE ON public.favorites",
		);
		expect(grants).toContain(
			"REVOKE EXECUTE ON FUNCTION public.persist_licensed_external_place_reference",
		);
	});

	it("enforces user-scoped 24 hour idempotency without storing raw tokens", async () => {
		const migration = (await loadMigrationPlan())[1]?.sql ?? "";
		expect(migration).toContain(
			"PRIMARY KEY (user_id, operation_code, idempotency_key_hash)",
		);
		expect(migration).toContain(
			"CHECK (retain_until = created_at + interval '24 hours')",
		);
		expect(migration).not.toMatch(
			/\b(result_token|access_token|refresh_token)\b/iu,
		);
		expect(migration).toContain("PERSISTENCE_IDEMPOTENCY_24H");
	});
});
