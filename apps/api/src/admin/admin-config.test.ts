import { describe, expect, it } from "vitest";
import { loadAdminRuntimeConfig } from "./admin-config.js";

const KEY_A = Buffer.alloc(32, 0x11).toString("base64");
const KEY_B = Buffer.alloc(32, 0x22).toString("base64");

function enabledEnvironment(
	overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	return {
		ADMIN_API_ENABLED: "true",
		ADMIN_DATABASE_URL:
			"postgresql://admin_api_runtime:admin-pass@admin-db.internal:5432/chi_shen_me",
		ADMIN_DATABASE_EXPECTED_TARGET: "admin-db.internal:5432/chi_shen_me",
		ADMIN_DATABASE_RUNTIME_ROLE_NAME: "admin_api_runtime",
		ADMIN_DATABASE_SSL_MODE: "verify-full",
		ADMIN_WEBAUTHN_RP_NAME: "吃什么管理后台",
		ADMIN_WEBAUTHN_RP_ID: "admin.example.cn",
		ADMIN_WEBAUTHN_ORIGINS: "https://admin.example.cn",
		ADMIN_HMAC_KEYS: `v2:${KEY_B},v1:${KEY_A}`,
		ADMIN_CREDENTIAL_ENCRYPTION_KEYS: `v2:${KEY_A}`,
		...overrides,
	};
}

describe("administrator runtime configuration", () => {
	it("is disabled by default without parsing stray administrator secrets", () => {
		const config = loadAdminRuntimeConfig(
			{
				ADMIN_DATABASE_URL: "this is deliberately invalid",
				ADMIN_HMAC_KEYS: "not-a-key",
			},
			"test",
		);
		expect(config.enabled).toBe(false);
		expect(config.database.connectionString).toBeNull();
		expect(config.hmacKeys).toEqual([]);
		expect(config.credentialEncryptionKeys).toEqual([]);
	});

	it("accepts only the isolated role, exact target, verify-full TLS and bounded key rings", () => {
		const config = loadAdminRuntimeConfig(enabledEnvironment(), "production");
		expect(config.enabled).toBe(true);
		expect(config.database.ssl).toMatchObject({ rejectUnauthorized: true });
		expect(config.database.poolMaximum).toBe(4);
		expect(config.webauthn).toMatchObject({
			rpId: "admin.example.cn",
			expectedOrigins: ["https://admin.example.cn"],
		});
		expect(config.hmacKeys.map(({ version }) => version)).toEqual(["v2", "v1"]);
		expect(config.hmacKeys.every(({ key }) => key.length === 32)).toBe(true);
	});

	it.each([
		[
			"ordinary database URL reuse",
			{
				DATABASE_URL:
					"postgresql://admin_api_runtime:admin-pass@admin-db.internal:5432/chi_shen_me",
			},
			"禁止复用 DATABASE_URL",
		],
		[
			"ordinary runtime role reuse",
			{ DATABASE_RUNTIME_ROLE_NAME: "admin_api_runtime" },
			"不得与普通 API 角色重用",
		],
		[
			"wrong administrator role",
			{ ADMIN_DATABASE_RUNTIME_ROLE_NAME: "api_runtime" },
			"admin_api_runtime",
		],
		[
			"wrong target",
			{ ADMIN_DATABASE_EXPECTED_TARGET: "other.internal:5432/chi_shen_me" },
			"未指向声明的目标数据库",
		],
		["TLS downgrade", { ADMIN_DATABASE_SSL_MODE: "require" }, "verify-full"],
	] as const)("rejects %s", (_label, overrides, expected) => {
		expect(() =>
			loadAdminRuntimeConfig(enabledEnvironment(overrides), "production"),
		).toThrow(expected);
	});

	it("rejects non-HTTPS, non-exact and production-local WebAuthn origins", () => {
		expect(() =>
			loadAdminRuntimeConfig(
				enabledEnvironment({
					ADMIN_WEBAUTHN_ORIGINS: "http://admin.example.cn",
				}),
				"production",
			),
		).toThrow("精确 HTTPS Origin");
		expect(() =>
			loadAdminRuntimeConfig(
				enabledEnvironment({
					ADMIN_WEBAUTHN_RP_ID: "localhost",
					ADMIN_WEBAUTHN_ORIGINS: "https://localhost",
				}),
				"production",
			),
		).toThrow("禁止 localhost");
	});

	it("rejects malformed and duplicate key versions without echoing secret material", () => {
		const secret = "definitely-not-a-valid-key-secret";
		let message = "";
		try {
			loadAdminRuntimeConfig(
				enabledEnvironment({ ADMIN_HMAC_KEYS: `v1:${secret}` }),
				"test",
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("ADMIN_HMAC_KEYS");
		expect(message).not.toContain(secret);
		expect(() =>
			loadAdminRuntimeConfig(
				enabledEnvironment({
					ADMIN_HMAC_KEYS: `v1:${KEY_A},v1:${KEY_B}`,
				}),
				"test",
			),
		).toThrow("重复版本号");
	});
});
