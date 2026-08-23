import type { SupportFeedbackCategory } from "@chi-shen-me/contracts";
import { Injectable } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { DatabasePool, DatabaseQueryError } from "../database/database-pool.js";

const KEY_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

export type SupportFeedbackSubmitterKind = "ACCOUNT" | "GUEST";

export interface SupportFeedbackInsert {
	readonly feedbackId: string;
	readonly userId: string | null;
	readonly submitterKind: SupportFeedbackSubmitterKind;
	readonly category: SupportFeedbackCategory;
	readonly ciphertext: Buffer;
	readonly encryptionKeyVersion: string;
	readonly contentFingerprint: string;
	readonly fingerprintKeyVersion: string;
	readonly contentFingerprintCandidates: Readonly<Record<string, string>>;
	readonly guestIpHash: string | null;
	readonly guestIpHashKeyVersion: string | null;
	readonly guestIpHashCandidates: Readonly<Record<string, string>> | null;
}

export type SupportFeedbackInsertResult =
	| { readonly kind: "INSERTED" }
	| { readonly kind: "REPLAY" }
	| { readonly kind: "MISMATCH" };

export type SupportFeedbackRequiredKeyPurpose =
	| "ENCRYPTION"
	| "HMAC"
	| "LEGACY";

export interface SupportFeedbackRequiredKeyVersion {
	readonly purpose: SupportFeedbackRequiredKeyPurpose;
	readonly keyVersion: string | null;
	readonly recordCount: number;
}

interface SubmissionRow extends QueryResultRow {
	readonly outcome: "INSERTED" | "REPLAY" | "MISMATCH";
}

interface RequiredKeyVersionRow extends QueryResultRow {
	readonly key_purpose: unknown;
	readonly key_version: unknown;
	readonly record_count: unknown;
}

export class SupportFeedbackQuotaExceededError extends Error {
	constructor() {
		super("support feedback quota exceeded");
		this.name = "SupportFeedbackQuotaExceededError";
	}
}

@Injectable()
export class SupportFeedbackRepository {
	constructor(private readonly database: DatabasePool) {}

	isAvailable(): boolean {
		return this.database.isEnabled();
	}

	/**
	 * Submission is deliberately one database call. The SECURITY DEFINER
	 * primitive owns idempotency, replay comparison and quota serialization;
	 * api_runtime has no direct support_feedback table privileges.
	 */
	async insert(
		input: SupportFeedbackInsert,
	): Promise<SupportFeedbackInsertResult> {
		try {
			const result = await this.database.query<SubmissionRow>(
				`SELECT public.submit_support_feedback(
				   $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb
				 ) AS outcome`,
				[
					input.feedbackId,
					input.userId,
					input.submitterKind,
					input.category,
					input.ciphertext,
					input.encryptionKeyVersion,
					input.contentFingerprint,
					input.fingerprintKeyVersion,
					JSON.stringify(input.contentFingerprintCandidates),
					input.guestIpHash,
					input.guestIpHashKeyVersion,
					input.guestIpHashCandidates === null
						? null
						: JSON.stringify(input.guestIpHashCandidates),
				],
			);
			const outcome = result.rows[0]?.outcome;
			if (
				outcome !== "INSERTED" &&
				outcome !== "REPLAY" &&
				outcome !== "MISMATCH"
			) {
				throw new Error("反馈原子提交未返回有效结果");
			}
			return Object.freeze({ kind: outcome });
		} catch (error) {
			if (error instanceof DatabaseQueryError && error.sqlState === "P5100") {
				throw new SupportFeedbackQuotaExceededError();
			}
			throw error;
		}
	}

	async requiredKeyVersions(): Promise<
		readonly SupportFeedbackRequiredKeyVersion[]
	> {
		const result = await this.database.query<RequiredKeyVersionRow>(
			`SELECT key_purpose, key_version, record_count
			 FROM public.support_feedback_required_key_versions()`,
		);
		return Object.freeze(
			result.rows.map((row) => {
				const purpose = row.key_purpose;
				const keyVersion = row.key_version;
				const recordCount = Number(row.record_count);
				if (
					(purpose !== "ENCRYPTION" &&
						purpose !== "HMAC" &&
						purpose !== "LEGACY") ||
					!Number.isSafeInteger(recordCount) ||
					recordCount < 1 ||
					(purpose === "LEGACY"
						? keyVersion !== null
						: typeof keyVersion !== "string" ||
							!KEY_VERSION_PATTERN.test(keyVersion))
				) {
					throw new Error("反馈密钥覆盖元数据无效");
				}
				const normalized: SupportFeedbackRequiredKeyVersion = {
					purpose,
					keyVersion: keyVersion as string | null,
					recordCount,
				};
				return Object.freeze(normalized);
			}),
		);
	}
}
