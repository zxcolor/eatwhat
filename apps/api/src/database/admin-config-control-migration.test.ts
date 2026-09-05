import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadMigrationPlan } from "./migration-plan.js";

const ROLE_GRANTS_PATH = new URL(
	"../../../../infra/postgres/role-grants.sql",
	import.meta.url,
);

const CONTROLLED_FUNCTIONS = [
	"runtime_list_active_app_config",
	"admin_list_sanitized_audit_events_v2",
	"admin_list_active_app_config",
	"admin_list_app_config_history",
	"admin_publish_app_config",
	"admin_rollback_app_config",
] as const;

async function migrationSql(): Promise<string> {
	const migration = (await loadMigrationPlan())[12];
	expect(migration).toMatchObject({
		version: 13,
		name: "admin_config_control",
		fileName: "0013_admin_config_control.sql",
	});
	return migration?.sql ?? "";
}

function functionDefinition(sql: string, functionName: string): string {
	const start = sql.indexOf(`CREATE FUNCTION public.${functionName}`);
	if (start < 0) throw new Error(`missing function ${functionName}`);
	const end = sql.indexOf("\n$$;", start);
	if (end < 0) throw new Error(`missing function terminator ${functionName}`);
	return sql.slice(start, end + 4);
}

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/gu, " ").trim();
}

