import { ExportLocatorKeyRing } from "./export-artifact-crypto.js";

const VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const REGION_PATTERN = /^oss-cn-[a-z0-9-]{2,32}$/u;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const RAM_ROLE_PATTERN = /^[A-Za-z0-9.@_-]{1,64}$/u;

export interface ExportArtifactRuntimeConfig {
	readonly enabled: boolean;
	readonly region: string;
	readonly bucket: string;
	readonly internal: boolean;
	readonly timeoutMs: number;
	readonly credentialTimeoutMs: number;
	readonly maximumArtifactBytes: number;
	readonly ramRoleName: string;
	readonly disableImdsV1: true;
	readonly enableImdsV2: true;
	readonly locatorKeyRing: ExportLocatorKeyRing | null;
}

export function loadExportArtifactRuntimeConfig(
	env: NodeJS.ProcessEnv,
	nodeEnvironment: "development" | "test" | "production",
): ExportArtifactRuntimeConfig {
	const enabled = readBoolean(
		env.DATA_EXPORT_ENABLED,
		"DATA_EXPORT_ENABLED",
		false,
	);
	if (!enabled) return disabledConfig();

	const region = env.DATA_EXPORT_OSS_REGION?.trim() ?? "";
	if (!REGION_PATTERN.test(region)) {
		throw new Error("DATA_EXPORT_OSS_REGION 格式无效");
	}
	if (nodeEnvironment === "production" && region !== "oss-cn-beijing") {
		throw new Error("生产数据导出工件必须存放在阿里云北京地域");
	}
	const bucket = env.DATA_EXPORT_OSS_BUCKET?.trim() ?? "";
	if (!BUCKET_PATTERN.test(bucket)) {
		throw new Error("DATA_EXPORT_OSS_BUCKET 格式无效");
	}
	const internal = readBoolean(
		env.DATA_EXPORT_OSS_INTERNAL,
		"DATA_EXPORT_OSS_INTERNAL",
		nodeEnvironment === "production",
	);
	if (nodeEnvironment === "production" && !internal) {
		throw new Error("生产数据导出工作器必须使用OSS北京内网接入点");
	}
	const ramRoleName = env.ALIBABA_CLOUD_ECS_METADATA?.trim() ?? "";
	if (!RAM_ROLE_PATTERN.test(ramRoleName)) {
		throw new Error("数据导出OSS必须声明合法的ECS RAM角色名");
	}
	if (
		readBoolean(
			env.ALIBABA_CLOUD_ECS_METADATA_DISABLED,
			"ALIBABA_CLOUD_ECS_METADATA_DISABLED",
			false,
		)
	) {
		throw new Error("数据导出OSS禁止关闭ECS RAM角色元数据凭据");
	}
	if (
		!readBoolean(
			env.ALIBABA_CLOUD_IMDSV1_DISABLED,
			"ALIBABA_CLOUD_IMDSV1_DISABLED",
			false,
		) ||
		!readBoolean(
			env.ALIBABA_CLOUD_ECS_IMDSV2_ENABLE,
			"ALIBABA_CLOUD_ECS_IMDSV2_ENABLE",
			false,
		)
	) {
		throw new Error("数据导出OSS必须强制使用IMDSv2并关闭IMDSv1");
	}
	const activeVersion = env.DATA_EXPORT_LOCATOR_ACTIVE_VERSION?.trim() ?? "";
	if (!VERSION_PATTERN.test(activeVersion)) {
		throw new Error("DATA_EXPORT_LOCATOR_ACTIVE_VERSION 格式无效");
	}
	const keyMap = decodeKeys(env.DATA_EXPORT_LOCATOR_KEYS_JSON);
	let locatorKeyRing: ExportLocatorKeyRing | null = null;
	try {
		locatorKeyRing = new ExportLocatorKeyRing(activeVersion, keyMap);
		return Object.freeze({
			enabled: true,
			region,
			bucket,
			internal,
			timeoutMs: readInteger(
				env.DATA_EXPORT_OSS_TIMEOUT_MS,
				"DATA_EXPORT_OSS_TIMEOUT_MS",
				10_000,
				1_000,
				30_000,
			),
			credentialTimeoutMs: readInteger(
				env.DATA_EXPORT_CREDENTIAL_TIMEOUT_MS,
				"DATA_EXPORT_CREDENTIAL_TIMEOUT_MS",
				3_000,
				500,
				10_000,
			),
			maximumArtifactBytes: readInteger(
				env.DATA_EXPORT_MAX_ARTIFACT_BYTES,
				"DATA_EXPORT_MAX_ARTIFACT_BYTES",
				10 * 1024 * 1024,
				1024,
				10 * 1024 * 1024,
			),
			ramRoleName,
			disableImdsV1: true,
			enableImdsV2: true,
			locatorKeyRing,
		});
	} catch (error) {
		locatorKeyRing?.destroy();
		throw error;
	} finally {
		for (const key of keyMap.values()) key.fill(0);
		keyMap.clear();
	}
}

function disabledConfig(): ExportArtifactRuntimeConfig {
	return Object.freeze({
		enabled: false,
		region: "",
		bucket: "",
		internal: false,
		timeoutMs: 10_000,
		credentialTimeoutMs: 3_000,
		maximumArtifactBytes: 10 * 1024 * 1024,
		ramRoleName: "",
		disableImdsV1: true,
		enableImdsV2: true,
		locatorKeyRing: null,
	});
}

function readBoolean(
	raw: string | undefined,
	name: string,
	fallback: boolean,
): boolean {
	if (raw === undefined || raw === "") return fallback;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new Error(`${name} 必须是 true 或 false`);
}

function readInteger(
	raw: string | undefined,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
	}
	return value;
}

function decodeKeys(raw: string | undefined): Map<string, Buffer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw ?? "");
	} catch {
		throw new Error("DATA_EXPORT_LOCATOR_KEYS_JSON 必须是有效JSON对象");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("DATA_EXPORT_LOCATOR_KEYS_JSON 必须是密钥版本对象");
	}
	const entries = Object.entries(parsed);
	if (entries.length < 1 || entries.length > 3) {
		throw new Error("DATA_EXPORT_LOCATOR_KEYS_JSON 只允许一到三个版本");
	}
	const keys = new Map<string, Buffer>();
	try {
		for (const [version, encoded] of entries) {
			if (!VERSION_PATTERN.test(version) || typeof encoded !== "string") {
				throw new Error("导出定位符密钥包含无效版本或值");
			}
			const bytes = Buffer.from(encoded, "base64");
			if (bytes.toString("base64") !== encoded || bytes.byteLength !== 32) {
				bytes.fill(0);
				throw new Error("导出定位符密钥必须是规范Base64编码的32字节值");
			}
			keys.set(version, bytes);
		}
		return keys;
	} catch (error) {
		for (const key of keys.values()) key.fill(0);
		keys.clear();
		throw error;
	}
}
