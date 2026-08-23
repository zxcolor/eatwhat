import {
	type ExportWorkerDatabaseConfig,
	loadExportWorkerDatabaseConfig,
	readNodeEnvironment,
} from "../database/database-config.js";
import type { SupportFeedbackKeyRing } from "../support-feedback/support-feedback-crypto.js";
import {
	type ExportArtifactRuntimeConfig,
	loadExportArtifactRuntimeConfig,
} from "./export-artifact-config.js";
import type { ExportLocatorKeyRing } from "./export-artifact-crypto.js";

const WORKER_APPLICATION_ENVIRONMENT_NAMES = [
	"DATABASE_EXPORT_WORKER_URL",
	"DATABASE_EXPORT_WORKER_SSL_MODE",
	"DATABASE_EXPORT_WORKER_SSL_CA_BASE64",
	"DATABASE_EXPECTED_TARGET",
	"DATABASE_RUNTIME_ROLE_NAME",
	"DATABASE_MIGRATION_ROLE_NAME",
	"DATABASE_MAINTENANCE_ROLE_NAME",
	"DATABASE_EXPORT_WORKER_ROLE_NAME",
	"DATA_EXPORT_ENABLED",
	"DATA_EXPORT_OSS_REGION",
	"DATA_EXPORT_OSS_BUCKET",
	"DATA_EXPORT_OSS_INTERNAL",
	"DATA_EXPORT_OSS_TIMEOUT_MS",
	"DATA_EXPORT_CREDENTIAL_TIMEOUT_MS",
	"DATA_EXPORT_MAX_ARTIFACT_BYTES",
	"DATA_EXPORT_LOCATOR_ACTIVE_VERSION",
	"DATA_EXPORT_LOCATOR_KEYS_JSON",
	"DATA_EXPORT_WORKER_LEASE_SECONDS",
	"DATA_EXPORT_WORKER_POLL_INTERVAL_MS",
	"SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION",
	"SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON",
	"ALIBABA_CLOUD_ECS_METADATA",
	"ALIBABA_CLOUD_IMDSV1_DISABLED",
	"ALIBABA_CLOUD_ECS_IMDSV2_ENABLE",
	"ALIBABA_CLOUD_ECS_METADATA_DISABLED",
] as const;

/**
 * Exact non-application variables that the standalone Node process may inherit.
 *
 * Keep this list deliberately boring and explicit. In particular, do not add
 * NODE_OPTIONS, NODE_EXTRA_CA_CERTS, proxy variables, npm lifecycle variables,
 * cloud credential variables, or a prefix/regular-expression escape hatch.
 * Production launchers must start from an empty environment and inject only
 * these runtime names plus WORKER_APPLICATION_ENVIRONMENT_NAMES.
 */
const WORKER_RUNTIME_ENVIRONMENT_NAMES = [
	// Node/base-image runtime.
	"NODE_ENV",
	"NODE_VERSION",
	"PNPM_HOME",
	"YARN_VERSION",
	"TZ",
	// Linux/POSIX runtime.
	"PATH",
	"HOME",
	"HOSTNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_COLLATE",
	"LC_NUMERIC",
	"LC_TIME",
	"LC_MONETARY",
	"LC_PAPER",
	"LC_NAME",
	"LC_ADDRESS",
	"LC_TELEPHONE",
	"LC_MEASUREMENT",
	"LC_IDENTIFICATION",
	"PWD",
	"OLDPWD",
	"SHLVL",
	"SHELL",
	"TERM",
	"TMPDIR",
	// Windows local verification runtime. Casing variants are intentional:
	// process.env preserves the spelling supplied by the parent process.
	"Path",
	"HOMEDRIVE",
	"HOMEPATH",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"USERNAME",
	"USERDOMAIN",
	"COMPUTERNAME",
	"OS",
	"ComSpec",
	"COMSPEC",
	"PATHEXT",
	"SystemDrive",
	"SYSTEMDRIVE",
	"SystemRoot",
	"SYSTEMROOT",
	"windir",
	"WINDIR",
	"TEMP",
	"TMP",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROCESSOR_LEVEL",
	"PROCESSOR_REVISION",
] as const;

