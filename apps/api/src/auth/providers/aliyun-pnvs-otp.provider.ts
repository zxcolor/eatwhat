import { SafeAliyunSdkError } from "./aliyun-official.clients.js";
import {
	type OtpDeliveryReceipt,
	type OtpDeliveryRequest,
	OtpDeliveryUnavailableError,
	type PhoneOtpProvider,
	type PhoneOtpVerificationRequest,
	validateOtpDeliveryRequest,
	validatePhoneOtpVerificationRequest,
} from "./otp-delivery.provider.js";

export interface AliyunPnvsSendRequest {
	readonly autoRetry: number;
	readonly countryCode: string;
	readonly phoneNumber: string;
	readonly signName: string;
	readonly templateCode: string;
	readonly templateParam: string;
	readonly codeLength: number;
	readonly validTime: number;
	readonly duplicatePolicy: number;
	readonly interval: number;
	readonly codeType: number;
	readonly returnVerifyCode: boolean;
	readonly outId: string;
}

export interface AliyunPnvsCheckRequest {
	readonly countryCode: string;
	readonly phoneNumber: string;
	readonly verifyCode: string;
	readonly outId: string;
}

export interface AliyunPnvsRuntimeOptions {
	readonly autoretry: false;
	readonly maxAttempts: 1;
	readonly connectTimeout: number;
	readonly readTimeout: number;
	readonly keepAlive: false;
	readonly maxIdleConns: 1;
}

export interface AliyunPnvsSendResponse {
	readonly body?: {
		readonly code?: unknown;
		readonly success?: unknown;
		readonly model?: { readonly bizId?: unknown; readonly outId?: unknown };
	};
}

export interface AliyunPnvsCheckResponse {
	readonly body?: {
		readonly code?: unknown;
		readonly success?: unknown;
		readonly model?: { readonly verifyResult?: unknown };
	};
}

export interface AliyunPnvsClient {
	sendSmsVerifyCodeWithOptions(
		request: AliyunPnvsSendRequest,
		runtime: AliyunPnvsRuntimeOptions,
	): Promise<AliyunPnvsSendResponse>;
	checkSmsVerifyCodeWithOptions(
		request: AliyunPnvsCheckRequest,
		runtime: AliyunPnvsRuntimeOptions,
	): Promise<AliyunPnvsCheckResponse>;
}

export interface AliyunPnvsOtpConfig {
	readonly enabled: boolean;
	readonly signName: string | null;
	readonly templateCode: string | null;
	readonly timeoutMs: number;
	readonly resendDelayMs: number;
}

function safeBizId(value: unknown): string | null {
	return typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 256 &&
		/^[A-Za-z0-9._^:-]+$/u.test(value)
		? value
		: null;
}

export class AliyunPnvsOtpProvider implements PhoneOtpProvider {
	readonly channel = "PHONE" as const;

	constructor(
		private readonly config: AliyunPnvsOtpConfig,
		private readonly client: AliyunPnvsClient,
	) {}

	async send(request: OtpDeliveryRequest): Promise<OtpDeliveryReceipt> {
		this.assertEnabled();
		validateOtpDeliveryRequest(request, this.channel);
		const validTime = Math.max(
			120,
			Math.min(
				600,
				Math.ceil((request.expiresAt.getTime() - Date.now()) / 1_000),
			),
		);
		try {
			const response = await this.client.sendSmsVerifyCodeWithOptions(
				{
					autoRetry: 0,
					countryCode: "86",
					phoneNumber: request.destination.slice(3),
					signName: this.config.signName as string,
					templateCode: this.config.templateCode as string,
					templateParam: JSON.stringify({
						code: "##code##",
						min: String(Math.ceil(validTime / 60)),
					}),
					codeLength: 6,
					validTime,
					duplicatePolicy: 1,
					interval: Math.max(60, Math.ceil(this.config.resendDelayMs / 1_000)),
					codeType: 1,
					returnVerifyCode: false,
					outId: request.idempotencyKey,
				},
				this.runtime(),
			);
			if (response.body?.code !== "OK" || response.body.success !== true) {
				throw new OtpDeliveryUnavailableError("UPSTREAM_REJECTED");
			}
			const reference = safeBizId(response.body.model?.bizId);
			if (reference === null) {
				throw new OtpDeliveryUnavailableError("UPSTREAM_REJECTED");
			}
			return Object.freeze({
				provider: "ALIYUN_PNVS" as const,
				requestReference: reference,
			});
		} catch (error) {
			this.mapFailure(error);
		}
	}

	async verify(request: PhoneOtpVerificationRequest): Promise<boolean> {
		this.assertEnabled();
		validatePhoneOtpVerificationRequest(request);
		try {
			const response = await this.client.checkSmsVerifyCodeWithOptions(
				{
					countryCode: "86",
					phoneNumber: request.destination.slice(3),
					verifyCode: request.code,
					outId: request.idempotencyKey,
				},
				this.runtime(),
			);
			if (response.body?.code !== "OK" || response.body.success !== true) {
				throw new OtpDeliveryUnavailableError("UPSTREAM_REJECTED");
			}
			const verifyResult = response.body.model?.verifyResult;
			if (verifyResult === "PASS") return true;
			if (verifyResult === "UNKNOWN") return false;
			throw new OtpDeliveryUnavailableError("UPSTREAM_REJECTED");
		} catch (error) {
			this.mapFailure(error);
		}
	}

	private assertEnabled(): void {
		if (
			!this.config.enabled ||
			this.config.signName === null ||
			this.config.templateCode === null
		) {
			throw new OtpDeliveryUnavailableError("DISABLED");
		}
	}

	private runtime(): AliyunPnvsRuntimeOptions {
		return Object.freeze({
			autoretry: false as const,
			maxAttempts: 1 as const,
			connectTimeout: this.config.timeoutMs,
			readTimeout: this.config.timeoutMs,
			keepAlive: false as const,
			maxIdleConns: 1 as const,
		});
	}

	private mapFailure(error: unknown): never {
		if (error instanceof OtpDeliveryUnavailableError) throw error;
		if (error instanceof SafeAliyunSdkError) {
			throw new OtpDeliveryUnavailableError(error.reason);
		}
		if (typeof error === "object" && error !== null) {
			const value = error as {
				readonly name?: unknown;
				readonly code?: unknown;
			};
			if (
				value.name === "AbortError" ||
				value.code === "ETIMEDOUT" ||
				value.code === "ESOCKETTIMEDOUT"
			) {
				throw new OtpDeliveryUnavailableError("TIMEOUT");
			}
		}
		throw new OtpDeliveryUnavailableError("NETWORK_ERROR");
	}
}
