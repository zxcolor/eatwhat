import { describe, expect, it } from "vitest";
import { AdminCrypto } from "./admin-crypto.js";
import { loadAdminProcessConfig } from "./admin-process-config.js";

const HMAC_CURRENT = Buffer.alloc(32, 0x31).toString("base64");
const HMAC_PREVIOUS = Buffer.alloc(32, 0x32).toString("base64");
const ENCRYPTION_CURRENT = Buffer.alloc(32, 0x41).toString("base64");
const ENCRYPTION_PREVIOUS = Buffer.alloc(32, 0x42).toString("base64");

function enabledConfig() {
	return loadAdminProcessConfig({
		NODE_ENV: "test",
		ADMIN_API_ENABLED: "true",
		ADMIN_DATABASE_URL:
			"postgresql://admin_api_runtime:admin-pass@admin-db.internal:5432/chi_shen_me",
		ADMIN_DATABASE_EXPECTED_TARGET: "admin-db.internal:5432/chi_shen_me",
		ADMIN_DATABASE_RUNTIME_ROLE_NAME: "admin_api_runtime",
		ADMIN_DATABASE_SSL_MODE: "verify-full",
		ADMIN_WEBAUTHN_RP_NAME: "吃什么管理后台",
		ADMIN_WEBAUTHN_RP_ID: "admin.example.cn",
		ADMIN_WEBAUTHN_ORIGINS: "https://admin.example.cn",
		ADMIN_HMAC_KEYS: `h2:${HMAC_CURRENT},h1:${HMAC_PREVIOUS}`,
		ADMIN_CREDENTIAL_ENCRYPTION_KEYS: `e2:${ENCRYPTION_CURRENT},e1:${ENCRYPTION_PREVIOUS}`,
		ADMIN_BIND_HOST: "127.0.0.1",
	});
}

interface CryptoInspection {
	readonly hmacKeys: readonly { readonly key: Buffer }[];
	readonly credentialEncryptionKeys: readonly { readonly key: Buffer }[];
}

describe("administrator cryptographic boundary", () => {
	it("copies and clears configuration key buffers while domain-separating HMACs", () => {
		const config = enabledConfig();
		const transported = [
			...config.admin.hmacKeys.map(({ key }) => key),
			...config.admin.credentialEncryptionKeys.map(({ key }) => key),
		];
		const crypto = new AdminCrypto(config);
		expect(transported.every((key) => key.every((byte) => byte === 0))).toBe(
			true,
		);

		const login = crypto.currentHash("LOGIN_LOOKUP", "administrator");
		const device = crypto.currentHash("DEVICE", "administrator");
		expect(login.keyVersion).toBe("h2");
		expect(login.value).toMatch(/^[0-9a-f]{64}$/u);
		expect(login.value).not.toBe(device.value);
		expect(
			crypto.verifyHash("LOGIN_LOOKUP", "administrator", login.value, "h2"),
		).toBe(true);
		expect(
			crypto.verifyHash("DEVICE", "administrator", login.value, "h2"),
		).toBe(false);
		expect(crypto.hashCandidates("LOGIN_LOOKUP", "administrator")).toHaveLength(
			2,
		);
	});

	it("round-trips only authenticated credential IDs and never packs plaintext", () => {
		const crypto = new AdminCrypto(enabledConfig());
		const credentialId = Buffer.alloc(64, 0x7a).toString("base64url");
		const encrypted = crypto.encryptCredentialId(credentialId);
		expect(encrypted.keyVersion).toBe("e2");
		expect(encrypted.ciphertext.toString("utf8")).not.toContain(credentialId);
		expect(
			crypto.decryptCredentialId(encrypted.ciphertext, encrypted.keyVersion),
		).toBe(credentialId);

		const corrupted = Buffer.from(encrypted.ciphertext);
		corrupted[corrupted.length - 1] ^= 0xff;
		expect(() =>
			crypto.decryptCredentialId(corrupted, encrypted.keyVersion),
		).toThrow("管理员凭据解密失败");
		expect(() =>
			crypto.decryptCredentialId(encrypted.ciphertext, "missing"),
		).toThrow("管理员凭据解密失败");
	});

	it("zeros every owned key and fails closed after application shutdown", () => {
		const crypto = new AdminCrypto(enabledConfig());
		const inspection = crypto as unknown as CryptoInspection;
		expect(
			[...inspection.hmacKeys, ...inspection.credentialEncryptionKeys].some(
				({ key }) => key.some((byte) => byte !== 0),
			),
		).toBe(true);

		crypto.onApplicationShutdown();
		expect(
			[...inspection.hmacKeys, ...inspection.credentialEncryptionKeys].every(
				({ key }) => key.every((byte) => byte === 0),
			),
		).toBe(true);
		expect(() => crypto.issueOpaqueToken()).toThrow("管理员加密服务不可用");
		expect(() => crypto.currentHash("DEVICE", "device")).toThrow(
			"管理员加密服务不可用",
		);
		expect(() => crypto.encryptCredentialId("Y3JlZGVudGlhbA")).toThrow(
			"管理员加密服务不可用",
		);
	});
});
