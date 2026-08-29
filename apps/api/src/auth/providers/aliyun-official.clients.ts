import CredentialPackage from "@alicloud/credentials";
import DypnsapiPackage, {
	CheckSmsVerifyCodeRequest,
	SendSmsVerifyCodeRequest,
} from "@alicloud/dypnsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { RuntimeOptions } from "@darabonba/typescript";
import type { AppConfig } from "../../config/app-config.js";
import type {
	AliyunPnvsCheckRequest,
	AliyunPnvsCheckResponse,
	AliyunPnvsClient,
	AliyunPnvsRuntimeOptions,
	AliyunPnvsSendRequest,
	AliyunPnvsSendResponse,
} from "./aliyun-pnvs-otp.provider.js";

const PNVS_ENDPOINT = "dypnsapi.aliyuncs.com";
const SAFE_CREDENTIAL_FAILURE = "账号阿里云认证凭据不可用";
const SAFE_UPSTREAM_FAILURE = "阿里云认证请求失败";

type OfficialCredential = InstanceType<typeof CredentialPackage.default>;

function resolveCommonJsConstructor<T>(value: unknown): T {
	if (typeof value === "function") return value as T;
	if (typeof value === "object" && value !== null && "default" in value) {
		const nestedDefault = (value as { readonly default?: unknown }).default;
		if (typeof nestedDefault === "function") return nestedDefault as T;
	}
	throw new Error("阿里云官方 SDK 导出不可用");
}

const CredentialConstructor =
	resolveCommonJsConstructor<typeof CredentialPackage.default>(
		CredentialPackage,
	);
const PnvsClientConstructor =
	resolveCommonJsConstructor<typeof DypnsapiPackage.default>(DypnsapiPackage);

export interface AliyunCredentialModelLike {
	readonly accessKeyId?: string;
	readonly accessKeySecret?: string;
	readonly type?: string;
	readonly providerName?: string;
}

export interface AliyunCredentialLike {
	getCredential(): Promise<AliyunCredentialModelLike>;
}

interface OfficialPnvsSdkClient {
	sendSmsVerifyCodeWithOptions(
		request: SendSmsVerifyCodeRequest,
		runtime: RuntimeOptions,
	): Promise<AliyunPnvsSendResponse>;
	checkSmsVerifyCodeWithOptions(
		request: CheckSmsVerifyCodeRequest,
		runtime: RuntimeOptions,
	): Promise<AliyunPnvsCheckResponse>;
}

export type SafeAliyunFailureReason =
	| "TIMEOUT"
	| "UPSTREAM_REJECTED"
	| "NETWORK_ERROR";

export class SafeAliyunSdkError extends Error {
	constructor(readonly reason: SafeAliyunFailureReason) {
		super(SAFE_UPSTREAM_FAILURE);
		this.name = "SafeAliyunSdkError";
	}
}

export interface AliyunOfficialClientDependencies {
	createCredential(): AliyunCredentialLike;
	createPnvsSdkClient(
		credential: AliyunCredentialLike,
		timeoutMs: number,
	): OfficialPnvsSdkClient;
}

const OFFICIAL_DEPENDENCIES: AliyunOfficialClientDependencies = Object.freeze({
	createCredential: () => new CredentialConstructor(),
	createPnvsSdkClient: (credential: AliyunCredentialLike, timeoutMs: number) =>
		new PnvsClientConstructor(
			new $OpenApiUtil.Config({
				credential: credential as OfficialCredential,
				endpoint: PNVS_ENDPOINT,
				protocol: "HTTPS",
				connectTimeout: timeoutMs,
				readTimeout: timeoutMs,
				maxIdleConns: 1,
			}),
		),
});

function usableCredential(model: AliyunCredentialModelLike): boolean {
	return (
		typeof model.accessKeyId === "string" &&
		model.accessKeyId.length > 0 &&
		typeof model.accessKeySecret === "string" &&
		model.accessKeySecret.length > 0 &&
		model.type !== "bearer"
	);
}

