import { describe, expect, it } from "vitest";
import { loadAppConfig } from "./app-config.js";

const productionDatabase = Object.freeze({
	DATABASE_URL:
		"postgresql://api_runtime:runtime-pass@db.internal:5432/chi_shen_me",
	DATABASE_SSL_MODE: "verify-full",
	DATABASE_EXPECTED_TARGET: "db.internal:5432/chi_shen_me",
	DATABASE_RUNTIME_ROLE_NAME: "api_runtime",
	DATABASE_MIGRATION_ROLE_NAME: "schema_migrator",
	DATABASE_MAINTENANCE_ROLE_NAME: "retention_worker",
	DATABASE_EXPORT_WORKER_ROLE_NAME: "data_export_worker",
});

describe("application safety configuration", () => {
	it("rejects administrator enablement or secrets in the public API process", () => {
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				ADMIN_API_ENABLED: "true",
			}),
		).toThrow("独立 admin-main");
		for (const [name, value] of [
			[
				"ADMIN_DATABASE_URL",
				"postgresql://secret-user:secret-pass@secret-db:5432/secret",
			],
			["ADMIN_DATABASE_SSL_CA_BASE64", "secret-ca"],
			["ADMIN_HMAC_KEYS", "secret-hmac"],
			["ADMIN_CREDENTIAL_ENCRYPTION_KEYS", "secret-encryption"],
		] as const) {
			let message = "";
			try {
				loadAppConfig({ NODE_ENV: "test", [name]: value });
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain(name);
			expect(message).not.toContain(value);
		}
	});

	it("keeps every persistence feature disabled unless explicitly enabled", () => {
		const defaults = loadAppConfig({ NODE_ENV: "test" });
		expect(defaults.features.favoritesEnabled).toBe(false);
		expect(defaults.features.historyEnabled).toBe(false);
		expect(defaults.features.privateFeedbackEnabled).toBe(false);
		expect(defaults.features.minimumSupportedVersion).toBe("0.1.1");

		const configured = loadAppConfig({
			NODE_ENV: "test",
			HISTORY_ENABLED: "true",
			PRIVATE_FEEDBACK_ENABLED: "true",
		});
		expect(configured.features.historyEnabled).toBe(true);
		expect(configured.features.privateFeedbackEnabled).toBe(true);
	});

	it("keeps anonymous group recommendations disabled unless explicitly enabled", () => {
		expect(
			loadAppConfig({ NODE_ENV: "test" }).features.groupRecommendationsEnabled,
		).toBe(false);
		expect(
			loadAppConfig({
				NODE_ENV: "test",
				GROUP_RECOMMENDATIONS_ENABLED: "true",
			}).features.groupRecommendationsEnabled,
		).toBe(true);
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				GROUP_RECOMMENDATIONS_ENABLED: "yes",
			}),
		).toThrow("GROUP_RECOMMENDATIONS_ENABLED");
	});

	it("requires the startup minimum client version to match the public contract", () => {
		expect(
			loadAppConfig({
				NODE_ENV: "test",
				MINIMUM_SUPPORTED_VERSION: "2.4.0",
			}).features.minimumSupportedVersion,
		).toBe("2.4.0");
		for (const value of ["02.4.0", "2.4", "2.4.0-beta", "2.4.10000"]) {
			expect(() =>
				loadAppConfig({
					NODE_ENV: "test",
					MINIMUM_SUPPORTED_VERSION: value,
				}),
			).toThrow("MINIMUM_SUPPORTED_VERSION");
		}
	});

	it("accepts only prompt and Qwen model versions registered in this build", () => {
		const defaults = loadAppConfig({ NODE_ENV: "test" });
		expect(defaults.versions.prompt).toBe("intent-prompt-v1");
		expect(defaults.qwen.model).toBe("qwen3.7-flash-2026-07-15");
		expect(() =>
			loadAppConfig({ NODE_ENV: "test", PROMPT_VERSION: "unknown-prompt" }),
		).toThrow("PROMPT_VERSION");
		expect(() =>
			loadAppConfig({ NODE_ENV: "test", QWEN_MODEL: "unknown-model" }),
		).toThrow("QWEN_MODEL");
	});

	it("rejects a worker-ready claim while the data-export capability is disabled", () => {
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				DATA_EXPORT_WORKER_READY: "true",
			}),
		).toThrow("工作器就绪标记");
	});

	it("bounds account-export total and idle delivery timeouts", () => {
		expect(loadAppConfig({ NODE_ENV: "test" }).dataExportDownload).toEqual({
			totalTimeoutMs: 120_000,
			idleTimeoutMs: 15_000,
		});
		expect(
			loadAppConfig({
				NODE_ENV: "test",
				DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS: "300000",
				DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS: "60000",
			}).dataExportDownload,
		).toEqual({ totalTimeoutMs: 300_000, idleTimeoutMs: 60_000 });

		for (const [name, value] of [
			["DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS", "29999"],
			["DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS", "300001"],
			["DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS", "4999"],
			["DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS", "60001"],
		] as const) {
			expect(() => loadAppConfig({ NODE_ENV: "test", [name]: value })).toThrow(
				name,
			);
		}
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS: "30000",
				DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS: "30000",
			}),
		).toThrow("必须小于");
	});

	it("uses separate provider priorities with a safe registered default", () => {
		const defaults = loadAppConfig({ NODE_ENV: "test" });
		expect(defaults.recommendationProviderPriority).toEqual(["AMAP", "DEMO"]);
		expect(defaults.locationSearchProviderPriority).toEqual(["AMAP", "DEMO"]);
		expect(defaults.placeSearchProviderPriority).toEqual(["AMAP", "DEMO"]);

		const configured = loadAppConfig({
			NODE_ENV: "test",
			RECOMMENDATION_PROVIDER_PRIORITY: " DEMO , AMAP ",
			LOCATION_SEARCH_PROVIDER_PRIORITY: "AMAP",
			PLACE_SEARCH_PROVIDER_PRIORITY: "DEMO",
		});
		expect(configured.recommendationProviderPriority).toEqual(["DEMO", "AMAP"]);
		expect(configured.locationSearchProviderPriority).toEqual(["AMAP"]);
		expect(configured.placeSearchProviderPriority).toEqual(["DEMO"]);
	});

	it.each(["", "AMAP,", ",AMAP", "AMAP,,DEMO"])(
		"rejects empty recommendation provider priority entries in %j",
		(value) => {
			expect(() =>
				loadAppConfig({
					NODE_ENV: "test",
					RECOMMENDATION_PROVIDER_PRIORITY: value,
				}),
			).toThrow("RECOMMENDATION_PROVIDER_PRIORITY");
		},
	);

	it("rejects duplicate, invalid and unregistered provider priority entries", () => {
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				RECOMMENDATION_PROVIDER_PRIORITY: "AMAP,AMAP",
			}),
		).toThrow("重复供应商");
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				LOCATION_SEARCH_PROVIDER_PRIORITY: "amap",
			}),
		).toThrow("第 1 项不是合法供应商代码");
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				LOCATION_SEARCH_PROVIDER_PRIORITY: "VENDOR",
			}),
		).toThrow("第 1 项未在当前构建注册");
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				PLACE_SEARCH_PROVIDER_PRIORITY: "AMAP,AMAP",
			}),
		).toThrow("重复供应商");
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				PLACE_SEARCH_PROVIDER_PRIORITY: "AMAP,",
			}),
		).toThrow("PLACE_SEARCH_PROVIDER_PRIORITY");
	});

	it("does not echo a misplaced secret in provider configuration errors", () => {
		const misplacedSecret = "secret-lowercase-value";
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				RECOMMENDATION_PROVIDER_PRIORITY: misplacedSecret,
			}),
		).toThrowError(expect.not.stringContaining(misplacedSecret));
	});

	it("allows demo data by default only outside production", () => {
		expect(loadAppConfig({ NODE_ENV: "development" }).demoDataAllowed).toBe(
			true,
		);
		expect(
			loadAppConfig({
				NODE_ENV: "production",
				TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
				...productionDatabase,
			}).demoDataAllowed,
		).toBe(false);
	});

	it("rejects demo data in production even when explicitly requested", () => {
		expect(() =>
			loadAppConfig({
				NODE_ENV: "production",
				ALLOW_DEMO_DATA: "true",
				TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
				...productionDatabase,
			}),
		).toThrow("生产环境禁止");
	});

	it("fails closed when AMap is enabled without a server-side key", () => {
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
			}),
		).toThrow("AMAP_WEB_SERVICE_KEY");
	});

	it("does not retain a stray AMap key while the integration is disabled", () => {
		const config = loadAppConfig({
			NODE_ENV: "test",
			AMAP_ENABLED: "false",
			AMAP_WEB_SERVICE_KEY: "must-not-be-active",
			AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: "must-not-be-active-either",
			AMAP_IP_WHITELIST_CONFIGURED: "true",
		});
		expect(config.amap).toMatchObject({
			enabled: false,
			apiKey: null,
			signingPrivateKey: null,
			ipWhitelistConfigured: false,
		});
	});

	it("requires signature and an IP whitelist confirmation for production AMap", () => {
		const base = {
			NODE_ENV: "production",
			TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
			...productionDatabase,
			AMAP_ENABLED: "true",
			AMAP_WEB_SERVICE_KEY: "production-web-service-key",
		} as const;
		expect(() => loadAppConfig(base)).toThrow("AMAP_IP_WHITELIST_CONFIGURED");
		expect(() =>
			loadAppConfig({ ...base, AMAP_IP_WHITELIST_CONFIGURED: "true" }),
		).toThrow("AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY");

		const config = loadAppConfig({
			...base,
			AMAP_IP_WHITELIST_CONFIGURED: "true",
			AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: "production-private-key",
		});
		expect(config.amap).toMatchObject({
			enabled: true,
			apiKey: "production-web-service-key",
			signingPrivateKey: "production-private-key",
			ipWhitelistConfigured: true,
		});
	});

	it("rejects malformed AMap security configuration without echoing it", () => {
		const privateValue = `secret${String.fromCharCode(10)}value`;
		let message = "";
		try {
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_ENABLED: "true",
				AMAP_WEB_SERVICE_KEY: "test-key",
				AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY: privateValue,
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY");
		expect(message).not.toContain(privateValue);
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				AMAP_IP_WHITELIST_CONFIGURED: "yes",
			}),
		).toThrow("AMAP_IP_WHITELIST_CONFIGURED");
	});

	it("fails closed when licensed enrichment has no authorization record", () => {
		expect(() =>
			loadAppConfig({
				NODE_ENV: "production",
				TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
				...productionDatabase,
				DATA_RIGHTS_MODE: "LICENSED_ENRICHMENT",
			}),
		).toThrow("DATA_RIGHTS_AUTHORIZATION_ID");
	});

	it("accepts a non-expired licensed authorization reference", () => {
		const config = loadAppConfig({
			NODE_ENV: "production",
			TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
			...productionDatabase,
			DATA_RIGHTS_MODE: "LICENSED_ENRICHMENT",
			DATA_RIGHTS_AUTHORIZATION_ID: "11111111-1111-4111-8111-111111111111",
			DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT: "2099-12-31T15:59:59.000Z",
		});
		expect(config.dataRightsAuthorization?.reference).toBe(
			"11111111-1111-4111-8111-111111111111",
		);
	});

	it("rejects a non-UUID data-rights authorization reference", () => {
		expect(() =>
			loadAppConfig({
				NODE_ENV: "test",
				DATA_RIGHTS_MODE: "LICENSED_ENRICHMENT",
				DATA_RIGHTS_AUTHORIZATION_ID: "AMAP-CONTRACT-TEST-001",
				DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT: "2099-12-31T15:59:59.000Z",
			}),
		).toThrow("DATA_RIGHTS_AUTHORIZATION_ID 必须是规范 UUID");
	});

	it("does not trust forwarded addresses by default outside production", () => {
		expect(loadAppConfig({ NODE_ENV: "test" }).trustedProxyCidrs).toEqual([]);
	});

	it("accepts only explicit IPv4 and IPv6 proxy addresses or bounded CIDRs", () => {
		expect(
			loadAppConfig({
				NODE_ENV: "test",
				TRUSTED_PROXY_CIDRS: "10.20.0.0/16, 2001:db8::1, 127.0.0.1",
			}).trustedProxyCidrs,
		).toEqual(["10.20.0.0/16", "2001:db8::1", "127.0.0.1"]);
	});

	it.each(["*", "true", "10.0.0.0/0", "::/0", "10.0.0.0/33", "not-an-ip"])(
		"rejects wildcard or invalid trusted proxy value %s",
		(value) => {
			expect(() =>
				loadAppConfig({ NODE_ENV: "test", TRUSTED_PROXY_CIDRS: value }),
			).toThrow("TRUSTED_PROXY_CIDRS");
		},
	);

	it("fails closed when production has no explicit trusted proxy network", () => {
		expect(() => loadAppConfig({ NODE_ENV: "production" })).toThrow(
			"TRUSTED_PROXY_CIDRS",
		);
	});
});
