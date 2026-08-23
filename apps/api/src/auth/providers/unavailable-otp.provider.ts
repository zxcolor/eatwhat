import {
	type OtpDeliveryChannel,
	type OtpDeliveryProvider,
	type OtpDeliveryRequest,
	OtpDeliveryUnavailableError,
} from "./otp-delivery.provider.js";

/**
 * Production-safe placeholder until an audited server-side Aliyun client is
 * injected. It never logs, queues, or pretends to deliver an OTP.
 */
export class UnavailableOtpDeliveryProvider implements OtpDeliveryProvider {
	constructor(readonly channel: OtpDeliveryChannel) {}

	send(_request: OtpDeliveryRequest): Promise<never> {
		return Promise.reject(new OtpDeliveryUnavailableError("DISABLED"));
	}
}
