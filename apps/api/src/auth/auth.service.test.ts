import { Readable } from "node:stream";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../config/app-config.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { hashOtpCode } from "./auth-crypto.js";
import type { OAuthStateDraft } from "./auth-workflow.types.js";
import { DatabaseAuthenticatedUserResolver } from "./authenticated-user.resolver.js";
import {
	type ExportArtifactReader,
	UnavailableExportArtifactReader,
} from "./data-export-artifact.reader.js";
import type {
	QqIdentityProvider,
	WechatIdentityProvider,
} from "./providers/external-identity.provider.js";
import { ExternalIdentityUnavailableError } from "./providers/external-identity.provider.js";
import {
	type FusionAuthProvider,
	FusionAuthUnavailableError,
} from "./providers/fusion-auth.provider.js";
import {
	type OtpDeliveryProvider,
	OtpDeliveryUnavailableError,
} from "./providers/otp-delivery.provider.js";

function enabledConfig(overrides: Record<string, string> = {}) {
	const hashKey = Buffer.alloc(32, 11).toString("base64");
	const otpPepper = Buffer.alloc(32, 13).toString("base64");
	const exportKey = Buffer.alloc(32, 12).toString("base64");
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@127.0.0.1/chishenme",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "true",
		EMAIL_AUTH_ENABLED: "true",
		WECHAT_AUTH_ENABLED: "true",
		QQ_AUTH_ENABLED: "true",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
		AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_SMS_SIGN_NAME: "test-sign",
		ALIYUN_SMS_TEMPLATE_CODE: "SMS_TEST",
		SMTP_HOST: "smtp.example.com",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USERNAME: "noreply@example.com",
		SMTP_PASSWORD: "smtp-app-password",
		SMTP_FROM_ADDRESS: "noreply@example.com",
		SMTP_FROM_NAME: "吃什么测试",
		WECHAT_APP_ID: "wx0123456789abcdef",
		WECHAT_APP_SECRET: "private-provider-secret",
		QQ_APP_ID: "123456789",
		DATA_EXPORT_ENABLED: "true",
		DATA_EXPORT_WORKER_READY: "true",
		DATA_EXPORT_OSS_REGION: "oss-cn-beijing",
		DATA_EXPORT_OSS_BUCKET: "chi-shen-me-test-exports",
		DATA_EXPORT_OSS_INTERNAL: "false",
		ALIBABA_CLOUD_ECS_METADATA: "chi-shen-me-data-export-worker",
		ALIBABA_CLOUD_IMDSV1_DISABLED: "true",
		ALIBABA_CLOUD_ECS_IMDSV2_ENABLE: "true",
		DATA_EXPORT_LOCATOR_ACTIVE_VERSION: "locator-v1",
		DATA_EXPORT_LOCATOR_KEYS_JSON: JSON.stringify({
			"locator-v1": exportKey,
		}),
		...overrides,
	});
}

function fakeRepository(
	overrides: Partial<AuthRepository> = {},
): AuthRepository {
	const unavailable = async () => {
		throw new Error("unexpected repository call");
	};
	return {
		isAvailable: () => true,
		createOtpChallenge: unavailable,
		finalizeOtpDelivery: unavailable,
		findOtpProof: unavailable,
		findRegistrationFlow: unavailable,
		createFusionFlow: unavailable,
		findFusionProof: unavailable,
		claimFusionVerifyToken: unavailable,
		findVerifiedFusionProof: unavailable,
		completeFusionVerification: unavailable,
		completeFusionLogin: unavailable,
		completeFusionRegistration: unavailable,
		createOAuthState: unavailable,
		findOAuthProof: unavailable,
		authenticateAccess: unavailable,
		completeOtpLogin: unavailable,
		completeOAuthLogin: unavailable,
		completeRegistration: unavailable,
		refreshSession: unavailable,
		...overrides,
	} as AuthRepository;
}

function phoneProvider(
	send: OtpDeliveryProvider["send"] = async () => ({
		provider: "ALIYUN_SMS",
		requestReference: "provider-reference",
	}),
): OtpDeliveryProvider {
	return { channel: "PHONE", send };
}

const emailProvider: OtpDeliveryProvider = {
	channel: "EMAIL",
	async send() {
		throw new OtpDeliveryUnavailableError("DISABLED");
	},
};

const fusionProvider: FusionAuthProvider = {
	async issueToken() {
		throw new FusionAuthUnavailableError("DISABLED");
	},
	async verifyToken() {
		throw new FusionAuthUnavailableError("DISABLED");
	},
};

function identityProviders() {
	const wechat: WechatIdentityProvider = {
		verify: vi.fn(async () => ({
			provider: "WECHAT",
			providerScope: "wx0123456789abcdef",
			subject: "wechat-subject",
			unionSubject: null,
		})),
	};
	const qq: QqIdentityProvider = {
		verify: vi.fn(async () => ({
			provider: "QQ",
			providerScope: "123456789",
			subject: "qq-subject",
			unionSubject: null,
		})),
	};
	return { wechat, qq };
}

function service(
	repository: AuthRepository,
	phone: OtpDeliveryProvider = phoneProvider(),
	providers = identityProviders(),
	email: OtpDeliveryProvider = emailProvider,
	exportArtifactReader: ExportArtifactReader = new UnavailableExportArtifactReader(),
	fusion: FusionAuthProvider = fusionProvider,
	config = enabledConfig(),
) {
	return {
		service: new AuthService(
			config,
			repository,
			phone,
			email,
			fusion,
			providers.wechat,
			providers.qq,
			new DatabaseAuthenticatedUserResolver(config, repository),
			exportArtifactReader,
		),
		...providers,
	};
}

function fusionEnabledConfig() {
	const flowHashKey = Buffer.alloc(32, 11).toString("base64");
	const stableDedupKey = Buffer.alloc(32, 14).toString("base64");
	return enabledConfig({
		FUSION_AUTH_ENABLED: "true",
		AUTH_HASH_KEYS_JSON: JSON.stringify({
			v1: flowHashKey,
			"stable-dedup-v1": stableDedupKey,
		}),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "stable-dedup-v1",
		ALIYUN_FUSION_SCHEME_CODE: "100001",
		ALIYUN_FUSION_PACKAGE_NAME: "com.chishenme.app",
		ALIYUN_FUSION_PACKAGE_SIGN: "a".repeat(32),
	});
}

function fusionLoginOnlyConfig() {
	const flowHashKey = Buffer.alloc(32, 11).toString("base64");
	const stableDedupKey = Buffer.alloc(32, 14).toString("base64");
	return enabledConfig({
		PHONE_AUTH_ENABLED: "false",
		EMAIL_AUTH_ENABLED: "false",
		WECHAT_AUTH_ENABLED: "false",
		QQ_AUTH_ENABLED: "false",
		FUSION_AUTH_ENABLED: "true",
		AUTH_HASH_KEYS_JSON: JSON.stringify({
			v1: flowHashKey,
			"stable-dedup-v1": stableDedupKey,
		}),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "stable-dedup-v1",
		ALIYUN_FUSION_SCHEME_CODE: "100001",
		ALIYUN_FUSION_PACKAGE_NAME: "com.chishenme.app",
		ALIYUN_FUSION_PACKAGE_SIGN: "a".repeat(32),
	});
}

function phoneLoginOnlyConfig() {
	return enabledConfig({
		PHONE_AUTH_ENABLED: "true",
		FUSION_AUTH_ENABLED: "false",
		EMAIL_AUTH_ENABLED: "false",
		WECHAT_AUTH_ENABLED: "false",
		QQ_AUTH_ENABLED: "false",
	});
}

