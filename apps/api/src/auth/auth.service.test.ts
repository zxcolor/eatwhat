import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import {
	AuthRepository,
	type IdentityBindingRecord,
} from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import {
	hashIdentityLookup,
	hashOtpCode,
	hashSensitiveRateLimitValue,
} from "./auth-crypto.js";
import type { OAuthProof, OtpProof } from "./auth-workflow.types.js";
import { DatabaseAuthenticatedUserResolver } from "./authenticated-user.resolver.js";
import { UnavailableExportArtifactReader } from "./data-export-artifact.reader.js";
import type {
	QqIdentityProvider,
	WechatIdentityProvider,
} from "./providers/external-identity.provider.js";
import {
	type OtpDeliveryProvider,
	OtpDeliveryUnavailableError,
	type PhoneOtpProvider,
} from "./providers/otp-delivery.provider.js";

const hashKey = Buffer.alloc(32, 11).toString("base64");
const otpPepper = Buffer.alloc(32, 13).toString("base64");
const installationId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
const challengeId = "3bf405ae-82a1-4f87-86b7-1c97c4a8683f";
const userId = "5bf405ae-82a1-4f87-86b7-1c97c4a8683f";
const phoneNumber = "+8613800138000";
const emailAddress = "Student@Example.com";
const device = {
	installationId,
	label: "Pixel test",
	platform: "ANDROID" as const,
	appVersion: "1.0.0",
};

function config() {
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@127.0.0.1/chishenme",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "true",
		EMAIL_AUTH_ENABLED: "true",
		WECHAT_AUTH_ENABLED: "true",
		QQ_AUTH_ENABLED: "true",
		QQ_UNION_ID_ENABLED: "true",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_OTP_PEPPER_ACTIVE_VERSION: "otp-v1",
		AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ "otp-v1": otpPepper }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_PNVS_SIGN_NAME: "test-sign",
		ALIYUN_PNVS_TEMPLATE_CODE: "100001",
		SMTP_HOST: "smtp.example.com",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USERNAME: "noreply@example.com",
		SMTP_PASSWORD: "smtp-app-password",
		SMTP_FROM_ADDRESS: "noreply@example.com",
		SMTP_REPLY_TO: "support@example.com",
		WECHAT_APP_ID: "wx0123456789abcdef",
		WECHAT_APP_SECRET: "private-provider-secret",
		WECHAT_OPEN_PLATFORM_REALM_ID: "eatwhat-primary",
		QQ_APP_ID: "1905202162",
		QQ_APP_KEY: "a".repeat(32),
		QQ_OPEN_PLATFORM_REALM_ID: "eatwhat-qq-primary",
	});
}

function fakeRepository(overrides: Partial<AuthRepository>): AuthRepository {
	return {
		isAvailable: () => true,
		...overrides,
	} as AuthRepository;
}

function providers() {
	const wechat: WechatIdentityProvider = {
		verify: vi.fn(async () => ({
			provider: "WECHAT" as const,
			providerScope: "wx0123456789abcdef",
			subject: "wechat-open-id",
			unionSubject: "wechat-union-id",
		})),
	};
	const qq: QqIdentityProvider = {
		verify: vi.fn(async () => ({
			provider: "QQ" as const,
			providerScope: "1905202162",
			subject: "qq-open-id",
			unionSubject: "qq-union-id",
		})),
	};
	return { wechat, qq };
}

function phoneProvider(
	overrides: Partial<PhoneOtpProvider> = {},
): PhoneOtpProvider {
	return {
		channel: "PHONE",
		send: vi.fn(async () => ({
			provider: "ALIYUN_PNVS" as const,
			requestReference: "123^456",
		})),
		verify: vi.fn(async () => true),
		...overrides,
	};
}

function emailProvider(
	overrides: Partial<OtpDeliveryProvider> = {},
): OtpDeliveryProvider {
	return {
		channel: "EMAIL",
		send: vi.fn(async () => ({
			provider: "SMTP" as const,
			requestReference: "mail-reference",
		})),
		...overrides,
	};
}

function service(
	repository: AuthRepository,
	phone: PhoneOtpProvider = phoneProvider(),
	identity = providers(),
	email: OtpDeliveryProvider = emailProvider(),
) {
	const appConfig = config();
	return {
		service: new AuthService(
			appConfig,
			repository,
			phone,
			email,
			identity.wechat,
			identity.qq,
			new DatabaseAuthenticatedUserResolver(appConfig, repository),
			new UnavailableExportArtifactReader(),
		),
		config: appConfig,
		phone,
		...identity,
	};
}

