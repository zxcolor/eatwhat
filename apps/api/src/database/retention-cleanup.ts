import type { QueryResultRow } from "pg";
import type { SqlClient } from "./migration-runner.js";

export const RETENTION_ADVISORY_LOCK = Object.freeze([
	1_129_310_029, 1_382_374_734,
] as const);

export const RETENTION_POLICY_CODES = Object.freeze([
	"RECOMMENDATION_HISTORY_90D",
	"CLOSED_SUPPORT_FEEDBACK_180D",
	"EXPORT_METADATA_7D",
	"ACCOUNT_DELETION_TOMBSTONE_30D",
	"OTP_24H",
	"OAUTH_STATE_24H",
	"ACCESS_TOKEN_24H_AFTER_EXPIRY",
	"SESSION_FAMILY_30D_AFTER_EXPIRY",
	"INACTIVE_EXTERNAL_REFERENCES",
	"ADMIN_AUDIT_180D",
	"PERSISTENCE_IDEMPOTENCY_24H",
] as const);

interface RetentionResultRow extends QueryResultRow {
	readonly policy_code: string;
	readonly affected_count: string | number;
}

function parseCount(value: string | number | undefined): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error("数据库返回了无效的保留期计数");
	}
	return parsed;
}

function parsePolicyRows(
	rows: readonly RetentionResultRow[],
): Readonly<Record<string, number>> {
	if (rows.length !== RETENTION_POLICY_CODES.length) {
		throw new Error("数据库返回了不完整的保留期策略结果");
	}
	const expected = new Set<string>(RETENTION_POLICY_CODES);
	const counts: Record<string, number> = {};
	for (const row of rows) {
		if (!expected.delete(row.policy_code) || row.policy_code in counts) {
			throw new Error("数据库返回了未知或重复的保留期策略");
		}
		counts[row.policy_code] = parseCount(row.affected_count);
	}
	if (expected.size !== 0) {
		throw new Error("数据库遗漏了必须执行的保留期策略");
	}
	return Object.freeze(counts);
}

export interface RetentionCleanupResult {
	readonly mode: "DRY_RUN" | "EXECUTE";
	readonly counts: Readonly<Record<string, number>>;
	/** Null in read-only dry-run mode; the execute job destroys expired guest IP HMACs. */
	readonly guestIpHashesDestroyed: number | null;
}

export async function runRetentionCleanupWithClient(
	client: SqlClient,
	execute: boolean,
): Promise<RetentionCleanupResult> {
	let locked = false;
	try {
		const lock = await client.query<{ readonly locked: boolean }>(
			"SELECT pg_try_advisory_lock($1, $2) AS locked",
			[RETENTION_ADVISORY_LOCK[0], RETENTION_ADVISORY_LOCK[1]],
		);
		if (lock.rows[0]?.locked !== true) {
			throw new Error("数据保留清理任务正在其他进程运行");
		}
		locked = true;
		await client.query(
			execute
				? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ"
				: "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
		);
		try {
			const functionName = execute
				? "execute_retention_cleanup"
				: "preview_retention_cleanup";
			const result = await client.query<RetentionResultRow>(
				`SELECT policy_code, affected_count::text FROM public.${functionName}()
				 UNION ALL
				 SELECT policy_code, affected_count::text
				 FROM public.${execute ? "execute_persistence_retention_cleanup" : "preview_persistence_retention_cleanup"}()`,
			);
			const counts = parsePolicyRows(result.rows);
			let guestIpHashesDestroyed: number | null = null;
			if (execute) {
				const anonymization = await client.query<{
					readonly affected_count: string | number;
				}>(
					`SELECT public.anonymize_expired_support_feedback_guest_ip_hashes()::text
					 AS affected_count`,
				);
				guestIpHashesDestroyed = parseCount(
					anonymization.rows[0]?.affected_count,
				);
			}
			await client.query("COMMIT");
			return Object.freeze({
				mode: execute ? "EXECUTE" : "DRY_RUN",
				counts,
				guestIpHashesDestroyed,
			});
		} catch {
			await client.query("ROLLBACK").catch(() => undefined);
			throw new Error("数据保留清理事务执行失败");
		}
	} finally {
		if (locked) {
			await client
				.query("SELECT pg_advisory_unlock($1, $2)", [
					RETENTION_ADVISORY_LOCK[0],
					RETENTION_ADVISORY_LOCK[1],
				])
				.catch(() => undefined);
		}
	}
}