const WORKER_ALLOWED_ENVIRONMENT_NAMES = new Set<string>([
	...WORKER_APPLICATION_ENVIRONMENT_NAMES,
	...WORKER_RUNTIME_ENVIRONMENT_NAMES,
]);

export interface DataExportWorkerRuntimeConfig {
	readonly database: ExportWorkerDatabaseConfig;
	readonly artifacts: ExportArtifactRuntimeConfig & {
		readonly enabled: true;
		readonly locatorKeyRing: NonNullable<
			ExportArtifactRuntimeConfig["locatorKeyRing"]
		>;
	};
	readonly leaseSeconds: number;
	readonly pollIntervalMs: number;
}

export function loadDataExportWorkerRuntimeConfig(
	env: NodeJS.ProcessEnv,
): DataExportWorkerRuntimeConfig {
	assertIsolatedWorkerEnvironment(env);
	const nodeEnvironment = readNodeEnvironment(env);
	const artifacts = loadExportArtifactRuntimeConfig(env, nodeEnvironment);
	if (!artifacts.enabled || artifacts.locatorKeyRing === null) {
		throw new Error("数据导出工作器未启用");
	}
	const leaseSeconds = readInteger(
		env.DATA_EXPORT_WORKER_LEASE_SECONDS,
		"DATA_EXPORT_WORKER_LEASE_SECONDS",
		180,
		120,
		900,
	);
	if (leaseSeconds * 1_000 <= artifacts.timeoutMs * 4) {
		artifacts.locatorKeyRing.destroy();
		throw new Error("数据导出工作器租约必须显著长于对象存储超时");
	}
	try {
		return Object.freeze({
			database: loadExportWorkerDatabaseConfig(env, nodeEnvironment),
			artifacts: artifacts as DataExportWorkerRuntimeConfig["artifacts"],
			leaseSeconds,
			pollIntervalMs: readInteger(
				env.DATA_EXPORT_WORKER_POLL_INTERVAL_MS,
				"DATA_EXPORT_WORKER_POLL_INTERVAL_MS",
				1_000,
				250,
				30_000,
			),
		});
	} catch (error) {
		artifacts.locatorKeyRing.destroy();
		throw error;
	}
}

/**
 * Fails startup before any claim when retained encrypted rows reference a key
 * version absent from the isolated worker. Error text deliberately omits the
 * missing version so deployment logs do not become a crypto inventory.
 */
export function assertDataExportWorkerKeyCoverage(
	locatorKeyRing: ExportLocatorKeyRing,
	supportFeedbackEncryptionKeyRing: SupportFeedbackKeyRing,
	requiredLocatorVersions: readonly string[],
	requiredSupportEncryptionVersions: readonly string[],
): void {
	const requiredLocator = validatedRequiredVersions(requiredLocatorVersions);
	const requiredSupport = validatedRequiredVersions(
		requiredSupportEncryptionVersions,
	);
	const configuredSupport = new Set(
		supportFeedbackEncryptionKeyRing.versions(),
	);
	for (const version of requiredLocator) {
		const key = locatorKeyRing.key(version);
		if (key === null) throw new Error("数据导出工作器密钥覆盖检查失败");
		key.fill(0);
	}
	for (const version of requiredSupport) {
		if (!configuredSupport.has(version)) {
			throw new Error("数据导出工作器密钥覆盖检查失败");
		}
	}
}

function validatedRequiredVersions(values: readonly string[]): Set<string> {
	if (!Array.isArray(values) || values.length > 4) {
		throw new Error("数据导出工作器密钥覆盖检查失败");
	}
	const result = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/u.test(value)) {
			throw new Error("数据导出工作器密钥覆盖检查失败");
		}
		result.add(value);
	}
	return result;
}

function assertIsolatedWorkerEnvironment(env: NodeJS.ProcessEnv): void {
	for (const [name, rawValue] of Object.entries(env)) {
		if (rawValue === undefined || rawValue.trim() === "") continue;
		if (WORKER_ALLOWED_ENVIRONMENT_NAMES.has(name)) continue;
		throw new Error("数据导出工作器检测到禁止注入的非必要配置或密钥");
	}
}

function readInteger(
	raw: string | undefined,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
	}
	return parsed;
}
