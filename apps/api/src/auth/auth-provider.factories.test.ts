import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import {
	createEmailOtpProvider,
	createPhoneOtpProvider,
} from "./auth-provider.factories.js";
import { UnavailablePhoneOtpProvider } from "./providers/unavailable-otp.provider.js";

function enabledConfig() {
	const hashKey = Buffer.alloc(32, 9).toString("base64");
	const otpPepper = Buffer.alloc(32, 10).toString("base64");
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@127.0.0.1/chishenme",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "true",
		WECHAT_AUTH_ENABLED: "true",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
		AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_PNVS_SIGN_NAME: "test-sign",
		ALIYUN_PNVS_TEMPLATE_CODE: "100001",
		WECHAT_APP_ID: "wx0123456789abcdef",
		WECHAT_APP_SECRET: "private-provider-secret",
		WECHAT_OPEN_PLATFORM_REALM_ID: "eatwhat-primary",
	});
}

describe("account provider startup factories", () => {
	it("uses a non-delivering provider while accounts are disabled", () => {
		const provider = createPhoneOtpProvider(
			loadAppConfig({ NODE_ENV: "test" }),
			undefined,
		);
		expect(provider).toBeInstanceOf(UnavailablePhoneOtpProvider);
	});

	it("fails startup when an enabled channel has no audited client", () => {
		let failure: unknown;
		try {
			createPhoneOtpProvider(enabledConfig(), undefined);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("账号短信供应商客户端未配置");
		expect((failure as Error).message).not.toContain("private-provider-secret");
	});

	it("fails startup when enabled SMTP email has no verified transport", () => {
		const config = loadAppConfig({
			...enabledConfigEnvironment(),
			EMAIL_AUTH_ENABLED: "true",
			SMTP_HOST: "smtp.example.com",
			SMTP_PORT: "465",
			SMTP_SECURE: "true",
			SMTP_USERNAME: "no-reply@example.com",
			SMTP_PASSWORD: "private-smtp-password",
			SMTP_FROM_ADDRESS: "no-reply@example.com",
			SMTP_REPLY_TO: "support@example.com",
		});
		expect(() => createEmailOtpProvider(config, undefined)).toThrow(
			"账号邮件供应商客户端未配置",
		);
	});
});

function enabledConfigEnvironment(): NodeJS.ProcessEnv {
	const hashKey = Buffer.alloc(32, 9).toString("base64");
	const otpPepper = Buffer.alloc(32, 10).toString("base64");
	return {
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@127.0.0.1/chishenme",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "true",
		WECHAT_AUTH_ENABLED: "true",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
		AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_PNVS_SIGN_NAME: "test-sign",
		ALIYUN_PNVS_TEMPLATE_CODE: "100001",
		WECHAT_APP_ID: "wx0123456789abcdef",
		WECHAT_APP_SECRET: "private-provider-secret",
		WECHAT_OPEN_PLATFORM_REALM_ID: "eatwhat-primary",
	};
}
