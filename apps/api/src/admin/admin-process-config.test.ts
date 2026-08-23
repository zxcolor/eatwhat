import { describe, expect, it } from "vitest";
import { loadAdminProcessConfig } from "./admin-process-config.js";

const KEY = Buffer.alloc(32, 0x61).toString("base64");

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		NODE_ENV: "test",
		ADMIN_API_ENABLED: "true",
		ADMIN_PORT: "3002",
		ADMIN_BIND_HOST: "127.0.0.1",
		ADMIN_DATABASE_URL:
			"postgresql://admin_api_runtime:admin-pass@admin-db.internal:5432/chi_shen_me",
		ADMIN_DATABASE_EXPECTED_TARGET: "admin-db.internal:5432/chi_shen_me",
		ADMIN_DATABASE_RUNTIME_ROLE_NAME: "admin_api_runtime",
		ADMIN_DATABASE_SSL_MODE: "verify-full",
		ADMIN_WEBAUTHN_RP_NAME: "吃什么管理后台",
		ADMIN_WEBAUTHN_RP_ID: "admin.example.cn",
		ADMIN_WEBAUTHN_ORIGINS: "https://admin.example.cn",
		ADMIN_HMAC_KEYS: `v1:${KEY}`,
		ADMIN_CREDENTIAL_ENCRYPTION_KEYS: `v1:${KEY}`,
		...overrides,
	};
}

describe("independent administrator process configuration", () => {
	it("refuses to start the administrator process while disabled", () => {
		expect(() =>
			loadAdminProcessConfig({
				NODE_ENV: "test",
				ADMIN_API_ENABLED: "false",
			}),
		).toThrow("拒绝在 ADMIN_API_ENABLED=false 时启动");
	});

	it("loads only an explicit private listener and bounded trusted BFF proxies", () => {
		const config = loadAdminProcessConfig(
			environment({
				ADMIN_PORT: "4312",
				ADMIN_BIND_HOST: "0.0.0.0",
				ADMIN_TRUSTED_PROXY_CIDRS: "10.24.0.8,2001:db8:10::/64",
			}),
		);
		expect(config).toMatchObject({
			nodeEnv: "test",
			port: 4_312,
			bindHost: "0.0.0.0",
			trustedProxyCidrs: ["10.24.0.8", "2001:db8:10::/64"],
		});
	});

	it("requires an explicit bind address and BFF proxy network in production", () => {
		expect(() =>
			loadAdminProcessConfig(
				environment({
					NODE_ENV: "production",
					ADMIN_BIND_HOST: undefined,
					ADMIN_TRUSTED_PROXY_CIDRS: "10.24.0.0/24",
				}),
			),
		).toThrow("显式配置 ADMIN_BIND_HOST");
		expect(() =>
			loadAdminProcessConfig(
				environment({
					NODE_ENV: "production",
					ADMIN_TRUSTED_PROXY_CIDRS: undefined,
				}),
			),
		).toThrow("仅包含同源 BFF");
	});

	it.each(["0.0.0.0/0", "::/0", "10.0.0.0/33", "*", "10.0.0.1,10.0.0.1"])(
		"rejects wildcard, invalid or duplicate proxy scope %s",
		(value) => {
			expect(() =>
				loadAdminProcessConfig(
					environment({ ADMIN_TRUSTED_PROXY_CIDRS: value }),
				),
			).toThrow("ADMIN_TRUSTED_PROXY_CIDRS");
		},
	);

	it("does not echo database credentials when startup validation fails", () => {
		const secret = "super-secret-admin-password";
		let message = "";
		try {
			loadAdminProcessConfig(
				environment({
					ADMIN_DATABASE_URL: `postgresql://admin_api_runtime:${secret}@wrong.internal:5432/chi_shen_me`,
				}),
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("目标数据库");
		expect(message).not.toContain(secret);
	});
});
