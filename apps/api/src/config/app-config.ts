import { isIP } from "node:net";
import {
	type DataRightsMode,
	DataRightsModeSchema,
	type DataSourceCode,
	DataSourceCodeSchema,
	REGISTERED_INTENT_PROMPT_VERSIONS,
	REGISTERED_QWEN_MODEL_VERSIONS,
} from "@chi-shen-me/contracts";
import {
	type AdminRuntimeConfig,
	loadAdminRuntimeConfig,
} from "../admin/admin-config.js";
import {
	type AuthRuntimeConfig,
	loadAuthRuntimeConfig,
} from "../auth/auth-config.js";
import {
	type ExportArtifactRuntimeConfig,
	loadExportArtifactRuntimeConfig,
} from "../data-export/export-artifact-config.js";
import {
	type DatabaseConfig,
	loadDatabaseConfig,
} from "../database/database-config.js";
import { REGISTERED_PROVIDER_CODES } from "../providers/provider-catalog.js";

export const APP_CONFIG = Symbol("APP_CONFIG");
// Executable behavior is a build identity, not an operator-editable label.
export const EXECUTABLE_RECOMMENDATION_RULE_VERSION = "recommendation-rules-v3";

export interface AppConfig {
	readonly nodeEnv: "development" | "test" | "production";
	readonly port: number;
	readonly trustedProxyCidrs: readonly string[];
	readonly database: DatabaseConfig;
	readonly dataExportArtifacts: ExportArtifactRuntimeConfig;
	readonly dataExportWorkerReady?: boolean;
	readonly dataExportDownload: {
		readonly totalTimeoutMs: number;
		readonly idleTimeoutMs: number;
	};
	readonly auth: AuthRuntimeConfig;
	readonly admin: AdminRuntimeConfig;
	readonly dataRightsMode: DataRightsMode;
	readonly dataRightsAuthorization: {
		readonly reference: string;
		readonly expiresAt: string;
	} | null;
	readonly demoDataAllowed: boolean;
	readonly recommendationProviderPriority: readonly DataSourceCode[];
	readonly locationSearchProviderPriority: readonly DataSourceCode[];
	readonly placeSearchProviderPriority: readonly DataSourceCode[];
	readonly amap: {
		readonly enabled: boolean;
		readonly apiKey: string | null;
		readonly signingPrivateKey: string | null;
		readonly ipWhitelistConfigured: boolean;
		readonly timeoutMs: number;
	};
	readonly qwen: {
		readonly enabled: boolean;
		readonly baseUrl: string | null;
		readonly apiKey: string | null;
		readonly model: (typeof REGISTERED_QWEN_MODEL_VERSIONS)[number];
		readonly timeoutMs: number;
	};
	readonly versions: {
		readonly rule: string;
		readonly prompt: (typeof REGISTERED_INTENT_PROMPT_VERSIONS)[number];
		readonly ruleFallbackModel: string;
	};
	readonly features: {
		readonly accountsEnabled: boolean;
		readonly favoritesEnabled: boolean;
		readonly historyEnabled: boolean;
		readonly privateFeedbackEnabled: boolean;
		readonly minimumSupportedVersion: string;
	};
}

const DEFAULT_PROVIDER_PRIORITY = "AMAP,DEMO";

function readProviderPriority(
	value: string | undefined,
	name: string,
): readonly DataSourceCode[] {
	const rawEntries = (value ?? DEFAULT_PROVIDER_PRIORITY).split(",");
	const trimmedEntries = rawEntries.map((entry) => entry.trim());
	if (trimmedEntries.some((entry) => entry.length === 0)) {
		throw new Error(`${name} 不能包含空条目`);
	}

	const entries = trimmedEntries.map((entry, index) => {
		const parsed = DataSourceCodeSchema.safeParse(entry);
		if (!parsed.success) {
			throw new Error(`${name} 第 ${index + 1} 项不是合法供应商代码`);
		}
		if (!REGISTERED_PROVIDER_CODES.includes(parsed.data)) {
			throw new Error(`${name} 第 ${index + 1} 项未在当前构建注册`);
		}
		return parsed.data;
	});

	if (new Set(entries).size !== entries.length) {
		throw new Error(`${name} 不能包含重复供应商`);
	}
	return Object.freeze(entries);
}

