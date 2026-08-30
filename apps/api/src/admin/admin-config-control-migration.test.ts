import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = fileURLToPath(
	new URL("../../migrations/0013_admin_config_control.sql", import.meta.url),
);
const ROLE_GRANTS_PATH = fileURLToPath(
	new URL("../../../../infra/postgres/role-grants.sql", import.meta.url),
);

describe("administrator configuration control migration", () => {
	it("fixes keys, schemas, reasons, bounds, and optimistic versioning", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf8");
		for (const value of [
			"features.ai-assistance",
			"recommendations.rules",
			"recommendations.prompt",
			"coverage.default",
			"clients.minimum-version",
			"FEATURE_FLAGS_V1",
			"RECOMMENDATION_RULES_V1",
			"PROMPT_SETTINGS_V1",
			"COVERAGE_SETTINGS_V1",
			"MINIMUM_APP_VERSION_V1",
			"ROUTINE_TUNING",
			"INCIDENT_RESPONSE",
			"RELEASE_COMPATIBILITY",
			"ROLLBACK",
		]) {
			expect(sql).toContain(value);
		}
		expect(sql).toContain("rules_total = 95");
		expect(sql).toContain("NOT BETWEEN 0 AND 5");
		expect(sql).toContain("NOT BETWEEN 500 AND 2500");
		expect(sql).toContain("NOT BETWEEN 200 AND 10000");
		expect(sql).toContain("p_expected_active_version IS DISTINCT FROM");
		expect(sql).toContain(
			"COALESCE(MAX(config_version.version)::bigint, 0) + 1",
		);
	});

	it("fences direct table writes and exposes only controlled functions", async () => {
		const [migration, grants] = await Promise.all([
			readFile(MIGRATION_PATH, "utf8"),
			readFile(ROLE_GRANTS_PATH, "utf8"),
		]);
		for (const functionName of [
			"runtime_list_active_app_config",
			"admin_list_active_app_config",
			"admin_list_app_config_history",
			"admin_publish_app_config",
			"admin_rollback_app_config",
		]) {
			expect(migration).toContain(`FUNCTION public.${functionName}`);
			expect(grants).toContain(`FUNCTION public.${functionName}`);
		}
		expect(migration).toContain("app_config_controlled_mutation");
		expect(migration).toContain("app_config_forbid_direct_truncate");
		expect(grants).not.toMatch(
			/GRANT SELECT ON[^;]*public\.app_config_versions[^;]*TO :"runtime_role"/u,
		);
		expect(grants).toContain("public.app_config_versions,");
		expect(grants).not.toMatch(
			/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*public\.app_config_versions[^;]*TO :"admin_runtime_role"/u,
		);
	});

	it("records publish and copy-forward rollback audit actions without secret fields", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf8");
		expect(sql).toContain("ADMIN_CONFIG_PUBLISHED");
		expect(sql).toContain("ADMIN_CONFIG_ROLLED_BACK");
		expect(sql).toContain("target_record.value_json");
		expect(sql).toContain("'configKey', p_config_key");
		expect(sql).toContain("'newVersion', published_record.version");
		expect(sql).toContain("'sourceVersion', target_record.version");
		expect(sql).toContain("admin_list_sanitized_audit_events_v2");
		expect(sql).not.toMatch(/jsonb_build_object\([^)]*value_json/isu);
		expect(sql).not.toMatch(/token_json|api_key|app_key|app_secret/iu);
	});
});
