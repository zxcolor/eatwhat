import { isIP } from "node:net";
import type {
	DatabaseSslConfig,
	NodeEnvironment,
} from "../database/database-config.js";

export interface AdminCryptoKeyConfig {
	readonly version: string;
	readonly key: Buffer;
}

export interface AdminDatabaseConfig {
	readonly enabled: boolean;
	readonly connectionString: string | null;
	readonly ssl: DatabaseSslConfig;
	readonly poolMaximum: number;
	readonly connectionTimeoutMs: number;
	readonly idleTimeoutMs: number;
}

export interface AdminRuntimeConfig {
	readonly enabled: boolean;
	readonly database: AdminDatabaseConfig;
	readonly webauthn: Readonly<{
		rpName: string | null;
		rpId: string | null;
		expectedOrigins: readonly string[];
	}>;
	readonly hmacKeys: readonly AdminCryptoKeyConfig[];
	readonly credentialEncryptionKeys: readonly AdminCryptoKeyConfig[];
}

interface ParsedAdminDatabaseUrl {
	readonly value: string;
	readonly username: string;
	readonly target: string;
}

function strictBoolean(value: string | undefined, name: string): boolean {
	if (value === undefined || value === "") return false;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} 必须是 true 或 false`);
}

function boundedInteger(
	value: string | undefined,
	fallback: number,
	name: string,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined || value === "") return fallback;
	if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
		throw new Error(`${name} 必须是规范十进制整数`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
	}
	return parsed;
}

function required(value: string | undefined, name: string): string {
	const normalized = value?.trim() ?? "";
	if (normalized.length === 0 || normalized !== value) {
		throw new Error(`${name} 在管理员 API 启用时必须显式配置`);
	}
	return normalized;
}

function parseAdminDatabaseUrl(
	raw: string | undefined,
): ParsedAdminDatabaseUrl {
	const value = required(raw, "ADMIN_DATABASE_URL");
	if (/\s/u.test(value)) throw new Error("ADMIN_DATABASE_URL 格式无效");

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("ADMIN_DATABASE_URL 必须是有效的 PostgreSQL URL");
	}
	if (url.protocol !== "postgresql:") {
		throw new Error("ADMIN_DATABASE_URL 必须使用 postgresql 协议");
	}
	if (
		url.username.length === 0 ||
		url.password.length === 0 ||
		url.hostname.length === 0 ||
		url.pathname.length <= 1 ||
		url.search.length > 0 ||
		url.hash.length > 0
	) {
		throw new Error(
			"ADMIN_DATABASE_URL 必须包含角色、密码、主机和数据库名，且不得包含查询参数或片段",
		);
	}

	let username: string;
	let databaseName: string;
	try {
		username = decodeURIComponent(url.username);
		databaseName = decodeURIComponent(url.pathname.slice(1));
	} catch {
		throw new Error("ADMIN_DATABASE_URL 包含无效的百分号编码");
	}
	if (
		username.length === 0 ||
		databaseName.length === 0 ||
		databaseName.includes("/")
	) {
		throw new Error("ADMIN_DATABASE_URL 的角色名或数据库名无效");
	}
	return Object.freeze({
		value,
		username,
		target: `${url.hostname.toLowerCase()}:${url.port || "5432"}/${databaseName}`,
	});
}

function decodeCa(raw: string | undefined): string | undefined {
	const value = raw?.trim() ?? "";
	if (value.length === 0) return undefined;
	let decoded: string;
	try {
		const bytes = Buffer.from(value, "base64");
		if (
			bytes.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
		) {
			throw new Error("invalid base64");
		}
		decoded = bytes.toString("utf8");
	} catch {
		throw new Error(
			"ADMIN_DATABASE_SSL_CA_BASE64 必须是有效 Base64 PEM CA 证书",
		);
	}
	if (
		!decoded.startsWith("-----BEGIN CERTIFICATE-----\n") ||
		!decoded.trimEnd().endsWith("-----END CERTIFICATE-----")
	) {
		throw new Error("ADMIN_DATABASE_SSL_CA_BASE64 必须解码为 PEM CA 证书");
	}
	return decoded;
}

function readCryptoKeys(
	raw: string | undefined,
	name: string,
): readonly AdminCryptoKeyConfig[] {
	const value = required(raw, name);
	const entries = value.split(",");
	if (entries.length < 1 || entries.length > 3) {
		throw new Error(`${name} 必须配置 1 到 3 个轮换密钥`);
	}
	const parsed = entries.map((entry, index) => {
		const separator = entry.indexOf(":");
		if (separator <= 0 || separator !== entry.lastIndexOf(":")) {
			throw new Error(`${name} 第 ${index + 1} 项格式必须为 version:base64`);
		}
		const version = entry.slice(0, separator);
		const encoded = entry.slice(separator + 1);
		if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(version)) {
			throw new Error(`${name} 第 ${index + 1} 项版本号无效`);
		}
		let key: Buffer;
		try {
			key = Buffer.from(encoded, "base64");
			if (
				key.toString("base64").replace(/=+$/u, "") !==
				encoded.replace(/=+$/u, "")
			) {
				throw new Error("invalid base64");
			}
		} catch {
			throw new Error(`${name} 第 ${index + 1} 项不是有效 Base64`);
		}
		if (key.length !== 32) {
			throw new Error(`${name} 第 ${index + 1} 项必须解码为 32 字节`);
		}
		return Object.freeze({ version, key });
	});
	if (new Set(parsed.map((key) => key.version)).size !== parsed.length) {
		throw new Error(`${name} 不能包含重复版本号`);
	}
	return Object.freeze(parsed);
}

function normalizeRpId(
	raw: string | undefined,
	nodeEnv: NodeEnvironment,
): string {
	const value = required(raw, "ADMIN_WEBAUTHN_RP_ID").toLowerCase();
	if (value !== raw || value.endsWith(".") || /[:/?#@]/u.test(value)) {
		throw new Error("ADMIN_WEBAUTHN_RP_ID 必须是规范的小写主机名");
	}
	let parsed: URL;
	try {
		parsed = new URL(`https://${value}`);
	} catch {
		throw new Error("ADMIN_WEBAUTHN_RP_ID 必须是有效主机名");
	}
	if (parsed.hostname !== value) {
		throw new Error("ADMIN_WEBAUTHN_RP_ID 必须是有效主机名");
	}
	if (
		nodeEnv === "production" &&
		(value === "localhost" || value.endsWith(".localhost") || isIP(value) !== 0)
	) {
		throw new Error("生产环境管理员 RP ID 禁止 localhost 或 IP 地址");
	}
	return value;
}

