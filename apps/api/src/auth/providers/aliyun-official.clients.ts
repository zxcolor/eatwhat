import CredentialPackage from "@alicloud/credentials";
import DysmsapiPackage, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { RuntimeOptions } from "@darabonba/typescript";
import type { AppConfig } from "../../config/app-config.js";
import type {
	AliyunSmsClient,
	AliyunSmsRuntimeOptions,
	AliyunSmsSendRequest,
	AliyunSmsSendResponse,
} from "./aliyun-sms-otp.provider.js";

const SMS_ENDPOINT = "dysmsapi.aliyuncs.com";
const SAFE_CREDENTIAL_FAILURE = "账号阿里云短信凭据不可用";
const SAFE_UPSTREAM_FAILURE = "阿里云短信请求失败";

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
const SmsClientConstructor =
	resolveCommonJsConstructor<typeof DysmsapiPackage.default>(DysmsapiPackage);

export interface AliyunCredentialModelLike {
	readonly accessKeyId?: string;
	readonly accessKeySecret?: string;
	readonly type?: string;
	readonly providerName?: string;
}

export interface AliyunCredentialLike {
	getCredential(): Promise<AliyunCredentialModelLike>;
}

interface OfficialSmsSdkClient {
	sendSmsWithOptions(
		request: SendSmsRequest,
		runtime: RuntimeOptions,
	): Promise<AliyunSmsSendResponse>;
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
	createSmsSdkClient(
		credential: AliyunCredentialLike,
		timeoutMs: number,
	): OfficialSmsSdkClient;
}

const OFFICIAL_DEPENDENCIES: AliyunOfficialClientDependencies = Object.freeze({
	createCredential: () => new CredentialConstructor(),
	createSmsSdkClient: (credential: AliyunCredentialLike, timeoutMs: number) =>
		new SmsClientConstructor(
			new $OpenApiUtil.Config({
				credential: credential as OfficialCredential,
				endpoint: SMS_ENDPOINT,
				protocol: "HTTPS",
				connectTimeout: timeoutMs,
				readTimeout: timeoutMs,
				maxIdleConns: 1,
			}),
		),
});

function deliveryEnabled(config: AppConfig): boolean {
	return config.auth.phone.enabled;
}

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

/**
 * Builds and verifies the official default credential chain before Nest starts.
 * The returned handle refreshes temporary RAM-role credentials inside Alibaba's
 * official library; this function never copies credentials into app config.
 */
export async function createAliyunCredential(
	config: AppConfig,
	dependencies: AliyunOfficialClientDependencies = OFFICIAL_DEPENDENCIES,
): Promise<AliyunCredentialLike | undefined> {
	if (!deliveryEnabled(config)) return undefined;

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
		// Never retain the SDK exception: the default chain can include profile
		// paths, metadata response bodies, AccessKey identifiers, or upstream text.
		throw new Error(SAFE_CREDENTIAL_FAILURE);
	}
}

export function createOfficialAliyunSmsClient(
	config: AppConfig,
	credential: AliyunCredentialLike | undefined,
	dependencies: AliyunOfficialClientDependencies = OFFICIAL_DEPENDENCIES,
): AliyunSmsClient | undefined {
	if (!config.auth.phone.enabled) return undefined;
	if (credential === undefined) throw new Error(SAFE_CREDENTIAL_FAILURE);
	return new OfficialAliyunSmsClient(
		dependencies.createSmsSdkClient(credential, config.auth.phone.timeoutMs),
	);
}

class OfficialAliyunSmsClient implements AliyunSmsClient {
	constructor(private readonly client: OfficialSmsSdkClient) {}

	async sendSmsWithOptions(
		request: AliyunSmsSendRequest,
		runtime: AliyunSmsRuntimeOptions,
	): Promise<AliyunSmsSendResponse> {
		try {
			const response = await this.client.sendSmsWithOptions(
				new SendSmsRequest({
					phoneNumbers: request.phoneNumbers,
					signName: request.signName,
					templateCode: request.templateCode,
					templateParam: request.templateParam,
					outId: request.outId,
				}),
				new RuntimeOptions({ ...runtime }),
			);
			return response;
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
