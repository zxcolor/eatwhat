import { timingSafeEqual } from "node:crypto";
import { AuthSecretKeyRing } from "./auth-crypto.js";

const KEY_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

export interface AuthRuntimeConfig {
	readonly enabled: boolean;
	readonly dataExportEnabled: boolean;
	readonly aliyunCredentialTimeoutMs: number;
	readonly aliyunCredentialAllowedProvider: string | null;
	readonly hashKeyRing: AuthSecretKeyRing | null;
	readonly otpPepperRing: AuthSecretKeyRing | null;
	readonly identityDedupKeyVersion: string | null;
	readonly accessTokenTtlMs: number;
	readonly refreshTokenTtlMs: number;
	readonly otpTtlMs: number;
	readonly otpResendDelayMs: number;
	readonly oauthStateTtlMs: number;
	readonly phone: {
		readonly enabled: boolean;
		readonly signName: string | null;
		readonly templateCode: string | null;
		readonly timeoutMs: number;
	};
	readonly email: {
		readonly enabled: boolean;
		readonly host: string | null;
		readonly port: number;
		readonly secure: boolean;
		readonly username: string | null;
		readonly password: string | null;
		readonly fromAddress: string | null;
		readonly fromName: string;
		readonly timeoutMs: number;
	};
	readonly wechat: {
		readonly enabled: boolean;
		readonly appId: string | null;
		readonly appSecret: string | null;
		readonly timeoutMs: number;
	};
	readonly qq: {
		readonly enabled: boolean;
		readonly appId: string | null;
		readonly timeoutMs: number;
	};
}

