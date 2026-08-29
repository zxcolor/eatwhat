import { describe, expect, it, vi } from "vitest";
import {
	type AliyunPnvsClient,
	AliyunPnvsOtpProvider,
} from "./aliyun-pnvs-otp.provider.js";
import { OtpDeliveryUnavailableError } from "./otp-delivery.provider.js";
import {
	createVerifiedSmtpTransportClient,
	SmtpEmailOtpDeliveryProvider,
	type SmtpTransportClient,
} from "./smtp-email-otp.provider.js";

const expiresAt = new Date(Date.now() + 5 * 60_000);
const challengeId = "3bf405ae-82a1-4f87-86b7-1c97c4a8683f";

function pnvsClient(
	overrides: Partial<AliyunPnvsClient> = {},
): AliyunPnvsClient {
	return {
		sendSmsVerifyCodeWithOptions: vi.fn().mockResolvedValue({
			body: {
				code: "OK",
				success: true,
				model: { bizId: "123456^789" },
			},
		}),
		checkSmsVerifyCodeWithOptions: vi.fn().mockResolvedValue({
			body: { code: "OK", success: true, model: { verifyResult: "PASS" } },
		}),
		...overrides,
	};
}

function pnvsProvider(client: AliyunPnvsClient): AliyunPnvsOtpProvider {
	return new AliyunPnvsOtpProvider(
		{
			enabled: true,
			signName: "吃什么",
			templateCode: "100001",
			timeoutMs: 1_500,
			resendDelayMs: 60_000,
		},
		client,
	);
}

function smtpProvider(
	client: SmtpTransportClient,
): SmtpEmailOtpDeliveryProvider {
	return new SmtpEmailOtpDeliveryProvider(
		{
			enabled: true,
			host: "smtp.example.com",
			port: 465,
			secure: true,
			username: "no-reply@example.com",
			password: "smtp-app-password",
			fromAddress: "no-reply@example.com",
			replyToAddress: "support@example.com",
			fromName: "吃什么",
			timeoutMs: 5_000,
		},
		client,
	);
}

