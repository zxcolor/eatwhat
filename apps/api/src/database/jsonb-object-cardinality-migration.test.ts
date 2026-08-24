import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

describe("JSONB object cardinality compatibility migration", () => {
	it("adds forward replacements for both validators", async () => {
		const migration = (await loadMigrationPlan())[7];
		expect(migration).toMatchObject({
			version: 8,
			name: "fix_jsonb_object_cardinality",
		});
		const sql = migration?.sql ?? "";
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION public.app_config_value_is_valid",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION public.audit_context_is_valid",
		);
		expect(sql).toContain(
			"FROM pg_catalog.jsonb_object_keys(input_value)",
		);
		expect(sql).toContain("FROM pg_catalog.jsonb_object_keys(value)");
		expect(sql).toContain(
			"WHEN 'RECOMMENDATION_RULES_V1' THEN key_count = 6",
		);
		expect(sql).toContain("IF key_count <> 1");
		expect(sql).not.toContain("jsonb_object_length");
	});
});
