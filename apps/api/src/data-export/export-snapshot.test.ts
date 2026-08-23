import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	encryptSupportFeedback,
	SupportFeedbackKeyRing,
} from "../support-feedback/support-feedback-crypto.js";
import {
	EXPORT_SNAPSHOT_ITEM_LIMITS,
	ExportSnapshotError,
	serializeExportSnapshot,
} from "./export-snapshot.js";

function ring(): SupportFeedbackKeyRing {
	return new SupportFeedbackKeyRing(
		"enc-v1",
		new Map([["enc-v1", randomBytes(32)]]),
	);
}

function validSnapshot(keyRing: SupportFeedbackKeyRing): object {
	const feedbackId = randomUUID();
	const encrypted = encryptSupportFeedback(
		"这是用户主动提交、需要随账号数据导出的反馈正文。",
		{ feedbackId, category: "PRODUCT" },
		keyRing,
	);
	return {
		schemaVersion: 1,
		generatedAt: "2026-08-21T00:00:00.000Z",
		account: {
			accountId: randomUUID(),
			status: "ACTIVE",
			createdAt: "2026-08-20T00:00:00.000Z",
		},
		identities: [
			{
				identityType: "PHONE",
				maskedDisplayHint: "+86138****8000",
				isPrimary: true,
				verifiedAt: "2026-08-20T00:00:00.000Z",
				createdAt: "2026-08-20T00:00:00.000Z",
			},
		],
		favorites: [],
		recommendationHistory: [],
		privateFeedback: [],
		preferences: {},
		supportFeedbackEncrypted: [
			{
				feedbackId,
				category: "PRODUCT",
				status: "OPEN",
				createdAt: "2026-08-21T00:00:00.000Z",
				ciphertextBase64: encrypted.ciphertext.toString("base64"),
				encryptionKeyVersion: encrypted.keyVersion,
			},
		],
	};
}

describe("serializeExportSnapshot", () => {
	it("rebuilds a strict public artifact and strips every internal crypto field", () => {
		const keyRing = ring();
		const serialized = serializeExportSnapshot(
			validSnapshot(keyRing),
			keyRing,
			1024 * 1024,
		);
		const json = serialized.body.toString("utf8");
		const artifact = JSON.parse(json) as Record<string, unknown>;
		expect(json).toContain("用户主动提交");
		expect(json).not.toMatch(
			/ciphertext|keyVersion|provider|placeId|token|coordinate|latitude|longitude|lease|hash/iu,
		);
		expect(Object.keys(artifact)).toEqual([
			"schemaVersion",
			"generatedAt",
			"account",
			"identities",
			"favorites",
			"recommendationHistory",
			"privateFeedback",
			"supportFeedback",
			"preferences",
		]);
		serialized.body.fill(0);
		keyRing.destroy();
	});

	it("rejects unexpected source fields, tampered feedback and oversized output", () => {
		const keyRing = ring();
		expect(() =>
			serializeExportSnapshot(
				{ ...validSnapshot(keyRing), providerPlaceId: "secret" },
				keyRing,
				1024 * 1024,
			),
		).toThrow();

		const tampered = validSnapshot(keyRing) as {
			supportFeedbackEncrypted: Array<{ ciphertextBase64: string }>;
		};
		const bytes = Buffer.from(
			tampered.supportFeedbackEncrypted[0]?.ciphertextBase64 ?? "",
			"base64",
		);
		bytes[bytes.length - 1] ^= 1;
		if (tampered.supportFeedbackEncrypted[0] !== undefined) {
			tampered.supportFeedbackEncrypted[0].ciphertextBase64 =
				bytes.toString("base64");
		}
		bytes.fill(0);
		expect(() =>
			serializeExportSnapshot(tampered, keyRing, 1024 * 1024),
		).toThrow("认证失败");
		expect(() =>
			serializeExportSnapshot(validSnapshot(keyRing), keyRing, 16),
		).toThrow("超过允许大小");
		keyRing.destroy();
	});

	it("rejects an over-budget array before decrypting or serializing", () => {
		const keyRing = ring();
		const snapshot = validSnapshot(keyRing) as {
			identities: Array<Record<string, unknown>>;
		};
		snapshot.identities = Array.from(
			{ length: EXPORT_SNAPSHOT_ITEM_LIMITS.identities + 1 },
			() => ({
				identityType: "PHONE",
				maskedDisplayHint: "+86138****8000",
				isPrimary: false,
				verifiedAt: "2026-08-20T00:00:00.000Z",
				createdAt: "2026-08-20T00:00:00.000Z",
			}),
		);
		try {
			expect(() =>
				serializeExportSnapshot(snapshot, keyRing, 1024 * 1024),
			).toThrowError(
				expect.objectContaining<Partial<ExportSnapshotError>>({
					failure: "SNAPSHOT_TOO_LARGE",
				}),
			);
		} finally {
			keyRing.destroy();
		}
	});
});