describe("administrator configuration control migration", () => {
	it("locks every key to one non-secret schema and classification", async () => {
		const sql = await migrationSql();
		for (const mapping of [
			"config_key = 'features.ai-assistance' AND config_schema = 'FEATURE_FLAGS_V1' AND classification = 'PUBLIC'",
			"config_key = 'recommendations.rules' AND config_schema = 'RECOMMENDATION_RULES_V1' AND classification = 'INTERNAL'",
			"config_key = 'recommendations.prompt' AND config_schema = 'PROMPT_SETTINGS_V1' AND classification = 'INTERNAL'",
			"config_key = 'coverage.default' AND config_schema = 'COVERAGE_SETTINGS_V1' AND classification = 'PUBLIC'",
			"config_key = 'clients.minimum-version' AND config_schema = 'MINIMUM_APP_VERSION_V1' AND classification = 'PUBLIC'",
		]) {
			expect(normalizeSql(sql)).toContain(mapping);
		}
		expect(sql).not.toContain("classification = 'SECRET'");
		expect(sql).toContain(
			"WHEN 'FEATURE_FLAGS_V1' THEN\n      key_count = 1 AND input_value ? 'enabled'",
		);
		expect(sql).not.toContain("rolloutPercentage");
		expect(sql).toContain(
			"legacy application configuration metadata requires manual review",
		);
		expect(sql).toContain(
			"legacy application configuration value requires manual review",
		);
		expect(sql).toContain(
			"legacy administrator audit context requires manual review",
		);
		expect(
			sql.indexOf("CREATE OR REPLACE FUNCTION public.audit_context_is_valid"),
		).toBeLessThan(
			sql.indexOf("legacy administrator audit context requires manual review"),
		);
		expect(sql).not.toMatch(
			/legacy administrator audit context requires manual review[\s\S]*context_json=%s/u,
		);
		expect(sql).toContain("<> 'intent-prompt-v1'");
		expect(sql).toContain("<> 'qwen3.7-flash-2026-07-15'");
		expect(sql).toContain("<> 'NATIONWIDE'");
	});

	it("fixes the execution context of exactly six controlled functions", async () => {
		const sql = await migrationSql();
		expect(sql.match(/^SECURITY DEFINER$/gmu)).toHaveLength(6);
		for (const functionName of CONTROLLED_FUNCTIONS) {
			const definition = functionDefinition(sql, functionName);
			expect(definition).toContain("SECURITY DEFINER");
			expect(definition).toContain("SET search_path = pg_catalog, public");
		}
	});

	it("checks release verification under the same lock for publish and rollback", async () => {
		const sql = await migrationSql();
		for (const name of [
			"admin_publish_app_config",
			"admin_rollback_app_config",
		]) {
			const definition = functionDefinition(sql, name);
			const lock = definition.indexOf("pg_advisory_xact_lock");
			const checkedActive = definition.indexOf("FOR UPDATE");
			const releaseGuard = definition.indexOf(
				"minimum_app_version_change_is_release_safe(",
			);
			const write = definition.indexOf(
				"INSERT INTO public.app_config_versions",
			);
			expect(lock).toBeGreaterThan(-1);
			expect(checkedActive).toBeGreaterThan(lock);
			expect(releaseGuard).toBeGreaterThan(checkedActive);
			expect(write).toBeGreaterThan(releaseGuard);
			expect(definition).toContain("status := 'CLIENT_RELEASE_UNVERIFIED'");
		}
		expect(sql).toContain(
			"REVOKE ALL ON FUNCTION public.minimum_app_version_change_is_release_safe(jsonb, jsonb) FROM PUBLIC",
		);
		const fixture = await readFile(
			new URL("./fixtures/admin-config-minimum-version.sql", import.meta.url),
			"utf8",
		);
		expect(fixture).toContain("SET LOCAL ROLE admin_api_runtime");
		expect(fixture).toContain(
			"minimum-version fixture requires an unused isolated key",
		);
		expect(fixture).toContain(
			"rejected minimum-version mutations wrote configuration or audit rows",
		);
		expect(fixture).toContain("ROLLBACK;");
	});

	it("revokes PUBLIC execution and blocks direct table mutations", async () => {
		const sql = await migrationSql();
		expect(sql).toContain(
			"REVOKE ALL ON public.app_config_versions FROM PUBLIC;",
		);
		expect(sql).toContain("DO $revoke_legacy_app_config_acl$");
		expect(sql).toContain(
			"REVOKE ALL PRIVILEGES ON TABLE public.app_config_versions FROM %I",
		);
		expect(sql).toContain(
			"REVOKE ALL PRIVILEGES (%s) ON TABLE public.app_config_versions FROM %I",
		);
		for (const serviceRole of [
			"api_runtime",
			"retention_worker",
			"admin_api_runtime",
			"data_export_worker",
		]) {
			expect(sql).toContain(`'${serviceRole}'`);
		}
		const statements = sql
			.split(";")
			.map(normalizeSql)
			.filter((statement) => statement.length > 0);
		for (const functionName of CONTROLLED_FUNCTIONS) {
			expect(
				statements.some(
					(statement) =>
						statement.startsWith(
							`REVOKE ALL ON FUNCTION public.${functionName}(`,
						) && statement.endsWith("FROM PUBLIC"),
				),
			).toBe(true);
		}
		expect(sql).toContain("CREATE TRIGGER app_config_controlled_mutation");
		expect(sql).toContain(
			"BEFORE INSERT OR UPDATE OR DELETE ON public.app_config_versions",
		);
		expect(sql).toContain("CREATE TRIGGER app_config_forbid_direct_truncate");
		expect(sql).toContain("BEFORE TRUNCATE ON public.app_config_versions");
		expect(sql).toContain(
			"current_setting('chi_shen_me.app_config_mutation', true)",
		);
	});

	it("grants only the role-specific functions and no configuration table access", async () => {
		const roleGrants = await readFile(ROLE_GRANTS_PATH, "utf8");
		const statements = roleGrants
			.replace(/^\\.*$/gmu, "")
			.split(";")
			.map(normalizeSql)
			.filter((statement) => statement.length > 0);
		const configurationGrants = statements.filter((statement) =>
			/GRANT EXECUTE ON FUNCTION public\.(?:runtime_list_active_app_config|admin_(?:list_active_app_config|list_app_config_history|publish_app_config|rollback_app_config))\(/u.test(
				statement,
			),
		);
		expect(configurationGrants).toHaveLength(5);
		expect(configurationGrants).toEqual(
			expect.arrayContaining([
				'GRANT EXECUTE ON FUNCTION public.runtime_list_active_app_config() TO :"runtime_role"',
				expect.stringMatching(
					/^GRANT EXECUTE ON FUNCTION public\.admin_list_active_app_config\(.+\) TO :"admin_runtime_role"$/u,
				),
				expect.stringMatching(
					/^GRANT EXECUTE ON FUNCTION public\.admin_list_app_config_history\(.+\) TO :"admin_runtime_role"$/u,
				),
				expect.stringMatching(
					/^GRANT EXECUTE ON FUNCTION public\.admin_publish_app_config\(.+\) TO :"admin_runtime_role"$/u,
				),
				expect.stringMatching(
					/^GRANT EXECUTE ON FUNCTION public\.admin_rollback_app_config\(.+\) TO :"admin_runtime_role"$/u,
				),
			]),
		);

		const tableAclStatements = statements.filter((statement) =>
			statement.includes("public.app_config_versions"),
		);
		expect(tableAclStatements.length).toBeGreaterThan(0);
		for (const statement of tableAclStatements) {
			expect(statement).not.toMatch(/\bGRANT\s+/u);
		}
		expect(normalizeSql(roleGrants)).toContain(
			"public.app_config_versions, public.data_rights_authorizations",
		);
		expect(normalizeSql(roleGrants)).toContain(
			'FROM :"runtime_role", :"maintenance_role", :"admin_runtime_role", :"export_worker_role"',
		);
	});
});
