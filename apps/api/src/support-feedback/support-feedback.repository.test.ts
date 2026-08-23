import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	type DatabasePool,
	DatabaseQueryError,
} from "../database/database-pool.js";
import {
	SupportFeedbackQuotaExceededError,
	SupportFeedbackRepository,
} from "./support-feedback.repository.js";

function submission() {
	return {
		feedbackId: randomUUID(),
		userId: null,
		submitterKind: "GUEST" as const,
		category: "COMPLAINT" as const,
		ciphertext: Buffer.from("opaque-ciphertext"),
		encryptionKeyVersion: "enc-v1",
		contentFingerprint: "a".repeat(64),
		fingerprintKeyVersion: "hmac-v2",
		contentFingerprintCandidates: {
			"hmac-v1": "b".repeat(64),
			"hmac-v2": "a".repeat(64),
		},
		guestIpHash: "c".repeat(64),
		guestIpHashKeyVersion: "hmac-v2",
		guestIpHashCandidates: {
			"hmac-v1": "d".repeat(64),
			"hmac-v2": "c".repeat(64),
		},
	};
}

describe("SupportFeedbackRepository", () => {
	it("uses one atomic function call without plaintext or a table read", async () => {
		const query = vi.fn(async () => ({
			rows: [{ outcome: "INSERTED" }],
			rowCount: 1,
		}));
		const repository = new SupportFeedbackRepository({
			isEnabled: () => true,
			query,
		} as unknown as DatabasePool);
		const input = submission();

		await expect(repository.insert(input)).resolves.toEqual({
			kind: "INSERTED",
		});

		expect(repository.isAvailable()).toBe(true);
		expect(query).toHaveBeenCalledOnce();
		const [sql, parameters] = query.mock.calls[0] as unknown as [
			string,
			readonly unknown[],
		];
		expect(sql).toContain("public.submit_support_feedback(");
		expect(sql).not.toMatch(/FROM public\.support_feedback/iu);
		expect(parameters).toHaveLength(12);
		expect(parameters).not.toContain(expect.stringContaining("反馈正文"));
		expect(parameters[8]).toBe(
			JSON.stringify(input.contentFingerprintCandidates),
		);
		expect(parameters[11]).toBe(JSON.stringify(input.guestIpHashCandidates));
	});

	it.each(["REPLAY", "MISMATCH"] as const)(
		"preserves the database %s outcome",
		async (outcome) => {
			const repository = new SupportFeedbackRepository({
				isEnabled: () => true,
				query: async () => ({ rows: [{ outcome }], rowCount: 1 }),
			} as unknown as DatabasePool);
			await expect(repository.insert(submission())).resolves.toEqual({
				kind: outcome,
			});
		},
	);

	it("maps only the dedicated database quota state", async () => {
		const quota = new SupportFeedbackRepository({
			isEnabled: () => true,
			query: async () => {
				throw new DatabaseQueryError("P5100");
			},
		} as unknown as DatabasePool);
		await expect(quota.insert(submission())).rejects.toBeInstanceOf(
			SupportFeedbackQuotaExceededError,
		);

		const other = new SupportFeedbackRepository({
			isEnabled: () => true,
			query: async () => {
				throw new DatabaseQueryError("23514");
			},
		} as unknown as DatabasePool);
		await expect(other.insert(submission())).rejects.toMatchObject({
			sqlState: "23514",
		});
	});

	it("loads only bounded key-version metadata for the startup gate", async () => {
		const query = vi.fn(async () => ({
			rows: [
				{
					key_purpose: "ENCRYPTION",
					key_version: "enc-v1",
					record_count: "2",
				},
				{
					key_purpose: "HMAC",
					key_version: "hmac-v1",
					record_count: 3,
				},
			],
			rowCount: 2,
		}));
		const repository = new SupportFeedbackRepository({
			isEnabled: () => true,
			query,
		} as unknown as DatabasePool);
		await expect(repository.requiredKeyVersions()).resolves.toEqual([
			{ purpose: "ENCRYPTION", keyVersion: "enc-v1", recordCount: 2 },
			{ purpose: "HMAC", keyVersion: "hmac-v1", recordCount: 3 },
		]);
		expect(query.mock.calls[0]?.[0]).toContain(
			"support_feedback_required_key_versions",
		);
	});

	it("rejects malformed key-coverage metadata instead of weakening startup", async () => {
		const repository = new SupportFeedbackRepository({
			isEnabled: () => true,
			query: async () => ({
				rows: [
					{
						key_purpose: "HMAC",
						key_version: "invalid version",
						record_count: "1",
					},
				],
				rowCount: 1,
			}),
		} as unknown as DatabasePool);
		await expect(repository.requiredKeyVersions()).rejects.toThrow(
			"覆盖元数据无效",
		);
	});
});
