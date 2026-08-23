import { describe, expect, it, vi } from "vitest";
import {
	type AliyunSmsClient,
	AliyunSmsOtpDeliveryProvider,
} from "./aliyun-sms-otp.provider.js";
import { OtpDeliveryUnavailableError } from "./otp-delivery.provider.js";
import {
	createVerifiedSmtpTransportClient,
	SmtpEmailOtpDeliveryProvider,
	type SmtpTransportClient,
} from "./smtp-email-otp.provider.js";

const expiresAt = new Date(Date.now() + 5 * 60_000);

describe("OTP delivery adapters", () => {
	it("sends one non-retried Aliyun SMS request with only the code variable", async () => {
		const client: AliyunSmsClient = {
			sendSmsWithOptions: vi.fn().mockResolvedValue({
				body: { code: "OK", bizId: "sms-request-1" },
			}),
		};
		const provider = new AliyunSmsOtpDeliveryProvider(
			{
				enabled: true,
				signName: "吃什么",
				templateCode: "SMS_123456",
				timeoutMs: 1_500,
			},
			client,
		);

		await expect(
			provider.send({
				channel: "PHONE",
				destination: "+8613800138000",
				code: "001204",
				idempotencyKey: "challenge_1234567890",
				expiresAt,
			}),
		).resolves.toEqual({
			provider: "ALIYUN_SMS",
			requestReference: "sms-request-1",
		});

		const call = vi.mocked(client.sendSmsWithOptions).mock.calls[0];
		expect(call?.[0]).toMatchObject({
			phoneNumbers: "13800138000",
			templateParam: '{"code":"001204"}',
			outId: "challenge_1234567890",
		});
		expect(call?.[1]).toEqual({
			autoretry: false,
			maxAttempts: 1,
			connectTimeout: 1_500,
			readTimeout: 1_500,
			keepAlive: false,
			maxIdleConns: 1,
		});
	});

	it("uses plain text SMTP and accepts exactly the requested recipient", async () => {
		const client: SmtpTransportClient = {
			verify: vi.fn().mockResolvedValue(true),
			sendMail: vi.fn().mockResolvedValue({
				messageId: "<mail-request-1@example.com>",
				accepted: ["user@example.com"],
				rejected: [],
				pending: [],
			}),
			close: vi.fn(),
		};
		const provider = new SmtpEmailOtpDeliveryProvider(
			{
				enabled: true,
				host: "smtp.example.com",
				port: 465,
				secure: true,
				username: "no-reply@example.com",
				password: "smtp-app-password",
				fromAddress: "no-reply@example.com",
				fromName: "吃什么",
				timeoutMs: 5_000,
			},
			client,
		);

		await expect(
			provider.send({
				channel: "EMAIL",
				destination: "user@example.com",
				code: "001204",
				idempotencyKey: "challenge_1234567890",
				expiresAt,
			}),
		).resolves.toEqual({
			provider: "SMTP",
			requestReference: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
		});

		const message = vi.mocked(client.sendMail).mock.calls[0]?.[0];
		expect(message).toMatchObject({
			from: { name: "吃什么", address: "no-reply@example.com" },
			to: [{ address: "user@example.com" }],
			disableFileAccess: true,
			disableUrlAccess: true,
		});
		expect(message?.text).toContain("001204");
		expect(message).not.toHaveProperty("html");
		expect(message).not.toHaveProperty("attachments");
	});

	it("verifies a locked-down TLS SMTP transport before making it available", async () => {
		const client: SmtpTransportClient = {
			verify: vi.fn().mockResolvedValue(true),
			sendMail: vi.fn(),
			close: vi.fn(),
		};
		const createTransport = vi.fn(() => client);
		await expect(
			createVerifiedSmtpTransportClient(
				{
					enabled: true,
					host: "smtp.example.com",
					port: 587,
					secure: false,
					username: "smtp-user",
					password: "smtp-app-password",
					fromAddress: "no-reply@example.com",
					fromName: "吃什么",
					timeoutMs: 5_000,
				},
				{ createTransport },
			),
		).resolves.toBe(client);

		expect(createTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				host: "smtp.example.com",
				port: 587,
				secure: false,
				requireTLS: true,
				ignoreTLS: false,
				opportunisticTLS: false,
				logger: false,
				debug: false,
				transactionLog: false,
				disableFileAccess: true,
				disableUrlAccess: true,
				tls: expect.objectContaining({
					rejectUnauthorized: true,
					minVersion: "TLSv1.2",
					servername: "smtp.example.com",
				}),
			}),
		);
		expect(client.verify).toHaveBeenCalledOnce();
	});

	it("fails SMTP startup with a fixed error and closes the transport", async () => {
		const marker = "smtp-user@example.com password must never leak";
		const client: SmtpTransportClient = {
			verify: vi.fn().mockRejectedValue(new Error(marker)),
			sendMail: vi.fn(),
			close: vi.fn(),
		};
		const failure = await captureError(
			createVerifiedSmtpTransportClient(
				{
					enabled: true,
					host: "smtp.example.com",
					port: 465,
					secure: true,
					username: "smtp-user@example.com",
					password: "private-app-password",
					fromAddress: "no-reply@example.com",
					fromName: "吃什么",
					timeoutMs: 5_000,
				},
				{ createTransport: vi.fn(() => client) },
			),
		);
		expect(failure.message).toBe("账号 SMTP 邮件服务不可用");
		expect(failure.message).not.toContain(marker);
		expect(failure).not.toHaveProperty("cause");
		expect(client.close).toHaveBeenCalledOnce();
	});

	it("fails closed before calling disabled or malformed channels", async () => {
		const smsClient: AliyunSmsClient = {
			sendSmsWithOptions: vi.fn(),
		};
		const disabled = new AliyunSmsOtpDeliveryProvider(
			{ enabled: false, signName: null, templateCode: null, timeoutMs: 1_000 },
			smsClient,
		);
		await expect(
			disabled.send({
				channel: "PHONE",
				destination: "+8613800138000",
				code: "123456",
				idempotencyKey: "challenge_1234567890",
				expiresAt,
			}),
		).rejects.toMatchObject({ reason: "DISABLED" });
		expect(smsClient.sendSmsWithOptions).not.toHaveBeenCalled();

		const enabled = new AliyunSmsOtpDeliveryProvider(
			{
				enabled: true,
				signName: "吃什么",
				templateCode: "SMS_123456",
				timeoutMs: 1_000,
			},
			smsClient,
		);
		await expect(
			enabled.send({
				channel: "EMAIL",
				destination: "user@example.com",
				code: "123456",
				idempotencyKey: "challenge_1234567890",
				expiresAt,
			}),
		).rejects.toMatchObject({ reason: "INVALID_REQUEST" });
		expect(smsClient.sendSmsWithOptions).not.toHaveBeenCalled();
	});

	it("rejects success envelopes that only contain API request IDs", async () => {
		const request = {
			channel: "PHONE" as const,
			destination: "+8613800138000",
			code: "001204",
			idempotencyKey: "challenge_1234567890",
			expiresAt,
		};
		const sms = new AliyunSmsOtpDeliveryProvider(
			{
				enabled: true,
				signName: "吃什么",
				templateCode: "SMS_123456",
				timeoutMs: 1_500,
			},
			{
				sendSmsWithOptions: vi.fn().mockResolvedValue({
					body: { code: "OK", requestId: "api-request-only" },
				}),
			},
		);
		await expect(sms.send(request)).rejects.toMatchObject({
			reason: "UPSTREAM_REJECTED",
		});

		const mail = new SmtpEmailOtpDeliveryProvider(
			{
				enabled: true,
				host: "smtp.example.com",
				port: 465,
				secure: true,
				username: "no-reply@example.com",
				password: "smtp-app-password",
				fromAddress: "no-reply@example.com",
				fromName: "吃什么",
				timeoutMs: 5_000,
			},
			{
				verify: vi.fn().mockResolvedValue(true),
				sendMail: vi.fn().mockResolvedValue({
					messageId: "<api-request-only@example.com>",
					accepted: [],
					rejected: ["user@example.com"],
					pending: [],
				}),
				close: vi.fn(),
			},
		);
		await expect(
			mail.send({
				...request,
				channel: "EMAIL",
				destination: "user@example.com",
			}),
		).rejects.toMatchObject({ reason: "UPSTREAM_REJECTED" });
	});

	it("maps provider failures to fixed categories without leaking recipient or code", async () => {
		const client: AliyunSmsClient = {
			sendSmsWithOptions: vi
				.fn()
				.mockRejectedValue(
					new Error("upstream failed for 13800138000 code 001204"),
				),
		};
		const provider = new AliyunSmsOtpDeliveryProvider(
			{
				enabled: true,
				signName: "吃什么",
				templateCode: "SMS_123456",
				timeoutMs: 1_000,
			},
			client,
		);
		const failure = await captureFailure(
			provider.send({
				channel: "PHONE",
				destination: "+8613800138000",
				code: "001204",
				idempotencyKey: "challenge_1234567890",
				expiresAt,
			}),
		);
		expect(failure.reason).toBe("NETWORK_ERROR");
		expect(failure.message).not.toContain("13800138000");
		expect(failure.message).not.toContain("001204");
	});
});

async function captureFailure(
	promise: Promise<unknown>,
): Promise<OtpDeliveryUnavailableError> {
	try {
		await promise;
		throw new Error("expected delivery failure");
	} catch (error) {
		if (error instanceof OtpDeliveryUnavailableError) return error;
		throw error;
	}
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
		throw new Error("expected failure");
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error("non-error failure");
	}
}