function phoneProof(
	appConfig: ReturnType<typeof config>,
	purpose: "LOGIN" | "REGISTER" = "LOGIN",
): OtpProof {
	const keyRing = appConfig.auth.hashKeyRing;
	if (keyRing === null || appConfig.auth.identityDedupKeyVersion === null) {
		throw new Error("missing test keyring");
	}
	return Object.freeze({
		id: challengeId,
		channel: "PHONE" as const,
		purpose,
		destinationDedupHash: hashIdentityLookup(
			"PHONE",
			"e164",
			phoneNumber,
			keyRing,
			appConfig.auth.identityDedupKeyVersion,
		).value,
		verificationMethod: "ALIYUN_PNVS" as const,
		codeHash: null,
		codeHashKeyVersion: null,
		operationTargetHash: null,
		targetUserId: null,
		registrationFlowReferenceHash:
			purpose === "REGISTER" ? "a".repeat(64) : null,
		deviceHash: hashSensitiveRateLimitValue("device", installationId, keyRing)
			.value,
		hashKeyVersion: "v1",
	});
}

async function emailProof(
	appConfig: ReturnType<typeof config>,
	code = "001204",
): Promise<OtpProof> {
	if (appConfig.auth.otpPepperRing === null) {
		throw new Error("missing pepper");
	}
	const hashed = await hashOtpCode(code, appConfig.auth.otpPepperRing);
	return Object.freeze({
		...phoneProof(appConfig),
		channel: "EMAIL" as const,
		purpose: "LOGIN" as const,
		verificationMethod: "LOCAL_HASH" as const,
		codeHash: hashed.value,
		codeHashKeyVersion: hashed.keyVersion,
	});
}

function authenticatedSession() {
	return {
		userId,
		sessionId: "6bf405ae-82a1-4f87-86b7-1c97c4a8683f",
		deviceHash: "e".repeat(64),
		hashKeyVersion: "v1",
	};
}