function readTrustedProxyCidrs(value: string | undefined): readonly string[] {
	if (value === undefined || value.trim() === "") return Object.freeze([]);

	const cidrs = value.split(",").map((entry) => entry.trim());
	if (cidrs.some((entry) => entry.length === 0)) {
		throw new Error("TRUSTED_PROXY_CIDRS 不能包含空条目");
	}

	const normalized = cidrs.map((entry) => {
		const slashIndex = entry.indexOf("/");
		const address = slashIndex === -1 ? entry : entry.slice(0, slashIndex);
		const prefixText = slashIndex === -1 ? null : entry.slice(slashIndex + 1);
		if (slashIndex !== entry.lastIndexOf("/") || address.length === 0) {
			throw new Error(`TRUSTED_PROXY_CIDRS 包含非法地址：${entry}`);
		}
		const family = isIP(address);
		if (family === 0) {
			throw new Error(
				`TRUSTED_PROXY_CIDRS 只接受有效 IPv4、IPv6 或 CIDR：${entry}`,
			);
		}
		if (prefixText === null) return address;
		if (!/^\d+$/.test(prefixText)) {
			throw new Error(`TRUSTED_PROXY_CIDRS 包含非法 CIDR 前缀：${entry}`);
		}
		const prefix = Number(prefixText);
		const maximumPrefix = family === 4 ? 32 : 128;
		// /0 effectively trusts every source and is therefore a wildcard, not an
		// explicitly bounded proxy network.
		if (prefix < 1 || prefix > maximumPrefix) {
			throw new Error(`TRUSTED_PROXY_CIDRS 禁止通配网段或非法 CIDR：${entry}`);
		}
		return `${address}/${prefix}`;
	});

	return Object.freeze([...new Set(normalized)]);
}

