import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

const KEY_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const LOCATOR_PATTERN =
	/^exports\/v1\/[0-9]{4}\/[0-9]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedExportArtifactLocator {
	readonly ciphertext: Buffer;
	readonly keyVersion: string;
}

export class ExportLocatorKeyRing {
	readonly activeVersion: string;
	readonly #keys: ReadonlyMap<string, Buffer>;
	#destroyed = false;

	constructor(activeVersion: string, keys: ReadonlyMap<string, Uint8Array>) {
		if (!KEY_VERSION_PATTERN.test(activeVersion)) {
			throw new Error("导出定位符密钥版本格式无效");
		}
		if (keys.size < 1 || keys.size > 3 || !keys.has(activeVersion)) {
			throw new Error("导出定位符密钥环必须包含当前版本且最多保留三版");
		}
		const copied = new Map<string, Buffer>();
		try {
			for (const [version, key] of keys) {
				if (!KEY_VERSION_PATTERN.test(version) || key.byteLength !== 32) {
					throw new Error("导出定位符密钥必须是带合法版本的32字节密钥");
				}
				if (
					[...copied.values()].some((existing) =>
						timingSafeEqual(existing, key),
					)
				) {
					throw new Error("导出定位符不同版本不得复用密钥材料");
				}
				copied.set(version, Buffer.from(key));
			}
		} catch (error) {
			for (const key of copied.values()) key.fill(0);
			throw error;
		}
		this.activeVersion = activeVersion;
		this.#keys = copied;
	}

	activeKey(): Buffer {
		return this.keyRequired(this.activeVersion);
	}

	key(version: string): Buffer | null {
		this.assertAvailable();
		const key = this.#keys.get(version);
		return key === undefined ? null : Buffer.from(key);
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		for (const key of this.#keys.values()) key.fill(0);
	}

	private keyRequired(version: string): Buffer {
		const key = this.key(version);
		if (key === null) throw new Error("导出定位符密钥版本不可用");
		return key;
	}

	private assertAvailable(): void {
		if (this.#destroyed) throw new Error("导出定位符密钥环已销毁");
	}
}

export function assertExportArtifactLocator(locator: string): void {
	if (!LOCATOR_PATTERN.test(locator)) {
		throw new Error("导出工件定位符格式无效");
	}
}

export function encryptExportArtifactLocator(
	locator: string,
	keyRing: ExportLocatorKeyRing,
): EncryptedExportArtifactLocator {
	assertExportArtifactLocator(locator);
	const plaintext = Buffer.from(locator, "utf8");
	const nonce = randomBytes(NONCE_BYTES);
	const key = keyRing.activeKey();
	const aad = locatorAad(keyRing.activeVersion);
	try {
		const cipher = createCipheriv("aes-256-gcm", key, nonce, {
			authTagLength: AUTH_TAG_BYTES,
		});
		cipher.setAAD(aad);
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
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
		plaintext.fill(0);
		aad.fill(0);
	}
}

export function decryptExportArtifactLocator(
	envelope: Uint8Array,
	keyVersion: string,
	keyRing: ExportLocatorKeyRing,
): string {
	const bytes = Buffer.from(envelope);
	if (
		bytes.byteLength <= 1 + NONCE_BYTES + AUTH_TAG_BYTES ||
		bytes[0] !== ENVELOPE_VERSION
	) {
		bytes.fill(0);
		throw new Error("导出定位符密文格式无效");
	}
	const key = keyRing.key(keyVersion);
	if (key === null) {
		bytes.fill(0);
		throw new Error("导出定位符密钥版本不可用");
	}
	const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
	const tag = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + AUTH_TAG_BYTES);
	const ciphertext = bytes.subarray(1 + NONCE_BYTES + AUTH_TAG_BYTES);
	const aad = locatorAad(keyVersion);
	let updated: Buffer | null = null;
	let finalized: Buffer | null = null;
	let plaintext: Buffer | null = null;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
			authTagLength: AUTH_TAG_BYTES,
		});
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		updated = decipher.update(ciphertext);
		finalized = decipher.final();
		plaintext = Buffer.concat([updated, finalized]);
		const locator = plaintext.toString("utf8");
		assertExportArtifactLocator(locator);
		return locator;
	} catch {
		throw new Error("导出定位符密文认证失败");
	} finally {
		updated?.fill(0);
		finalized?.fill(0);
		plaintext?.fill(0);
		key.fill(0);
		bytes.fill(0);
		aad.fill(0);
	}
}

function locatorAad(keyVersion: string): Buffer {
	return Buffer.from(
		`chi-shen-me:data-export:artifact-locator:v1\u0000${keyVersion}`,
		"utf8",
	);
}
