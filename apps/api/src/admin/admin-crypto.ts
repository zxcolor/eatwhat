import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { OnApplicationShutdown } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import type { AdminCryptoKeyConfig } from "./admin-config.js";
import {
	ADMIN_PROCESS_CONFIG,
	type AdminProcessConfig,
} from "./admin-process-config.js";

export type AdminHmacPurpose =
	| "LOGIN_LOOKUP"
	| "CHALLENGE"
	| "REQUEST_IP"
	| "DEVICE"
	| "CREDENTIAL_ID"
	| "CREDENTIAL_HANDLE"
	| "SESSION_TOKEN"
	| "RP_ID"
	| "ORIGIN"
	| "SUBJECT";

export interface VersionedHash {
	readonly value: string;
	readonly keyVersion: string;
}

export interface EncryptedCredentialId {
	readonly ciphertext: Buffer;
	readonly keyVersion: string;
}

const CREDENTIAL_MAGIC = Buffer.from("CSMA", "ascii");
const CREDENTIAL_FORMAT_VERSION = 1;
const CREDENTIAL_IV_BYTES = 12;
const CREDENTIAL_TAG_BYTES = 16;

function aad(version: string): Buffer {
	return Buffer.from(`chi-shen-me-admin:credential-id:v1:${version}`, "utf8");
}

function isOpaqueBase64Url(value: string): boolean {
	return /^[A-Za-z0-9_-]{1,2048}$/u.test(value);
}

@Injectable()
export class AdminCrypto implements OnApplicationShutdown {
	private readonly hmacKeys: AdminCryptoKeyConfig[];
	private readonly credentialEncryptionKeys: AdminCryptoKeyConfig[];
	private destroyed = false;

	constructor(@Inject(ADMIN_PROCESS_CONFIG) config: AdminProcessConfig) {
		this.hmacKeys = config.admin.hmacKeys.map((entry) => ({
			version: entry.version,
			key: Buffer.from(entry.key),
		}));
		this.credentialEncryptionKeys = config.admin.credentialEncryptionKeys.map(
			(entry) => ({
				version: entry.version,
				key: Buffer.from(entry.key),
			}),
		);
		// AdminProcessConfig is only a bootstrap transport for decoded key bytes. Clear those
		// buffers immediately so AdminCrypto becomes the sole live key owner.
		for (const entry of [
			...config.admin.hmacKeys,
			...config.admin.credentialEncryptionKeys,
		]) {
			entry.key.fill(0);
		}
	}

	onApplicationShutdown(): void {
		for (const entry of [...this.hmacKeys, ...this.credentialEncryptionKeys]) {
			entry.key.fill(0);
		}
		this.destroyed = true;
	}

	currentHash(purpose: AdminHmacPurpose, value: string): VersionedHash {
		const key = this.requiredCurrentKey(this.hmacKeys);
		return this.hashWithKey(key, purpose, value);
	}

	hashCandidates(
		purpose: AdminHmacPurpose,
		value: string,
	): readonly VersionedHash[] {
		return Object.freeze(
			this.hmacKeys.map((key) => this.hashWithKey(key, purpose, value)),
		);
	}

	verifyHash(
		purpose: AdminHmacPurpose,
		value: string,
		expectedHex: string,
		keyVersion: string,
	): boolean {
		if (!/^[0-9a-f]{64}$/u.test(expectedHex)) return false;
		this.assertActive();
		const key = this.hmacKeys.find(
			(candidate) => candidate.version === keyVersion,
		);
		if (key === undefined) return false;
		const actual = this.hashWithKey(key, purpose, value).value;
		return timingSafeEqual(
			Buffer.from(actual, "hex"),
			Buffer.from(expectedHex, "hex"),
		);
	}

	issueOpaqueToken(): string {
		this.assertActive();
		return randomBytes(32).toString("base64url");
	}

