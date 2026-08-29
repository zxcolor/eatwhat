import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildMigrationPlan } from "./migration-plan.js";
import {
	runMigrationsWithClient,
	type SqlClient,
	type SqlResult,
	verifySchemaWithClient,
} from "./migration-runner.js";

class FakeSqlClient implements SqlClient {
	readonly calls: string[] = [];
	appliedRows: QueryResultRow[] = [];
	lockResponses: boolean[] = [true];
	failSql: string | null = null;

	async query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
	): Promise<SqlResult<Row>> {
		this.calls.push(text);
		if (text.includes("pg_try_advisory_lock")) {
			return {
				rows: [{ locked: this.lockResponses.shift() ?? false } as Row],
				rowCount: 1,
			};
		}
		if (text.includes("pg_advisory_unlock")) {
			return { rows: [{ unlocked: true } as Row], rowCount: 1 };
		}
		if (text.includes("to_regclass")) {
			return {
				rows: [{ table_name: "schema_migrations" } as Row],
				rowCount: 1,
			};
		}
		if (text.startsWith("SELECT version, name, checksum")) {
			return {
				rows: this.appliedRows as Row[],
				rowCount: this.appliedRows.length,
			};
		}
		if (this.failSql !== null && text.includes(this.failSql)) {
			throw new Error(
				"driver leaked postgresql://user:password@secret-host/db",
			);
		}
		return { rows: [], rowCount: text.startsWith("DELETE") ? 0 : 1 };
	}
}

function plan() {
	return buildMigrationPlan([
		{ fileName: "0001_first.sql", contents: Buffer.from("SELECT 101;") },
		{ fileName: "0002_second.sql", contents: Buffer.from("SELECT 202;") },
	]);
}

describe("transactional migration runner", () => {
	it("serializes, applies each migration transactionally and records checksums", async () => {
		const client = new FakeSqlClient();
		const result = await runMigrationsWithClient(client, plan());
		expect(result).toEqual({ appliedVersions: [1, 2], currentVersion: 2 });
		expect(client.calls.filter((call) => call === "BEGIN")).toHaveLength(3);
		expect(client.calls.filter((call) => call === "COMMIT")).toHaveLength(3);
		expect(
			client.calls.filter(
				(call) => call === "SET LOCAL search_path TO pg_catalog, public",
			),
		).toHaveLength(3);
		expect(client.calls.at(-1)).toContain("pg_advisory_unlock");
	});

	it("is idempotent when the complete checked plan is already applied", async () => {
		const migrations = plan();
		const client = new FakeSqlClient();
		client.appliedRows = migrations.map(({ version, name, checksum }) => ({
			version,
			name,
			checksum,
		}));
		const result = await runMigrationsWithClient(client, migrations);
		expect(result.appliedVersions).toEqual([]);
		expect(client.calls).not.toContain("SELECT 101;");
		expect(client.calls).not.toContain("SELECT 202;");
	});

	it("rolls back a failed migration without recording it or leaking driver details", async () => {
		const client = new FakeSqlClient();
		client.failSql = "SELECT 202";
		let message = "";
		try {
			await runMigrationsWithClient(client, plan());
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("0002");
		expect(message).not.toContain("password");
		expect(message).not.toContain("secret-host");
		expect(client.calls).toContain("ROLLBACK");
		expect(client.calls.at(-1)).toContain("pg_advisory_unlock");
	});

	it("fails within a bounded wait when the advisory lock stays busy", async () => {
		const client = new FakeSqlClient();
		client.lockResponses = [false, false];
		const wait = vi.fn(async () => undefined);
		await expect(
			runMigrationsWithClient(client, plan(), {
				maximumAttempts: 2,
				retryDelayMs: 1,
				wait,
			}),
		).rejects.toThrow("限定时间");
		expect(wait).toHaveBeenCalledTimes(1);
		expect(client.calls.some((call) => call === "BEGIN")).toBe(false);
	});

	it("requires the database schema to exactly match the local checksums", async () => {
		const migrations = plan();
		const client = new FakeSqlClient();
		client.appliedRows = migrations.map(({ version, name, checksum }) => ({
			version,
			name,
			checksum,
		}));
		await expect(
			verifySchemaWithClient(client, migrations),
		).resolves.toBeUndefined();
		client.appliedRows = client.appliedRows.slice(0, 1);
		await expect(verifySchemaWithClient(client, migrations)).rejects.toThrow(
			"落后",
		);
	});

	it("allows the bridge to miss only the exact final phone-only migration", async () => {
		const legacySources = Array.from({ length: 10 }, (_, index) => {
			const version = index + 1;
			return {
				fileName: `${String(version).padStart(4, "0")}_legacy_${String(version)}.sql`,
				contents: Buffer.from(`SELECT ${String(version)};`),
			};
		});
		const migrations = buildMigrationPlan([
			...legacySources,
			{
				fileName: "0011_phone_only_auth.sql",
				contents: Buffer.from("SELECT 11;"),
			},
		]);
		const bridgeTarget = {
			version: 11,
			name: "phone_only_auth",
			fileName: "0011_phone_only_auth.sql",
		} as const;
		const client = new FakeSqlClient();
		client.appliedRows = migrations
			.slice(0, 10)
			.map(({ version, name, checksum }) => ({ version, name, checksum }));

		await expect(
			verifySchemaWithClient(client, migrations, bridgeTarget),
		).resolves.toBeUndefined();
		await expect(verifySchemaWithClient(client, migrations)).rejects.toThrow(
			"落后",
		);

		client.appliedRows = migrations.map(({ version, name, checksum }) => ({
			version,
			name,
			checksum,
		}));
		await expect(
			verifySchemaWithClient(client, migrations, bridgeTarget),
		).resolves.toBeUndefined();

		client.appliedRows = client.appliedRows.slice(0, 9);
		await expect(
			verifySchemaWithClient(client, migrations, bridgeTarget),
		).rejects.toThrow("受控认证迁移过渡条件");

		const wrongFinal = buildMigrationPlan([
			...legacySources,
			{ fileName: "0011_other.sql", contents: Buffer.from("SELECT 12;") },
		]);
		client.appliedRows = wrongFinal
			.slice(0, 10)
			.map(({ version, name, checksum }) => ({ version, name, checksum }));
		await expect(
			verifySchemaWithClient(client, wrongFinal, bridgeTarget),
		).rejects.toThrow("受控认证迁移过渡条件");
	});
});
