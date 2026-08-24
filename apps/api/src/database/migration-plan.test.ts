import { describe, expect, it } from "vitest";
import {
	assertNoTransactionControl,
	buildMigrationPlan,
	loadMigrationPlan,
	validateAppliedMigrations,
} from "./migration-plan.js";

function sqlSource(fileName: string, sql = "SELECT 1;") {
	return { fileName, contents: Buffer.from(sql, "utf8") };
}

describe("fixed migration plan", () => {
	it("loads the repository migration with a deterministic checksum", async () => {
		const first = await loadMigrationPlan();
		const second = await loadMigrationPlan();
		expect(first).toHaveLength(8);
		expect(first[0]).toMatchObject({
			version: 1,
			name: "initial_schema",
			fileName: "0001_initial_schema.sql",
		});
		expect(first[0]?.checksum).toBe(
			"ebdda07eba3f68b88de87078facab9aa42e71288efcfce753269601ea35a34aa",
		);
		expect(first[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(first[1]).toMatchObject({
			version: 2,
			name: "persistence_api",
			fileName: "0002_persistence_api.sql",
		});
		expect(first[1]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(first[2]).toMatchObject({
			version: 3,
			name: "admin_security",
			fileName: "0003_admin_security.sql",
		});
		expect(first[2]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(first[3]).toMatchObject({
			version: 4,
			name: "admin_api_primitives",
			fileName: "0004_admin_api_primitives.sql",
		});
		expect(first[3]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(first[4]).toMatchObject({
			version: 5,
			name: "support_feedback_security",
			fileName: "0005_support_feedback_security.sql",
		});
		expect(first[4]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(first[5]).toMatchObject({
			version: 6,
			name: "data_export_delivery",
			fileName: "0006_data_export_delivery.sql",
		});
		expect(first[5]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(first[6]).toMatchObject({
			version: 7,
			name: "otp_verification_attempt_limit",
			fileName: "0007_otp_verification_attempt_limit.sql",
		});
		expect(first[6]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(first[7]).toMatchObject({
			version: 8,
			name: "fix_jsonb_object_cardinality",
			fileName: "0008_fix_jsonb_object_cardinality.sql",
		});
		expect(first[7]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(second[0]?.checksum).toBe(first[0]?.checksum);
		expect(second[1]?.checksum).toBe(first[1]?.checksum);
		expect(second[2]?.checksum).toBe(first[2]?.checksum);
		expect(second[3]?.checksum).toBe(first[3]?.checksum);
		expect(second[4]?.checksum).toBe(first[4]?.checksum);
		expect(second[5]?.checksum).toBe(first[5]?.checksum);
		expect(second[6]?.checksum).toBe(first[6]?.checksum);
		expect(second[7]?.checksum).toBe(first[7]?.checksum);
	});

	it("requires versions to start at 0001 and remain contiguous", () => {
		expect(() => buildMigrationPlan([sqlSource("0002_late.sql")])).toThrow(
			"连续无缺号",
		);
		expect(() =>
			buildMigrationPlan([
				sqlSource("0001_first.sql"),
				sqlSource("0003_gap.sql"),
			]),
		).toThrow("连续无缺号");
	});

	it("rejects invalid UTF-8 rather than accepting replacement characters", () => {
		expect(() =>
			buildMigrationPlan([
				{ fileName: "0001_bad.sql", contents: Buffer.from([0xc3, 0x28]) },
			]),
		).toThrow("严格有效的 UTF-8");
	});

	it.each([
		"BEGIN; SELECT 1;",
		"COMMIT;",
		"END WORK;",
		"ROLLBACK;",
		"SAVEPOINT nested;",
		"RELEASE SAVEPOINT nested;",
		"START TRANSACTION;",
		"SET TRANSACTION READ ONLY;",
		"PREPARE TRANSACTION 'x';",
	])("rejects migration-owned transaction control: %s", (sql) => {
		expect(() => assertNoTransactionControl(sql)).toThrow("禁止自行控制事务");
	});

	it("does not hide COMMIT after a standard string containing a backslash", () => {
		expect(() => assertNoTransactionControl("SELECT '\\\\'; COMMIT;")).toThrow(
			"禁止自行控制事务",
		);
	});

	it("ignores keywords inside comments, strings and dollar-quoted functions", () => {
		expect(() =>
			assertNoTransactionControl(`
-- COMMIT;
SELECT 'ROLLBACK', E'BEGIN\\\\value';
CREATE FUNCTION public.example() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'COMMIT';
END;
$$;
/* START TRANSACTION; /* nested COMMIT */ */
`),
		).not.toThrow();
	});

	it("rejects checksum drift, unknown versions and applied gaps", () => {
		const plan = buildMigrationPlan([
			sqlSource("0001_first.sql"),
			sqlSource("0002_second.sql", "SELECT 2;"),
		]);
		expect(() =>
			validateAppliedMigrations(
				plan,
				[{ version: 1, name: "first", checksum: "0".repeat(64) }],
				false,
			),
		).toThrow("校验和");
		expect(() =>
			validateAppliedMigrations(
				plan,
				[
					{
						version: 2,
						name: "second",
						checksum: plan[1]?.checksum ?? "",
					},
				],
				false,
			),
		).toThrow("缺号或乱序");
		expect(() =>
			validateAppliedMigrations(
				plan,
				[
					...plan.map(({ version, name, checksum }) => ({
						version,
						name,
						checksum,
					})),
					{ version: 3, name: "unknown", checksum: "a".repeat(64) },
				],
				false,
			),
		).toThrow("未知");
	});
});
