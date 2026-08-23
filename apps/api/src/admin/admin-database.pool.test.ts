import type { Pool, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadMigrationPlan } from "../database/migration-plan.js";
import {
	AdminDatabasePool,
	type AdminDatabasePoolFactory,
} from "./admin-database.pool.js";
import {
	type AdminProcessConfig,
	loadAdminProcessConfig,
} from "./admin-process-config.js";

const KEY = Buffer.alloc(32, 0x21).toString("base64");

function config() {
	return loadAdminProcessConfig({
		NODE_ENV: "test",
		ADMIN_API_ENABLED: "true",
		ADMIN_DATABASE_URL:
			"postgresql://admin_api_runtime:admin-pass@admin-db.internal:5444/chi_shen_me_admin",
		ADMIN_DATABASE_EXPECTED_TARGET: "admin-db.internal:5444/chi_shen_me_admin",
		ADMIN_DATABASE_RUNTIME_ROLE_NAME: "admin_api_runtime",
		ADMIN_DATABASE_SSL_MODE: "verify-full",
		ADMIN_WEBAUTHN_RP_NAME: "吃什么管理后台",
		ADMIN_WEBAUTHN_RP_ID: "admin.example.cn",
		ADMIN_WEBAUTHN_ORIGINS: "https://admin.example.cn",
		ADMIN_HMAC_KEYS: `v1:${KEY}`,
		ADMIN_CREDENTIAL_ENCRYPTION_KEYS: `v1:${KEY}`,
		ADMIN_BIND_HOST: "127.0.0.1",
	});
}

function disabledConfig(): AdminProcessConfig {
	return Object.freeze({
		nodeEnv: "test",
		port: 3_002,
		bindHost: "127.0.0.1",
		trustedProxyCidrs: Object.freeze([]),
		admin: Object.freeze({
			enabled: false,
			database: Object.freeze({
				enabled: false,
				connectionString: null,
				ssl: false,
				poolMaximum: 4,
				connectionTimeoutMs: 5_000,
				idleTimeoutMs: 15_000,
			}),
			webauthn: Object.freeze({
				rpName: null,
				rpId: null,
				expectedOrigins: Object.freeze([]),
			}),
			hmacKeys: Object.freeze([]),
			credentialEncryptionKeys: Object.freeze([]),
		}),
	});
}

describe("isolated administrator database pool", () => {
	it("never creates a pool while the administrator API is disabled", async () => {
		const factory = vi.fn() as unknown as AdminDatabasePoolFactory;
		const database = new AdminDatabasePool(disabledConfig(), factory);
		await database.onApplicationBootstrap();
		await database.onApplicationShutdown();
		expect(factory).not.toHaveBeenCalled();
		expect(database.isAvailable()).toBe(false);
	});

	it("checks the exact administrator role, database, port and full migration plan", async () => {
		const plan = await loadMigrationPlan();
		const client = {
			query: vi.fn(async (text: string) => {
				if (text.includes("current_user AS runtime_role")) {
					return {
						rows: [
							{
								runtime_role: "admin_api_runtime",
								database_name: "chi_shen_me_admin",
								server_port: 5444,
							},
						],
						rowCount: 1,
					};
				}
				if (text.includes("to_regclass")) {
					return { rows: [{ table_name: "schema_migrations" }], rowCount: 1 };
				}
				if (text.startsWith("SELECT version, name, checksum")) {
					return {
						rows: plan.map(({ version, name, checksum }) => ({
							version,
							name,
							checksum,
						})) as QueryResultRow[],
						rowCount: plan.length,
					};
				}
				return { rows: [], rowCount: 0 };
			}),
			release: vi.fn(),
		};
		const fakePool = {
			on: vi.fn(),
			connect: vi.fn(async () => client),
			query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
			end: vi.fn(async () => undefined),
		};
		const factory = vi.fn(() => fakePool as unknown as Pool);
		const database = new AdminDatabasePool(config(), factory);
		await database.onApplicationBootstrap();
		expect(database.isAvailable()).toBe(true);
		expect(factory).toHaveBeenCalledWith(
			expect.objectContaining({
				connectionString: expect.stringContaining("admin_api_runtime"),
				ssl: expect.objectContaining({ rejectUnauthorized: true }),
				application_name: "chi-shen-me-admin-api",
			}),
		);
		await database.onApplicationShutdown();
		expect(client.release).toHaveBeenCalledTimes(1);
		expect(fakePool.end).toHaveBeenCalledTimes(1);
	});

	it("destroys the startup client and returns one secret-free error on identity mismatch", async () => {
		const events: string[] = [];
		const client = {
			query: vi.fn(async () => ({
				rows: [
					{
						runtime_role: "api_runtime",
						database_name: "secret_database_name",
						server_port: 5444,
					},
				],
				rowCount: 1,
			})),
			release: vi.fn((destroy?: boolean) => {
				events.push(`release:${String(destroy)}`);
			}),
		};
		const fakePool = {
			on: vi.fn(),
			connect: vi.fn(async () => client),
			end: vi.fn(async () => {
				events.push("end");
			}),
		};
		const database = new AdminDatabasePool(
			config(),
			() => fakePool as unknown as Pool,
		);
		let message = "";
		try {
			await database.onApplicationBootstrap();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("管理员数据库启动检查失败");
		expect(message).not.toContain("secret_database_name");
		expect(events).toEqual(["release:true", "end"]);
		expect(database.isAvailable()).toBe(false);
	});
});
