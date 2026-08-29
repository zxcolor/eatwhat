import { describe, expect, it } from "vitest";
import {
	loadDatabaseConfig,
	loadExportWorkerDatabaseConfig,
	loadMaintenanceDatabaseConfig,
	loadMigrationDatabaseConfig,
} from "./database-config.js";

const runtimeUrl =
	"postgresql://api_runtime:runtime-pass@db.internal:5432/chi_shen_me";
const migrationUrl =
	"postgresql://schema_migrator:migration-pass@db.internal:5432/chi_shen_me";
const maintenanceUrl =
	"postgresql://retention_worker:maintenance-pass@db.internal:5432/chi_shen_me";
const exportWorkerUrl =
	"postgresql://data_export_worker:worker-pass@db.internal:5432/chi_shen_me";
const productionIdentity = Object.freeze({
	DATABASE_EXPECTED_TARGET: "db.internal:5432/chi_shen_me",
	DATABASE_RUNTIME_ROLE_NAME: "api_runtime",
	DATABASE_MIGRATION_ROLE_NAME: "schema_migrator",
	DATABASE_MAINTENANCE_ROLE_NAME: "retention_worker",
	DATABASE_EXPORT_WORKER_ROLE_NAME: "data_export_worker",
});

describe("database safety configuration", () => {
	it("keeps development and test database-free unless explicitly enabled", () => {
		for (const environment of ["development", "test"] as const) {
			const config = loadDatabaseConfig(
				{
					DATABASE_URL:
						"postgresql://stray-user:stray-secret@stray.internal/db",
					DATABASE_SSL_CA_BASE64: "stray-ca",
				},
				environment,
			);
			expect(config).toMatchObject({
				enabled: false,
				connectionString: null,
				ssl: false,
			});
		}
	});

	it("accepts an explicit non-production direct PostgreSQL connection", () => {
		const config = loadDatabaseConfig(
			{
				DATABASE_ENABLED: "true",
				DATABASE_URL: runtimeUrl,
				DATABASE_SSL_MODE: "disable",
			},
			"test",
		);
		expect(config.enabled).toBe(true);
		expect(config.connectionString).toBe(runtimeUrl);
		expect(config.ssl).toBe(false);
		expect(config.authSchemaTransitionMode).toBe("none");
	});

	it("allows only the explicit accounts-disabled legacy phone drain bridge", () => {
		expect(
			loadDatabaseConfig(
				{
					DATABASE_ENABLED: "true",
					DATABASE_URL: runtimeUrl,
					DATABASE_SSL_MODE: "disable",
					ACCOUNTS_ENABLED: "false",
					AUTH_SCHEMA_TRANSITION_MODE: "legacy_phone_drain",
				},
				"test",
			).authSchemaTransitionMode,
		).toBe("legacy_phone_drain");
		expect(() =>
			loadDatabaseConfig(
				{
					DATABASE_ENABLED: "true",
					DATABASE_URL: runtimeUrl,
					ACCOUNTS_ENABLED: "true",
					AUTH_SCHEMA_TRANSITION_MODE: "legacy_phone_drain",
				},
				"test",
			),
		).toThrow("必须关闭 ACCOUNTS_ENABLED");
		for (const invalid of ["legacy", "phone_drain", "NONE", " none "]) {
			expect(() =>
				loadDatabaseConfig({ AUTH_SCHEMA_TRANSITION_MODE: invalid }, "test"),
			).toThrow("只允许");
		}
	});

	it("allows the exact WeChat alias bridge only while WeChat is disabled", () => {
		expect(
			loadDatabaseConfig(
				{
					DATABASE_ENABLED: "true",
					DATABASE_URL: runtimeUrl,
					AUTH_SCHEMA_TRANSITION_MODE: "wechat_union_aliases_pending",
					WECHAT_AUTH_ENABLED: "false",
				},
				"test",
			).authSchemaTransitionMode,
		).toBe("wechat_union_aliases_pending");
		expect(() =>
			loadDatabaseConfig(
				{
					DATABASE_ENABLED: "true",
					DATABASE_URL: runtimeUrl,
					AUTH_SCHEMA_TRANSITION_MODE: "wechat_union_aliases_pending",
					WECHAT_AUTH_ENABLED: "true",
				},
				"test",
			),
		).toThrow("必须关闭 WECHAT_AUTH_ENABLED");
	});

	it("requires a direct postgresql URL and certificate-verifying TLS in production", () => {
		expect(() => loadDatabaseConfig({}, "production")).toThrow("DATABASE_URL");
		expect(() =>
			loadDatabaseConfig({ DATABASE_ENABLED: "false" }, "production"),
		).toThrow("禁止关闭");
		expect(() =>
			loadDatabaseConfig(
				{ DATABASE_URL: runtimeUrl, ...productionIdentity },
				"production",
			),
		).toThrow("verify-full");
		const config = loadDatabaseConfig(
			{
				DATABASE_URL: runtimeUrl,
				DATABASE_SSL_MODE: "verify-full",
				...productionIdentity,
			},
			"production",
		);
		expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
	});

	it.each([
		"postgres://api:secret@db.internal/chi_shen_me",
		"postgresql://api:secret@db.internal/chi_shen_me?sslmode=disable",
		"postgresql://api:secret@db.internal/chi_shen_me#fragment",
		"postgresql://api@db.internal/chi_shen_me",
	])("rejects unsafe URL form without echoing it", (unsafeUrl) => {
		let message = "";
		try {
			loadDatabaseConfig(
				{ DATABASE_ENABLED: "true", DATABASE_URL: unsafeUrl },
				"test",
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).not.toBe("");
		expect(message).not.toContain(unsafeUrl);
		expect(message).not.toContain("secret");
	});

	it("rejects percent-encoded reuse of the declared runtime role", () => {
		expect(() =>
			loadMigrationDatabaseConfig(
				{
					DATABASE_MIGRATION_URL:
						"postgresql://%61pi_runtime:other-pass@db.internal:5432/chi_shen_me",
					DATABASE_MIGRATION_SSL_MODE: "verify-full",
					...productionIdentity,
				},
				"production",
			),
		).toThrow("最小权限角色");
	});

	it("requires production migration and maintenance roles to target the runtime database", () => {
		expect(() =>
			loadMigrationDatabaseConfig(
				{
					DATABASE_MIGRATION_URL:
						"postgresql://schema_migrator:pass@other.internal:5432/chi_shen_me",
					DATABASE_MIGRATION_SSL_MODE: "verify-full",
					...productionIdentity,
				},
				"production",
			),
		).toThrow("目标数据库");
		expect(() =>
			loadMaintenanceDatabaseConfig(
				{
					DATABASE_MAINTENANCE_URL:
						"postgresql://retention_worker:pass@db.internal:5432/other_database",
					DATABASE_MAINTENANCE_SSL_MODE: "verify-full",
					...productionIdentity,
				},
				"production",
			),
		).toThrow("目标数据库");
	});

	it("lets each production job receive only its own database secret", () => {
		expect(
			loadMigrationDatabaseConfig(
				{
					DATABASE_MIGRATION_URL: migrationUrl,
					DATABASE_MIGRATION_SSL_MODE: "verify-full",
					...productionIdentity,
				},
				"production",
			).connectionString,
		).toBe(migrationUrl);
		expect(
			loadMaintenanceDatabaseConfig(
				{
					DATABASE_MAINTENANCE_URL: maintenanceUrl,
					DATABASE_MAINTENANCE_SSL_MODE: "verify-full",
					...productionIdentity,
				},
				"production",
			).connectionString,
		).toBe(maintenanceUrl);
		expect(
			loadExportWorkerDatabaseConfig(
				{
					DATABASE_EXPORT_WORKER_URL: exportWorkerUrl,
					DATABASE_EXPORT_WORKER_SSL_MODE: "verify-full",
					...productionIdentity,
				},
				"production",
			).connectionString,
		).toBe(exportWorkerUrl);
	});

	it("does not let the export worker reuse the API or maintenance role", () => {
		expect(() =>
			loadExportWorkerDatabaseConfig(
				{
					DATABASE_EXPORT_WORKER_URL: runtimeUrl,
					DATABASE_EXPORT_WORKER_SSL_MODE: "verify-full",
					...productionIdentity,
				},
				"production",
			),
		).toThrow("最小权限角色");
		expect(() =>
			loadDatabaseConfig(
				{
					DATABASE_URL: runtimeUrl,
					DATABASE_SSL_MODE: "verify-full",
					...productionIdentity,
					DATABASE_EXPORT_WORKER_ROLE_NAME: "retention_worker",
				},
				"production",
			),
		).toThrow("两两不同");
	});
});