function fusionService(
	repository: AuthRepository,
	fusion: FusionAuthProvider,
	providers = identityProviders(),
) {
	return service(
		repository,
		phoneProvider(),
		providers,
		emailProvider,
		new UnavailableExportArtifactReader(),
		fusion,
		fusionEnabledConfig(),
	);
}

function fusionLoginOnlyService(
	repository: AuthRepository,
	fusion: FusionAuthProvider,
	providers = identityProviders(),
	phone: OtpDeliveryProvider = phoneProvider(),
) {
	return service(
		repository,
		phone,
		providers,
		emailProvider,
		new UnavailableExportArtifactReader(),
		fusion,
		fusionLoginOnlyConfig(),
	);
}

const installationId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
const challengeId = "3bf405ae-82a1-4f87-86b7-1c97c4a8683f";
const oauthState = "A".repeat(43);
const device = {
	installationId,
	label: "Pixel test",
	platform: "ANDROID" as const,
	appVersion: "1.0.0",
};
const appAccessToken = "B".repeat(43);
const authenticatedSession = {
	userId: "5bf405ae-82a1-4f87-86b7-1c97c4a8683f",
	sessionId: "6bf405ae-82a1-4f87-86b7-1c97c4a8683f",
	deviceHash: "e".repeat(64),
	hashKeyVersion: "v1",
};

function authenticatedRepository(
	overrides: Partial<AuthRepository> = {},
): AuthRepository {
	return fakeRepository({
		authenticateAccess: async () => authenticatedSession,
		...overrides,
	});
}

