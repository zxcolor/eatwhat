import { SupportFeedbackKeyRing } from "./support-feedback-crypto.js";

const KEY_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

export interface SupportFeedbackRuntimeConfig {
	readonly enabled: boolean;
	readonly encryptionKeyRing: SupportFeedbackKeyRing | null;
	readonly hmacKeyRing: SupportFeedbackKeyRing | null;
}

/**
 * Loads only the AES key material required by the isolated data-export worker.
 * The worker must never receive the support-feedback HMAC or guest-IP keys.
 */
export function loadExportWorkerSupportFeedbackEncryptionKeyRing(
	env: NodeJS.ProcessEnv,
): SupportFeedbackKeyRing {
	const activeVersion =
		env.SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION?.trim() ?? "";
	if (!KEY_VERSION_PATTERN.test(activeVersion)) {
		throw new Error(
			"SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION 必须是有效密钥版本",
		);
	}
	const keys = decodeKeyMap(
		env.SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON,
		"SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON",
	);
	try {
		return new SupportFeedbackKeyRing(activeVersion, keys);
	} finally {
		destroyKeyMap(keys);
	}
}

export function loadSupportFeedbackRuntimeConfig(
	env: NodeJS.ProcessEnv,
	options: { readonly databaseEnabled: boolean },
): SupportFeedbackRuntimeConfig {
	const enabled = readBoolean(
		env.SUPPORT_FEEDBACK_ENABLED,
		"SUPPORT_FEEDBACK_ENABLED",
	);
	if (!enabled) {
		return Object.freeze({
			enabled: false,
			encryptionKeyRing: null,
			hmacKeyRing: null,
		});
	}
	if (!options.databaseEnabled) {
		throw new Error("用户反馈服务启用时必须启用 PostgreSQL");
	}

	const encryptionActiveVersion =
		env.SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION?.trim() ?? "";
	if (!KEY_VERSION_PATTERN.test(encryptionActiveVersion)) {
		throw new Error(
			"SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION 必须是有效密钥版本",
		);
	}
	const hmacActiveVersion =
		env.SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION?.trim() ?? "";
	if (!KEY_VERSION_PATTERN.test(hmacActiveVersion)) {
		throw new Error("SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION 必须是有效密钥版本");
	}
	const encryptionKeys = decodeKeyMap(
		env.SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON,
		"SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON",
	);
	let hmacKeys: Map<string, Buffer>;
	try {
		hmacKeys = decodeKeyMap(
			env.SUPPORT_FEEDBACK_HMAC_KEYS_JSON,
			"SUPPORT_FEEDBACK_HMAC_KEYS_JSON",
		);
	} catch (error) {
		destroyKeyMap(encryptionKeys);
		throw error;
	}
	let encryptionKeyRing: SupportFeedbackKeyRing | null = null;
	let hmacKeyRing: SupportFeedbackKeyRing | null = null;
	try {
		assertPurposeSeparated(encryptionKeys, hmacKeys);
		encryptionKeyRing = new SupportFeedbackKeyRing(
			encryptionActiveVersion,
			encryptionKeys,
		);
		hmacKeyRing = new SupportFeedbackKeyRing(hmacActiveVersion, hmacKeys);
		return Object.freeze({
			enabled: true,
			encryptionKeyRing,
			hmacKeyRing,
		});
	} catch (error) {
		encryptionKeyRing?.destroy();
		hmacKeyRing?.destroy();
		throw error;
	} finally {
		destroyKeyMap(encryptionKeys);
		destroyKeyMap(hmacKeys);
	}
}

function readBoolean(value: string | undefined, name: string): boolean {
	if (value === undefined || value === "") return false;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} 必须是 true 或 false`);
}

function decodeKeyMap(
	raw: string | undefined,
	environmentName: string,
): Map<string, Buffer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw ?? "");
	} catch {
		throw new Error(`${environmentName} 必须是有效密钥版本 JSON 对象`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${environmentName} 必须是密钥版本 JSON 对象`);
	}
	const entries = Object.entries(parsed);
	if (entries.length < 1 || entries.length > 3) {
		throw new Error(`${environmentName} 只允许一到三个密钥版本`);
	}

	const keys = new Map<string, Buffer>();
	try {
		for (const [version, encoded] of entries) {
			if (!KEY_VERSION_PATTERN.test(version) || typeof encoded !== "string") {
				throw new Error("反馈密钥环包含无效版本或值");
			}
			const bytes = Buffer.from(encoded, "base64");
			if (bytes.toString("base64") !== encoded || bytes.byteLength !== 32) {
				bytes.fill(0);
				throw new Error("反馈密钥必须是规范 Base64 编码的 32 字节值");
			}
			if ([...keys.values()].some((existing) => existing.equals(bytes))) {
				bytes.fill(0);
				throw new Error("反馈密钥的不同版本不得复用相同密钥材料");
			}
			keys.set(version, bytes);
		}
		return keys;
	} catch (error) {
		for (const key of keys.values()) key.fill(0);
		keys.clear();
		throw error;
	}
}

function destroyKeyMap(keys: Map<string, Buffer>): void {
	for (const key of keys.values()) key.fill(0);
	keys.clear();
}

function assertPurposeSeparated(
	encryptionKeys: ReadonlyMap<string, Buffer>,
	hmacKeys: ReadonlyMap<string, Buffer>,
): void {
	for (const encryptionKey of encryptionKeys.values()) {
		if (
			[...hmacKeys.values()].some((hmacKey) => hmacKey.equals(encryptionKey))
		) {
			throw new Error("反馈加密密钥与 HMAC 密钥不得复用相同密钥材料");
		}
	}
}
