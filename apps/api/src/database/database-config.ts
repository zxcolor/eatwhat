export type NodeEnvironment = "development" | "test" | "production";
export type AuthSchemaTransitionMode =
	| "none"
	| "legacy_phone_drain"
	| "wechat_union_aliases_pending";

export type DatabaseSslConfig =
	| false
	| Readonly<{
			rejectUnauthorized: true;
			ca?: string;
	  }>;

export interface DatabaseConfig {
	readonly enabled: boolean;
	readonly authSchemaTransitionMode: AuthSchemaTransitionMode;
	readonly connectionString: string | null;
	readonly ssl: DatabaseSslConfig;
	readonly poolMaximum: number;
	readonly connectionTimeoutMs: number;
	readonly idleTimeoutMs: number;
}

export interface MigrationDatabaseConfig {
	readonly connectionString: string;
	readonly ssl: DatabaseSslConfig;
}

export type MaintenanceDatabaseConfig = MigrationDatabaseConfig;
export type ExportWorkerDatabaseConfig = MigrationDatabaseConfig;

function readStrictBoolean(
	value: string | undefined,
	name: string,
	fallback: boolean,
): boolean {
	if (value === undefined || value === "") return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} 必须是 true 或 false`);
}

function readBoundedInteger(
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

function readAuthSchemaTransitionMode(
	value: string | undefined,
): AuthSchemaTransitionMode {
	const normalized = value === undefined || value === "" ? "none" : value;
	if (
		normalized !== "none" &&
		normalized !== "legacy_phone_drain" &&
		normalized !== "wechat_union_aliases_pending"
	) {
		throw new Error(
			"AUTH_SCHEMA_TRANSITION_MODE 只允许 none、legacy_phone_drain 或 wechat_union_aliases_pending",
		);
	}
	return normalized;
}

interface ParsedDatabaseUrl {
	readonly value: string;
	readonly username: string;
	readonly target: string;
}

function readDatabaseUrl(
	raw: string | undefined,
	name: string,
): ParsedDatabaseUrl {
	const value = raw?.trim() ?? "";
	if (value.length === 0) {
		throw new Error(`${name} 在数据库启用时不能为空`);
	}
	if (value !== raw || /\s/.test(value)) {
		throw new Error(`${name} 格式无效`);
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} 必须是有效的 PostgreSQL URL`);
	}
	if (url.protocol !== "postgresql:") {
		throw new Error(`${name} 必须使用 postgresql 协议`);
	}
	if (
		url.username.length === 0 ||
		url.password.length === 0 ||
		url.hostname.length === 0 ||
		url.pathname.length <= 1
	) {
		throw new Error(`${name} 必须包含用户名、密码、主机和数据库名`);
	}
	if (url.search.length > 0 || url.hash.length > 0) {
		throw new Error(`${name} 禁止包含查询参数或片段；TLS 必须单独配置`);
	}
	let username: string;
	let databaseName: string;
	try {
		username = decodeURIComponent(url.username);
		databaseName = decodeURIComponent(url.pathname.slice(1));
	} catch {
		throw new Error(`${name} 包含无效的百分号编码`);
	}
	if (
		username.length === 0 ||
		databaseName.length === 0 ||
		databaseName.includes("/")
	) {
		throw new Error(`${name} 的角色名或数据库名无效`);
	}
	return Object.freeze({
		value,
		username,
		target: `${url.hostname.toLowerCase()}:${url.port || "5432"}/${databaseName}`,
	});
}

function decodeOptionalCa(
	raw: string | undefined,
	name: string,
): string | undefined {
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
		throw new Error(`${name} 必须是有效的 Base64 PEM CA 证书`);
	}
	if (
		!decoded.startsWith("-----BEGIN CERTIFICATE-----\n") ||
		!decoded.trimEnd().endsWith("-----END CERTIFICATE-----")
	) {
		throw new Error(`${name} 必须解码为 PEM CA 证书`);
	}
	return decoded;
}

function readSslConfig(
	modeRaw: string | undefined,
	caRaw: string | undefined,
	modeName: string,
	caName: string,
	nodeEnv: NodeEnvironment,
): DatabaseSslConfig {
	const mode = modeRaw?.trim() || "disable";
	if (mode !== "disable" && mode !== "verify-full") {
		throw new Error(`${modeName} 只允许 disable 或 verify-full`);
	}
	if (nodeEnv === "production" && mode !== "verify-full") {
		throw new Error(`生产环境的 ${modeName} 必须为 verify-full`);
	}
	if (mode === "disable") {
		if ((caRaw?.trim() ?? "").length > 0) {
			throw new Error(`${caName} 只能在 verify-full 模式使用`);
		}
		return false;
	}
	const ca = decodeOptionalCa(caRaw, caName);
	return Object.freeze({
		rejectUnauthorized: true as const,
		...(ca === undefined ? {} : { ca }),
	});
}

