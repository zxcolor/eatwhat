import {
	CONTRACT_VERSION_HEADER,
	CURRENT_CONTRACT_VERSION,
} from "@chi-shen-me/contracts";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { AppModule } from "../app.module.js";
import { configureHttpRuntime } from "../common/http-runtime-security.js";
import { SafeExceptionFilter } from "../common/safe-exception.filter.js";
import { APP_CONFIG, loadAppConfig } from "../config/app-config.js";
import { DatabasePool } from "../database/database-pool.js";
import { AuthRepository } from "./auth.repository.js";
import {
	ALIYUN_CREDENTIAL,
	ALIYUN_FUSION_CLIENT,
	ALIYUN_SMS_CLIENT,
	EMAIL_OTP_PROVIDER,
	FUSION_AUTH_PROVIDER,
	PHONE_OTP_PROVIDER,
	QQ_IDENTITY_PROVIDER,
	SMTP_CLIENT,
	WECHAT_IDENTITY_PROVIDER,
} from "./auth-provider.factories.js";
import type {
	FusionAuthProof,
	VerifiedFusionAuthProof,
} from "./auth-workflow.types.js";
import { AUTHENTICATED_USER_RESOLVER } from "./authenticated-user.resolver.js";

const INSTALLATION_ID = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
const FUSION_AUTH_TOKEN = "FusionAuthToken_test_1234567890";
const FUSION_VERIFY_TOKEN = "FusionVerifyToken_test_1234567890";
const OAUTH_STATE = "A".repeat(43);
const AUTHORIZATION_CODE = "WechatAuthorizationCode_test";

const repository = {
	isAvailable: vi.fn(() => true),
	createFusionFlow: vi.fn(async () => true),
	findFusionProof: vi.fn(),
	claimFusionVerifyToken: vi.fn(async () => true),
	findVerifiedFusionProof: vi.fn(),
	completeFusionVerification: vi.fn(),
	completeFusionLogin: vi.fn(),
	completeFusionRegistration: vi.fn(),
	createOtpChallenge: vi.fn(),
	finalizeOtpDelivery: vi.fn(),
	findOtpProof: vi.fn(),
	findRegistrationFlow: vi.fn(),
	createOAuthState: vi.fn(),
	findOAuthProof: vi.fn(),
	authenticateAccess: vi.fn(),
	completeOtpLogin: vi.fn(),
	completeOAuthLogin: vi.fn(),
	completeRegistration: vi.fn(),
};

const fusionProvider = {
	issueToken: vi.fn(async () => ({ authToken: FUSION_AUTH_TOKEN })),
	verifyToken: vi.fn(async () => ({ e164PhoneNumber: "+8613800138000" })),
};
const phoneProvider = { channel: "PHONE", send: vi.fn() };
const emailProvider = { channel: "EMAIL", send: vi.fn() };
const wechatProvider = { verify: vi.fn() };
const qqProvider = { verify: vi.fn() };
const authenticatedUserResolver = { resolveAccessToken: vi.fn() };
const aliyunFusionClient = {
	getFusionAuthTokenWithOptions: vi.fn(),
	verifyWithFusionAuthTokenWithOptions: vi.fn(),
};
const aliyunSmsClient = { sendSmsWithOptions: vi.fn() };
const smtpClient = { verify: vi.fn(), sendMail: vi.fn(), close: vi.fn() };

const repositoryEffects = [
	repository.createFusionFlow,
	repository.findFusionProof,
	repository.claimFusionVerifyToken,
	repository.findVerifiedFusionProof,
	repository.completeFusionVerification,
	repository.completeFusionLogin,
	repository.completeFusionRegistration,
	repository.createOtpChallenge,
	repository.finalizeOtpDelivery,
	repository.findOtpProof,
	repository.findRegistrationFlow,
	repository.createOAuthState,
	repository.findOAuthProof,
	repository.authenticateAccess,
	repository.completeOtpLogin,
	repository.completeOAuthLogin,
	repository.completeRegistration,
] as const;

const providerEffects = [
	fusionProvider.issueToken,
	fusionProvider.verifyToken,
	phoneProvider.send,
	emailProvider.send,
	wechatProvider.verify,
	qqProvider.verify,
	authenticatedUserResolver.resolveAccessToken,
	aliyunFusionClient.getFusionAuthTokenWithOptions,
	aliyunFusionClient.verifyWithFusionAuthTokenWithOptions,
	aliyunSmsClient.sendSmsWithOptions,
	smtpClient.verify,
	smtpClient.sendMail,
	smtpClient.close,
] as const;

function fusionOnlyConfig() {
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://test_user:test_password@127.0.0.1:5432/test_db",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "false",
		FUSION_AUTH_ENABLED: "true",
		EMAIL_AUTH_ENABLED: "false",
		WECHAT_AUTH_ENABLED: "false",
		QQ_AUTH_ENABLED: "false",
		AUTH_HASH_KEYS_JSON: JSON.stringify({
			v1: Buffer.alloc(32, 0x11).toString("base64"),
		}),
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_FUSION_SCHEME_CODE: "fusion_test_scheme",
		ALIYUN_FUSION_PACKAGE_NAME: "com.chishenme.app",
		ALIYUN_FUSION_PACKAGE_SIGN: "0123456789abcdef0123456789abcdef",
		AMAP_ENABLED: "false",
		QWEN_ENABLED: "false",
	});
}

