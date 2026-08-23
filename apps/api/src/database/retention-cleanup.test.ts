import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { SqlClient, SqlResult } from "./migration-runner.js";
import {
	RETENTION_POLICY_CODES,
	runRetentionCleanupWithClient,
} from "./retention-cleanup.js";

class CleanupClient implements SqlClient {
	readonly calls: string[] = [];
	failOn = "";

	async query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
	): Promise<SqlResult<Row>> {
		this.calls.push(text);
		if (this.failOn.length > 0 && text.includes(this.failOn)) {
			throw new Error("postgresql://private-user:private-pass@private-host/db");
		}
		if (text.includes("pg_try_advisory_lock")) {
			return { rows: [{ locked: true } as Row], rowCount: 1 };
		}
		if (text.includes("pg_advisory_unlock")) {
			return { rows: [{ unlocked: true } as Row], rowCount: 1 };
		}
		if (text.includes("anonymize_expired_support_feedback_guest_ip_hashes")) {
			return {
				rows: [{ affected_count: "4" } as Row],
				rowCount: 1,
			};
		}
		if (text.includes("retention_cleanup")) {
			return {
				rows: RETENTION_POLICY_CODES.map((policy_code) => ({
					policy_code,
					affected_count: text.includes("execute_") ? "3" : "2",
				})) as Row[],
				rowCount: RETENTION_POLICY_CODES.length,
			};
		}
		return { rows: [], rowCount: text.startsWith("DELETE") ? 4 : 1 };
	}
}

describe("retention cleanup safety gates", () => {
	it("contains the required 90d, 180d, 7d and 30d policies", () => {
		expect(RETENTION_POLICY_CODES).toEqual(
			expect.arrayContaining([
				"RECOMMENDATION_HISTORY_90D",
				"CLOSED_SUPPORT_FEEDBACK_180D",
				"EXPORT_METADATA_7D",
				"ACCOUNT_DELETION_TOMBSTONE_30D",
			]),
		);
	});

	it("defaults to a read-only dry run and never calls mutation SQL", async () => {
		const client = new CleanupClient();
		const result = await runRetentionCleanupWithClient(client, false);
		expect(result.mode).toBe("DRY_RUN");
		expect(result.guestIpHashesDestroyed).toBeNull();
		expect(Object.values(result.counts)).toEqual(
			Array(RETENTION_POLICY_CODES.length).fill(2),
		);
		expect(client.calls).toContain(
			"BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
		);
		expect(client.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
		expect(client.calls).toContainEqual(
			expect.stringContaining("preview_retention_cleanup"),
		);
	});

	it("executes all fixed policies atomically only in explicit execute mode", async () => {
		const client = new CleanupClient();
		const result = await runRetentionCleanupWithClient(client, true);
		expect(result.mode).toBe("EXECUTE");
		expect(result.guestIpHashesDestroyed).toBe(4);
		expect(result.counts.INACTIVE_EXTERNAL_REFERENCES).toBe(3);
		expect(result.counts.ADMIN_AUDIT_180D).toBe(3);
		expect(client.calls).toContainEqual(
			expect.stringContaining("execute_retention_cleanup"),
		);
		expect(client.calls).toContainEqual(
			expect.stringContaining(
				"anonymize_expired_support_feedback_guest_ip_hashes",
			),
		);
		expect(client.calls).toContain("COMMIT");
		expect(client.calls.at(-1)).toContain("pg_advisory_unlock");
	});

	it("rolls back without leaking a lower-level connection error", async () => {
		const client = new CleanupClient();
		client.failOn = "execute_retention_cleanup";
		let message = "";
		try {
			await runRetentionCleanupWithClient(client, true);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("数据保留清理事务执行失败");
		expect(message).not.toContain("private-pass");
		expect(client.calls).toContain("ROLLBACK");
	});
});