function validateProductionConnectionIdentity(
	env: NodeJS.ProcessEnv,
	connection: ParsedDatabaseUrl,
	nodeEnv: NodeEnvironment,
	roleKind: "API" | "MIGRATION" | "MAINTENANCE" | "EXPORT_WORKER",
): void {
	if (nodeEnv !== "production") return;
	const expectedTarget = env.DATABASE_EXPECTED_TARGET?.trim() ?? "";
	if (
		expectedTarget.length === 0 ||
		expectedTarget.length > 300 ||
		/\s|[?#]/u.test(expectedTarget)
	) {
		throw new Error("生产环境必须配置合法的 DATABASE_EXPECTED_TARGET");
	}
	if (connection.target !== expectedTarget) {
		throw new Error("数据库连接未指向生产部署声明的目标数据库");
	}
	const roleNames = {
		API: env.DATABASE_RUNTIME_ROLE_NAME?.trim() ?? "",
		MIGRATION: env.DATABASE_MIGRATION_ROLE_NAME?.trim() ?? "",
		MAINTENANCE: env.DATABASE_MAINTENANCE_ROLE_NAME?.trim() ?? "",
		EXPORT_WORKER: env.DATABASE_EXPORT_WORKER_ROLE_NAME?.trim() ?? "",
	} as const;
	for (const roleName of Object.values(roleNames)) {
		if (!/^[a-z_][a-z0-9_]{1,62}$/u.test(roleName)) {
			throw new Error("生产环境必须声明四个合法的数据库角色名");
		}
	}
	if (new Set(Object.values(roleNames)).size !== 4) {
		throw new Error("生产环境的四类数据库角色必须两两不同");
	}
	if (connection.username !== roleNames[roleKind]) {
		throw new Error("数据库连接未使用该进程声明的最小权限角色");
	}
}

export function loadDatabaseConfig(
	env: NodeJS.ProcessEnv,
	nodeEnv: NodeEnvironment,
): DatabaseConfig {
	const authSchemaTransitionMode = readAuthSchemaTransitionMode(
		env.AUTH_SCHEMA_TRANSITION_MODE,
	);
	if (
		authSchemaTransitionMode === "legacy_phone_drain" &&
		readStrictBoolean(env.ACCOUNTS_ENABLED, "ACCOUNTS_ENABLED", false)
	) {
		throw new Error(
			"AUTH_SCHEMA_TRANSITION_MODE=legacy_phone_drain 时必须关闭 ACCOUNTS_ENABLED",
		);
	}
	if (
		authSchemaTransitionMode === "wechat_union_aliases_pending" &&
		readStrictBoolean(env.WECHAT_AUTH_ENABLED, "WECHAT_AUTH_ENABLED", false)
	) {
		throw new Error(
			"AUTH_SCHEMA_TRANSITION_MODE=wechat_union_aliases_pending 时必须关闭 WECHAT_AUTH_ENABLED",
		);
	}
	const enabled = readStrictBoolean(
		env.DATABASE_ENABLED,
		"DATABASE_ENABLED",
		nodeEnv === "production",
	);
	if (nodeEnv === "production" && !enabled) {
		throw new Error("生产环境禁止关闭 PostgreSQL 数据库");
	}

	const poolMaximum = readBoundedInteger(
		env.DATABASE_POOL_MAX,
		10,
		"DATABASE_POOL_MAX",
		1,
		50,
	);
	const connectionTimeoutMs = readBoundedInteger(
		env.DATABASE_CONNECT_TIMEOUT_MS,
		5_000,
		"DATABASE_CONNECT_TIMEOUT_MS",
		500,
		30_000,
	);
	const idleTimeoutMs = readBoundedInteger(
		env.DATABASE_IDLE_TIMEOUT_MS,
		30_000,
		"DATABASE_IDLE_TIMEOUT_MS",
		1_000,
		300_000,
	);

	if (!enabled) {
		return Object.freeze({
			enabled: false,
			authSchemaTransitionMode,
			connectionString: null,
			ssl: false,
			poolMaximum,
			connectionTimeoutMs,
			idleTimeoutMs,
		});
	}

	const parsedUrl = readDatabaseUrl(env.DATABASE_URL, "DATABASE_URL");
	validateProductionConnectionIdentity(env, parsedUrl, nodeEnv, "API");
	return Object.freeze({
		enabled: true,
		authSchemaTransitionMode,
		connectionString: parsedUrl.value,
		ssl: readSslConfig(
			env.DATABASE_SSL_MODE,
			env.DATABASE_SSL_CA_BASE64,
			"DATABASE_SSL_MODE",
			"DATABASE_SSL_CA_BASE64",
			nodeEnv,
		),
		poolMaximum,
		connectionTimeoutMs,
		idleTimeoutMs,
	});
}

export function loadMigrationDatabaseConfig(
	env: NodeJS.ProcessEnv,
	nodeEnv: NodeEnvironment,
): MigrationDatabaseConfig {
	const migrationUrl = readDatabaseUrl(
		env.DATABASE_MIGRATION_URL ??
			(nodeEnv === "production" ? undefined : env.DATABASE_URL),
		"DATABASE_MIGRATION_URL",
	);
	validateProductionConnectionIdentity(env, migrationUrl, nodeEnv, "MIGRATION");
	return Object.freeze({
		connectionString: migrationUrl.value,
		ssl: readSslConfig(
			env.DATABASE_MIGRATION_SSL_MODE ??
				(nodeEnv === "production" ? undefined : env.DATABASE_SSL_MODE),
			env.DATABASE_MIGRATION_SSL_CA_BASE64 ??
				(nodeEnv === "production" ? undefined : env.DATABASE_SSL_CA_BASE64),
			"DATABASE_MIGRATION_SSL_MODE",
			"DATABASE_MIGRATION_SSL_CA_BASE64",
			nodeEnv,
		),
	});
}

export function loadMaintenanceDatabaseConfig(
	env: NodeJS.ProcessEnv,
	nodeEnv: NodeEnvironment,
): MaintenanceDatabaseConfig {
	const maintenanceUrl = readDatabaseUrl(
		env.DATABASE_MAINTENANCE_URL ??
			(nodeEnv === "production" ? undefined : env.DATABASE_URL),
		"DATABASE_MAINTENANCE_URL",
	);
	validateProductionConnectionIdentity(
		env,
		maintenanceUrl,
		nodeEnv,
		"MAINTENANCE",
	);
	return Object.freeze({
		connectionString: maintenanceUrl.value,
		ssl: readSslConfig(
			env.DATABASE_MAINTENANCE_SSL_MODE ??
				(nodeEnv === "production" ? undefined : env.DATABASE_SSL_MODE),
			env.DATABASE_MAINTENANCE_SSL_CA_BASE64 ??
				(nodeEnv === "production" ? undefined : env.DATABASE_SSL_CA_BASE64),
			"DATABASE_MAINTENANCE_SSL_MODE",
			"DATABASE_MAINTENANCE_SSL_CA_BASE64",
			nodeEnv,
		),
	});
}

export function loadExportWorkerDatabaseConfig(
	env: NodeJS.ProcessEnv,
	nodeEnv: NodeEnvironment,
): ExportWorkerDatabaseConfig {
	const workerUrl = readDatabaseUrl(
		env.DATABASE_EXPORT_WORKER_URL ??
			(nodeEnv === "production" ? undefined : env.DATABASE_URL),
		"DATABASE_EXPORT_WORKER_URL",
	);
	validateProductionConnectionIdentity(
		env,
		workerUrl,
		nodeEnv,
		"EXPORT_WORKER",
	);
	return Object.freeze({
		connectionString: workerUrl.value,
		ssl: readSslConfig(
			env.DATABASE_EXPORT_WORKER_SSL_MODE ??
				(nodeEnv === "production" ? undefined : env.DATABASE_SSL_MODE),
			env.DATABASE_EXPORT_WORKER_SSL_CA_BASE64 ??
				(nodeEnv === "production" ? undefined : env.DATABASE_SSL_CA_BASE64),
			"DATABASE_EXPORT_WORKER_SSL_MODE",
			"DATABASE_EXPORT_WORKER_SSL_CA_BASE64",
			nodeEnv,
		),
	});
}

export function readNodeEnvironment(env: NodeJS.ProcessEnv): NodeEnvironment {
	const value = env.NODE_ENV ?? "development";
	if (value !== "development" && value !== "test" && value !== "production") {
		throw new Error("NODE_ENV 必须是 development、test 或 production");
	}
	return value;
}