describe("OTP delivery adapters", () => {
	it("asks PNVS to generate a six-digit code and returns only the real BizId", async () => {
		const client = pnvsClient();
		await expect(
			pnvsProvider(client).send({
				channel: "PHONE",
				destination: "+8613800138000",
				code: null,
				idempotencyKey: challengeId,
				expiresAt,
			}),
		).resolves.toEqual({
			provider: "ALIYUN_PNVS",
			requestReference: "123456^789",
		});

		const [request, runtime] =
			vi.mocked(client.sendSmsVerifyCodeWithOptions).mock.calls[0] ?? [];
		expect(request).toEqual({
			autoRetry: 0,
			countryCode: "86",
			phoneNumber: "13800138000",
			signName: "吃什么",
			templateCode: "100001",
			templateParam: JSON.stringify({ code: "##code##", min: "5" }),
			codeLength: 6,
			validTime: expect.any(Number),
			duplicatePolicy: 1,
			interval: 60,
			codeType: 1,
			returnVerifyCode: false,
			outId: challengeId,
		});
		expect(runtime).toEqual({
			autoretry: false,
			maxAttempts: 1,
			connectTimeout: 1_500,
			readTimeout: 1_500,
			keepAlive: false,
			maxIdleConns: 1,
		});
	});

	it("checks the same +86 number and OutId, accepting only PASS", async () => {
		const passClient = pnvsClient();
		await expect(
			pnvsProvider(passClient).verify({
				destination: "+8613800138000",
				code: "001204",
				idempotencyKey: challengeId,
			}),
		).resolves.toBe(true);
		expect(passClient.checkSmsVerifyCodeWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				countryCode: "86",
				phoneNumber: "13800138000",
				verifyCode: "001204",
				outId: challengeId,
			}),
			expect.any(Object),
		);

		const unknownClient = pnvsClient({
			checkSmsVerifyCodeWithOptions: vi.fn().mockResolvedValue({
				body: {
					code: "OK",
					success: true,
					model: { verifyResult: "UNKNOWN" },
				},
			}),
		});
		await expect(
			pnvsProvider(unknownClient).verify({
				destination: "+8613800138000",
				code: "001204",
				idempotencyKey: challengeId,
			}),
		).resolves.toBe(false);
	});

	it.each([undefined, "FAIL", "EXPIRED"])(
		"treats missing or undocumented VerifyResult %s as an upstream error",
		async (verifyResult) => {
			const client = pnvsClient({
				checkSmsVerifyCodeWithOptions: vi.fn().mockResolvedValue({
					body: {
						code: "OK",
						success: true,
						model: verifyResult === undefined ? {} : { verifyResult },
					},
				}),
			});
			await expect(
				pnvsProvider(client).verify({
					destination: "+8613800138000",
					code: "001204",
					idempotencyKey: challengeId,
				}),
			).rejects.toMatchObject({ reason: "UPSTREAM_REJECTED" });
		},
	);

	it("rejects send success without a valid provider BizId and never trusts OutId", async () => {
		for (const model of [
			{ outId: challengeId },
			{ bizId: "invalid BizId", outId: challengeId },
		]) {
			const client = pnvsClient({
				sendSmsVerifyCodeWithOptions: vi.fn().mockResolvedValue({
					body: { code: "OK", success: true, model },
				}),
			});
			await expect(
				pnvsProvider(client).send({
					channel: "PHONE",
					destination: "+8613800138000",
					code: null,
					idempotencyKey: challengeId,
					expiresAt,
				}),
			).rejects.toMatchObject({ reason: "UPSTREAM_REJECTED" });
		}
	});

	it("uses plain-text SMTP with the configured reply-to address", async () => {
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
		const provider = smtpProvider(client);

		const receipt = await provider.send({
			channel: "EMAIL",
			destination: "user@example.com",
			code: "001204",
			idempotencyKey: challengeId,
			expiresAt,
		});
		expect(receipt).toMatchObject({
			provider: "SMTP",
			requestReference: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
		});
		expect(receipt.requestReference).not.toContain("mail-request-1");
		expect(receipt.requestReference).not.toContain("example.com");
		const message = vi.mocked(client.sendMail).mock.calls[0]?.[0];
		expect(message).toMatchObject({
			from: { name: "吃什么", address: "no-reply@example.com" },
			to: [{ address: "user@example.com" }],
			replyTo: [{ address: "support@example.com" }],
			disableFileAccess: true,
			disableUrlAccess: true,
		});
		expect(message?.text).toContain("001204");
		expect(message).not.toHaveProperty("html");
	});

	it.each([
		[
			{ code: "ETIMEDOUT", message: "timeout user@example.com 001204" },
			"TIMEOUT",
		],
		[
			{ code: "EAUTH", message: "auth user@example.com 001204" },
			"UPSTREAM_REJECTED",
		],
		[new Error("network user@example.com 001204"), "NETWORK_ERROR"],
	] as const)(
		"maps SMTP failures to fixed categories without retaining destination or code",
		async (upstreamError, expectedReason) => {
			const client: SmtpTransportClient = {
				verify: vi.fn().mockResolvedValue(true),
				sendMail: vi.fn().mockRejectedValue(upstreamError),
				close: vi.fn(),
			};
			const failure = await captureFailure(
				smtpProvider(client).send({
					channel: "EMAIL",
					destination: "user@example.com",
					code: "001204",
					idempotencyKey: challengeId,
					expiresAt,
				}),
			);
			expect(failure.reason).toBe(expectedReason);
			expect(failure.message).not.toContain("user@example.com");
			expect(failure.message).not.toContain("001204");
		},
	);

	it.each([
		{ accepted: [], rejected: ["user@example.com"], pending: [] },
		{ accepted: [], rejected: [], pending: ["user@example.com"] },
		{
			accepted: ["user@example.com", "other@example.com"],
			rejected: [],
			pending: [],
		},
	])(
		"rejects SMTP acceptance that is not exactly the requested mailbox",
		async (response) => {
			const client: SmtpTransportClient = {
				verify: vi.fn().mockResolvedValue(true),
				sendMail: vi.fn().mockResolvedValue(response),
				close: vi.fn(),
			};
			await expect(
				smtpProvider(client).send({
					channel: "EMAIL",
					destination: "user@example.com",
					code: "001204",
					idempotencyKey: challengeId,
					expiresAt,
				}),
			).rejects.toMatchObject({ reason: "UPSTREAM_REJECTED" });
		},
	);

	it("verifies a locked-down TLS SMTP transport before exposing it", async () => {
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
					replyToAddress: "support@example.com",
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
	});

	it("maps failures to fixed categories without leaking phone or code", async () => {
		const client = pnvsClient({
			sendSmsVerifyCodeWithOptions: vi
				.fn()
				.mockRejectedValue(
					new Error("upstream failed for 13800138000 code 001204"),
				),
		});
		const failure = await captureFailure(
			pnvsProvider(client).send({
				channel: "PHONE",
				destination: "+8613800138000",
				code: null,
				idempotencyKey: challengeId,
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
