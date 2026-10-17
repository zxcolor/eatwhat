import type { AppConfig } from "../config/app-config.js";
import {
	type AliyunPnvsClient,
	AliyunPnvsOtpProvider,
} from "./providers/aliyun-pnvs-otp.provider.js";
import type {
	QqIdentityProvider,
	WechatIdentityProvider,
} from "./providers/external-identity.provider.js";
import type {
	OtpDeliveryProvider,
	PhoneOtpProvider,
} from "./providers/otp-delivery.provider.js";
import { OfficialQqIdentityProvider } from "./providers/qq-identity.provider.js";
import {
	SmtpEmailOtpDeliveryProvider,
	type SmtpTransportClient,
} from "./providers/smtp-email-otp.provider.js";
import {
	UnavailableOtpDeliveryProvider,
	UnavailablePhoneOtpProvider,
} from "./providers/unavailable-otp.provider.js";
import { OfficialWechatIdentityProvider } from "./providers/wechat-identity.provider.js";
import { OfficialWechatMiniProgramIdentityProvider } from "./providers/wechat-miniprogram-identity.provider.js";

export const ALIYUN_PNVS_CLIENT = Symbol("ALIYUN_PNVS_CLIENT");
export const ALIYUN_CREDENTIAL = Symbol("ALIYUN_CREDENTIAL");
export const SMTP_CLIENT = Symbol("SMTP_CLIENT");
export const PHONE_OTP_PROVIDER = Symbol("PHONE_OTP_PROVIDER");
export const EMAIL_OTP_PROVIDER = Symbol("EMAIL_OTP_PROVIDER");
export const WECHAT_IDENTITY_PROVIDER = Symbol("WECHAT_IDENTITY_PROVIDER");
export const WECHAT_MINIPROGRAM_IDENTITY_PROVIDER = Symbol(
	"WECHAT_MINIPROGRAM_IDENTITY_PROVIDER",
);
export const QQ_IDENTITY_PROVIDER = Symbol("QQ_IDENTITY_PROVIDER");

export function createPhoneOtpProvider(
	config: AppConfig,
	client: AliyunPnvsClient | undefined,
): PhoneOtpProvider {
	if (!config.auth.phone.enabled) {
		return new UnavailablePhoneOtpProvider();
	}
	if (client === undefined) {
		throw new Error("账号短信供应商客户端未配置");
	}
	return new AliyunPnvsOtpProvider(
		{
			...config.auth.phone,
			resendDelayMs: config.auth.otpResendDelayMs,
		},
		client,
	);
}

export function createEmailOtpProvider(
	config: AppConfig,
	client: SmtpTransportClient | undefined,
): OtpDeliveryProvider {
	if (!config.auth.email.enabled) {
		return new UnavailableOtpDeliveryProvider("EMAIL");
	}
	if (client === undefined) {
		throw new Error("账号邮件供应商客户端未配置");
	}
	return new SmtpEmailOtpDeliveryProvider(config.auth.email, client);
}

export function createWechatIdentityProvider(
	config: AppConfig,
): WechatIdentityProvider {
	return new OfficialWechatIdentityProvider(config.auth.wechat);
}

export function createQqIdentityProvider(
	config: AppConfig,
): QqIdentityProvider {
	return new OfficialQqIdentityProvider(config.auth.qq);
}

export function createWechatMiniProgramIdentityProvider(
	config: AppConfig,
): WechatIdentityProvider {
	return new OfficialWechatMiniProgramIdentityProvider(
		config.auth.wechatMiniProgram,
	);
}
