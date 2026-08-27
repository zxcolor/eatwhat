import { describe, expect, it } from "vitest";
import { loadAuthRuntimeConfig } from "./auth-config.js";

describe("account startup configuration", () => {
	it("keeps every provider secret absent while accounts are disabled", () => {
		const config = loadAuthRuntimeConfig(
			{},
			{
				accountsEnabled: false,
				databaseEnabled: false,
			},
		);
		expect(config.enabled).toBe(false);
		expect(config.registrationEnabled).toBe(false);
		expect(config.dataExportEnabled).toBe(false);
		expect(config.hashKeyRing).toBeNull();
		expect(config.otpPepperRing).toBeNull();
		expect(config.phone.signName).toBeNull();
		expect(config.wechat.appSecret).toBeNull();
	});

	it("fails startup when accounts have no database", () => {
		expect(() =>
			loadAuthRuntimeConfig(
				{},
				{
					accountsEnabled: true,
					databaseEnabled: false,
				},
			),
		).toThrow("账号服务启用时必须启用 PostgreSQL");
	});

	it("fails startup when accounts have no mobile channel", () => {
		expect(() =>
			loadAuthRuntimeConfig(
				{},
				{
					accountsEnabled: true,
					databaseEnabled: true,
				},
			),
		).toThrow("账号服务启用前必须至少就绪一个手机通道");
	});

	it("allows fusion login-only without WeChat registration credentials", () => {
		const hashKey = Buffer.alloc(32, 7).toString("base64");
		const config = loadAuthRuntimeConfig(
			{
				FUSION_AUTH_ENABLED: "true",
				AUTH_HASH_ACTIVE_VERSION: "v1",
				AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
				AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
				ALIYUN_FUSION_SCHEME_CODE: "scheme_100001",
				ALIYUN_FUSION_PACKAGE_NAME: "com.chishenme.app",
				ALIYUN_FUSION_PACKAGE_SIGN: "A".repeat(32),
			},
			{ accountsEnabled: true, databaseEnabled: true },
		);

		expect(config.enabled).toBe(true);
		expect(config.registrationEnabled).toBe(false);
		expect(config.phone.enabled).toBe(false);
		expect(config.fusion.enabled).toBe(true);
		expect(config.wechat).toMatchObject({
			enabled: false,
			appId: null,
			appSecret: null,
		});
	});

	it("allows fusion plus WeChat registration without SMS and pins every Android field", () => {
		const hashKey = Buffer.alloc(32, 7).toString("base64");
		const base = {
			FUSION_AUTH_ENABLED: "true",
			WECHAT_AUTH_ENABLED: "true",
			AUTH_HASH_ACTIVE_VERSION: "v1",
			AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
			AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
			WECHAT_APP_ID: "wx0123456789abcdef",
			WECHAT_APP_SECRET: "wechat-secret",
		};
		const options = { accountsEnabled: true, databaseEnabled: true } as const;

		expect(() => loadAuthRuntimeConfig(base, options)).toThrow(
			"ALIYUN_FUSION_SCHEME_CODE",
		);
		expect(() =>
			loadAuthRuntimeConfig(
				{ ...base, ALIYUN_FUSION_SCHEME_CODE: "100001" },
				options,
			),
		).toThrow("ALIYUN_FUSION_PACKAGE_NAME");
		expect(() =>
			loadAuthRuntimeConfig(
				{
					...base,
					ALIYUN_FUSION_SCHEME_CODE: "100001",
					ALIYUN_FUSION_PACKAGE_NAME: "com.chishenme.app",
				},
				options,
			),
		).toThrow("ALIYUN_FUSION_PACKAGE_SIGN");
		const config = loadAuthRuntimeConfig(
			{
				...base,
				ALIYUN_FUSION_SCHEME_CODE: "scheme_100001",
				ALIYUN_FUSION_PACKAGE_NAME: "com.chishenme.app",
				ALIYUN_FUSION_PACKAGE_SIGN: "A".repeat(32),
			},
			options,
		);
		expect(config.phone.enabled).toBe(false);
		expect(config.registrationEnabled).toBe(true);
		expect(config.otpPepperRing).toBeNull();
		expect(config.fusion).toMatchObject({
			enabled: true,
			schemeCode: "scheme_100001",
			packageName: "com.chishenme.app",
			packageSign: "a".repeat(32),
		});
	});

	it("fails startup on missing provider configuration without echoing secret values", () => {
		const marker = "must-never-be-echoed";
		const hashKey = Buffer.alloc(32, 7).toString("base64");
		const otpPepper = Buffer.alloc(32, 8).toString("base64");
		let failure: unknown;
		try {
			loadAuthRuntimeConfig(
				{
					PHONE_AUTH_ENABLED: "true",
					WECHAT_AUTH_ENABLED: "true",
					AUTH_HASH_ACTIVE_VERSION: "v1",
					AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
					AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
					AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
					AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
					ALIYUN_SMS_SIGN_NAME: "吃什么",
					WECHAT_APP_SECRET: marker,
				},
				{ accountsEnabled: true, databaseEnabled: true },
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("ALIYUN_SMS_TEMPLATE_CODE");
		expect((failure as Error).message).not.toContain(marker);
	});

	it("enforces official SMS and secure SMTP field limits", () => {
		const hashKey = Buffer.alloc(32, 7).toString("base64");
		const otpPepper = Buffer.alloc(32, 8).toString("base64");
		const base = {
			PHONE_AUTH_ENABLED: "true",
			EMAIL_AUTH_ENABLED: "true",
			WECHAT_AUTH_ENABLED: "true",
			AUTH_HASH_ACTIVE_VERSION: "v1",
			AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
			AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
			AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
			AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
			ALIYUN_SMS_SIGN_NAME: "吃什么",
			ALIYUN_SMS_TEMPLATE_CODE: "SMS_123456",
			SMTP_HOST: "smtp.example.com",
			SMTP_PORT: "465",
			SMTP_SECURE: "true",
			SMTP_USERNAME: "no-reply@example.com",
			SMTP_PASSWORD: "smtp-app-password",
			SMTP_FROM_ADDRESS: "no-reply@example.com",
			SMTP_FROM_NAME: "吃什么",
			WECHAT_APP_ID: "wx0123456789abcdef",
			WECHAT_APP_SECRET: "wechat-secret",
		};

		expect(() =>
			loadAuthRuntimeConfig(
				{ ...base, ALIYUN_SMS_SIGN_NAME: "一二三四五六七八九十一二三" },
				{ accountsEnabled: true, databaseEnabled: true },
			),
		).toThrow("ALIYUN_SMS_SIGN_NAME 必须是 2 到 12 个字符");
		expect(() =>
			loadAuthRuntimeConfig(
				{ ...base, ALIYUN_SMS_TEMPLATE_CODE: "template-123" },
				{ accountsEnabled: true, databaseEnabled: true },
			),
		).toThrow("ALIYUN_SMS_TEMPLATE_CODE 必须是有效的短信模板 Code");
		expect(() =>
			loadAuthRuntimeConfig(
				{ ...base, SMTP_FROM_NAME: "一".repeat(65) },
				{ accountsEnabled: true, databaseEnabled: true },
			),
		).toThrow("SMTP_FROM_NAME 必须是 1 到 64 个单行字符");
		expect(() =>
			loadAuthRuntimeConfig(
				{ ...base, SMTP_PORT: "587", SMTP_SECURE: "true" },
				{ accountsEnabled: true, databaseEnabled: true },
			),
		).toThrow("SMTP_PORT=465 时 SMTP_SECURE 必须为 true");
		expect(() =>
			loadAuthRuntimeConfig(
				{ ...base, ALIYUN_SMS_TIMEOUT_MS: "999" },
				{ accountsEnabled: true, databaseEnabled: true },
			),
		).toThrow("ALIYUN_SMS_TIMEOUT_MS 必须是 1000 到 5000 的整数");
	});

	it("fails closed on malformed WeChat and QQ application identifiers", () => {
		const hashKey = Buffer.alloc(32, 7).toString("base64");
		const otpPepper = Buffer.alloc(32, 8).toString("base64");
		const base = {
			PHONE_AUTH_ENABLED: "true",
			WECHAT_AUTH_ENABLED: "true",
			AUTH_HASH_ACTIVE_VERSION: "v1",
			AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
			AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
			AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
			AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
			ALIYUN_SMS_SIGN_NAME: "吃什么",
			ALIYUN_SMS_TEMPLATE_CODE: "SMS_123456",
			WECHAT_APP_SECRET: "wechat-secret",
		};
		const options = { accountsEnabled: true, databaseEnabled: true } as const;

		expect(() =>
			loadAuthRuntimeConfig({ ...base, WECHAT_APP_ID: "wechat-app" }, options),
		).toThrow("WECHAT_APP_ID 必须符合 wx + 16 位十六进制字符格式");
		expect(() =>
			loadAuthRuntimeConfig(
				{
					...base,
					WECHAT_APP_ID: "wx0123456789abcdef",
					QQ_AUTH_ENABLED: "true",
					QQ_APP_ID: "01234",
				},
				options,
			),
		).toThrow("QQ_APP_ID 必须为 5 至 16 位、不以 0 开头的纯数字 AppID");
	});

	it("rejects reused key material across the authentication and OTP rings", () => {
		const reused = Buffer.alloc(32, 7).toString("base64");
		expect(() =>
			loadAuthRuntimeConfig(
				{
					PHONE_AUTH_ENABLED: "true",
					WECHAT_AUTH_ENABLED: "true",
					AUTH_HASH_ACTIVE_VERSION: "hash-v1",
					AUTH_HASH_KEYS_JSON: JSON.stringify({ "hash-v1": reused }),
					AUTH_OTP_PEPPER_ACTIVE_VERSION: "otp-v1",
					AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ "otp-v1": reused }),
					AUTH_IDENTITY_DEDUP_KEY_VERSION: "hash-v1",
					ALIYUN_SMS_SIGN_NAME: "吃什么",
					ALIYUN_SMS_TEMPLATE_CODE: "SMS_123456",
					WECHAT_APP_ID: "wx0123456789abcdef",
					WECHAT_APP_SECRET: "wechat-secret",
				},
				{ accountsEnabled: true, databaseEnabled: true },
			),
		).toThrow(
			"AUTH_HASH_KEYS_JSON 与 AUTH_OTP_PEPPER_KEYS_JSON 禁止复用密钥材料",
		);
	});

	it("requires an explicitly pinned ephemeral Aliyun credential provider in production", () => {
		const hashKey = Buffer.alloc(32, 7).toString("base64");
		const otpPepper = Buffer.alloc(32, 8).toString("base64");
		const base = {
			PHONE_AUTH_ENABLED: "true",
			WECHAT_AUTH_ENABLED: "true",
			AUTH_HASH_ACTIVE_VERSION: "v1",
			AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
			AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
			AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
			AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
			ALIYUN_SMS_SIGN_NAME: "吃什么",
			ALIYUN_SMS_TEMPLATE_CODE: "SMS_123456",
			WECHAT_APP_ID: "wx0123456789abcdef",
			WECHAT_APP_SECRET: "wechat-secret",
		};
		const production = {
			accountsEnabled: true,
			databaseEnabled: true,
			production: true,
		} as const;

		expect(() => loadAuthRuntimeConfig(base, production)).toThrow(
			"生产阿里云账号通道必须用 ALIYUN_CREDENTIAL_ALLOWED_PROVIDER 钉死凭据来源",
		);
		expect(() =>
			loadAuthRuntimeConfig(
				{ ...base, ALIYUN_CREDENTIAL_ALLOWED_PROVIDER: "default/env" },
				production,
			),
		).toThrow("生产阿里云账号通道禁止使用长期环境变量 AccessKey");
		expect(
			loadAuthRuntimeConfig(
				{
					...base,
					ALIYUN_CREDENTIAL_ALLOWED_PROVIDER: "default/ecs_ram_role",
				},
				production,
			).aliyunCredentialAllowedProvider,
		).toBe("default/ecs_ram_role");
	});
});
