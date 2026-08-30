import type { Pool, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import {
	DatabasePool,
	type DatabasePoolFactory,
	DatabaseQueryError,
} from "./database-pool.js";
import { loadMigrationPlan } from "./migration-plan.js";

describe("Nest database pool lifecycle", () => {
	it("does not create or connect a pool while the database is disabled", async () => {
		const factory = vi.fn() as unknown as DatabasePoolFactory;
		const database = new DatabasePool(
			loadAppConfig({ NODE_ENV: "test", DATABASE_ENABLED: "false" }),
			factory,
		);
		await database.onApplicationBootstrap();
		await database.onApplicationShutdown();
		expect(factory).not.toHaveBeenCalled();
		expect(database.isEnabled()).toBe(false);
		await expect(database.isReady()).resolves.toBe(true);
	});

	it("releases a failed startup-check client before ending the pool", async () => {
		const events: string[] = [];
		const client = {
			query: vi.fn(async () => {
				throw new Error(
					"password authentication failed for user secret-user at secret-host",
				);
			}),
			release: vi.fn((destroy?: boolean) => {
				events.push(`release:${String(destroy)}`);
			}),
		};
		const fakePool = {
			on: vi.fn(),
			connect: vi.fn(async () => {
				events.push("connect");
				return client;
			}),
			end: vi.fn(async () => {
				events.push("end");
			}),
		};
		const database = new DatabasePool(
			loadAppConfig({
				NODE_ENV: "test",
				DATABASE_ENABLED: "true",
				DATABASE_URL:
					"postgresql://api_runtime:runtime-pass@db.internal:5432/chi_shen_me",
			}),
			() => fakePool as unknown as Pool,
		);
		let message = "";
		try {
			await database.onApplicationBootstrap();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("数据库启动检查失败");
		expect(message).not.toContain("secret-user");
		expect(events).toEqual(["connect", "release:true", "end"]);
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	it("starts the WeChat Union alias bridge when 0012 and later migrations are pending", async () => {
		const plan = await loadMigrationPlan();
		expect(plan.at(-1)?.fileName).toBe("0013_admin_config_control.sql");
		const applied = plan.slice(0, 11).map(({ version, name, checksum }) => ({
			version,
			name,
			checksum,
		}));
		const createPool = () => {
			const client = {
				query: vi.fn(async (text: string) => {
					if (text.includes("to_regclass")) {
						return {
							rows: [{ table_name: "schema_migrations" }],
							rowCount: 1,
						};
					}
					if (text.startsWith("SELECT version, name, checksum")) {
						return { rows: applied, rowCount: applied.length };
					}
					return { rows: [], rowCount: 1 };
				}),
				release: vi.fn(),
			};
			const pool = {
				on: vi.fn(),
				connect: vi.fn(async () => client),
				end: vi.fn(async () => undefined),
			};
			return { client, pool };
		};
		const env = {
			NODE_ENV: "test",
			DATABASE_ENABLED: "true",
			DATABASE_URL:
				"postgresql://api_runtime:runtime-pass@db.internal:5432/chi_shen_me",
			ACCOUNTS_ENABLED: "false",
		} as const;

		const bridgeState = createPool();
		const bridge = new DatabasePool(
			loadAppConfig({
				...env,
				AUTH_SCHEMA_TRANSITION_MODE: "wechat_union_aliases_pending",
				WECHAT_AUTH_ENABLED: "false",
			}),
			() => bridgeState.pool as unknown as Pool,
		);
		await expect(bridge.onApplicationBootstrap()).resolves.toBeUndefined();
		await bridge.onApplicationShutdown();

		const strictState = createPool();
		const strict = new DatabasePool(
			loadAppConfig({ ...env, AUTH_SCHEMA_TRANSITION_MODE: "none" }),
			() => strictState.pool as unknown as Pool,
		);
		await expect(strict.onApplicationBootstrap()).rejects.toThrow(
			"数据库启动检查失败",
		);
		expect(strictState.client.release).toHaveBeenCalledWith(true);
	});

	it("checks the exact schema and closes the singleton pool on shutdown", async () => {
		const plan = await loadMigrationPlan();
		const events: string[] = [];
		const client = {
			query: vi.fn(async (text: string) => {
				if (text === "SELECT private_error") {
					throw new Error(
						"postgresql://secret-user:secret-pass@secret-host/db",
					);
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
				return { rows: [], rowCount: 1 };
			}),
			release: vi.fn(() => events.push("release")),
		};
		const fakePool = {
			on: vi.fn(),
			connect: vi.fn(async () => client),
			end: vi.fn(async () => {
				events.push("end");
			}),
			query: vi.fn(async (query: unknown) => {
				if (typeof query !== "object" || query === null) {
					throw new TypeError("expected a query configuration object");
				}
				(query as { callback?: () => void }).callback = () => undefined;
				return { rows: [{ ready: 1 }], rowCount: 1 };
			}),
		};
		const database = new DatabasePool(
			loadAppConfig({
				NODE_ENV: "test",
				DATABASE_ENABLED: "true",
				DATABASE_URL:
					"postgresql://api_runtime:runtime-pass@db.internal:5432/chi_shen_me",
			}),
			() => fakePool as unknown as Pool,
		);
		await database.onApplicationBootstrap();
		expect(events).toEqual(["release"]);
		await expect(database.isReady()).resolves.toBe(true);
		const firstReadinessQuery = fakePool.query.mock.calls[0]?.[0];
		expect(firstReadinessQuery).toMatchObject({
			text: "SELECT 1",
			query_timeout: 2_000,
		});
		expect(Object.isExtensible(firstReadinessQuery)).toBe(true);
		fakePool.query.mockRejectedValueOnce(
			new Error("private database readiness failure"),
		);
		await expect(database.isReady()).resolves.toBe(false);
		expect(fakePool.query.mock.calls[1]?.[0]).not.toBe(firstReadinessQuery);
		await expect(
			database.withTransaction(async (transaction) => {
				await transaction.query("SELECT transaction_work");
				return "committed";
			}),
		).resolves.toBe("committed");
		expect(client.query).toHaveBeenCalledWith("BEGIN");
		expect(client.query).toHaveBeenCalledWith("COMMIT");
		let transactionMessage = "";
		try {
			await database.withTransaction(async (transaction) => {
				await transaction.query("SELECT private_error");
			});
		} catch (error) {
			transactionMessage =
				error instanceof Error ? error.message : String(error);
		}
		expect(transactionMessage).toBe("数据库事务执行失败");
		expect(transactionMessage).not.toContain("secret-pass");
		expect(client.query).toHaveBeenCalledWith("ROLLBACK");
		await database.onApplicationShutdown();
		expect(events).toEqual(["release", "release", "release", "end"]);
	});

	it("preserves only a valid SQLSTATE for safe domain error mapping", async () => {
		const plan = await loadMigrationPlan();
		const client = {
			query: vi.fn(async (text: string) => {
				if (text.includes("to_regclass")) {
					return { rows: [{ table_name: "schema_migrations" }], rowCount: 1 };
				}
				if (text.startsWith("SELECT version, name, checksum")) {
					return {
						rows: plan.map(({ version, name, checksum }) => ({
							version,
							name,
							checksum,
						})),
						rowCount: plan.length,
					};
				}
				return { rows: [], rowCount: 1 };
			}),
			release: vi.fn(),
		};
		const fakePool = {
			on: vi.fn(),
			connect: vi.fn(async () => client),
			end: vi.fn(async () => undefined),
			query: vi.fn(async () => {
				throw Object.assign(new Error("private quota detail"), {
					code: "P5100",
				});
			}),
		};
		const database = new DatabasePool(
			loadAppConfig({
				NODE_ENV: "test",
				DATABASE_ENABLED: "true",
				DATABASE_URL:
					"postgresql://api_runtime:runtime-pass@db.internal:5432/chi_shen_me",
			}),
			() => fakePool as unknown as Pool,
		);
		await database.onApplicationBootstrap();
		let caught: unknown;
		try {
			await database.query("SELECT quota");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DatabaseQueryError);
		expect(caught).toMatchObject({
			message: "数据库查询执行失败",
			sqlState: "P5100",
		});
		expect(JSON.stringify(caught)).not.toContain("private quota detail");
	});
});
