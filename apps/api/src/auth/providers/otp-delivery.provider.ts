export type OtpDeliveryChannel = "PHONE" | "EMAIL";

export interface OtpDeliveryRequest {
	readonly channel: OtpDeliveryChannel;
	readonly destination: string;
	readonly code: string;
	readonly idempotencyKey: string;
	readonly expiresAt: Date;
}

export interface OtpDeliveryReceipt {
	readonly provider: "ALIYUN_SMS" | "SMTP";
	readonly requestReference: string;
}

export type OtpDeliveryFailureReason =
	| "DISABLED"
	| "INVALID_REQUEST"
	| "UPSTREAM_REJECTED"
	| "TIMEOUT"
	| "NETWORK_ERROR";

export class OtpDeliveryUnavailableError extends Error {
	constructor(readonly reason: OtpDeliveryFailureReason) {
		super("验证码暂时无法发送");
		this.name = "OtpDeliveryUnavailableError";
	}
}

export interface OtpDeliveryProvider {
	readonly channel: OtpDeliveryChannel;
	send(request: OtpDeliveryRequest): Promise<OtpDeliveryReceipt>;
}

export function validateOtpDeliveryRequest(
	request: OtpDeliveryRequest,
	expectedChannel: OtpDeliveryChannel,
): void {
	const validDestination =
		expectedChannel === "PHONE"
			? /^\+861[3-9]\d{9}$/u.test(request.destination)
			: request.destination.length >= 3 &&
				request.destination.length <= 254 &&
				/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(request.destination);
	if (
		request.channel !== expectedChannel ||
		!validDestination ||
		!/^\d{6}$/u.test(request.code) ||
		!request.idempotencyKey.match(/^[A-Za-z0-9_-]{16,86}$/u) ||
		!Number.isFinite(request.expiresAt.getTime()) ||
		request.expiresAt.getTime() <= Date.now()
	) {
		throw new OtpDeliveryUnavailableError("INVALID_REQUEST");
	}
}