function readBoolean(value: string | undefined, name: string): boolean {
	if (value === undefined || value === "") return false;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} 必须是 true 或 false`);
}

function readBooleanWithFallback(
	value: string | undefined,
	fallback: boolean,
	name: string,
): boolean {
	if (value === undefined || value === "") return fallback;
	return readBoolean(value, name);
}

function readInteger(
	value: string | undefined,
	fallback: number,
	name: string,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
	}
	return parsed;
}

function optionalWhenDisabled(
	enabled: boolean,
	value: string | undefined,
	name: string,
	maximum = 256,
): string | null {
	if (!enabled) return null;
	const normalized = value?.trim() ?? "";
	if (normalized.length === 0 || normalized.length > maximum) {
		throw new Error(`${name} 在通道启用时必须是有效的服务端配置`);
	}
	return normalized;
}

function containsAsciiControl(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) as number;
		if (codePoint <= 0x1f || codePoint === 0x7f) return true;
	}
	return false;
}

function readWechatAppId(
	enabled: boolean,
	value: string | undefined,
): string | null {
	const normalized = optionalWhenDisabled(enabled, value, "WECHAT_APP_ID", 18);
	if (normalized !== null && !/^wx[0-9a-fA-F]{16}$/u.test(normalized)) {
		throw new Error("WECHAT_APP_ID 必须符合 wx + 16 位十六进制字符格式");
	}
	return normalized;
}

function readQqAppId(
	enabled: boolean,
	value: string | undefined,
): string | null {
	const normalized = optionalWhenDisabled(enabled, value, "QQ_APP_ID", 16);
	if (normalized !== null && !/^[1-9][0-9]{4,15}$/u.test(normalized)) {
		throw new Error("QQ_APP_ID 必须为 5 至 16 位、不以 0 开头的纯数字 AppID");
	}
	return normalized;
}

function readCodePointBoundedValue(
	enabled: boolean,
	value: string | undefined,
	name: string,
	minimumCodePoints: number,
	maximumCodePoints: number,
): string | null {
	const normalized = optionalWhenDisabled(enabled, value, name, 512);
	if (normalized === null) return null;
	const length = Array.from(normalized).length;
	if (
		length < minimumCodePoints ||
		length > maximumCodePoints ||
		containsAsciiControl(normalized)
	) {
		throw new Error(
			`${name} 必须是 ${minimumCodePoints} 到 ${maximumCodePoints} 个字符`,
		);
	}
	return normalized;
}

function readSmsTemplateCode(
	enabled: boolean,
	value: string | undefined,
): string | null {
	const normalized = optionalWhenDisabled(
		enabled,
		value,
		"ALIYUN_SMS_TEMPLATE_CODE",
		64,
	);
	if (normalized !== null && !/^SMS_[A-Za-z0-9]{1,32}$/u.test(normalized)) {
		throw new Error("ALIYUN_SMS_TEMPLATE_CODE 必须是有效的短信模板 Code");
	}
	return normalized;
}

function readEmailAddress(
	enabled: boolean,
	value: string | undefined,
	name: string,
): string | null {
	const normalized = optionalWhenDisabled(enabled, value, name, 254);
	if (
		normalized !== null &&
		(!/^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/u.test(normalized) ||
			normalized.includes(","))
	) {
		throw new Error(`${name} 必须是单个有效邮箱地址`);
	}
	return normalized;
}

function readSmtpHost(
	enabled: boolean,
	value: string | undefined,
): string | null {
	const normalized = optionalWhenDisabled(enabled, value, "SMTP_HOST", 253);
	if (
		normalized !== null &&
		(!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(
			normalized,
		) ||
			normalized.includes(".."))
	) {
		throw new Error("SMTP_HOST 必须是完整 DNS 主机名，不能填写 URL 或 IP 地址");
	}
	return normalized?.toLowerCase() ?? null;
}

function readSmtpUsername(
	enabled: boolean,
	value: string | undefined,
): string | null {
	const normalized = optionalWhenDisabled(enabled, value, "SMTP_USERNAME", 254);
	if (normalized !== null && containsAsciiControl(normalized)) {
		throw new Error("SMTP_USERNAME 必须是单行 SMTP 登录名");
	}
	return normalized;
}

function readSmtpPassword(
	enabled: boolean,
	value: string | undefined,
): string | null {
	if (!enabled) return null;
	const password = value ?? "";
	if (
		password.length < 1 ||
		password.length > 1_024 ||
		password.includes("\0") ||
		password.includes("\r") ||
		password.includes("\n")
	) {
		throw new Error("SMTP_PASSWORD 在邮件通道启用时必须是有效的服务端密钥");
	}
	return password;
}

function readSmtpFromName(enabled: boolean, value: string | undefined): string {
	if (!enabled) return "吃什么";
	const normalized = value?.trim() || "吃什么";
	const length = Array.from(normalized).length;
	if (length < 1 || length > 64 || containsAsciiControl(normalized)) {
		throw new Error("SMTP_FROM_NAME 必须是 1 到 64 个单行字符");
	}
	return normalized;
}

const ALIYUN_CREDENTIAL_PROVIDERS = new Set([
	"default/env",
	"default/ecs_ram_role",
	"default/oidc_role_arn",
]);

function readAliyunCredentialAllowedProvider(
	enabled: boolean,
	production: boolean,
	value: string | undefined,
): string | null {
	if (!enabled) return null;
	const normalized = value?.trim() ?? "";
	if (normalized.length === 0) {
		if (production) {
			throw new Error(
				"生产短信通道必须用 ALIYUN_CREDENTIAL_ALLOWED_PROVIDER 钉死凭据来源",
			);
		}
		return null;
	}
	if (!ALIYUN_CREDENTIAL_PROVIDERS.has(normalized)) {
		throw new Error("ALIYUN_CREDENTIAL_ALLOWED_PROVIDER 不是受支持的凭据来源");
	}
	if (production && normalized === "default/env") {
		throw new Error("生产短信通道禁止使用长期环境变量 AccessKey");
	}
	return normalized;
}

function keyRingsShareMaterial(
	left: AuthSecretKeyRing,
	right: AuthSecretKeyRing,
): boolean {
	for (const leftVersion of left.versions()) {
		const leftKey = left.key(leftVersion);
		if (leftKey === null) continue;
		try {
			for (const rightVersion of right.versions()) {
				const rightKey = right.key(rightVersion);
				if (rightKey === null) continue;
				try {
					if (
						leftKey.length === rightKey.length &&
						timingSafeEqual(leftKey, rightKey)
					) {
						return true;
					}
				} finally {
					rightKey.fill(0);
				}
			}
		} finally {
			leftKey.fill(0);
		}
	}
	return false;
}

function decodeKeyMap(
	raw: string | undefined,
	name: string,
): Map<string, Buffer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw ?? "");
	} catch {
		throw new Error(`${name} 必须是有效的密钥版本 JSON 对象`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${name} 必须是密钥版本 JSON 对象`);
	}
	const entries = Object.entries(parsed);
	if (entries.length < 1 || entries.length > 3) {
		throw new Error(`${name} 只允许 1 到 3 个 current/retiring 版本`);
	}
	const keys = new Map<string, Buffer>();
	try {
		for (const [version, encoded] of entries) {
			if (!KEY_VERSION_PATTERN.test(version) || typeof encoded !== "string") {
				throw new Error(`${name} 包含无效的版本或密钥`);
			}
			let bytes: Buffer | null = null;
			try {
				bytes = Buffer.from(encoded, "base64");
				const canonical = bytes.toString("base64").replace(/=+$/u, "");
				if (canonical !== encoded.replace(/=+$/u, "")) {
					throw new Error("invalid base64");
				}
			} catch {
				bytes?.fill(0);
				throw new Error(`${name} 包含无效的 Base64 密钥`);
			}
			if (bytes.length < 32 || bytes.length > 128) {
				bytes.fill(0);
				throw new Error(`${name} 的每个密钥必须为 32 到 128 字节`);
			}
			keys.set(version, bytes);
		}
		return keys;
	} catch (error) {
		for (const key of keys.values()) {
			key.fill(0);
		}
		keys.clear();
		throw error;
	}
}

