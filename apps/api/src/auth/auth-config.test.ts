import { describe, expect, it } from "vitest";
import { loadAuthRuntimeConfig } from "./auth-config.js";

const options = { accountsEnabled: true, databaseEnabled: true } as const;
const hashKey = Buffer.alloc(32, 7).toString("base64");
const otpPepper = Buffer.alloc(32, 8).toString("base64");

function phoneEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		PHONE_AUTH_ENABLED: "true",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_PNVS_SIGN_NAME: "吃什么",
		ALIYUN_PNVS_TEMPLATE_CODE: "100001",
		...overrides,
	};
}

function emailEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return phoneEnv({
		EMAIL_AUTH_ENABLED: "true",
		AUTH_OTP_PEPPER_ACTIVE_VERSION: "otp-v1",
		AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ "otp-v1": otpPepper }),
		SMTP_HOST: "smtp.qiye.aliyun.com",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USERNAME: "no-reply@example.com",
		SMTP_PASSWORD: "smtp-app-password",
		SMTP_FROM_ADDRESS: "no-reply@example.com",
		SMTP_REPLY_TO: "support@example.com",
		SMTP_FROM_NAME: "吃什么",
		...overrides,
	});
}

describe("account startup configuration", () => {
	it("keeps provider secrets absent while accounts are disabled", () => {
		const config = loadAuthRuntimeConfig(
			{},
			{ accountsEnabled: false, databaseEnabled: false },
		);
		expect(config).toMatchObject({
			enabled: false,
			registrationEnabled: false,
			dataExportEnabled: false,
		});
		expect(config.hashKeyRing).toBeNull();
		expect(config.otpPepperRing).toBeNull();
		expect(config.phone.signName).toBeNull();
		expect(config.email.replyToAddress).toBeNull();
		expect(config.wechat.appSecret).toBeNull();
		expect(config.wechat.openPlatformRealmId).toBeNull();
		expect(config.qq.appKey).toBeNull();
		expect(config.qq.openPlatformRealmId).toBeNull();
	});

	it("requires PostgreSQL and a phone channel for account service", () => {
		expect(() =>
			loadAuthRuntimeConfig(
				{},
				{ accountsEnabled: true, databaseEnabled: false },
			),
		).toThrow("账号服务启用时必须启用 PostgreSQL");
		expect(() => loadAuthRuntimeConfig({}, options)).toThrow(
			"账号服务启用前必须至少就绪一个手机通道",
		);
	});

	it("uses PHONE_ONLY registration and does not need a local OTP pepper", () => {
		const config = loadAuthRuntimeConfig(phoneEnv(), options);
		expect(config.enabled).toBe(true);
		expect(config.registrationEnabled).toBe(true);
		expect(config.phone).toMatchObject({
			enabled: true,
			signName: "吃什么",
			templateCode: "100001",
			timeoutMs: 1_500,
		});
		expect(config.otpPepperRing).toBeNull();
		expect(config).not.toHaveProperty("fusion");
	});

	it("keeps QQ fail-closed when rollback temporarily retains staged QQ credentials", () => {
		const config = loadAuthRuntimeConfig(
			phoneEnv({
				QQ_AUTH_ENABLED: "false",
				QQ_UNION_ID_ENABLED: "false",
				QQ_APP_ID: "1905202162",
				QQ_APP_KEY: "a".repeat(32),
				QQ_OPEN_PLATFORM_REALM_ID: "eatwhat-qq-primary",
			}),
			options,
		);

		expect(config.qq).toEqual({
			enabled: false,
			unionIdEnabled: false,
			appId: null,
			appKey: null,
			openPlatformRealmId: null,
			timeoutMs: 2_000,
		});
	});

	it("requires PNVS fields without echoing unrelated secret values", () => {
		const marker = "must-never-be-echoed";
		let failure: unknown;
		try {
			loadAuthRuntimeConfig(
				phoneEnv({
					ALIYUN_PNVS_TEMPLATE_CODE: undefined,
					WECHAT_AUTH_ENABLED: "true",
					WECHAT_APP_SECRET: marker,
				}),
				options,
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("ALIYUN_PNVS_TEMPLATE_CODE");
		expect((failure as Error).message).not.toContain(marker);
	});

	it("requires email pepper, SMTP sender and reply-to when email is enabled", () => {
		const config = loadAuthRuntimeConfig(emailEnv(), options);
		expect(config.email.replyToAddress).toBe("support@example.com");
		expect(config.otpPepperRing?.activeVersion).toBe("otp-v1");
		expect(() =>
			loadAuthRuntimeConfig(emailEnv({ SMTP_REPLY_TO: undefined }), options),
		).toThrow("SMTP_REPLY_TO");
		expect(() =>
			loadAuthRuntimeConfig(
				emailEnv({ SMTP_REPLY_TO: "not-an-email" }),
				options,
			),
		).toThrow("SMTP_REPLY_TO 必须是单个有效邮箱地址");
	});

	it("enforces PNVS and secure SMTP field limits", () => {
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({ AUTH_OTP_RESEND_SECONDS: "59" }),
				options,
			),
		).toThrow("AUTH_OTP_RESEND_SECONDS 必须是 60 到 300 的整数");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({ ALIYUN_PNVS_SIGN_NAME: "一".repeat(13) }),
				options,
			),
		).toThrow("ALIYUN_PNVS_SIGN_NAME 必须是 2 到 12 个字符");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({ ALIYUN_PNVS_TEMPLATE_CODE: "template value" }),
				options,
			),
		).toThrow("ALIYUN_PNVS_TEMPLATE_CODE 必须是有效的短信认证模板 Code");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({ ALIYUN_PNVS_TIMEOUT_MS: "999" }),
				options,
			),
		).toThrow("ALIYUN_PNVS_TIMEOUT_MS 必须是 1000 到 5000 的整数");
		expect(() =>
			loadAuthRuntimeConfig(
				emailEnv({ SMTP_PORT: "587", SMTP_SECURE: "true" }),
				options,
			),
		).toThrow("SMTP_PORT=465 时 SMTP_SECURE 必须为 true");
	});

	it("fails closed on malformed WeChat, QQ and UnionID configuration", () => {
		expect(() =>
			loadAuthRuntimeConfig(phoneEnv({ QQ_UNION_ID_ENABLED: "true" }), options),
		).toThrow("QQ_UNION_ID_ENABLED=true 时必须同时启用 QQ_AUTH_ENABLED");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({
					WECHAT_AUTH_ENABLED: "true",
					WECHAT_APP_ID: "wechat-app",
					WECHAT_APP_SECRET: "wechat-secret",
				}),
				options,
			),
		).toThrow("WECHAT_APP_ID 必须符合 wx + 16 位十六进制字符格式");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({
					WECHAT_AUTH_ENABLED: "true",
					WECHAT_APP_ID: "wx0123456789abcdef",
					WECHAT_APP_SECRET: "wechat-secret",
					WECHAT_OPEN_PLATFORM_REALM_ID: "EatWhat Primary",
				}),
				options,
			),
		).toThrow("WECHAT_OPEN_PLATFORM_REALM_ID");
		expect(
			loadAuthRuntimeConfig(
				phoneEnv({
					WECHAT_AUTH_ENABLED: "true",
					WECHAT_APP_ID: "wx0123456789abcdef",
					WECHAT_APP_SECRET: "wechat-secret",
					WECHAT_OPEN_PLATFORM_REALM_ID: "eatwhat-primary",
				}),
				options,
			).wechat.openPlatformRealmId,
		).toBe("eatwhat-primary");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({
					QQ_AUTH_ENABLED: "true",
					QQ_APP_ID: "01234",
				}),
				options,
			),
		).toThrow("QQ_APP_ID 必须为 5 至 16 位、不以 0 开头的纯数字 AppID");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({
					QQ_AUTH_ENABLED: "true",
					QQ_APP_ID: "1905202162",
				}),
				options,
			),
		).toThrow("QQ_APP_KEY");
		const appKeyMarker = `must-not-appear-${"a".repeat(32)}`;
		let appKeyFailure: unknown;
		try {
			loadAuthRuntimeConfig(
				phoneEnv({
					QQ_AUTH_ENABLED: "true",
					QQ_APP_ID: "1905202162",
					QQ_APP_KEY: `${appKeyMarker}\n`,
				}),
				options,
			);
		} catch (error) {
			appKeyFailure = error;
		}
		expect(appKeyFailure).toBeInstanceOf(Error);
		expect((appKeyFailure as Error).message).toContain("QQ_APP_KEY");
		expect((appKeyFailure as Error).message).not.toContain(appKeyMarker);
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({
					QQ_AUTH_ENABLED: "true",
					QQ_APP_ID: "1905202162",
					QQ_UNION_ID_ENABLED: "yes",
				}),
				options,
			),
		).toThrow("QQ_UNION_ID_ENABLED 必须是 true 或 false");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({
					QQ_AUTH_ENABLED: "true",
					QQ_APP_ID: "1905202162",
					QQ_APP_KEY: "a".repeat(32),
					QQ_UNION_ID_ENABLED: "true",
				}),
				options,
			),
		).toThrow("QQ_OPEN_PLATFORM_REALM_ID");
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({
					QQ_AUTH_ENABLED: "true",
					QQ_APP_ID: "1905202162",
					QQ_APP_KEY: "a".repeat(32),
					QQ_UNION_ID_ENABLED: "true",
					QQ_OPEN_PLATFORM_REALM_ID: "EatWhat Primary",
				}),
				options,
			),
		).toThrow("QQ_OPEN_PLATFORM_REALM_ID 必须是稳定的小写内部标识");
		const qq = loadAuthRuntimeConfig(
			phoneEnv({
				QQ_AUTH_ENABLED: "true",
				QQ_APP_ID: "1905202162",
				QQ_APP_KEY: "a".repeat(32),
				QQ_UNION_ID_ENABLED: "true",
				QQ_OPEN_PLATFORM_REALM_ID: "eatwhat-qq-primary",
			}),
			options,
		).qq;
		expect(qq.unionIdEnabled).toBe(true);
		expect(qq.appKey).toBe("a".repeat(32));
		expect(qq.openPlatformRealmId).toBe("eatwhat-qq-primary");
	});

	it("rejects reused authentication and email OTP key material", () => {
		expect(() =>
			loadAuthRuntimeConfig(
				emailEnv({
					AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ "otp-v1": hashKey }),
				}),
				options,
			),
		).toThrow(
			"AUTH_HASH_KEYS_JSON 与 AUTH_OTP_PEPPER_KEYS_JSON 禁止复用密钥材料",
		);
	});

	it("requires a pinned ephemeral Aliyun credential provider in production", () => {
		const production = { ...options, production: true } as const;
		expect(() => loadAuthRuntimeConfig(phoneEnv(), production)).toThrow(
			"生产阿里云账号通道必须用 ALIYUN_CREDENTIAL_ALLOWED_PROVIDER 钉死凭据来源",
		);
		expect(() =>
			loadAuthRuntimeConfig(
				phoneEnv({ ALIYUN_CREDENTIAL_ALLOWED_PROVIDER: "default/env" }),
				production,
			),
		).toThrow("生产阿里云账号通道禁止使用长期环境变量 AccessKey");
		expect(
			loadAuthRuntimeConfig(
				phoneEnv({
					ALIYUN_CREDENTIAL_ALLOWED_PROVIDER: "default/ecs_ram_role",
				}),
				production,
			).aliyunCredentialAllowedProvider,
		).toBe("default/ecs_ram_role");
	});
});
