import type { SupportFeedbackCategory } from "@chi-shen-me/contracts";
import { z } from "zod";
import {
	decryptSupportFeedback,
	type SupportFeedbackKeyRing,
} from "../support-feedback/support-feedback-crypto.js";

export const EXPORT_SNAPSHOT_ITEM_LIMITS = Object.freeze({
	identities: 32,
	favorites: 1_000,
	recommendationHistory: 5_000,
	privateFeedback: 2_000,
	supportFeedback: 100,
});

export class ExportSnapshotError extends Error {
	constructor(readonly failure: "SNAPSHOT_TOO_LARGE" | "INVALID_SOURCE") {
		super(
			failure === "SNAPSHOT_TOO_LARGE"
				? "数据导出快照超过允许大小"
				: "数据导出快照无效",
		);
		this.name = "ExportSnapshotError";
	}
}

const UUID = z.uuid();
const Timestamp = z.iso.datetime();
const SafeText = z
	.string()
	.min(1)
	.max(254)
	.refine((value) => !containsControlCharacter(value));
const CiphertextBase64 = z
	.string()
	.min(44)
	.max(87_384)
	.refine((value) => {
		const bytes = Buffer.from(value, "base64");
		try {
			return (
				bytes.byteLength >= 16 &&
				bytes.byteLength <= 65_536 &&
				bytes.toString("base64") === value
			);
		} finally {
			bytes.fill(0);
		}
	});

const InternalExportSnapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		generatedAt: Timestamp,
		account: z
			.object({
				accountId: UUID,
				status: z.literal("ACTIVE"),
				createdAt: Timestamp,
			})
			.strict(),
		identities: z.array(
			z
				.object({
					identityType: z.enum(["PHONE", "WECHAT", "EMAIL", "QQ", "APPLE"]),
					maskedDisplayHint: SafeText,
					isPrimary: z.boolean(),
					verifiedAt: Timestamp,
					createdAt: Timestamp,
					revokedAt: Timestamp.optional(),
				})
				.strict(),
		).max(EXPORT_SNAPSHOT_ITEM_LIMITS.identities),
		favorites: z.array(
			z
				.object({
					favoriteId: UUID,
					group: z.enum(["WANT_TO_GO", "REGULAR"]),
					createdAt: Timestamp,
					placeReferenceAvailable: z.boolean(),
				})
				.strict(),
		).max(EXPORT_SNAPSHOT_ITEM_LIMITS.favorites),
		recommendationHistory: z.array(
			z
				.object({
					historyId: UUID,
					action: z.enum([
						"IMPRESSION",
						"DETAIL",
						"FAVORITE",
						"NAVIGATION",
						"CALL",
						"REROLL",
					]),
					mealPeriod: z.enum(["BREAKFAST", "LUNCH", "DINNER"]),
					occurredAt: Timestamp,
					placeReferenceAvailable: z.boolean(),
				})
				.strict(),
		).max(EXPORT_SNAPSHOT_ITEM_LIMITS.recommendationHistory),
		privateFeedback: z.array(
			z
				.object({
					feedbackId: UUID,
					type: z.enum([
						"WANT_TO_EAT",
						"ATE",
						"LIKE",
						"DISLIKE",
						"TOO_FAR",
						"TOO_EXPENSIVE",
						"ATE_RECENTLY",
						"EXCLUDE_CUISINE",
					]),
					createdAt: Timestamp,
					placeReferenceAvailable: z.boolean(),
				})
				.strict(),
		).max(EXPORT_SNAPSHOT_ITEM_LIMITS.privateFeedback),
		preferences: z.object({}).strict(),
		supportFeedbackEncrypted: z.array(
			z
				.object({
					feedbackId: UUID,
					category: z.enum([
						"PRODUCT",
						"PLACE_CORRECTION",
						"PRIVACY",
						"COMPLAINT",
					]),
					status: z.enum(["OPEN", "IN_REVIEW", "CLOSED"]),
					createdAt: Timestamp,
					closedAt: Timestamp.optional(),
					ciphertextBase64: CiphertextBase64,
					encryptionKeyVersion: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u),
				})
				.strict(),
		).max(EXPORT_SNAPSHOT_ITEM_LIMITS.supportFeedback),
	})
	.strict();

export interface SerializedExportSnapshot {
	readonly body: Buffer;
	readonly generatedAt: Date;
}

/**
 * Parses the worker-only DB projection, decrypts the user's own support text,
 * and reconstructs an explicit public artifact. Internal ciphertext, key
 * versions, provider references, HMACs and database lease fields cannot be
 * represented by the returned JSON shape.
 */
export function serializeExportSnapshot(
	value: unknown,
	supportFeedbackEncryptionKeys: SupportFeedbackKeyRing,
	maximumBytes: number,
): SerializedExportSnapshot {
	const parsed = InternalExportSnapshotSchema.safeParse(value);
	if (!parsed.success) {
		throw new ExportSnapshotError(
			parsed.error.issues.some((issue) => issue.code === "too_big")
				? "SNAPSHOT_TOO_LARGE"
				: "INVALID_SOURCE",
		);
	}
	const source = parsed.data;
	const supportFeedback = source.supportFeedbackEncrypted.map((feedback) => {
		const ciphertext = Buffer.from(feedback.ciphertextBase64, "base64");
		try {
			const message = decryptSupportFeedback(
				ciphertext,
				feedback.encryptionKeyVersion,
				{
					feedbackId: feedback.feedbackId,
					category: feedback.category as SupportFeedbackCategory,
				},
				supportFeedbackEncryptionKeys,
			);
			assertStoredSupportMessage(message);
			return Object.freeze({
				feedbackId: feedback.feedbackId,
				category: feedback.category,
				status: feedback.status,
				createdAt: feedback.createdAt,
				...(feedback.closedAt === undefined
					? {}
					: { closedAt: feedback.closedAt }),
				message,
			});
		} finally {
			ciphertext.fill(0);
		}
	});

	const artifact = {
		schemaVersion: source.schemaVersion,
		generatedAt: source.generatedAt,
		account: source.account,
		identities: source.identities,
		favorites: source.favorites,
		recommendationHistory: source.recommendationHistory,
		privateFeedback: source.privateFeedback,
		supportFeedback,
		preferences: source.preferences,
	};
	const body = Buffer.from(JSON.stringify(artifact), "utf8");
	if (
		!Number.isSafeInteger(maximumBytes) ||
		maximumBytes < 1 ||
		body.byteLength > maximumBytes
	) {
		body.fill(0);
		throw new ExportSnapshotError("SNAPSHOT_TOO_LARGE");
	}
	return Object.freeze({
		body,
		generatedAt: new Date(source.generatedAt),
	});
}

function assertStoredSupportMessage(message: string): void {
	const length = Array.from(message).length;
	if (length < 10 || length > 2_000) {
		throw new Error("导出反馈正文长度无效");
	}
	for (const character of message) {
		const point = character.codePointAt(0) ?? 0;
		if (
			point <= 0x08 ||
			(point >= 0x0b && point <= 0x1f) ||
			(point >= 0x7f && point <= 0x9f)
		) {
			throw new Error("导出反馈正文包含控制字符");
		}
	}
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const point = character.codePointAt(0) ?? 0;
		if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) return true;
	}
	return false;
}
