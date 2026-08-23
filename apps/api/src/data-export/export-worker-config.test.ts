import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SupportFeedbackKeyRing } from "../support-feedback/support-feedback-crypto.js";
import { ExportLocatorKeyRing } from "./export-artifact-crypto.js";
import {
	assertDataExportWorkerKeyCoverage,
	loadDataExportWorkerRuntimeConfig,
} from "./export-worker-config.js";

function environment(): NodeJS.ProcessEnv {
	return {
		NODE_ENV: "test",
		DATA_EXPORT_ENABLED: "true",
		DATA_EXPORT_OSS_REGION: "oss-cn-beijing",
		DATA_EXPORT_OSS_BUCKET: "chi-shen-me-private-exports",
		DATA_EXPORT_OSS_INTERNAL: "true",
		ALIBABA_CLOUD_ECS_METADATA: "chi-shen-me-data-export-worker",
		ALIBABA_CLOUD_IMDSV1_DISABLED: "true",
		ALIBABA_CLOUD_ECS_IMDSV2_ENABLE: "true",
		DATA_EXPORT_LOCATOR_ACTIVE_VERSION: "locator-v1",
		DATA_EXPORT_LOCATOR_KEYS_JSON: JSON.stringify({
			"locator-v1": randomBytes(32).toString("base64"),
		}),
		DATABASE_EXPORT_WORKER_URL:
			"postgresql://data_export_worker:secret@localhost:5432/chi_shen_me",
		DATABASE_EXPORT_WORKER_SSL_MODE: "disable",
	};
}

describe("loadDataExportWorkerRuntimeConfig", () => {
	it("loads an isolated bounded worker configuration", () => {
		const config = loadDataExportWorkerRuntimeConfig(environment());
		try {
			expect(config.database.connectionString).toContain("data_export_worker");
			expect(config.leaseSeconds).toBe(180);
			expect(config.pollIntervalMs).toBe(1_000);
			expect(config.artifacts.maximumArtifactBytes).toBe(10 * 1024 * 1024);
		} finally {
			config.artifacts.locatorKeyRing.destroy();
		}
	});

	it("fails closed when disabled or when the lease is too short", () => {
		expect(() =>
			loadDataExportWorkerRuntimeConfig({
				...environment(),
				DATA_EXPORT_ENABLED: "false",
			}),
		).toThrow("未启用");
		expect(() =>
			loadDataExportWorkerRuntimeConfig({
				...environment(),
				DATA_EXPORT_OSS_TIMEOUT_MS: "30000",
				DATA_EXPORT_WORKER_LEASE_SECONDS: "120",
			}),
		).toThrow("显著长于");
	});

	it.each([
		["API数据库", "DATABASE_URL"],
		["认证HMAC", "AUTH_HASH_KEYS_JSON"],
		["管理后台", "ADMIN_HMAC_KEYS"],
		["反馈HMAC", "SUPPORT_FEEDBACK_HMAC_KEYS_JSON"],
		["高德", "AMAP_WEB_SERVICE_KEY"],
		["千问", "QWEN_API_KEY"],
		["微信", "WECHAT_APP_SECRET"],
		["静态云凭据", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
		["静态云身份", "ALIBABA_CLOUD_ACCESS_KEY_ID"],
		["本地凭据profile", "ALIBABA_CLOUD_PROFILE"],
		["本地凭据文件", "ALIBABA_CLOUD_CREDENTIALS_FILE"],
		["凭据URI", "ALIBABA_CLOUD_CREDENTIALS_URI"],
		["Sentry", "SENTRY_DSN"],
		["支付", "STRIPE_KEY"],
		["普通敏感命名", "MY_SENSITIVE_MATERIAL"],
		["Kubernetes service link", "KUBERNETES_SERVICE_HOST"],
		["普通未知变量", "FEATURE_FLAG"],
		["Node启动参数", "NODE_OPTIONS"],
		["代理", "HTTPS_PROXY"],
		["API下载绝对期限", "DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS"],
		["API下载空闲期限", "DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS"],
	])("rejects non-empty %s material (%s)", (_category, name) => {
		expect(() =>
			loadDataExportWorkerRuntimeConfig({
				...environment(),
				[name]: "must-not-enter-worker",
			}),
		).toThrow("禁止注入");
	});

	it("accepts the explicitly enumerated Linux and Windows runtime variables", () => {
		const config = loadDataExportWorkerRuntimeConfig({
			...environment(),
			PATH: "/usr/local/bin:/usr/bin:/bin",
			HOME: "/home/node",
			HOSTNAME: "export-worker-1",
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			LC_CTYPE: "C.UTF-8",
			NODE_VERSION: "24.7.0",
			PNPM_HOME: "/pnpm",
			YARN_VERSION: "1.22.22",
			Path: "C:\\Windows\\System32",
			SystemRoot: "C:\\Windows",
			TEMP: "C:\\Temp",
			TMP: "C:\\Temp",
			USERPROFILE: "C:\\Users\\worker",
		});
		config.artifacts.locatorKeyRing.destroy();
	});

	it("ignores empty forbidden variables but accepts only worker key material", () => {
		const config = loadDataExportWorkerRuntimeConfig({
			...environment(),
			AUTH_HASH_KEYS_JSON: "",
			SUPPORT_FEEDBACK_HMAC_KEYS_JSON: "",
			SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION: "support-v1",
			SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON: JSON.stringify({
				"support-v1": randomBytes(32).toString("base64"),
			}),
		});
		config.artifacts.locatorKeyRing.destroy();
	});

	it("fails startup when retained locator or support ciphertext needs an old key", () => {
		const locatorV1 = randomBytes(32);
		const supportV1 = randomBytes(32);
		const locatorRing = new ExportLocatorKeyRing(
			"locator-v1",
			new Map([["locator-v1", locatorV1]]),
		);
		const supportRing = new SupportFeedbackKeyRing(
			"support-v1",
			new Map([["support-v1", supportV1]]),
		);
		try {
			expect(() =>
				assertDataExportWorkerKeyCoverage(
					locatorRing,
					supportRing,
					["locator-v1"],
					["support-v1"],
				),
			).not.toThrow();
			expect(() =>
				assertDataExportWorkerKeyCoverage(
					locatorRing,
					supportRing,
					["locator-v0"],
					["support-v1"],
				),
			).toThrow("密钥覆盖检查失败");
			expect(() =>
				assertDataExportWorkerKeyCoverage(
					locatorRing,
					supportRing,
					["locator-v1"],
					["support-v0"],
				),
			).toThrow("密钥覆盖检查失败");
		} finally {
			locatorRing.destroy();
			supportRing.destroy();
			locatorV1.fill(0);
			supportV1.fill(0);
		}
	});
});