describe("AuthService core workflows", () => {
	it("keeps Fusion LOGIN and REGISTER verification flows available when registration is closed", async () => {
		const drafts: unknown[] = [];
		const completeRegistration = vi.fn(async () => {
			throw new Error("verification must not create an account");
		});
		const completeFusionRegistration = vi.fn(async () => {
			throw new Error("verification must not create an account");
		});
		const repository = fakeRepository({
			createFusionFlow: async (draft) => {
				drafts.push(draft);
				return true;
			},
			completeRegistration,
			completeFusionRegistration,
		});
		const issueToken = vi.fn(async () => ({
			authToken: "FusionAuthToken_1234567890",
		}));
		const fusion: FusionAuthProvider = {
			issueToken,
			verifyToken: vi.fn(),
		};
		const app = fusionLoginOnlyService(repository, fusion).service;

		for (const purpose of ["LOGIN", "REGISTER"] as const) {
			const response = await app.requestFusionToken(
				{ purpose, installationId },
				"203.0.113.7",
			);
			expect(response.schemeCode).toBe("100001");
			expect(response.authToken).toBe("FusionAuthToken_1234567890");
		}
		expect(issueToken).toHaveBeenCalledTimes(2);
		expect(drafts).toHaveLength(2);
		expect(drafts[0]).toMatchObject({
			purpose: "LOGIN",
			registrationFlowReferenceHash: null,
		});
		expect(drafts[1]).toMatchObject({ purpose: "REGISTER" });
		const persisted = JSON.stringify(drafts);
		expect(persisted).not.toContain("FusionAuthToken_1234567890");
		expect(persisted).not.toContain(installationId);
		expect(persisted).not.toContain("203.0.113.7");
		expect(completeRegistration).not.toHaveBeenCalled();
		expect(completeFusionRegistration).not.toHaveBeenCalled();
	});

	it("verifies a REGISTER flow into a proof without creating an account while registration is closed", async () => {
		const proofExpiresAt = new Date(Date.now() + 4 * 60_000);
		const pending = {
			id: challengeId,
			purpose: "REGISTER" as const,
			registrationFlowReferenceHash: "d".repeat(64),
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
			expiresAt: new Date(Date.now() + 10 * 60_000),
		};
		const completeFusionVerification = vi.fn(async (completion) => {
			if (completion.verifiedPhone === null) {
				throw new Error("test expected a verified fusion phone");
			}
			return {
				kind: "SUCCESS" as const,
				proof: {
					...pending,
					expiresAt: proofExpiresAt,
					verifiedAt: new Date(),
					verifiedPhone: completion.verifiedPhone,
				},
			};
		});
		const completeRegistration = vi.fn(async () => {
			throw new Error("verification must not create an account");
		});
		const completeFusionRegistration = vi.fn(async () => {
			throw new Error("verification must not create an account");
		});
		const repository = fakeRepository({
			findFusionProof: async () => pending,
			claimFusionVerifyToken: async () => true,
			completeFusionVerification,
			completeRegistration,
			completeFusionRegistration,
		});
		const verifyToken = vi.fn(async () => ({
			e164PhoneNumber: "+8613800138000",
		}));
		const response = await fusionLoginOnlyService(repository, {
			issueToken: vi.fn(),
			verifyToken,
		}).service.verifyFusionPhone({
			flowId: challengeId,
			verifyToken: "FusionVerifyToken_1234567890",
			installationId,
		});

		expect(response).toEqual({
			proofId: challengeId,
			expiresAt: proofExpiresAt.toISOString(),
		});
		expect(JSON.stringify(completeFusionVerification.mock.calls)).not.toContain(
			"+8613800138000",
		);
		expect(JSON.stringify(completeFusionVerification.mock.calls)).not.toContain(
			"FusionVerifyToken_1234567890",
		);
		expect(completeFusionVerification).toHaveBeenCalledWith(
			expect.objectContaining({
				verifyTokenHash: expect.objectContaining({
					keyVersion: "stable-dedup-v1",
				}),
			}),
		);
		expect(completeRegistration).not.toHaveBeenCalled();
		expect(completeFusionRegistration).not.toHaveBeenCalled();
	});

	it("rejects registration creation paths before repository or provider side effects in Fusion-only mode", async () => {
		const unexpectedRepositoryCall = vi.fn(async () => {
			throw new Error("registration gate must run before repository access");
		});
		const phoneSend = vi.fn(async () => {
			throw new Error("disabled phone channel must not call its provider");
		});
		const repository = fakeRepository({
			createOtpChallenge: unexpectedRepositoryCall,
			authenticateAccess: unexpectedRepositoryCall,
			findOtpProof: unexpectedRepositoryCall,
			findRegistrationFlow: unexpectedRepositoryCall,
			findVerifiedFusionProof: unexpectedRepositoryCall,
			findOAuthProof: unexpectedRepositoryCall,
			createOAuthState: unexpectedRepositoryCall,
			completeRegistration: unexpectedRepositoryCall,
			completeFusionRegistration: unexpectedRepositoryCall,
		});
		const providers = identityProviders();
		const app = fusionLoginOnlyService(
			repository,
			fusionProvider,
			providers,
			phoneProvider(phoneSend),
		).service;

		for (const purpose of ["LOGIN", "REGISTER"] as const) {
			await expect(
				app.requestPhoneCode(
					{
						phoneNumber: "+8613800138000",
						purpose,
						installationId,
					},
					null,
					"203.0.113.19",
				),
			).rejects.toMatchObject({ status: 503 });
		}

		const phoneLoginOnlyApp = service(
			repository,
			phoneProvider(phoneSend),
			providers,
			emailProvider,
			new UnavailableExportArtifactReader(),
			fusionProvider,
			phoneLoginOnlyConfig(),
		).service;
		await expect(
			phoneLoginOnlyApp.requestPhoneCode(
				{
					phoneNumber: "+8613800138000",
					purpose: "REGISTER",
					installationId,
				},
				null,
				"203.0.113.19",
			),
		).rejects.toMatchObject({ status: 503 });

		for (const disabledLogin of [
			{
				method: "PHONE" as const,
				challengeId,
				otpCode: "123456",
				device,
			},
			{
				method: "EMAIL" as const,
				challengeId,
				otpCode: "123456",
				device,
			},
			{
				method: "WECHAT" as const,
				oauthState,
				authorizationCode: "WechatCode123456",
				device,
			},
			{
				method: "QQ" as const,
				oauthState,
				accessToken: "QqAccessToken1234567890",
				device,
			},
		]) {
			await expect(
				app.login(disabledLogin, "203.0.113.19"),
			).rejects.toMatchObject({ status: 503 });
		}

		await expect(
			app.createOAuthState(
				{ provider: "QQ", purpose: "BIND", installationId },
				`Bearer ${"A".repeat(43)}`,
				"203.0.113.19",
			),
		).rejects.toMatchObject({ status: 503 });
		for (const disabledBinding of [
			{ type: "EMAIL" as const, challengeId, otpCode: "123456" },
			{
				type: "QQ" as const,
				oauthState,
				accessToken: "QqAccessToken1234567890",
			},
		]) {
			await expect(
				app.bindIdentity("A".repeat(43), disabledBinding),
			).rejects.toMatchObject({ status: 503 });
		}

		await expect(
			app.createOAuthState(
				{
					provider: "WECHAT",
					purpose: "REGISTER",
					installationId,
					phoneProofId: challengeId,
				},
				null,
				"203.0.113.19",
			),
		).rejects.toMatchObject({ status: 503 });
		await expect(
			app.createOAuthState(
				{
					provider: "WECHAT",
					purpose: "REGISTER",
					installationId,
					phoneChallengeId: challengeId,
				},
				null,
				"203.0.113.19",
			),
		).rejects.toMatchObject({ status: 503 });
		await expect(
			app.register(
				{
					phoneChallengeId: challengeId,
					phoneOtpCode: "123456",
					wechatOAuthState: oauthState,
					wechatAuthorizationCode: "WechatCode123456",
					device,
				},
				"203.0.113.19",
			),
		).rejects.toMatchObject({ status: 503 });
		await expect(
			app.registerWithFusion(
				{
					phoneProofId: challengeId,
					wechatOAuthState: oauthState,
					wechatAuthorizationCode: "WechatCode123456",
					device,
				},
				"203.0.113.19",
			),
		).rejects.toMatchObject({ status: 503 });

		expect(unexpectedRepositoryCall).not.toHaveBeenCalled();
		expect(phoneSend).not.toHaveBeenCalled();
		expect(providers.wechat.verify).not.toHaveBeenCalled();
		expect(providers.qq.verify).not.toHaveBeenCalled();
	});

	it("logs in an existing bound phone with a one-time fusion proof", async () => {
		const pending = {
			id: challengeId,
			purpose: "LOGIN" as const,
			registrationFlowReferenceHash: null,
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
			expiresAt: new Date(Date.now() + 10 * 60_000),
		};
		const completeFusionLogin = vi.fn(async (completion) => ({
			kind: "SUCCESS" as const,
			userId: "5bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			sessionId: completion.session?.sessionId ?? challengeId,
		}));
		const repository = fakeRepository({
			findFusionProof: async () => pending,
			claimFusionVerifyToken: async () => true,
			completeFusionLogin,
		});
		const response = await fusionService(repository, {
			issueToken: vi.fn(),
			verifyToken: vi.fn(async () => ({
				e164PhoneNumber: "+8613800138000",
			})),
		}).service.login(
			{
				method: "PHONE_FUSION",
				flowId: challengeId,
				verifyToken: "FusionVerifyToken_1234567890",
				device,
			},
			"203.0.113.17",
		);

		expect(response.accessToken).toHaveLength(43);
		expect(completeFusionLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				proof: pending,
				verifiedPhone: expect.objectContaining({
					maskedPhone: "+86138****8000",
				}),
			}),
		);
		expect(JSON.stringify(completeFusionLogin.mock.calls)).not.toContain(
			"FusionVerifyToken_1234567890",
		);
		expect(JSON.stringify(completeFusionLogin.mock.calls)).not.toContain(
			"+8613800138000",
		);
	});

	it("rejects a replay claim before calling the fusion provider", async () => {
		const pending = {
			id: challengeId,
			purpose: "LOGIN" as const,
			registrationFlowReferenceHash: null,
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
			expiresAt: new Date(Date.now() + 10 * 60_000),
		};
		const verifyToken = vi.fn();
		const claimFusionVerifyToken = vi.fn(async () => false);
		const repository = fakeRepository({
			findFusionProof: async () => pending,
			claimFusionVerifyToken,
		});

		await expect(
			fusionService(repository, {
				issueToken: vi.fn(),
				verifyToken,
			}).service.login(
				{
					method: "PHONE_FUSION",
					flowId: challengeId,
					verifyToken: "FusionVerifyToken_replayed",
					device,
				},
				"203.0.113.17",
			),
		).rejects.toMatchObject({ status: 401 });
		expect(verifyToken).not.toHaveBeenCalled();
		expect(claimFusionVerifyToken).toHaveBeenCalledWith(
			pending,
			expect.arrayContaining([
				expect.objectContaining({ keyVersion: "v1" }),
				expect.objectContaining({ keyVersion: "stable-dedup-v1" }),
			]),
			expect.objectContaining({ keyVersion: "stable-dedup-v1" }),
		);
	});

	it("claims every current and retiring key version for a maximum-sized VerifyToken", async () => {
		const pending = {
			id: challengeId,
			purpose: "LOGIN" as const,
			registrationFlowReferenceHash: null,
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
			expiresAt: new Date(Date.now() + 10 * 60_000),
		};
		const claimFusionVerifyToken = vi.fn(async () => false);
		const repository = fakeRepository({
			findFusionProof: async () => pending,
			claimFusionVerifyToken,
		});

		await expect(
			fusionService(repository, {
				issueToken: vi.fn(),
				verifyToken: vi.fn(),
			}).service.login(
				{
					method: "PHONE_FUSION",
					flowId: challengeId,
					verifyToken: "T".repeat(4_096),
					device,
				},
				"203.0.113.17",
			),
		).rejects.toMatchObject({ status: 401 });
		const candidates = claimFusionVerifyToken.mock.calls[0]?.[1] ?? [];
		expect(candidates.map((candidate) => candidate.keyVersion).sort()).toEqual([
			"stable-dedup-v1",
			"v1",
		]);
		expect(new Set(candidates.map((candidate) => candidate.value)).size).toBe(2);
	});

	it("consumes a claimed flow after provider rejection without leaking details", async () => {
		const pending = {
			id: challengeId,
			purpose: "LOGIN" as const,
			registrationFlowReferenceHash: null,
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
			expiresAt: new Date(Date.now() + 10 * 60_000),
		};
		const claimFusionVerifyToken = vi.fn(async () => true);
		const completeFusionLogin = vi.fn(async () => ({
			kind: "INVALID_CREDENTIALS" as const,
		}));
		const verifyToken = vi.fn(async () => {
			throw new FusionAuthUnavailableError("UPSTREAM_REJECTED");
		});
		const repository = fakeRepository({
			findFusionProof: async () => pending,
			claimFusionVerifyToken,
			completeFusionLogin,
		});

		const attempt = fusionService(repository, {
			issueToken: vi.fn(),
			verifyToken,
		}).service.login(
			{
				method: "PHONE_FUSION",
				flowId: challengeId,
				verifyToken: "FusionVerifyToken_rejected",
				device,
			},
			"203.0.113.17",
		);
		await expect(attempt).rejects.toMatchObject({ status: 401 });
		expect(completeFusionLogin).toHaveBeenCalledWith({
			proof: pending,
			verifyTokenHash: expect.objectContaining({
				keyVersion: "stable-dedup-v1",
			}),
			verifiedPhone: null,
			session: null,
		});
		expect(claimFusionVerifyToken.mock.invocationCallOrder[0]).toBeLessThan(
			verifyToken.mock.invocationCallOrder[0] as number,
		);
		expect(verifyToken.mock.invocationCallOrder[0]).toBeLessThan(
			completeFusionLogin.mock.invocationCallOrder[0] as number,
		);
		expect(JSON.stringify(completeFusionLogin.mock.calls)).not.toContain(
			"FusionVerifyToken_rejected",
		);
	});

	it("fails closed when fusion is disabled even if a registration proof remains", async () => {
		const findVerifiedFusionProof = vi.fn();
		const repository = fakeRepository({ findVerifiedFusionProof });
		const app = service(repository).service;

		await expect(
			app.createOAuthState(
				{
					provider: "WECHAT",
					purpose: "REGISTER",
					installationId,
					phoneProofId: challengeId,
				},
				null,
				"203.0.113.18",
			),
		).rejects.toMatchObject({ status: 503 });
		await expect(
			app.registerWithFusion(
				{
					phoneProofId: challengeId,
					wechatOAuthState: oauthState,
					wechatAuthorizationCode: "WechatCode123456",
					device,
				},
				"203.0.113.18",
			),
		).rejects.toMatchObject({ status: 503 });
		expect(findVerifiedFusionProof).not.toHaveBeenCalled();
	});

	it("copies the server registration flow and device hash into WeChat state", async () => {
		let inserted: OAuthStateDraft | null = null;
		const repository = fakeRepository({
			findRegistrationFlow: async () => ({
				registrationFlowReferenceHash: "a".repeat(64),
				deviceHash: "b".repeat(64),
				hashKeyVersion: "v1",
			}),
			createOAuthState: async (draft) => {
				inserted = draft;
				return { kind: "CREATED" };
			},
		});
		const app = service(repository).service;
		const response = await app.createOAuthState(
			{
				provider: "WECHAT",
				purpose: "REGISTER",
				installationId,
				phoneChallengeId: challengeId,
			},
			null,
			"203.0.113.8",
		);

		expect(response.state).toHaveLength(43);
		expect(inserted).toMatchObject({
			provider: "WECHAT",
			purpose: "REGISTER",
			flowReferenceHash: "a".repeat(64),
			deviceHash: "b".repeat(64),
		});
		expect(JSON.stringify(inserted)).not.toContain(response.state);
	});

	it("creates a WeChat REGISTER state from a live fusion phone proof", async () => {
		let inserted: OAuthStateDraft | null = null;
		const repository = fakeRepository({
			findVerifiedFusionProof: async () => ({
				id: challengeId,
				purpose: "REGISTER",
				registrationFlowReferenceHash: "a".repeat(64),
				deviceHash: "b".repeat(64),
				hashKeyVersion: "v1",
				expiresAt: new Date(Date.now() + 5 * 60_000),
				verifiedAt: new Date(),
				verifiedPhone: {
					lookup: { value: "c".repeat(64), keyVersion: "v1" },
					dedup: {
						value: "d".repeat(64),
						keyVersion: "stable-dedup-v1",
					},
					maskedPhone: "+86138****8000",
					verifyTokenHash: {
						value: "e".repeat(64),
						keyVersion: "stable-dedup-v1",
					},
				},
			}),
			createOAuthState: async (draft) => {
				inserted = draft;
				return { kind: "CREATED" };
			},
		});
		const response = await fusionService(repository, fusionProvider).service.createOAuthState(
			{
				provider: "WECHAT",
				purpose: "REGISTER",
				installationId,
				phoneProofId: challengeId,
			},
			null,
			"203.0.113.8",
		);

		expect(response.state).toHaveLength(43);
		expect(inserted).toMatchObject({
			provider: "WECHAT",
			purpose: "REGISTER",
			flowReferenceHash: "a".repeat(64),
			deviceHash: "b".repeat(64),
		});
	});

	it("uses a stable HMAC IP scope for login state without storing the raw IP", async () => {
		const inserted: OAuthStateDraft[] = [];
		const repository = fakeRepository({
			createOAuthState: async (draft) => {
				inserted.push(draft);
				return { kind: "CREATED" };
			},
		});
		const app = service(repository).service;
		for (const device of [
			installationId,
			"4cf405ae-82a1-4f87-86b7-1c97c4a8683f",
		]) {
			await app.createOAuthState(
				{ provider: "QQ", purpose: "LOGIN", installationId: device },
				null,
				"198.51.100.10",
			);
		}
		expect(inserted).toHaveLength(2);
		expect(inserted[0]?.flowReferenceHash).toBe(inserted[1]?.flowReferenceHash);
		expect(JSON.stringify(inserted)).not.toContain("198.51.100.10");
	});

	it("marks a pending challenge failed when the real delivery provider fails", async () => {
		const finalize = vi.fn(async () => true);
		const repository = fakeRepository({
			createOtpChallenge: async () => ({ kind: "CREATED" }),
			finalizeOtpDelivery: finalize,
		});
		const app = service(
			repository,
			phoneProvider(async () => {
				throw new OtpDeliveryUnavailableError("NETWORK_ERROR");
			}),
		).service;

		await expect(
			app.requestPhoneCode(
				{
					phoneNumber: "+8613800138000",
					purpose: "LOGIN",
					installationId,
				},
				null,
				"203.0.113.9",
			),
		).rejects.toMatchObject({ status: 503 });
		expect(finalize).toHaveBeenCalledWith(
			expect.any(String),
			"FAILED",
			null,
			null,
		);
	});

	it("records a wrong registration OTP without spending the WeChat code", async () => {
		const config = enabledConfig();
		const pepper = config.auth.otpPepperRing;
		if (pepper === null) throw new Error("test pepper unavailable");
		const encoded = await hashOtpCode("111111", pepper);
		const completeRegistration = vi.fn(async () => ({
			kind: "INVALID_CREDENTIALS" as const,
		}));
		const repository = fakeRepository({
			findOtpProof: async () => ({
				id: challengeId,
				channel: "PHONE",
				purpose: "REGISTER",
				destinationDedupHash: "c".repeat(64),
				codeHash: encoded.value,
				codeHashKeyVersion: encoded.keyVersion,
				operationTargetHash: null,
				targetUserId: null,
				registrationFlowReferenceHash: "d".repeat(64),
				deviceHash: "e".repeat(64),
				hashKeyVersion: "v1",
			}),
			findOAuthProof: async () => ({
				id: "4bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				provider: "WECHAT",
				purpose: "REGISTER",
				flowReferenceHash: "d".repeat(64),
				operationTargetHash: null,
				targetUserId: null,
				deviceHash: "e".repeat(64),
				hashKeyVersion: "v1",
			}),
			completeRegistration,
		});
		const appWithProviders = service(repository);

		await expect(
			appWithProviders.service.register(
				{
					phoneChallengeId: challengeId,
					phoneOtpCode: "222222",
					wechatOAuthState: "A".repeat(43),
					wechatAuthorizationCode: "WechatCode123456",
					device: {
						installationId,
						label: "Pixel test",
						platform: "ANDROID",
						appVersion: "1.0.0",
					},
				},
				"203.0.113.10",
			),
		).rejects.toMatchObject({ status: 401 });
		expect(appWithProviders.wechat.verify).not.toHaveBeenCalled();
		expect(completeRegistration).toHaveBeenCalledWith(
			expect.objectContaining({
				otpVerificationSucceeded: false,
				verifiedWechatIdentity: null,
				session: null,
			}),
		);
	});

	it("registers with matching phone and WeChat proofs and returns only App tokens", async () => {
		const config = enabledConfig();
		const pepper = config.auth.otpPepperRing;
		if (pepper === null) throw new Error("test pepper unavailable");
		const encoded = await hashOtpCode("123456", pepper);
		const completeRegistration = vi.fn(async (completion) => ({
			kind: "SUCCESS" as const,
			userId: "5bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			sessionId: completion.session?.sessionId ?? challengeId,
		}));
		const repository = fakeRepository({
			findOtpProof: async () => ({
				id: challengeId,
				channel: "PHONE",
				purpose: "REGISTER",
				destinationDedupHash: "c".repeat(64),
				codeHash: encoded.value,
				codeHashKeyVersion: encoded.keyVersion,
				operationTargetHash: null,
				targetUserId: null,
				registrationFlowReferenceHash: "d".repeat(64),
				deviceHash: "e".repeat(64),
				hashKeyVersion: "v1",
			}),
			findOAuthProof: async () => ({
				id: "4bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				provider: "WECHAT",
				purpose: "REGISTER",
				flowReferenceHash: "d".repeat(64),
				operationTargetHash: null,
				targetUserId: null,
				deviceHash: "e".repeat(64),
				hashKeyVersion: "v1",
			}),
			completeRegistration,
		});
		const app = service(repository).service;
		const authorizationCode = "WechatCode123456";
		const response = await app.register(
			{
				phoneChallengeId: challengeId,
				phoneOtpCode: "123456",
				wechatOAuthState: oauthState,
				wechatAuthorizationCode: authorizationCode,
				device,
			},
			"203.0.113.12",
		);

		expect(response.accessToken).toHaveLength(43);
		expect(response.refreshToken).toHaveLength(43);
		expect(response.accessToken).not.toBe(response.refreshToken);
		const publicResponse = JSON.stringify(response);
		const persistenceCall = JSON.stringify(completeRegistration.mock.calls);
		for (const privateProof of ["123456", oauthState, authorizationCode]) {
			expect(publicResponse).not.toContain(privateProof);
			expect(persistenceCall).not.toContain(privateProof);
		}
	});

	it("registers only after matching fusion-phone and WeChat proofs", async () => {
		const phoneProof = {
			id: challengeId,
			purpose: "REGISTER" as const,
			registrationFlowReferenceHash: "d".repeat(64),
			deviceHash: "e".repeat(64),
			hashKeyVersion: "v1",
			expiresAt: new Date(Date.now() + 5 * 60_000),
			verifiedAt: new Date(),
			verifiedPhone: {
				lookup: { value: "1".repeat(64), keyVersion: "v1" },
				dedup: {
					value: "2".repeat(64),
					keyVersion: "stable-dedup-v1",
				},
				maskedPhone: "+86138****8000",
				verifyTokenHash: {
					value: "3".repeat(64),
					keyVersion: "stable-dedup-v1",
				},
			},
		};
		const oauthProof = {
			id: "4bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			provider: "WECHAT" as const,
			purpose: "REGISTER" as const,
			flowReferenceHash: phoneProof.registrationFlowReferenceHash,
			operationTargetHash: null,
			targetUserId: null,
			deviceHash: phoneProof.deviceHash,
			hashKeyVersion: "v1",
		};
		const completeFusionRegistration = vi.fn(async (completion) => ({
			kind: "SUCCESS" as const,
			userId: "5bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			sessionId: completion.session.sessionId,
		}));
		const repository = fakeRepository({
			findVerifiedFusionProof: async () => phoneProof,
			findOAuthProof: async () => oauthProof,
			completeFusionRegistration,
		});
		const authorizationCode = "WechatCode123456";
		const response = await fusionService(repository, fusionProvider).service.registerWithFusion(
			{
				phoneProofId: challengeId,
				wechatOAuthState: oauthState,
				wechatAuthorizationCode: authorizationCode,
				device,
			},
			"203.0.113.12",
		);

		expect(response.accessToken).toHaveLength(43);
		expect(completeFusionRegistration).toHaveBeenCalledWith(
			expect.objectContaining({ phoneProof, oauthProof }),
		);
		const persisted = JSON.stringify(completeFusionRegistration.mock.calls);
		expect(persisted).not.toContain(authorizationCode);
		expect(persisted).not.toContain(oauthState);
		expect(persisted).not.toContain("+8613800138000");
	});

	it.each(["PHONE", "EMAIL"] as const)(
		"logs in with a consumed %s OTP and returns separate opaque tokens",
		async (method) => {
			const config = enabledConfig();
			const pepper = config.auth.otpPepperRing;
			if (pepper === null) throw new Error("test pepper unavailable");
			const encoded = await hashOtpCode("654321", pepper);
			const completeOtpLogin = vi.fn(async (completion) => ({
				kind: "SUCCESS" as const,
				userId: "5bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				sessionId: completion.session?.sessionId ?? challengeId,
			}));
			const repository = fakeRepository({
				findOtpProof: async () => ({
					id: challengeId,
					channel: method,
					purpose: "LOGIN",
					destinationDedupHash: "c".repeat(64),
					codeHash: encoded.value,
					codeHashKeyVersion: encoded.keyVersion,
					operationTargetHash: null,
					targetUserId: null,
					registrationFlowReferenceHash: null,
					deviceHash: "e".repeat(64),
					hashKeyVersion: "v1",
				}),
				completeOtpLogin,
			});
			const response = await service(repository).service.login(
				{ method, challengeId, otpCode: "654321", device },
				"203.0.113.13",
			);
			expect(response.accessToken).toHaveLength(43);
			expect(response.refreshToken).toHaveLength(43);
			expect(JSON.stringify(completeOtpLogin.mock.calls)).not.toContain(
				"654321",
			);
		},
	);

	it.each(["WECHAT", "QQ"] as const)(
		"logs in with a server-verified %s proof and persists only hashes",
		async (method) => {
			const completeOAuthLogin = vi.fn(async (completion) => ({
				kind: "SUCCESS" as const,
				userId: "5bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				sessionId: completion.session.sessionId,
			}));
			const repository = fakeRepository({
				findOAuthProof: async () => ({
					id: "4bf405ae-82a1-4f87-86b7-1c97c4a8683f",
					provider: method,
					purpose: "LOGIN",
					flowReferenceHash: "d".repeat(64),
					operationTargetHash: null,
					targetUserId: null,
					deviceHash: "e".repeat(64),
					hashKeyVersion: "v1",
				}),
				completeOAuthLogin,
			});
			const privateProviderProof =
				method === "WECHAT" ? "WechatCode123456" : "QqAccessToken123456";
			const request =
				method === "WECHAT"
					? {
							method,
							oauthState,
							authorizationCode: privateProviderProof,
							device,
						}
					: { method, oauthState, accessToken: privateProviderProof, device };
			const response = await service(repository).service.login(
				request,
				"203.0.113.14",
			);
			expect(response.accessToken).toHaveLength(43);
			expect(response.refreshToken).toHaveLength(43);
			const persisted = JSON.stringify(completeOAuthLogin.mock.calls);
			expect(persisted).not.toContain(oauthState);
			expect(persisted).not.toContain(privateProviderProof);
		},
	);

	it.each(["FLOW", "DEVICE", "STATE"] as const)(
		"rejects a registration %s mismatch before calling WeChat upstream",
		async (mismatch) => {
			const repository = fakeRepository({
				findOtpProof: async () => ({
					id: challengeId,
					channel: "PHONE",
					purpose: "REGISTER",
					destinationDedupHash: "c".repeat(64),
					codeHash: "not-used",
					codeHashKeyVersion: "v1",
					operationTargetHash: null,
					targetUserId: null,
					registrationFlowReferenceHash: "d".repeat(64),
					deviceHash: "e".repeat(64),
					hashKeyVersion: "v1",
				}),
				findOAuthProof: async () =>
					mismatch === "STATE"
						? null
						: {
								id: "4bf405ae-82a1-4f87-86b7-1c97c4a8683f",
								provider: "WECHAT",
								purpose: "REGISTER",
								flowReferenceHash:
									mismatch === "FLOW" ? "f".repeat(64) : "d".repeat(64),
								operationTargetHash: null,
								targetUserId: null,
								deviceHash:
									mismatch === "DEVICE" ? "0".repeat(64) : "e".repeat(64),
								hashKeyVersion: "v1",
							},
			});
			const appWithProviders = service(repository);
			await expect(
				appWithProviders.service.register(
					{
						phoneChallengeId: challengeId,
						phoneOtpCode: "123456",
						wechatOAuthState: oauthState,
						wechatAuthorizationCode: "WechatCode123456",
						device,
					},
					"203.0.113.15",
				),
			).rejects.toMatchObject({ status: 401 });
			expect(appWithProviders.wechat.verify).not.toHaveBeenCalled();
		},
	);

	it.each([
		["UPSTREAM_REJECTED", 401],
		["TIMEOUT", 503],
	] as const)("maps WeChat %s to HTTP %i", async (reason, status) => {
		const repository = fakeRepository({
			findOAuthProof: async () => ({
				id: "4bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				provider: "WECHAT",
				purpose: "LOGIN",
				flowReferenceHash: "d".repeat(64),
				operationTargetHash: null,
				targetUserId: null,
				deviceHash: "e".repeat(64),
				hashKeyVersion: "v1",
			}),
		});
		const providers = identityProviders();
		providers.wechat.verify = vi.fn(async () => {
			throw new ExternalIdentityUnavailableError(reason);
		});
		await expect(
			service(repository, phoneProvider(), providers).service.login(
				{
					method: "WECHAT",
					oauthState,
					authorizationCode: "WechatCode123456",
					device,
				},
				"203.0.113.16",
			),
		).rejects.toMatchObject({ status });
	});

	it("maps both OAuth and OTP durable limits to 429 with retry metadata", async () => {
		const oauthRepository = fakeRepository({
			createOAuthState: async () => ({
				kind: "RATE_LIMITED",
				retryAfterSeconds: 47,
			}),
		});
		let oauthFailure: unknown;
		try {
			await service(oauthRepository).service.createOAuthState(
				{ provider: "QQ", purpose: "LOGIN", installationId },
				null,
				"203.0.113.17",
			);
		} catch (error) {
			oauthFailure = error;
		}
		expect(oauthFailure).toMatchObject({
			status: 429,
			retryAfterSeconds: 47,
		});

		const send = vi.fn(phoneProvider().send);
		const otpRepository = fakeRepository({
			createOtpChallenge: async () => ({
				kind: "RATE_LIMITED",
				retryAfterSeconds: 31,
			}),
		});
		let otpFailure: unknown;
		try {
			await service(
				otpRepository,
				phoneProvider(send),
			).service.requestPhoneCode(
				{
					phoneNumber: "+8613800138000",
					purpose: "LOGIN",
					installationId,
				},
				null,
				"203.0.113.18",
			);
		} catch (error) {
			otpFailure = error;
		}
		expect(otpFailure).toMatchObject({
			status: 429,
			retryAfterSeconds: 31,
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("maps refresh replay to a non-reflective reauthentication error", async () => {
		const refreshSession = vi.fn(async () => ({ kind: "REPLAY" as const }));
		const repository = fakeRepository({ refreshSession });
		const app = service(repository).service;
		let failure: unknown;
		try {
			await app.refresh(
				{ refreshToken: "R".repeat(43), installationId },
				"203.0.113.11",
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(HttpException);
		expect((failure as HttpException).getStatus()).toBe(401);
		expect((failure as HttpException).getResponse()).toMatchObject({
			code: "TOKEN_REPLAY_DETECTED",
		});
		expect(JSON.stringify(refreshSession.mock.calls)).not.toContain(
			"R".repeat(43),
		);
	});

	it("maps an unknown or expired refresh token to SESSION_EXPIRED", async () => {
		const repository = fakeRepository({
			refreshSession: async () => ({ kind: "INVALID" }),
		});
		let failure: unknown;
		try {
			await service(repository).service.refresh(
				{ refreshToken: "R".repeat(43), installationId },
				"203.0.113.19",
			);
		} catch (error) {
			failure = error;
		}
		expect((failure as HttpException).getStatus()).toBe(401);
		expect((failure as HttpException).getResponse()).toMatchObject({
			code: "SESSION_EXPIRED",
		});
	});

	it("binds an email challenge to the authenticated device without persisting raw inputs", async () => {
		const createOtpChallenge = vi.fn(async () => ({
			kind: "CREATED" as const,
		}));
		const finalizeOtpDelivery = vi.fn(async () => true);
		const emailSend = vi.fn(async () => ({
			provider: "SMTP" as const,
			requestReference: "mail-reference",
		}));
		const repository = authenticatedRepository({
			createOtpChallenge,
			finalizeOtpDelivery,
		});
		const response = await service(
			repository,
			phoneProvider(),
			identityProviders(),
			{ channel: "EMAIL", send: emailSend },
		).service.requestEmailCode(
			{
				email: "student@example.com",
				purpose: "BIND",
				installationId,
			},
			appAccessToken,
			"203.0.113.20",
		);
		expect(response.targetType).toBe("EMAIL");
		expect(createOtpChallenge).toHaveBeenCalledWith(
			expect.objectContaining({
				purpose: "BIND",
				targetUserId: authenticatedSession.userId,
				deviceHash: authenticatedSession.deviceHash,
				operationTargetHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
			}),
		);
		const persisted = JSON.stringify(createOtpChallenge.mock.calls);
		expect(persisted).not.toContain("student@example.com");
		expect(persisted).not.toContain(appAccessToken);
	});

	it("issues a QQ BIND state scoped to the authenticated session", async () => {
		const createOAuthState = vi.fn(async () => ({ kind: "CREATED" as const }));
		const repository = authenticatedRepository({ createOAuthState });
		const app = service(repository).service;
		const response = await app.createOAuthState(
			{ provider: "QQ", purpose: "BIND", installationId },
			appAccessToken,
			"203.0.113.21",
		);
		expect(response).toMatchObject({ provider: "QQ", purpose: "BIND" });
		expect(createOAuthState).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "QQ",
				purpose: "BIND",
				targetUserId: authenticatedSession.userId,
				deviceHash: authenticatedSession.deviceHash,
				operationTargetHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
				flowReferenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
			}),
		);
		expect(createOAuthState).toHaveBeenCalledTimes(1);
	});

	it("consumes an EMAIL BIND proof and returns only its masked binding", async () => {
		const config = enabledConfig();
		const pepper = config.auth.otpPepperRing;
		if (pepper === null) throw new Error("test pepper unavailable");
		const encoded = await hashOtpCode("246810", pepper);
		const completeOtpBinding = vi.fn(async () => ({
			kind: "SUCCESS" as const,
			binding: {
				bindingId: "7bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				type: "EMAIL" as const,
				maskedValue: "s*****t@example.com",
				boundAt: new Date("2026-08-21T05:00:00.000Z"),
				primary: false,
				canUnbind: true,
				revokedAt: null,
			},
		}));
		const repository = authenticatedRepository({
			findOtpProof: async () => ({
				id: challengeId,
				channel: "EMAIL",
				purpose: "BIND",
				destinationDedupHash: "c".repeat(64),
				codeHash: encoded.value,
				codeHashKeyVersion: encoded.keyVersion,
				operationTargetHash: "d".repeat(64),
				targetUserId: authenticatedSession.userId,
				registrationFlowReferenceHash: null,
				deviceHash: authenticatedSession.deviceHash,
				hashKeyVersion: "v1",
			}),
			completeOtpBinding,
		});
		const response = await service(repository).service.bindIdentity(
			appAccessToken,
			{ type: "EMAIL", challengeId, otpCode: "246810" },
		);
		expect(response.binding).toMatchObject({
			type: "EMAIL",
			maskedValue: "s*****t@example.com",
			canUnbind: true,
		});
		const persisted = JSON.stringify(completeOtpBinding.mock.calls);
		expect(persisted).not.toContain("246810");
		expect(persisted).not.toContain(appAccessToken);
	});

	it("records a bad EMAIL BIND OTP, rejects replay and maps an ownership conflict", async () => {
		const config = enabledConfig();
		const pepper = config.auth.otpPepperRing;
		if (pepper === null) throw new Error("test pepper unavailable");
		const encoded = await hashOtpCode("135790", pepper);
		const proof = {
			id: challengeId,
			channel: "EMAIL" as const,
			purpose: "BIND" as const,
			destinationDedupHash: "c".repeat(64),
			codeHash: encoded.value,
			codeHashKeyVersion: encoded.keyVersion,
			operationTargetHash: "d".repeat(64),
			targetUserId: authenticatedSession.userId,
			registrationFlowReferenceHash: null,
			deviceHash: authenticatedSession.deviceHash,
			hashKeyVersion: "v1",
		};
		const completeOtpBinding = vi.fn(async () => ({
			kind: "INVALID_CREDENTIALS" as const,
		}));
		await expect(
			service(
				authenticatedRepository({
					findOtpProof: async () => proof,
					completeOtpBinding,
				}),
			).service.bindIdentity(appAccessToken, {
				type: "EMAIL",
				challengeId,
				otpCode: "000000",
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(completeOtpBinding).toHaveBeenCalledWith(
			expect.objectContaining({ verificationSucceeded: false }),
		);

		await expect(
			service(
				authenticatedRepository({ findOtpProof: async () => null }),
			).service.bindIdentity(appAccessToken, {
				type: "EMAIL",
				challengeId,
				otpCode: "135790",
			}),
		).rejects.toMatchObject({ status: 401 });

		await expect(
			service(
				authenticatedRepository({
					findOtpProof: async () => proof,
					completeOtpBinding: async () => ({
						kind: "IDENTITY_CONFLICT",
					}),
				}),
			).service.bindIdentity(appAccessToken, {
				type: "EMAIL",
				challengeId,
				otpCode: "135790",
			}),
		).rejects.toMatchObject({ status: 409 });
	});

	it("consumes a QQ BIND state without persisting its raw state or provider token", async () => {
		const completeOAuthBinding = vi.fn(async () => ({
			kind: "SUCCESS" as const,
			binding: {
				bindingId: "8bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				type: "QQ" as const,
				maskedValue: "QQ 账号",
				boundAt: new Date("2026-08-21T05:05:00.000Z"),
				primary: false,
				canUnbind: true,
				revokedAt: null,
			},
		}));
		const repository = authenticatedRepository({
			findOAuthProof: async () => ({
				id: "9bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				provider: "QQ",
				purpose: "BIND",
				flowReferenceHash: "c".repeat(64),
				operationTargetHash: "d".repeat(64),
				targetUserId: authenticatedSession.userId,
				deviceHash: authenticatedSession.deviceHash,
				hashKeyVersion: "v1",
			}),
			completeOAuthBinding,
		});
		const providerToken = "QqAccessToken123456";
		const response = await service(repository).service.bindIdentity(
			appAccessToken,
			{ type: "QQ", oauthState, accessToken: providerToken },
		);
		expect(response.binding).toMatchObject({ type: "QQ", canUnbind: true });
		const persisted = JSON.stringify(completeOAuthBinding.mock.calls);
		expect(persisted).not.toContain(oauthState);
		expect(persisted).not.toContain(providerToken);
	});

	it("rejects a replayed QQ BIND state before contacting the provider", async () => {
		const providers = identityProviders();
		await expect(
			service(
				authenticatedRepository({ findOAuthProof: async () => null }),
				phoneProvider(),
				providers,
			).service.bindIdentity(appAccessToken, {
				type: "QQ",
				oauthState,
				accessToken: "QqAccessToken123456",
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(providers.qq.verify).not.toHaveBeenCalled();
	});

	it("maps identity and session management records without exposing hashes", async () => {
		const boundAt = new Date("2026-08-21T05:10:00.000Z");
		const createdAt = new Date("2026-08-20T05:10:00.000Z");
		const repository = authenticatedRepository({
			listIdentityBindings: async () => [
				{
					bindingId: "abf405ae-82a1-4f87-86b7-1c97c4a8683f",
					type: "PHONE",
					maskedValue: "+86138****8000",
					boundAt,
					primary: true,
					canUnbind: false,
					revokedAt: null,
				},
			],
			listSessions: async () => [
				{
					sessionId: authenticatedSession.sessionId,
					deviceLabel: "Pixel test",
					platform: "ANDROID",
					current: true,
					createdAt,
					lastActiveAt: boundAt,
					expiresAt: new Date("2026-09-01T05:10:00.000Z"),
				},
			],
		});
		const app = service(repository).service;
		expect(await app.listIdentities(appAccessToken)).toEqual({
			items: [
				{
					bindingId: "abf405ae-82a1-4f87-86b7-1c97c4a8683f",
					type: "PHONE",
					maskedValue: "+86138****8000",
					boundAt: boundAt.toISOString(),
					primary: true,
					canUnbind: false,
				},
			],
		});
		expect((await app.listSessions(appAccessToken)).items[0]).toMatchObject({
			current: true,
			deviceLabel: "Pixel test",
		});
	});

	it("supports logout, session revocation and idempotent non-primary unbind outcomes", async () => {
		const revokedAt = new Date("2026-08-21T05:15:00.000Z");
		const revokeSession = vi.fn(async () => ({
			kind: "SUCCESS" as const,
			revokedAt,
		}));
		const unbindIdentity = vi.fn(async () => ({
			kind: "SUCCESS" as const,
			unboundAt: revokedAt,
		}));
		const app = service(
			authenticatedRepository({ revokeSession, unbindIdentity }),
		).service;
		expect(await app.logout(appAccessToken)).toEqual({
			sessionId: authenticatedSession.sessionId,
			loggedOutAt: revokedAt.toISOString(),
		});
		expect(revokeSession).toHaveBeenCalledWith(
			expect.objectContaining({ userId: authenticatedSession.userId }),
			authenticatedSession.sessionId,
		);
		expect(
			await app.unbindIdentity(
				appAccessToken,
				"bbf405ae-82a1-4f87-86b7-1c97c4a8683f",
			),
		).toMatchObject({ unboundAt: revokedAt.toISOString() });
	});

	it("queues either export scope faithfully and never returns an artifact locator", async () => {
		const queueDataExport = vi.fn(async (_session, draft) => ({
			kind: "SUCCESS" as const,
			exportId: "cbf405ae-82a1-4f87-86b7-1c97c4a8683f",
			requestedAt: new Date("2026-08-21T05:20:00.000Z"),
			expiresAt: new Date("2026-08-28T05:20:00.000Z"),
			includeBehaviorHistory: draft.includeBehaviorHistory,
		}));
		const repository = authenticatedRepository({ queueDataExport });
		const app = service(repository).service;
		const response = await app.requestExport(appAccessToken, {
			format: "JSON",
			includeBehaviorHistory: true,
		});
		expect(response.status).toBe("QUEUED");
		expect(JSON.stringify(response)).not.toMatch(/artifact|locator|https?:/iu);
		await expect(
			app.requestExport(appAccessToken, {
				format: "JSON",
				includeBehaviorHistory: false,
			}),
		).resolves.toMatchObject({ includeBehaviorHistory: false });
		expect(queueDataExport).toHaveBeenLastCalledWith(
			expect.objectContaining({ userId: authenticatedSession.userId }),
			expect.objectContaining({ includeBehaviorHistory: false }),
		);
	});

	it("returns owner-scoped export status without internal worker metadata", async () => {
		const record = {
			exportId: "cbf405ae-82a1-4f87-86b7-1c97c4a8683f",
			status: "READY" as const,
			requestedAt: new Date("2026-08-21T05:20:00.000Z"),
			readyAt: new Date("2026-08-21T05:21:00.000Z"),
			expiresAt: new Date("2099-08-28T05:20:00.000Z"),
			includeBehaviorHistory: true,
			artifactSizeBytes: 17,
			artifactSha256: "a".repeat(64),
		};
		const app = service(
			authenticatedRepository({
				readDataExport: async () => ({ kind: "SUCCESS", record }),
				readLatestDataExport: async () => ({ kind: "SUCCESS", record }),
			}),
		).service;
		const status = await app.getExport(appAccessToken, record.exportId);
		expect(status).toMatchObject({
			status: "READY",
			sizeBytes: 17,
			contentType: "application/json",
			downloadAvailable: true,
		});
		expect(await app.getLatestExport(appAccessToken)).toEqual({ item: status });
		expect(JSON.stringify(status)).not.toMatch(
			/locator|objectKey|ciphertext|keyVersion|worker/iu,
		);
	});

	it("opens export bytes only after status and artifact metadata agree", async () => {
		const exportId = "cbf405ae-82a1-4f87-86b7-1c97c4a8683f";
		const locatorCiphertext = Buffer.from("encrypted-internal-locator");
		const record = {
			exportId,
			status: "READY" as const,
			requestedAt: new Date("2026-08-21T05:20:00.000Z"),
			readyAt: new Date("2026-08-21T05:21:00.000Z"),
			expiresAt: new Date("2099-08-28T05:20:00.000Z"),
			includeBehaviorHistory: false,
			artifactSizeBytes: 2,
			artifactSha256: "b".repeat(64),
		};
		let readerLocatorCiphertext: Buffer | null = null;
		const reader: ExportArtifactReader = {
			open: vi.fn(
				async (request: Parameters<ExportArtifactReader["open"]>[0]) => {
					readerLocatorCiphertext = Buffer.from(request.locatorCiphertext);
					return { body: Readable.from(["{}"]) };
				},
			),
		};
		const app = service(
			authenticatedRepository({
				readDataExport: async () => ({ kind: "SUCCESS", record }),
				openDataExportArtifact: async () => ({
					kind: "SUCCESS",
					artifact: {
						locatorCiphertext,
						locatorKeyVersion: "v1",
						sizeBytes: 2,
						sha256: "b".repeat(64),
						contentType: "application/json",
					},
				}),
			}),
			phoneProvider(),
			identityProviders(),
			emailProvider,
			reader,
		).service;
		const content = await app.openExportContent(appAccessToken, exportId);
		expect(content).toMatchObject({
			sizeBytes: 2,
			sha256: "b".repeat(64),
			contentType: "application/json",
		});
		expect(reader.open).toHaveBeenCalledTimes(1);
		expect(readerLocatorCiphertext).toEqual(
			Buffer.from("encrypted-internal-locator"),
		);
		expect(locatorCiphertext.every((byte) => byte === 0)).toBe(true);
		expect(JSON.stringify(content)).not.toContain("encrypted-internal-locator");
	});

	it("zeroes the internal export locator when the artifact reader fails", async () => {
		const exportId = "cbf405ae-82a1-4f87-86b7-1c97c4a8683f";
		const locatorCiphertext = Buffer.from("reader-failure-locator");
		const record = {
			exportId,
			status: "READY" as const,
			requestedAt: new Date("2026-08-21T05:20:00.000Z"),
			readyAt: new Date("2026-08-21T05:21:00.000Z"),
			expiresAt: new Date("2099-08-28T05:20:00.000Z"),
			includeBehaviorHistory: false,
			artifactSizeBytes: 2,
			artifactSha256: "b".repeat(64),
		};
		let readerLocatorCiphertext: Buffer | null = null;
		const reader: ExportArtifactReader = {
			open: vi.fn(
				async (request: Parameters<ExportArtifactReader["open"]>[0]) => {
					readerLocatorCiphertext = Buffer.from(request.locatorCiphertext);
					throw new Error("reader unavailable");
				},
			),
		};
		const app = service(
			authenticatedRepository({
				readDataExport: async () => ({ kind: "SUCCESS", record }),
				openDataExportArtifact: async () => ({
					kind: "SUCCESS",
					artifact: {
						locatorCiphertext,
						locatorKeyVersion: "v1",
						sizeBytes: 2,
						sha256: "b".repeat(64),
						contentType: "application/json",
					},
				}),
			}),
			phoneProvider(),
			identityProviders(),
			emailProvider,
			reader,
		).service;

		await expect(
			app.openExportContent(appAccessToken, exportId),
		).rejects.toMatchObject({ status: 503 });
		expect(readerLocatorCiphertext).toEqual(
			Buffer.from("reader-failure-locator"),
		);
		expect(locatorCiphertext.every((byte) => byte === 0)).toBe(true);
	});

	it("deactivates the account and rejects the same bearer immediately afterward", async () => {
		let active = true;
		const repository = fakeRepository({
			authenticateAccess: async () => (active ? authenticatedSession : null),
			beginAccountDeletion: async () => {
				active = false;
				return {
					kind: "SUCCESS" as const,
					requestedAt: new Date("2026-08-21T05:25:00.000Z"),
					purgeDueAt: new Date("2026-09-20T05:25:00.000Z"),
				};
			},
			listSessions: async () => [],
		});
		const app = service(repository).service;
		const response = await app.deleteAccount(appAccessToken, {
			confirmation: "DELETE_MY_ACCOUNT",
		});
		expect(response).toMatchObject({
			userId: authenticatedSession.userId,
			status: "DEACTIVATED",
		});
		await expect(app.listSessions(appAccessToken)).rejects.toMatchObject({
			status: 401,
		});
	});
});