async function getCredentialBeforeDeadline(
	credential: AliyunCredentialLike,
	timeoutMs: number,
): Promise<AliyunCredentialModelLike> {
	let timeoutHandle: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeoutHandle = setTimeout(
			() => reject(new Error(SAFE_CREDENTIAL_FAILURE)),
			timeoutMs,
		);
		timeoutHandle.unref();
	});
	try {
		return await Promise.race([credential.getCredential(), deadline]);
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	}
}

export async function createAliyunCredential(
	config: AppConfig,
	dependencies: AliyunOfficialClientDependencies = OFFICIAL_DEPENDENCIES,
): Promise<AliyunCredentialLike | undefined> {
	if (!config.auth.phone.enabled) return undefined;
	try {
		const credential = dependencies.createCredential();
		const model = await getCredentialBeforeDeadline(
			credential,
			config.auth.aliyunCredentialTimeoutMs,
		);
		if (!usableCredential(model)) throw new Error(SAFE_CREDENTIAL_FAILURE);
		if (
			config.auth.aliyunCredentialAllowedProvider !== null &&
			model.providerName !== config.auth.aliyunCredentialAllowedProvider
		) {
			throw new Error(SAFE_CREDENTIAL_FAILURE);
		}
		return credential;
	} catch {
		throw new Error(SAFE_CREDENTIAL_FAILURE);
	}
}

export function createOfficialAliyunPnvsClient(
	config: AppConfig,
	credential: AliyunCredentialLike | undefined,
	dependencies: AliyunOfficialClientDependencies = OFFICIAL_DEPENDENCIES,
): AliyunPnvsClient | undefined {
	if (!config.auth.phone.enabled) return undefined;
	if (credential === undefined) throw new Error(SAFE_CREDENTIAL_FAILURE);
	return new OfficialAliyunPnvsClient(
		dependencies.createPnvsSdkClient(credential, config.auth.phone.timeoutMs),
	);
}

class OfficialAliyunPnvsClient implements AliyunPnvsClient {
	constructor(private readonly client: OfficialPnvsSdkClient) {}

	async sendSmsVerifyCodeWithOptions(
		request: AliyunPnvsSendRequest,
		runtime: AliyunPnvsRuntimeOptions,
	): Promise<AliyunPnvsSendResponse> {
		try {
			return await this.client.sendSmsVerifyCodeWithOptions(
				new SendSmsVerifyCodeRequest({ ...request }),
				new RuntimeOptions({ ...runtime }),
			);
		} catch (error) {
			throw new SafeAliyunSdkError(classifySdkFailure(error));
		}
	}

	async checkSmsVerifyCodeWithOptions(
		request: AliyunPnvsCheckRequest,
		runtime: AliyunPnvsRuntimeOptions,
	): Promise<AliyunPnvsCheckResponse> {
		try {
			return await this.client.checkSmsVerifyCodeWithOptions(
				new CheckSmsVerifyCodeRequest({ ...request }),
				new RuntimeOptions({ ...runtime }),
			);
		} catch (error) {
			throw new SafeAliyunSdkError(classifySdkFailure(error));
		}
	}
}

function primitiveField(
	error: unknown,
	field: "name" | "code" | "statusCode",
): string | number | undefined {
	if (typeof error !== "object" || error === null || !(field in error)) {
		return undefined;
	}
	const value = (error as Record<PropertyKey, unknown>)[field];
	return typeof value === "string" || typeof value === "number"
		? value
		: undefined;
}

function classifySdkFailure(error: unknown): SafeAliyunFailureReason {
	const name = primitiveField(error, "name");
	const code = primitiveField(error, "code");
	const statusCode = primitiveField(error, "statusCode");
	if (
		name === "AbortError" ||
		code === "ETIMEDOUT" ||
		code === "ESOCKETTIMEDOUT" ||
		code === "ECONNABORTED"
	) {
		return "TIMEOUT";
	}
	if (
		statusCode === 429 ||
		(typeof code === "string" &&
			(code === "Throttling" || code.startsWith("Throttling.")))
	) {
		return "UPSTREAM_REJECTED";
	}
	if (
		typeof statusCode === "number" ||
		(typeof code === "string" && code.length > 0)
	) {
		return "UPSTREAM_REJECTED";
	}
	return "NETWORK_ERROR";
}