function readOrigins(
	raw: string | undefined,
	rpId: string,
	nodeEnv: NodeEnvironment,
): readonly string[] {
	const entries = required(raw, "ADMIN_WEBAUTHN_ORIGINS").split(",");
	if (entries.length < 1 || entries.length > 5) {
		throw new Error("ADMIN_WEBAUTHN_ORIGINS 必须包含 1 到 5 个精确 Origin");
	}
	const origins = entries.map((entry) => {
		if (entry.trim() !== entry) {
			throw new Error("ADMIN_WEBAUTHN_ORIGINS 条目不得包含首尾空白");
		}
		let url: URL;
		try {
			url = new URL(entry);
		} catch {
			throw new Error("ADMIN_WEBAUTHN_ORIGINS 包含无效 URL");
		}
		if (
			url.protocol !== "https:" ||
			url.username.length > 0 ||
			url.password.length > 0 ||
			url.pathname !== "/" ||
			url.search.length > 0 ||
			url.hash.length > 0 ||
			url.origin !== entry
		) {
			throw new Error(
				"ADMIN_WEBAUTHN_ORIGINS 只接受不带路径、凭据、查询和片段的精确 HTTPS Origin",
			);
		}
		const hostname = url.hostname.toLowerCase();
		if (hostname !== rpId && !hostname.endsWith(`.${rpId}`)) {
			throw new Error("管理员 Origin 必须等于 RP ID 或位于其子域");
		}
		if (
			nodeEnv === "production" &&
			(hostname === "localhost" ||
				hostname.endsWith(".localhost") ||
				isIP(hostname) !== 0)
		) {
			throw new Error("生产环境管理员 Origin 禁止 localhost 或 IP 地址");
		}
		return entry;
	});
	if (new Set(origins).size !== origins.length) {
		throw new Error("ADMIN_WEBAUTHN_ORIGINS 不能包含重复 Origin");
	}
	return Object.freeze(origins);
}

