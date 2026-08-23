import { SafeAliyunSdkError } from "./aliyun-official.clients.js";
import {
	type OtpDeliveryProvider,
	type OtpDeliveryReceipt,
	type OtpDeliveryRequest,
	OtpDeliveryUnavailableError,
	validateOtpDeliveryRequest,
} from "./otp-delivery.provider.js";

export interface AliyunSmsSendRequest {
	readonly phoneNumbers: string;
	readonly signName: string;
	readonly templateCode: string;
	readonly templateParam: string;
	readonly outId: string;
}

export interface AliyunSmsRuntimeOptions {
	readonly autoretry: false;
	readonly maxAttempts: 1;
	readonly connectTimeout: number;
	readonly readTimeout: number;
	readonly keepAlive: false;
	readonly maxIdleConns: 1;
}

export interface AliyunSmsSendResponse {
	readonly body?: {
		readonly code?: unknown;
		readonly bizId?: unknown;
		readonly requestId?: unknown;
	};
}

export interface AliyunSmsClient {
	sendSmsWithOptions(
		request: AliyunSmsSendRequest,
		runtime: AliyunSmsRuntimeOptions,
	): Promise<AliyunSmsSendResponse>;
}

export interface AliyunSmsOtpConfig {
	readonly enabled: boolean;
	readonly signName: string | null;
	readonly templateCode: string | null;
	readonly timeoutMs: number;
}

function safeReference(value: unknown): string | null {
	return typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 128 &&
		/^[A-Za-z0-9_-]+$/u.test(value)
		? value
		: null;
}

export class AliyunSmsOtpDeliveryProvider implements OtpDeliveryProvider {
	readonly channel = "PHONE" as const;

	constructor(
		private readonly config: AliyunSmsOtpConfig,
		private readonly client: AliyunSmsClient,
	) {}

	async send(request: OtpDeliveryRequest): Promise<OtpDeliveryReceipt> {
		if (
			!this.config.enabled ||
			this.config.signName === null ||
			this.config.templateCode === null
		) {
			throw new OtpDeliveryUnavailableError("DISABLED");
		}
		validateOtpDeliveryRequest(request, this.channel);
		try {
			const response = await this.client.sendSmsWithOptions(
				{
					phoneNumbers: request.destination.slice(3),
					signName: this.config.signName,
					templateCode: this.config.templateCode,
					templateParam: JSON.stringify({ code: request.code }),
					// SendSms itself is not idempotent. outId is trace correlation only;
					// the challenge store must atomically prevent duplicate submissions.
					outId: request.idempotencyKey,
				},
				{
					autoretry: false,
					maxAttempts: 1,
					connectTimeout: this.config.timeoutMs,
					readTimeout: this.config.timeoutMs,
					keepAlive: false,
					maxIdleConns: 1,
				},
			);
			if (response.body?.code !== "OK") {
				throw new OtpDeliveryUnavailableError("UPSTREAM_REJECTED");
			}
			// BizId is the SendSms delivery receipt identifier. RequestId only
			// identifies the API call and must not be persisted as delivery evidence.
			const reference = safeReference(response.body.bizId);
			if (reference === null) {
				throw new OtpDeliveryUnavailableError("UPSTREAM_REJECTED");
			}
			return Object.freeze({
				provider: "ALIYUN_SMS" as const,
				requestReference: reference,
			});
		} catch (error) {
			if (error instanceof OtpDeliveryUnavailableError) throw error;
			throw new OtpDeliveryUnavailableError(classifyTransportFailure(error));
		}
	}
}

function classifyTransportFailure(
	error: unknown,
): "TIMEOUT" | "UPSTREAM_REJECTED" | "NETWORK_ERROR" {
	if (error instanceof SafeAliyunSdkError) {
		return error.reason;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		("name" in error || "code" in error)
	) {
		const name = "name" in error ? error.name : null;
		const code = "code" in error ? error.code : null;
		if (
			name === "AbortError" ||
			code === "ETIMEDOUT" ||
			code === "ESOCKETTIMEDOUT"
		) {
			return "TIMEOUT";
		}
	}
	return "NETWORK_ERROR";
}