async function post(baseUrl: string, path: string, body: unknown) {
	return fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function expectUnavailable(response: Response): Promise<void> {
	const body = (await response.json()) as Record<string, unknown>;
	expect(response.status).toBe(503);
	expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
		CURRENT_CONTRACT_VERSION,
	);
	expect(body).toMatchObject({
		code: "AUTH_CHANNEL_UNAVAILABLE",
		message: "该账号能力暂未开放或暂时不可用",
	});
}

function expectNoAuthSideEffects(): void {
	expect(repository.isAvailable).not.toHaveBeenCalled();
	for (const effect of [...repositoryEffects, ...providerEffects]) {
		expect(effect).not.toHaveBeenCalled();
	}
}

describe("Fusion-only account HTTP boundary", () => {
	let app: INestApplication;
	let baseUrl: string;

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(APP_CONFIG)
			.useValue(fusionOnlyConfig())
			.overrideProvider(DatabasePool)
			.useValue({
				isEnabled: () => true,
				isReady: async () => true,
				query: vi.fn(),
				withTransaction: vi.fn(),
			})
			.overrideProvider(AuthRepository)
			.useValue(repository)
			.overrideProvider(ALIYUN_CREDENTIAL)
			.useValue(Object.freeze({ provider: "test" }))
			.overrideProvider(ALIYUN_FUSION_CLIENT)
			.useValue(aliyunFusionClient)
			.overrideProvider(ALIYUN_SMS_CLIENT)
			.useValue(aliyunSmsClient)
			.overrideProvider(SMTP_CLIENT)
			.useValue(smtpClient)
			.overrideProvider(FUSION_AUTH_PROVIDER)
			.useValue(fusionProvider)
			.overrideProvider(PHONE_OTP_PROVIDER)
			.useValue(phoneProvider)
			.overrideProvider(EMAIL_OTP_PROVIDER)
			.useValue(emailProvider)
			.overrideProvider(WECHAT_IDENTITY_PROVIDER)
			.useValue(wechatProvider)
			.overrideProvider(QQ_IDENTITY_PROVIDER)
			.useValue(qqProvider)
			.overrideProvider(AUTHENTICATED_USER_RESOLVER)
			.useValue(authenticatedUserResolver)
			.compile();
		app = module.createNestApplication({ bodyParser: false });
		app.useGlobalFilters(new SafeExceptionFilter());
		configureHttpRuntime(app, app.get(APP_CONFIG));
		await app.listen(0, "127.0.0.1");
		baseUrl = await app.getUrl();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		repository.isAvailable.mockReturnValue(true);
		repository.createFusionFlow.mockResolvedValue(true);
		repository.claimFusionVerifyToken.mockResolvedValue(true);
		fusionProvider.issueToken.mockResolvedValue({
			authToken: FUSION_AUTH_TOKEN,
		});
		fusionProvider.verifyToken.mockResolvedValue({
			e164PhoneNumber: "+8613800138000",
		});
	});

	afterAll(async () => {
		await app.close();
	});

	it("publishes Fusion without advertising registration, SMS or WeChat", async () => {
		const response = await fetch(`${baseUrl}/v1/config`);

		expect(response.status).toBe(200);
		expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(
			CURRENT_CONTRACT_VERSION,
		);
		await expect(response.json()).resolves.toMatchObject({
			accountsEnabled: true,
			authCapabilities: {
				accountsEnabled: true,
				registrationEnabled: false,
				phoneEnabled: false,
				fusionEnabled: true,
				wechatEnabled: false,
				emailEnabled: false,
				qqEnabled: false,
			},
		});
		expectNoAuthSideEffects();
	});

	it.each([
		[
			"SMS REGISTER",
			"/v1/auth/phone/request-code",
			{
				phoneNumber: "+8613800138000",
				purpose: "REGISTER",
				installationId: INSTALLATION_ID,
			},
		],
		[
			"SMS LOGIN",
			"/v1/auth/phone/request-code",
			{
				phoneNumber: "+8613800138000",
				purpose: "LOGIN",
				installationId: INSTALLATION_ID,
			},
		],
		[
			"WeChat REGISTER state",
			"/v1/auth/oauth/state",
			{
				provider: "WECHAT",
				purpose: "REGISTER",
				installationId: INSTALLATION_ID,
				phoneProofId: "55555555-5555-4555-8555-555555555555",
			},
		],
		[
			"WeChat LOGIN state",
			"/v1/auth/oauth/state",
			{
				provider: "WECHAT",
				purpose: "LOGIN",
				installationId: INSTALLATION_ID,
			},
		],
		[
			"phone plus WeChat registration",
			"/v1/auth/register/phone-wechat",
			{
				phoneChallengeId: "44444444-4444-4444-8444-444444444444",
				phoneOtpCode: "123456",
				wechatOAuthState: OAUTH_STATE,
				wechatAuthorizationCode: AUTHORIZATION_CODE,
				device: {
					installationId: INSTALLATION_ID,
					label: "Pixel test",
					platform: "ANDROID",
					appVersion: "1.0.0",
				},
			},
		],
		[
			"Fusion plus WeChat registration",
			"/v1/auth/register/fusion-wechat",
			{
				phoneProofId: "55555555-5555-4555-8555-555555555555",
				wechatOAuthState: OAUTH_STATE,
				wechatAuthorizationCode: AUTHORIZATION_CODE,
				device: {
					installationId: INSTALLATION_ID,
					label: "Pixel test",
					platform: "ANDROID",
					appVersion: "1.0.0",
				},
			},
		],
		[
			"WeChat login",
			"/v1/auth/login",
			{
				method: "WECHAT",
				oauthState: OAUTH_STATE,
				authorizationCode: AUTHORIZATION_CODE,
				device: {
					installationId: INSTALLATION_ID,
					label: "Pixel test",
					platform: "ANDROID",
					appVersion: "1.0.0",
				},
			},
		],
	] as const)(
		"fails closed for %s before repository or provider work",
		async (_name, path, body) => {
			await expectUnavailable(await post(baseUrl, path, body));
			expectNoAuthSideEffects();
		},
	);

	it("keeps REGISTER Fusion token and verification as a proof-only HTTP flow", async () => {
		const tokenResponse = await post(baseUrl, "/v1/auth/phone/fusion-token", {
			purpose: "REGISTER",
			installationId: INSTALLATION_ID,
		});
		const tokenBody = (await tokenResponse.json()) as {
			readonly flowId: string;
			readonly schemeCode: string;
			readonly authToken: string;
			readonly expiresAt: string;
		};

		expect(tokenResponse.status).toBe(201);
		expect(tokenResponse.headers.get("cache-control")).toContain("no-store");
		expect(tokenBody).toMatchObject({
			schemeCode: "fusion_test_scheme",
			authToken: FUSION_AUTH_TOKEN,
		});
		expect(tokenBody.flowId).toMatch(/^[0-9a-f-]{36}$/iu);
		expect(Number.isFinite(Date.parse(tokenBody.expiresAt))).toBe(true);
		expect(fusionProvider.issueToken).toHaveBeenCalledOnce();
		expect(repository.createFusionFlow).toHaveBeenCalledOnce();
		const createdFlow = repository.createFusionFlow.mock.calls[0]?.[0];
		expect(createdFlow).toMatchObject({
			id: tokenBody.flowId,
			purpose: "REGISTER",
			hashKeyVersion: "v1",
		});
		expect(createdFlow?.registrationFlowReferenceHash).toMatch(
			/^[0-9a-f]{64}$/u,
		);

		const proofExpiresAt = new Date(Date.now() + 5 * 60_000);
		const proof: FusionAuthProof = {
			id: tokenBody.flowId,
			purpose: "REGISTER",
			registrationFlowReferenceHash: "f".repeat(64),
			deviceHash: "d".repeat(64),
			hashKeyVersion: "v1",
			expiresAt: proofExpiresAt,
		};
		const verifiedProof: VerifiedFusionAuthProof = {
			...proof,
			registrationFlowReferenceHash: "f".repeat(64),
			expiresAt: proofExpiresAt,
			verifiedAt: new Date(),
			verifiedPhone: {
				lookup: { value: "6".repeat(64), keyVersion: "v1" },
				dedup: { value: "7".repeat(64), keyVersion: "v1" },
				maskedPhone: "+86138****8000",
				verifyTokenHash: { value: "8".repeat(64), keyVersion: "v1" },
			},
		};
		repository.findFusionProof.mockResolvedValue(proof);
		repository.completeFusionVerification.mockResolvedValue({
			kind: "SUCCESS",
			proof: verifiedProof,
		});

		const verifyResponse = await post(baseUrl, "/v1/auth/phone/fusion-verify", {
			flowId: tokenBody.flowId,
			verifyToken: FUSION_VERIFY_TOKEN,
			installationId: INSTALLATION_ID,
		});
		const verifyBody = (await verifyResponse.json()) as Record<string, unknown>;

		expect(verifyResponse.status).toBe(200);
		expect(verifyResponse.headers.get("cache-control")).toContain("no-store");
		expect(verifyBody).toEqual({
			proofId: tokenBody.flowId,
			expiresAt: proofExpiresAt.toISOString(),
		});
		expect(repository.findFusionProof).toHaveBeenCalledWith(
			tokenBody.flowId,
			"REGISTER",
			expect.any(Array),
		);
		expect(repository.claimFusionVerifyToken).toHaveBeenCalledOnce();
		expect(fusionProvider.verifyToken).toHaveBeenCalledWith(
			FUSION_VERIFY_TOKEN,
		);
		expect(repository.completeFusionVerification).toHaveBeenCalledOnce();
		expect(repository.completeFusionRegistration).not.toHaveBeenCalled();
		expect(wechatProvider.verify).not.toHaveBeenCalled();
	});
});