export function loadAdminRuntimeConfig(
	env: NodeJS.ProcessEnv,
	nodeEnv: NodeEnvironment,
): AdminRuntimeConfig {
	const enabled = strictBoolean(env.ADMIN_API_ENABLED, "ADMIN_API_ENABLED");
	if (!enabled) {
		return Object.freeze({
			enabled: false,
			database: Object.freeze({
				enabled: false,
				connectionString: null,
				ssl: false,
				poolMaximum: 4,
				connectionTimeoutMs: 5_000,
				idleTimeoutMs: 15_000,
			}),
			webauthn: Object.freeze({
				rpName: null,
				rpId: null,
				expectedOrigins: Object.freeze([]),
			}),
			hmacKeys: Object.freeze([]),
			credentialEncryptionKeys: Object.freeze([]),
		});
	}

	const connection = parseAdminDatabaseUrl(env.ADMIN_DATABASE_URL);
	if (connection.value === env.DATABASE_URL?.trim()) {
		throw new Error("管理员 API 禁止复用 DATABASE_URL");
	}
	const expectedTarget = required(
		env.ADMIN_DATABASE_EXPECTED_TARGET,
		"ADMIN_DATABASE_EXPECTED_TARGET",
	);
	if (
		expectedTarget.length > 300 ||
		/\s|[?#]/u.test(expectedTarget) ||
		connection.target !== expectedTarget
	) {
		throw new Error("管理员数据库连接未指向声明的目标数据库");
	}
	const runtimeRole = required(
		env.ADMIN_DATABASE_RUNTIME_ROLE_NAME,
		"ADMIN_DATABASE_RUNTIME_ROLE_NAME",
	);
	if (
		runtimeRole !== "admin_api_runtime" ||
		connection.username !== runtimeRole
	) {
		throw new Error("管理员数据库连接必须使用独立 admin_api_runtime");
	}
	for (const ordinaryRole of [
		env.DATABASE_RUNTIME_ROLE_NAME,
		env.DATABASE_MIGRATION_ROLE_NAME,
		env.DATABASE_MAINTENANCE_ROLE_NAME,
	]) {
		if ((ordinaryRole?.trim() ?? "") === runtimeRole) {
			throw new Error("管理员数据库角色不得与普通 API 角色重用");
		}
	}
	if (env.ADMIN_DATABASE_SSL_MODE?.trim() !== "verify-full") {
		throw new Error("ADMIN_DATABASE_SSL_MODE 在启用时必须为 verify-full");
	}
	const ca = decodeCa(env.ADMIN_DATABASE_SSL_CA_BASE64);
	const rpId = normalizeRpId(env.ADMIN_WEBAUTHN_RP_ID, nodeEnv);
	const rpName = required(env.ADMIN_WEBAUTHN_RP_NAME, "ADMIN_WEBAUTHN_RP_NAME");
	if (rpName.length > 80) {
		throw new Error("ADMIN_WEBAUTHN_RP_NAME 最长 80 个字符");
	}

	return Object.freeze({
		enabled: true,
		database: Object.freeze({
			enabled: true,
			connectionString: connection.value,
			ssl: Object.freeze({
				rejectUnauthorized: true as const,
				...(ca === undefined ? {} : { ca }),
			}),
			poolMaximum: boundedInteger(
				env.ADMIN_DATABASE_POOL_MAX,
				4,
				"ADMIN_DATABASE_POOL_MAX",
				1,
				10,
			),
			connectionTimeoutMs: boundedInteger(
				env.ADMIN_DATABASE_CONNECT_TIMEOUT_MS,
				5_000,
				"ADMIN_DATABASE_CONNECT_TIMEOUT_MS",
				500,
				15_000,
			),
			idleTimeoutMs: boundedInteger(
				env.ADMIN_DATABASE_IDLE_TIMEOUT_MS,
				15_000,
				"ADMIN_DATABASE_IDLE_TIMEOUT_MS",
				1_000,
				60_000,
			),
		}),
		webauthn: Object.freeze({
			rpName,
			rpId,
			expectedOrigins: readOrigins(env.ADMIN_WEBAUTHN_ORIGINS, rpId, nodeEnv),
		}),
		hmacKeys: readCryptoKeys(env.ADMIN_HMAC_KEYS, "ADMIN_HMAC_KEYS"),
		credentialEncryptionKeys: readCryptoKeys(
			env.ADMIN_CREDENTIAL_ENCRYPTION_KEYS,
			"ADMIN_CREDENTIAL_ENCRYPTION_KEYS",
		),
	});
}