function readBoolean(value: string | undefined, name: string): boolean {
	if (value === undefined || value === "") return false;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} 必须是 true 或 false`);
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

function readSemanticVersion(
	value: string | undefined,
	fallback: string,
	name: string,
): string {
	const normalized = value?.trim() || fallback;
	if (
		!/^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/u.test(
			normalized,
		)
	) {
		throw new Error(`${name} 必须是三段式版本号 x.y.z`);
	}
	return normalized;
}

function readRegisteredVersion<T extends string>(
	value: string | undefined,
	fallback: T,
	name: string,
	registeredVersions: readonly T[],
): T {
	const normalized = value?.trim() || fallback;
	if (!registeredVersions.includes(normalized as T)) {
		throw new Error(`${name} 未在当前服务端构建注册`);
	}
	return normalized as T;
}

function requiredWhenEnabled(
	enabled: boolean,
	value: string | undefined,
	name: string,
): string | null {
	const normalized = value?.trim() ?? "";
	if (enabled && normalized.length === 0) {
		throw new Error(`${name} 在对应服务启用时不能为空`);
	}
	return normalized.length === 0 ? null : normalized;
}

function readAmapSecret(
	enabled: boolean,
	value: string | undefined,
	name: string,
	required: boolean,
): string | null {
	if (!enabled) return null;
	const normalized = value?.trim() ?? "";
	if (required && normalized.length === 0) {
		throw new Error(`${name} 在高德启用时不能为空`);
	}
	const hasControlCharacter = [...normalized].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 32 || codePoint === 127;
	});
	if (hasControlCharacter || normalized.length > 512) {
		throw new Error(`${name} 格式无效`);
	}
	return normalized.length === 0 ? null : normalized;
}

function normalizeQwenBaseUrl(
	enabled: boolean,
	raw: string | undefined,
): string | null {
	const value = requiredWhenEnabled(enabled, raw, "QWEN_BASE_URL");
	if (value === null) return null;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("QWEN_BASE_URL 必须是有效 URL");
	}

	if (url.protocol !== "https:") {
		throw new Error("QWEN_BASE_URL 必须使用 HTTPS");
	}
	if (!url.hostname.endsWith(".cn-beijing.maas.aliyuncs.com")) {
		throw new Error("QWEN_BASE_URL 必须指向百炼北京地域工作空间");
	}

	return url.toString().replace(/\/$/, "");
}

function readDataRightsAuthorization(
	mode: DataRightsMode,
	env: NodeJS.ProcessEnv,
): AppConfig["dataRightsAuthorization"] {
	if (mode === "LIVE_DISPLAY_ONLY") return null;

	const reference = requiredWhenEnabled(
		true,
		env.DATA_RIGHTS_AUTHORIZATION_ID,
		"DATA_RIGHTS_AUTHORIZATION_ID",
	);
	const expiresAt = requiredWhenEnabled(
		true,
		env.DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT,
		"DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT",
	);
	const expiresAtMs = Date.parse(expiresAt ?? "");
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
		throw new Error(
			"DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT 必须是未来的有效时间",
		);
	}
	if (
		reference === null ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
			reference,
		)
	) {
		throw new Error("DATA_RIGHTS_AUTHORIZATION_ID 必须是规范 UUID");
	}
	return Object.freeze({
		reference,
		expiresAt: new Date(expiresAtMs).toISOString(),
	});
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const nodeEnvRaw = env.NODE_ENV ?? "development";
	if (
		!(["development", "test", "production"] as const).includes(
			nodeEnvRaw as never,
		)
	) {
		throw new Error("NODE_ENV 必须是 development、test 或 production");
	}
	const nodeEnv = nodeEnvRaw as AppConfig["nodeEnv"];
	const amapEnabled = readBoolean(env.AMAP_ENABLED, "AMAP_ENABLED");
	const amapApiKey = readAmapSecret(
		amapEnabled,
		env.AMAP_WEB_SERVICE_KEY,
		"AMAP_WEB_SERVICE_KEY",
		true,
	);
	const amapIpWhitelistConfigured = readBoolean(
		env.AMAP_IP_WHITELIST_CONFIGURED,
		"AMAP_IP_WHITELIST_CONFIGURED",
	);
	const amapSigningPrivateKey = readAmapSecret(
		amapEnabled,
		env.AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY,
		"AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY",
		false,
	);
	if (nodeEnv === "production" && amapEnabled) {
		if (!amapIpWhitelistConfigured) {
			throw new Error(
				"生产环境启用高德前必须确认 AMAP_IP_WHITELIST_CONFIGURED",
			);
		}
		if (amapSigningPrivateKey === null) {
			throw new Error(
				"生产环境启用高德必须配置 AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY",
			);
		}
	}
	const qwenEnabled = readBoolean(env.QWEN_ENABLED, "QWEN_ENABLED");
	const dataRightsMode = DataRightsModeSchema.parse(
		env.DATA_RIGHTS_MODE ?? "LIVE_DISPLAY_ONLY",
	);
	const demoDataAllowed =
		env.ALLOW_DEMO_DATA === undefined
			? nodeEnv !== "production"
			: readBoolean(env.ALLOW_DEMO_DATA, "ALLOW_DEMO_DATA");
	if (nodeEnv === "production" && demoDataAllowed) {
		throw new Error("生产环境禁止启用虚构演示餐厅数据");
	}
	const trustedProxyCidrs = readTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS);
	if (nodeEnv === "production" && trustedProxyCidrs.length === 0) {
		throw new Error("生产环境必须显式配置 TRUSTED_PROXY_CIDRS");
	}
	const database = loadDatabaseConfig(env, nodeEnv);
	if (
		env.ADMIN_API_ENABLED !== undefined &&
		env.ADMIN_API_ENABLED !== "" &&
		env.ADMIN_API_ENABLED !== "false"
	) {
		throw new Error(
			"公开 API 进程禁止启用管理员能力；请使用独立 admin-main 入口",
		);
	}
	for (const secretName of [
		"ADMIN_DATABASE_URL",
		"ADMIN_DATABASE_SSL_CA_BASE64",
		"ADMIN_HMAC_KEYS",
		"ADMIN_CREDENTIAL_ENCRYPTION_KEYS",
	] as const) {
		if ((env[secretName]?.trim() ?? "").length > 0) {
			throw new Error(
				`公开 API 进程禁止注入 ${secretName}；管理员 Secret 只属于独立进程`,
			);
		}
	}
	const admin = loadAdminRuntimeConfig({ ADMIN_API_ENABLED: "false" }, nodeEnv);
	const accountsEnabled = readBoolean(env.ACCOUNTS_ENABLED, "ACCOUNTS_ENABLED");
	const auth = loadAuthRuntimeConfig(env, {
		accountsEnabled,
		databaseEnabled: database.enabled,
		production: nodeEnv === "production",
	});
	const dataExportArtifacts = loadExportArtifactRuntimeConfig(env, nodeEnv);
	if (auth.dataExportEnabled !== dataExportArtifacts.enabled) {
		throw new Error("账号导出能力与私有工件存储配置不一致");
	}
	const dataExportWorkerReady = readBoolean(
		env.DATA_EXPORT_WORKER_READY,
		"DATA_EXPORT_WORKER_READY",
	);
	if (dataExportWorkerReady && !auth.dataExportEnabled) {
		throw new Error("数据导出工作器就绪标记只能在完整导出能力启用后设置");
	}
	const dataExportDownloadTotalTimeoutMs = readInteger(
		env.DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS,
		120_000,
		"DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS",
		30_000,
		300_000,
	);
	const dataExportDownloadIdleTimeoutMs = readInteger(
		env.DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS,
		15_000,
		"DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS",
		5_000,
		60_000,
	);
	if (dataExportDownloadIdleTimeoutMs >= dataExportDownloadTotalTimeoutMs) {
		throw new Error(
			"DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS 必须小于 DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS",
		);
	}

	return Object.freeze({
		nodeEnv,
		port: readInteger(env.PORT, 3_001, "PORT", 1, 65_535),
		trustedProxyCidrs,
		database,
		dataExportArtifacts,
		dataExportWorkerReady,
		dataExportDownload: Object.freeze({
			totalTimeoutMs: dataExportDownloadTotalTimeoutMs,
			idleTimeoutMs: dataExportDownloadIdleTimeoutMs,
		}),
		auth,
		admin,
		dataRightsMode,
		dataRightsAuthorization: readDataRightsAuthorization(dataRightsMode, env),
		demoDataAllowed,
		recommendationProviderPriority: readProviderPriority(
			env.RECOMMENDATION_PROVIDER_PRIORITY,
			"RECOMMENDATION_PROVIDER_PRIORITY",
		),
		locationSearchProviderPriority: readProviderPriority(
			env.LOCATION_SEARCH_PROVIDER_PRIORITY,
			"LOCATION_SEARCH_PROVIDER_PRIORITY",
		),
		placeSearchProviderPriority: readProviderPriority(
			env.PLACE_SEARCH_PROVIDER_PRIORITY,
			"PLACE_SEARCH_PROVIDER_PRIORITY",
		),
		amap: Object.freeze({
			enabled: amapEnabled,
			// A disabled integration must not retain a stray secret in runtime
			// configuration. Enabling AMap always requires an explicit non-empty key.
			apiKey: amapApiKey,
			signingPrivateKey: amapEnabled ? amapSigningPrivateKey : null,
			ipWhitelistConfigured: amapEnabled ? amapIpWhitelistConfigured : false,
			timeoutMs: readInteger(
				env.AMAP_TIMEOUT_MS,
				2_200,
				"AMAP_TIMEOUT_MS",
				500,
				10_000,
			),
		}),
		qwen: Object.freeze({
			enabled: qwenEnabled,
			baseUrl: normalizeQwenBaseUrl(qwenEnabled, env.QWEN_BASE_URL),
			apiKey: requiredWhenEnabled(
				qwenEnabled,
				env.QWEN_API_KEY,
				"QWEN_API_KEY",
			),
			model: readRegisteredVersion(
				env.QWEN_MODEL,
				REGISTERED_QWEN_MODEL_VERSIONS[0],
				"QWEN_MODEL",
				REGISTERED_QWEN_MODEL_VERSIONS,
			),
			timeoutMs: readInteger(
				env.QWEN_TIMEOUT_MS,
				2_500,
				"QWEN_TIMEOUT_MS",
				500,
				2_500,
			),
		}),
		versions: Object.freeze({
			rule: EXECUTABLE_RECOMMENDATION_RULE_VERSION,
			prompt: readRegisteredVersion(
				env.PROMPT_VERSION,
				REGISTERED_INTENT_PROMPT_VERSIONS[0],
				"PROMPT_VERSION",
				REGISTERED_INTENT_PROMPT_VERSIONS,
			),
			ruleFallbackModel: "rule-fallback-v1",
		}),
		features: Object.freeze({
			accountsEnabled,
			favoritesEnabled: readBoolean(env.FAVORITES_ENABLED, "FAVORITES_ENABLED"),
			historyEnabled: readBoolean(env.HISTORY_ENABLED, "HISTORY_ENABLED"),
			privateFeedbackEnabled: readBoolean(
				env.PRIVATE_FEEDBACK_ENABLED,
				"PRIVATE_FEEDBACK_ENABLED",
			),
			minimumSupportedVersion: readSemanticVersion(
				env.MINIMUM_SUPPORTED_VERSION,
				"0.1.1",
				"MINIMUM_SUPPORTED_VERSION",
			),
		}),
	});
}