function readKeyRing(
	enabled: boolean,
	env: NodeJS.ProcessEnv,
	keysName: string,
	activeName: string,
): AuthSecretKeyRing | null {
	if (!enabled) return null;
	const activeVersion = env[activeName]?.trim() ?? "";
	if (!KEY_VERSION_PATTERN.test(activeVersion)) {
		throw new Error(`${activeName} 必须是有效的当前密钥版本`);
	}
	const decodedKeys = decodeKeyMap(env[keysName], keysName);
	try {
		return new AuthSecretKeyRing(activeVersion, decodedKeys);
	} finally {
		// AuthSecretKeyRing copies every key. Erase the temporary Base64-decoded
		// buffers immediately instead of leaving a second secret copy to GC.
		for (const key of decodedKeys.values()) key.fill(0);
		decodedKeys.clear();
	}
}

export function loadAuthRuntimeConfig(
	env: NodeJS.ProcessEnv,
	options: {
		readonly accountsEnabled: boolean;
		readonly databaseEnabled: boolean;
		readonly production?: boolean;
	},
): AuthRuntimeConfig {
	const enabled = options.accountsEnabled;
	if (enabled && !options.databaseEnabled) {
		throw new Error("账号服务启用时必须启用 PostgreSQL");
	}

	const phoneEnabled =
		enabled && readBoolean(env.PHONE_AUTH_ENABLED, "PHONE_AUTH_ENABLED");
	const emailEnabled =
		enabled && readBoolean(env.EMAIL_AUTH_ENABLED, "EMAIL_AUTH_ENABLED");
	const wechatEnabled =
		enabled && readBoolean(env.WECHAT_AUTH_ENABLED, "WECHAT_AUTH_ENABLED");
	const qqEnabled =
		enabled && readBoolean(env.QQ_AUTH_ENABLED, "QQ_AUTH_ENABLED");
	const dataExportEnabled =
		enabled && readBoolean(env.DATA_EXPORT_ENABLED, "DATA_EXPORT_ENABLED");
	if (enabled && (!phoneEnabled || !wechatEnabled)) {
		throw new Error("账号服务启用前必须同时就绪手机和微信注册通道");
	}

	const hashKeyRing = readKeyRing(
		enabled,
		env,
		"AUTH_HASH_KEYS_JSON",
		"AUTH_HASH_ACTIVE_VERSION",
	);
	const otpPepperRing = readKeyRing(
		enabled,
		env,
		"AUTH_OTP_PEPPER_KEYS_JSON",
		"AUTH_OTP_PEPPER_ACTIVE_VERSION",
	);
	if (
		hashKeyRing !== null &&
		otpPepperRing !== null &&
		keyRingsShareMaterial(hashKeyRing, otpPepperRing)
	) {
		throw new Error(
			"AUTH_HASH_KEYS_JSON 与 AUTH_OTP_PEPPER_KEYS_JSON 禁止复用密钥材料",
		);
	}
	const smtpPort = readInteger(env.SMTP_PORT, 465, "SMTP_PORT", 1, 65_535);
	const smtpSecure = readBooleanWithFallback(
		env.SMTP_SECURE,
		true,
		"SMTP_SECURE",
	);
	if (emailEnabled && (smtpPort === 465) !== smtpSecure) {
		throw new Error(
			"SMTP_PORT=465 时 SMTP_SECURE 必须为 true；其他端口必须为 false 并强制 STARTTLS",
		);
	}
	const dedupVersion = enabled
		? (env.AUTH_IDENTITY_DEDUP_KEY_VERSION?.trim() ?? "")
		: null;
	if (
		enabled &&
		(hashKeyRing === null ||
			dedupVersion === null ||
			!hashKeyRing.versions().includes(dedupVersion))
	) {
		throw new Error(
			"AUTH_IDENTITY_DEDUP_KEY_VERSION 必须引用密钥环中的稳定去重版本；变更前必须完成全量回填和冲突审计",
		);
	}

	return Object.freeze({
		enabled,
		dataExportEnabled,
		aliyunCredentialTimeoutMs: readInteger(
			env.ALIYUN_CREDENTIAL_TIMEOUT_MS,
			2_000,
			"ALIYUN_CREDENTIAL_TIMEOUT_MS",
			500,
			5_000,
		),
		aliyunCredentialAllowedProvider: readAliyunCredentialAllowedProvider(
			phoneEnabled,
			options.production === true,
			env.ALIYUN_CREDENTIAL_ALLOWED_PROVIDER,
		),
		hashKeyRing,
		otpPepperRing,
		identityDedupKeyVersion: dedupVersion,
		accessTokenTtlMs:
			readInteger(
				env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
				15 * 60,
				"AUTH_ACCESS_TOKEN_TTL_SECONDS",
				300,
				1_800,
			) * 1_000,
		refreshTokenTtlMs:
			readInteger(
				env.AUTH_REFRESH_TOKEN_TTL_DAYS,
				30,
				"AUTH_REFRESH_TOKEN_TTL_DAYS",
				1,
				30,
			) * 86_400_000,
		otpTtlMs:
			readInteger(
				env.AUTH_OTP_TTL_SECONDS,
				300,
				"AUTH_OTP_TTL_SECONDS",
				120,
				600,
			) * 1_000,
		otpResendDelayMs:
			readInteger(
				env.AUTH_OTP_RESEND_SECONDS,
				60,
				"AUTH_OTP_RESEND_SECONDS",
				30,
				300,
			) * 1_000,
		oauthStateTtlMs:
			readInteger(
				env.AUTH_OAUTH_STATE_TTL_SECONDS,
				600,
				"AUTH_OAUTH_STATE_TTL_SECONDS",
				120,
				900,
			) * 1_000,
		phone: Object.freeze({
			enabled: phoneEnabled,
			signName: readCodePointBoundedValue(
				phoneEnabled,
				env.ALIYUN_SMS_SIGN_NAME,
				"ALIYUN_SMS_SIGN_NAME",
				2,
				12,
			),
			templateCode: readSmsTemplateCode(
				phoneEnabled,
				env.ALIYUN_SMS_TEMPLATE_CODE,
			),
			timeoutMs: readInteger(
				env.ALIYUN_SMS_TIMEOUT_MS,
				1_500,
				"ALIYUN_SMS_TIMEOUT_MS",
				1_000,
				5_000,
			),
		}),
		email: Object.freeze({
			enabled: emailEnabled,
			host: readSmtpHost(emailEnabled, env.SMTP_HOST),
			port: smtpPort,
			secure: smtpSecure,
			username: readSmtpUsername(emailEnabled, env.SMTP_USERNAME),
			password: readSmtpPassword(emailEnabled, env.SMTP_PASSWORD),
			fromAddress: readEmailAddress(
				emailEnabled,
				env.SMTP_FROM_ADDRESS,
				"SMTP_FROM_ADDRESS",
			),
			fromName: readSmtpFromName(emailEnabled, env.SMTP_FROM_NAME),
			timeoutMs: readInteger(
				env.SMTP_TIMEOUT_MS,
				5_000,
				"SMTP_TIMEOUT_MS",
				1_000,
				10_000,
			),
		}),
		wechat: Object.freeze({
			enabled: wechatEnabled,
			appId: readWechatAppId(wechatEnabled, env.WECHAT_APP_ID),
			appSecret: optionalWhenDisabled(
				wechatEnabled,
				env.WECHAT_APP_SECRET,
				"WECHAT_APP_SECRET",
				256,
			),
			timeoutMs: readInteger(
				env.WECHAT_AUTH_TIMEOUT_MS,
				2_000,
				"WECHAT_AUTH_TIMEOUT_MS",
				500,
				5_000,
			),
		}),
		qq: Object.freeze({
			enabled: qqEnabled,
			appId: readQqAppId(qqEnabled, env.QQ_APP_ID),
			timeoutMs: readInteger(
				env.QQ_AUTH_TIMEOUT_MS,
				2_000,
				"QQ_AUTH_TIMEOUT_MS",
				500,
				5_000,
			),
		}),
	});
}