	encryptCredentialId(credentialId: string): EncryptedCredentialId {
		if (!isOpaqueBase64Url(credentialId)) {
			throw new Error("管理员凭据材料无效");
		}
		const key = this.requiredCurrentKey(this.credentialEncryptionKeys);
		const iv = randomBytes(CREDENTIAL_IV_BYTES);
		const aadBuffer = aad(key.version);
		const plaintext = Buffer.from(credentialId, "utf8");
		try {
			const cipher = createCipheriv("aes-256-gcm", key.key, iv, {
				authTagLength: CREDENTIAL_TAG_BYTES,
			});
			cipher.setAAD(aadBuffer);
			const encrypted = Buffer.concat([
				cipher.update(plaintext),
				cipher.final(),
			]);
			const packed = Buffer.concat([
				CREDENTIAL_MAGIC,
				Buffer.from([CREDENTIAL_FORMAT_VERSION]),
				iv,
				cipher.getAuthTag(),
				encrypted,
			]);
			return Object.freeze({ ciphertext: packed, keyVersion: key.version });
		} finally {
			plaintext.fill(0);
			aadBuffer.fill(0);
		}
	}

	decryptCredentialId(ciphertext: Uint8Array, keyVersion: string): string {
		this.assertActive();
		const key = this.credentialEncryptionKeys.find(
			(candidate) => candidate.version === keyVersion,
		);
		const packed = Buffer.from(ciphertext);
		const headerBytes =
			CREDENTIAL_MAGIC.length + 1 + CREDENTIAL_IV_BYTES + CREDENTIAL_TAG_BYTES;
		if (
			key === undefined ||
			packed.length <= headerBytes ||
			!packed.subarray(0, CREDENTIAL_MAGIC.length).equals(CREDENTIAL_MAGIC) ||
			packed[CREDENTIAL_MAGIC.length] !== CREDENTIAL_FORMAT_VERSION
		) {
			throw new Error("管理员凭据解密失败");
		}
		const aadBuffer = aad(key.version);
		let plaintext: Buffer | null = null;
		try {
			const ivStart = CREDENTIAL_MAGIC.length + 1;
			const tagStart = ivStart + CREDENTIAL_IV_BYTES;
			const ciphertextStart = tagStart + CREDENTIAL_TAG_BYTES;
			const decipher = createDecipheriv(
				"aes-256-gcm",
				key.key,
				packed.subarray(ivStart, tagStart),
				{ authTagLength: CREDENTIAL_TAG_BYTES },
			);
			decipher.setAAD(aadBuffer);
			decipher.setAuthTag(packed.subarray(tagStart, ciphertextStart));
			plaintext = Buffer.concat([
				decipher.update(packed.subarray(ciphertextStart)),
				decipher.final(),
			]);
			const value = plaintext.toString("utf8");
			if (!isOpaqueBase64Url(value)) {
				throw new Error("invalid credential id");
			}
			return value;
		} catch {
			throw new Error("管理员凭据解密失败");
		} finally {
			plaintext?.fill(0);
			aadBuffer.fill(0);
		}
	}

	private hashWithKey(
		key: AdminCryptoKeyConfig,
		purpose: AdminHmacPurpose,
		value: string,
	): VersionedHash {
		this.assertActive();
		const hmac = createHmac("sha256", key.key);
		hmac.update("chi-shen-me-admin:v1\0", "utf8");
		hmac.update(purpose, "utf8");
		hmac.update("\0", "utf8");
		hmac.update(value, "utf8");
		return Object.freeze({
			value: hmac.digest("hex"),
			keyVersion: key.version,
		});
	}

	private requiredCurrentKey(
		keys: readonly AdminCryptoKeyConfig[],
	): AdminCryptoKeyConfig {
		const key = keys[0];
		if (key === undefined) throw new Error("管理员加密服务不可用");
		this.assertActive();
		return key;
	}

	private assertActive(): void {
		if (this.destroyed) throw new Error("管理员加密服务不可用");
	}
}
