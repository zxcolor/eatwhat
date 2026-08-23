import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { SupportFeedbackCategory } from "@chi-shen-me/contracts";

const KEY_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 16_384;

export interface SupportFeedbackEncryptionContext {
	readonly feedbackId: string;
	readonly category: SupportFeedbackCategory;
}

export interface EncryptedSupportFeedback {
	readonly ciphertext: Buffer;
	readonly keyVersion: string;
}

export interface SupportFeedbackFingerprintContext {
	readonly feedbackId: string;
	readonly category: SupportFeedbackCategory;
}

export interface VersionedSupportFeedbackFingerprint {
	readonly activeFingerprint: string;
	readonly activeKeyVersion: string;
	readonly candidates: Readonly<Record<string, string>>;
}

/**
 * Dedicated support-content crypto key ring. Separate instances are required
 * for encryption and HMAC, and neither may reuse auth, admin-session, or
 * WebAuthn credential keys. Every key is copied on input and access so callers
 * cannot mutate the configured secret in place.
 */
export class SupportFeedbackKeyRing {
	readonly activeVersion: string;
	readonly #keys: ReadonlyMap<string, Buffer>;
	#destroyed = false;

	constructor(activeVersion: string, keys: ReadonlyMap<string, Uint8Array>) {
		if (!KEY_VERSION_PATTERN.test(activeVersion)) {
			throw new Error("反馈密钥版本格式无效");
		}
		if (keys.size < 1 || keys.size > 3 || !keys.has(activeVersion)) {
			throw new Error("反馈密钥环必须包含当前版本且只保留最多三个版本");
		}

		const copied = new Map<string, Buffer>();
		for (const [version, key] of keys) {
			if (!KEY_VERSION_PATTERN.test(version) || key.byteLength !== 32) {
				for (const copiedKey of copied.values()) copiedKey.fill(0);
				throw new Error("反馈密钥必须是带合法版本的 32 字节密钥");
			}
			if (
				[...copied.values()].some((existing) => timingSafeEqual(existing, key))
			) {
				for (const copiedKey of copied.values()) copiedKey.fill(0);
				throw new Error("同一反馈密钥环不得在不同版本复用密钥材料");
			}
			copied.set(version, Buffer.from(key));
		}
		this.activeVersion = activeVersion;
		this.#keys = copied;
	}