describe("AuthService PHONE_ONLY workflows", () => {
	it("stores no local phone code and finalizes a successful PNVS send", async () => {
		const createOtpChallenge = vi.fn(async (draft) => ({
			kind: "CREATED" as const,
			draft,
		}));
		const finalizeOtpDelivery = vi.fn(async () => true);
		const repository = fakeRepository({
			createOtpChallenge,
			finalizeOtpDelivery,
		});
		const phone = phoneProvider();
		const response = await service(repository, phone).service.requestPhoneCode(
			{ phoneNumber, purpose: "REGISTER", installationId },
			null,
			"203.0.113.7",
		);
		expect(response.targetType).toBe("PHONE");
		const draft = createOtpChallenge.mock.calls[0]?.[0];
		expect(draft).toMatchObject({
			channel: "PHONE",
			purpose: "REGISTER",
			verificationMethod: "ALIYUN_PNVS",
			codeHash: null,
		});
		expect(phone.send).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: "PHONE",
				destination: phoneNumber,
				code: null,
			}),
		);
		expect(finalizeOtpDelivery).toHaveBeenCalledWith(
			expect.any(String),
			"SENT",
			expect.stringMatching(/^[0-9a-f]{64}$/u),
			expect.any(Date),
		);
	});

	it("keeps an uncertain send PENDING but marks an explicit rejection FAILED", async () => {
		for (const [reason, expectedFinalizations] of [
			["TIMEOUT", 0],
			["NETWORK_ERROR", 0],
			["UPSTREAM_REJECTED", 1],
		] as const) {
			const finalizeOtpDelivery = vi.fn(async () => true);
			const repository = fakeRepository({
				createOtpChallenge: async () => ({ kind: "CREATED" as const }),
				finalizeOtpDelivery,
			});
			const phone = phoneProvider({
				send: vi.fn(async () => {
					throw new OtpDeliveryUnavailableError(reason);
				}),
			});
			await expect(
				service(repository, phone).service.requestPhoneCode(
					{ phoneNumber, purpose: "LOGIN", installationId },
					null,
					"203.0.113.7",
				),
			).rejects.toBeInstanceOf(HttpException);
			expect(finalizeOtpDelivery).toHaveBeenCalledTimes(expectedFinalizations);
			if (expectedFinalizations === 1) {
				expect(finalizeOtpDelivery).toHaveBeenCalledWith(
					expect.any(String),
					"FAILED",
					null,
					null,
				);
			}
		}
	});

	it("keeps uncertain EMAIL delivery PENDING and only marks an explicit SMTP rejection FAILED", async () => {
		for (const [reason, expectedFinalizations] of [
			["TIMEOUT", 0],
			["NETWORK_ERROR", 0],
			["UPSTREAM_REJECTED", 1],
		] as const) {
			const finalizeOtpDelivery = vi.fn(async () => true);
			const repository = fakeRepository({
				createOtpChallenge: async () => ({ kind: "CREATED" as const }),
				finalizeOtpDelivery,
			});
			const email = emailProvider({
				send: vi.fn(async () => {
					throw new OtpDeliveryUnavailableError(reason);
				}),
			});

			await expect(
				service(
					repository,
					phoneProvider(),
					providers(),
					email,
				).service.requestEmailCode(
					{
						email: emailAddress,
						purpose: "LOGIN",
						installationId,
					},
					null,
					"203.0.113.7",
				),
			).rejects.toBeInstanceOf(HttpException);
			expect(email.send).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: "EMAIL",
					destination: "student@example.com",
					code: expect.stringMatching(/^\d{6}$/u),
				}),
			);
			expect(finalizeOtpDelivery).toHaveBeenCalledTimes(expectedFinalizations);
			if (expectedFinalizations === 1) {
				expect(finalizeOtpDelivery).toHaveBeenCalledWith(
					expect.any(String),
					"FAILED",
					null,
					null,
				);
			}
		}
	});

	it("claims a durable lease before one PNVS verification and consumes PASS", async () => {
		const completeOtpLogin = vi.fn(async (completion) => ({
			kind: "SUCCESS" as const,
			userId,
			sessionId: completion.session?.sessionId ?? challengeId,
		}));
		let proof: OtpProof;
		const repository = fakeRepository({
			findOtpProof: async () => proof,
			claimPhoneOtpVerification: vi.fn(async () => true),
			releasePhoneOtpVerification: vi.fn(async () => true),
			completeOtpLogin,
		});
		const app = service(repository);
		proof = phoneProof(app.config);
		await expect(
			app.service.login(
				{
					method: "PHONE",
					challengeId,
					otpCode: "001204",
					phoneNumber,
					device,
				},
				"203.0.113.7",
			),
		).resolves.toMatchObject({ userId, tokenType: "Bearer" });
		expect(repository.claimPhoneOtpVerification).toHaveBeenCalledOnce();
		expect(app.phone.verify).toHaveBeenCalledOnce();
		expect(completeOtpLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				proof,
				verificationSucceeded: true,
				verificationClaimHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
			}),
		);
		expect(
			vi.mocked(repository.claimPhoneOtpVerification).mock
				.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(app.phone.verify).mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("does not call PNVS when another request owns the challenge lease", async () => {
		let proof: OtpProof;
		const repository = fakeRepository({
			findOtpProof: async () => proof,
			claimPhoneOtpVerification: vi.fn(async () => false),
		});
		const app = service(repository);
		proof = phoneProof(app.config);
		await expect(
			app.service.login(
				{
					method: "PHONE",
					challengeId,
					otpCode: "001204",
					phoneNumber,
					device,
				},
				"203.0.113.7",
			),
		).rejects.toBeInstanceOf(HttpException);
		expect(app.phone.verify).not.toHaveBeenCalled();
	});

	it("releases the lease without decrementing attempts on PNVS timeout", async () => {
		let proof: OtpProof;
		const releasePhoneOtpVerification = vi.fn(async () => true);
		const completeOtpLogin = vi.fn();
		const repository = fakeRepository({
			findOtpProof: async () => proof,
			claimPhoneOtpVerification: vi.fn(async () => true),
			releasePhoneOtpVerification,
			completeOtpLogin,
		});
		const app = service(
			repository,
			phoneProvider({
				verify: vi.fn(async () => {
					throw new OtpDeliveryUnavailableError("TIMEOUT");
				}),
			}),
		);
		proof = phoneProof(app.config);
		await expect(
			app.service.login(
				{
					method: "PHONE",
					challengeId,
					otpCode: "001204",
					phoneNumber,
					device,
				},
				"203.0.113.7",
			),
		).rejects.toBeInstanceOf(HttpException);
		expect(releasePhoneOtpVerification).toHaveBeenCalledOnce();
		expect(completeOtpLogin).not.toHaveBeenCalled();
	});

	it("charges one bounded attempt for a mismatched phone without calling PNVS", async () => {
		let proof: OtpProof;
		const completeOtpLogin = vi.fn(async () => ({
			kind: "INVALID_CREDENTIALS" as const,
		}));
		const repository = fakeRepository({
			findOtpProof: async () => proof,
			claimPhoneOtpVerification: vi.fn(async () => true),
			releasePhoneOtpVerification: vi.fn(async () => true),
			completeOtpLogin,
		});
		const app = service(repository);
		proof = phoneProof(app.config);
		await expect(
			app.service.login(
				{
					method: "PHONE",
					challengeId,
					otpCode: "001204",
					phoneNumber: "+8613900139000",
					device,
				},
				"203.0.113.7",
			),
		).rejects.toBeInstanceOf(HttpException);
		expect(app.phone.verify).not.toHaveBeenCalled();
		expect(completeOtpLogin).toHaveBeenCalledWith(
			expect.objectContaining({ verificationSucceeded: false }),
		);
	});

	it("uses the same PHONE login endpoint to create a phone-only account", async () => {
		let proof: OtpProof;
		const completeOtpLogin = vi.fn(async (completion) => ({
			kind: "SUCCESS" as const,
			userId: completion.newUserId ?? userId,
			sessionId: completion.session?.sessionId ?? challengeId,
		}));
		const findOtpProof = vi.fn(async (_id, _channel, purpose) =>
			purpose === "REGISTER" ? proof : null,
		);
		const repository = fakeRepository({
			findOtpProof,
			claimPhoneOtpVerification: vi.fn(async () => true),
			releasePhoneOtpVerification: vi.fn(async () => true),
			completeOtpLogin,
		});
		const app = service(repository);
		proof = phoneProof(app.config, "REGISTER");
		await app.service.login(
			{
				method: "PHONE",
				challengeId,
				otpCode: "001204",
				phoneNumber,
				device,
			},
			"203.0.113.7",
		);
		expect(findOtpProof).toHaveBeenCalledTimes(2);
		expect(completeOtpLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				proof,
				newUserId: expect.any(String),
			}),
		);
	});

	it("uses the same REGISTER challenge to log in an existing phone account without a second SMS", async () => {
		let proof: OtpProof;
		const completeOtpLogin = vi.fn(async () => ({
			kind: "SUCCESS" as const,
			userId,
			sessionId: challengeId,
		}));
		const findOtpProof = vi.fn(async (_id, _channel, purpose) =>
			purpose === "REGISTER" ? proof : null,
		);
		const repository = fakeRepository({
			findOtpProof,
			claimPhoneOtpVerification: vi.fn(async () => true),
			releasePhoneOtpVerification: vi.fn(async () => true),
			completeOtpLogin,
		});
		const app = service(repository);
		proof = phoneProof(app.config, "REGISTER");

		await expect(
			app.service.login(
				{
					method: "PHONE",
					challengeId,
					otpCode: "001204",
					phoneNumber,
					device,
				},
				"203.0.113.7",
			),
		).resolves.toMatchObject({ userId });
		expect(findOtpProof).toHaveBeenCalledTimes(2);
		expect(app.phone.verify).toHaveBeenCalledOnce();
		expect(completeOtpLogin).toHaveBeenCalledOnce();
	});

	it("keeps EMAIL verification on the local peppered hash path", async () => {
		const appConfig = config();
		const proof = await emailProof(appConfig);
		const completeOtpLogin = vi.fn(async (completion) => ({
			kind: "SUCCESS" as const,
			userId,
			sessionId: completion.session?.sessionId ?? challengeId,
		}));
		const repository = fakeRepository({
			findOtpProof: async () => proof,
			completeOtpLogin,
		});
		await service(repository).service.login(
			{
				method: "EMAIL",
				challengeId,
				otpCode: "001204",
				device,
			},
			"203.0.113.7",
		);
		expect(completeOtpLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				verificationSucceeded: true,
				verificationClaimHash: null,
			}),
		);
	});

	it("charges a wrong EMAIL code as a generic invalid credential without issuing a session", async () => {
		const appConfig = config();
		const proof = await emailProof(appConfig);
		const completeOtpLogin = vi.fn(async () => ({
			kind: "INVALID_CREDENTIALS" as const,
		}));
		const repository = fakeRepository({
			findOtpProof: async () => proof,
			completeOtpLogin,
		});

		const failure = await service(repository)
			.service.login(
				{
					method: "EMAIL",
					challengeId,
					otpCode: "999999",
					device,
				},
				"203.0.113.7",
			)
			.then(
				() => null,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(HttpException);
		expect((failure as HttpException).getResponse()).toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
		expect(completeOtpLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				verificationSucceeded: false,
				session: null,
				newUserId: null,
				verificationClaimHash: null,
			}),
		);
	});

	it("keeps an unbound EMAIL login indistinguishable from other invalid credentials", async () => {
		const appConfig = config();
		const proof = await emailProof(appConfig);
		const completeOtpLogin = vi.fn(async () => ({
			kind: "INVALID_CREDENTIALS" as const,
		}));
		const repository = fakeRepository({
			findOtpProof: async () => proof,
			completeOtpLogin,
		});

		const failure = await service(repository)
			.service.login(
				{
					method: "EMAIL",
					challengeId,
					otpCode: "001204",
					device,
				},
				"203.0.113.7",
			)
			.then(
				() => null,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(HttpException);
		expect((failure as HttpException).getResponse()).toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
		expect(completeOtpLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				verificationSucceeded: true,
				newUserId: null,
				verificationClaimHash: null,
			}),
		);
	});

	it("returns IDENTITY_NOT_BOUND only after verified WeChat proof and keeps AppID-scoped deduplication", async () => {
		const appConfig = config();
		if (
			appConfig.auth.hashKeyRing === null ||
			appConfig.auth.identityDedupKeyVersion === null
		) {
			throw new Error("missing test keyring");
		}
		const oauthProof: OAuthProof = {
			id: challengeId,
			provider: "WECHAT",
			purpose: "LOGIN",
			flowReferenceHash: "a".repeat(64),
			operationTargetHash: null,
			targetUserId: null,
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
		};
		const completeOAuthLogin = vi.fn(async () => ({
			kind: "IDENTITY_NOT_BOUND" as const,
		}));
		const repository = fakeRepository({
			findOAuthProof: async () => oauthProof,
			completeOAuthLogin,
		});
		const identity = providers();
		const app = service(repository, phoneProvider(), identity);

		const failure = await app.service
			.login(
				{
					method: "WECHAT",
					oauthState: "A".repeat(43),
					authorizationCode: "WechatCode123456",
					device,
				},
				"203.0.113.7",
			)
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(failure).toBeInstanceOf(HttpException);
		expect((failure as HttpException).getResponse()).toMatchObject({
			code: "IDENTITY_NOT_BOUND",
		});
		expect(identity.wechat.verify).toHaveBeenCalledOnce();
		expect(completeOAuthLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				proof: oauthProof,
				verifiedIdentity: {
					lookup: hashIdentityLookup(
						"WECHAT",
						"wx0123456789abcdef",
						"wechat-open-id",
						appConfig.auth.hashKeyRing,
					),
					dedup: hashIdentityLookup(
						"WECHAT",
						"wx0123456789abcdef",
						"wechat-open-id",
						appConfig.auth.hashKeyRing,
						appConfig.auth.identityDedupKeyVersion,
					),
					wechatUnionAlias: {
						realmId: "eatwhat-primary",
						hash: hashIdentityLookup(
							"WECHAT",
							"open-platform:eatwhat-primary",
							"wechat-union-id",
							appConfig.auth.hashKeyRing,
							appConfig.auth.identityDedupKeyVersion,
						),
					},
				},
			}),
		);
	});

	it("falls back to AppID-scoped OpenID deduplication when WeChat omits UnionID", async () => {
		const appConfig = config();
		if (
			appConfig.auth.hashKeyRing === null ||
			appConfig.auth.identityDedupKeyVersion === null
		) {
			throw new Error("missing test keyring");
		}
		const oauthProof: OAuthProof = {
			id: challengeId,
			provider: "WECHAT",
			purpose: "LOGIN",
			flowReferenceHash: "a".repeat(64),
			operationTargetHash: null,
			targetUserId: null,
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
		};
		const completeOAuthLogin = vi.fn(async () => ({
			kind: "IDENTITY_NOT_BOUND" as const,
		}));
		const repository = fakeRepository({
			findOAuthProof: async () => oauthProof,
			completeOAuthLogin,
		});
		const identity = {
			...providers(),
			wechat: {
				verify: vi.fn(async () => ({
					provider: "WECHAT" as const,
					providerScope: "wx0123456789abcdef",
					subject: "wechat-open-id",
					unionSubject: null,
				})),
			},
		};

		await expect(
			service(repository, phoneProvider(), identity).service.login(
				{
					method: "WECHAT",
					oauthState: "A".repeat(43),
					authorizationCode: "WechatCode123456",
					device,
				},
				"203.0.113.7",
			),
		).rejects.toBeInstanceOf(HttpException);
		expect(completeOAuthLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				verifiedIdentity: {
					lookup: hashIdentityLookup(
						"WECHAT",
						"wx0123456789abcdef",
						"wechat-open-id",
						appConfig.auth.hashKeyRing,
					),
					dedup: hashIdentityLookup(
						"WECHAT",
						"wx0123456789abcdef",
						"wechat-open-id",
						appConfig.auth.hashKeyRing,
						appConfig.auth.identityDedupKeyVersion,
					),
					wechatUnionAlias: null,
				},
			}),
		);
	});

	it("keeps QQ lookup AppID-scoped and realm-scopes verified UnionID deduplication", async () => {
		const appConfig = config();
		if (
			appConfig.auth.hashKeyRing === null ||
			appConfig.auth.identityDedupKeyVersion === null
		) {
			throw new Error("missing test keyring");
		}
		const oauthProof: OAuthProof = {
			id: challengeId,
			provider: "QQ",
			purpose: "LOGIN",
			flowReferenceHash: "a".repeat(64),
			operationTargetHash: null,
			targetUserId: null,
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
		};
		const completeOAuthLogin = vi.fn(async () => ({
			kind: "IDENTITY_NOT_BOUND" as const,
		}));
		const repository = fakeRepository({
			findOAuthProof: async () => oauthProof,
			completeOAuthLogin,
		});
		const identity = providers();

		const failure = await service(repository, phoneProvider(), identity)
			.service.login(
				{
					method: "QQ",
					oauthState: "A".repeat(43),
					authorizationCode: "temporary-qq-authorization-code",
					device,
				},
				"203.0.113.7",
			)
			.then(
				() => null,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(HttpException);
		expect((failure as HttpException).getResponse()).toMatchObject({
			code: "IDENTITY_NOT_BOUND",
		});
		expect(identity.qq.verify).toHaveBeenCalledWith({
			authorizationCode: "temporary-qq-authorization-code",
		});
		expect(completeOAuthLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				proof: oauthProof,
				verifiedIdentity: {
					lookup: hashIdentityLookup(
						"QQ",
						"1905202162",
						"qq-open-id",
						appConfig.auth.hashKeyRing,
					),
					dedup: hashIdentityLookup(
						"QQ",
						"open-platform:eatwhat-qq-primary",
						"qq-union-id",
						appConfig.auth.hashKeyRing,
						appConfig.auth.identityDedupKeyVersion,
					),
					wechatUnionAlias: null,
				},
			}),
		);
	});

	it("binds WeChat after authentication through the generic OAuth binding path", async () => {
		const session = authenticatedSession();
		const oauthProof: OAuthProof = {
			id: challengeId,
			provider: "WECHAT",
			purpose: "BIND",
			flowReferenceHash: "a".repeat(64),
			operationTargetHash: "b".repeat(64),
			targetUserId: userId,
			deviceHash: session.deviceHash,
			hashKeyVersion: "v1",
		};
		const binding: IdentityBindingRecord = {
			bindingId: "7bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			type: "WECHAT",
			maskedValue: "微信账号",
			boundAt: new Date(),
			primary: false,
			canUnbind: true,
			revokedAt: null,
		};
		const completeOAuthBinding = vi.fn(async () => ({
			kind: "SUCCESS" as const,
			binding,
		}));
		const repository = fakeRepository({
			authenticateAccess: async () => session,
			findOAuthProof: async () => oauthProof,
			completeOAuthBinding,
		});
		const identity = providers();
		await expect(
			service(repository, phoneProvider(), identity).service.bindIdentity(
				"B".repeat(43),
				{
					type: "WECHAT",
					oauthState: "A".repeat(43),
					authorizationCode: "WechatCode123456",
				},
			),
		).resolves.toMatchObject({ binding: { type: "WECHAT" } });
		expect(identity.wechat.verify).toHaveBeenCalledOnce();
		expect(completeOAuthBinding).toHaveBeenCalledOnce();
	});
});