	activeKey(): Buffer {
		this.assertAvailable();
		return Buffer.from(this.#keys.get(this.activeVersion) as Buffer);
	}

	key(version: string): Buffer | null {
		this.assertAvailable();
		const key = this.#keys.get(version);
		return key === undefined ? null : Buffer.from(key);
	}

	versions(): readonly string[] {
		this.assertAvailable();
		return Object.freeze([...this.#keys.keys()]);
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		for (const key of this.#keys.values()) key.fill(0);
	}

	private assertAvailable(): void {
		if (this.#destroyed) throw new Error("反馈密钥环已销毁");
	}
}

export function encryptSupportFeedback(
	plaintext: string,
	context: SupportFeedbackEncryptionContext,
	keyRing: SupportFeedbackKeyRing,
): EncryptedSupportFeedback {
	assertContext(context);
	const plaintextBytes = Buffer.from(plaintext, "utf8");
	if (
		plaintextBytes.length < 1 ||
		plaintextBytes.length > MAX_PLAINTEXT_BYTES
	) {
		plaintextBytes.fill(0);
		throw new Error("反馈正文长度无效");
	}

	const key = keyRing.activeKey();
	const nonce = randomBytes(NONCE_BYTES);
	const aad = contextAad(context, keyRing.activeVersion);
	try {
		const cipher = createCipheriv("aes-256-gcm", key, nonce, {
			authTagLength: AUTH_TAG_BYTES,
		});
		cipher.setAAD(aad);
		const encrypted = Buffer.concat([
			cipher.update(plaintextBytes),
			cipher.final(),
		]);
		const authTag = cipher.getAuthTag();
		return Object.freeze({
			ciphertext: Buffer.concat([
				Buffer.from([ENVELOPE_VERSION]),
				nonce,
				authTag,
				encrypted,
			]),
			keyVersion: keyRing.activeVersion,
		});
	} finally {
		key.fill(0);
		plaintextBytes.fill(0);
		aad.fill(0);
	}
}

export function decryptSupportFeedback(
	envelope: Uint8Array,
	keyVersion: string,
	context: SupportFeedbackEncryptionContext,
	keyRing: SupportFeedbackKeyRing,
): string {
	assertContext(context);
	const bytes = Buffer.from(envelope);
	if (
		bytes.length <= 1 + NONCE_BYTES + AUTH_TAG_BYTES ||
		bytes[0] !== ENVELOPE_VERSION
	) {
		bytes.fill(0);
		throw new Error("反馈密文格式无效");
	}
	const key = keyRing.key(keyVersion);
	if (key === null) {
		bytes.fill(0);
		throw new Error("反馈密文引用的密钥版本不可用");
	}
	const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
	const authTag = bytes.subarray(
		1 + NONCE_BYTES,
		1 + NONCE_BYTES + AUTH_TAG_BYTES,
	);
	const encrypted = bytes.subarray(1 + NONCE_BYTES + AUTH_TAG_BYTES);
	const aad = contextAad(context, keyVersion);
	let updated: Buffer | null = null;
	let finalized: Buffer | null = null;
	let plaintext: Buffer | null = null;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
			authTagLength: AUTH_TAG_BYTES,
		});
		decipher.setAAD(aad);
		decipher.setAuthTag(authTag);
		updated = decipher.update(encrypted);
		finalized = decipher.final();
		plaintext = Buffer.concat([updated, finalized]);
		// JavaScript strings cannot be actively zeroed. Callers must keep the
		// returned value request-scoped and must never log it.
		return plaintext.toString("utf8");
	} catch {
		throw new Error("反馈密文认证失败");
	} finally {
		updated?.fill(0);
		finalized?.fill(0);
		plaintext?.fill(0);
		key.fill(0);
		bytes.fill(0);
		aad.fill(0);
	}
}

export function supportFeedbackPlaintextsEqual(
	left: string,
	right: string,
): boolean {
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	try {
		return (
			leftBytes.byteLength === rightBytes.byteLength &&
			timingSafeEqual(leftBytes, rightBytes)
		);
	} finally {
		leftBytes.fill(0);
		rightBytes.fill(0);
	}
}

/**
 * Builds one domain-separated HMAC candidate per retained key version. Keeping
 * the bounded candidate set lets PostgreSQL recognise an exact retry after a
 * key rotation without reading or decrypting the existing support message.
 */
export function fingerprintSupportFeedback(
	plaintext: string,
	context: SupportFeedbackFingerprintContext,
	keyRing: SupportFeedbackKeyRing,
): VersionedSupportFeedbackFingerprint {
	assertContext(context);
	const plaintextBytes = Buffer.from(plaintext, "utf8");
	if (
		plaintextBytes.byteLength < 1 ||
		plaintextBytes.byteLength > MAX_PLAINTEXT_BYTES
	) {
		plaintextBytes.fill(0);
		throw new Error("反馈正文长度无效");
	}
	const prefix = Buffer.from(
		[
			"chi-shen-me:support-feedback:content-fingerprint:v1",
			context.feedbackId.toLowerCase(),
			context.category,
			"",
		].join("\u0000"),
		"utf8",
	);
	try {
		return versionedHmac(prefix, plaintextBytes, keyRing);
	} finally {
		prefix.fill(0);
		plaintextBytes.fill(0);
	}
}

/**
 * The raw client address is request-scoped and never leaves this function.
 * Candidate hashes preserve rolling-key quota continuity for guest retries.
 */
export function fingerprintSupportFeedbackGuestIp(
	clientIp: string,
	keyRing: SupportFeedbackKeyRing,
): VersionedSupportFeedbackFingerprint {
	const ipBytes = Buffer.from(clientIp, "utf8");
	if (ipBytes.byteLength < 1 || ipBytes.byteLength > 64) {
		ipBytes.fill(0);
		throw new Error("反馈来源地址无效");
	}
	const prefix = Buffer.from(
		"chi-shen-me:support-feedback:guest-ip:v1\u0000",
		"utf8",
	);
	try {
		return versionedHmac(prefix, ipBytes, keyRing);
	} finally {
		prefix.fill(0);
		ipBytes.fill(0);
	}
}

function versionedHmac(
	prefix: Uint8Array,
	payload: Uint8Array,
	keyRing: SupportFeedbackKeyRing,
): VersionedSupportFeedbackFingerprint {
	const candidates: Record<string, string> = Object.create(null) as Record<
		string,
		string
	>;
	for (const keyVersion of [...keyRing.versions()].sort()) {
		const key = keyRing.key(keyVersion);
		if (key === null) throw new Error("反馈 HMAC 密钥版本不可用");
		try {
			candidates[keyVersion] = createHmac("sha256", key)
				.update(prefix)
				.update(payload)
				.digest("hex");
		} finally {
			key.fill(0);
		}
	}
	return Object.freeze({
		activeFingerprint: candidates[keyRing.activeVersion] as string,
		activeKeyVersion: keyRing.activeVersion,
		candidates: Object.freeze(candidates),
	});
}

function contextAad(
	context: SupportFeedbackEncryptionContext,
	keyVersion: string,
): Buffer {
	// Do not bind AAD to support_feedback.user_id: account deletion intentionally
	// changes that foreign key to NULL while the closed ticket may remain for its
	// 180-day retention window. The immutable row id and category still prevent a
	// ciphertext from being moved to a different ticket or classification.
	return Buffer.from(
		[
			"chi-shen-me:support-feedback:v1",
			keyVersion,
			context.feedbackId.toLowerCase(),
			context.category,
		].join("\u0000"),
		"utf8",
	);
}

function assertContext(context: SupportFeedbackEncryptionContext): void {
	if (!UUID_PATTERN.test(context.feedbackId)) {
		throw new Error("反馈标识格式无效");
	}
	if (
		!(
			["PRODUCT", "PLACE_CORRECTION", "PRIVACY", "COMPLAINT"] as const
		).includes(context.category)
	) {
		throw new Error("反馈分类无效");
	}
}
