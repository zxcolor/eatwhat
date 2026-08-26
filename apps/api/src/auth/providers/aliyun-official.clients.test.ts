import { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import {
	GetFusionAuthTokenRequest,
	VerifyWithFusionAuthTokenRequest,
} from "@alicloud/dypnsapi20170525";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../../config/app-config.js";
import {
	type AliyunCredentialLike,
	type AliyunFusionOfficialClientDependencies,
	type AliyunOfficialClientDependencies,
	createAliyunCredential,
	createOfficialAliyunFusionClient,
	createOfficialAliyunSmsClient,
	SafeAliyunSdkError,
} from "./aliyun-official.clients.js";
import type { AliyunSmsRuntimeOptions } from "./aliyun-sms-otp.provider.js";
import type { AliyunFusionRuntimeOptions } from "./fusion-auth.provider.js";

const hashKey = Buffer.alloc(32, 5).toString("base64");
const otpPepper = Buffer.alloc(32, 6).toString("base64");

function config(overrides: NodeJS.ProcessEnv = {}) {
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@127.0.0.1/chishenme",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "true",
		WECHAT_AUTH_ENABLED: "true",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
		AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_SMS_SIGN_NAME: "吃什么",
		ALIYUN_SMS_TEMPLATE_CODE: "SMS_123456",
		WECHAT_APP_ID: "wx0123456789abcdef",
		WECHAT_APP_SECRET: "wechat-secret",
		...overrides,
	});
}

function fusionConfig(overrides: NodeJS.ProcessEnv = {}) {
	return config({
		PHONE_AUTH_ENABLED: "false",
		ALIYUN_SMS_SIGN_NAME: "",
		ALIYUN_SMS_TEMPLATE_CODE: "",
		FUSION_AUTH_ENABLED: "true",
		ALIYUN_FUSION_SCHEME_CODE: "100001",
		ALIYUN_FUSION_PACKAGE_NAME: "com.chishenme.app",
		ALIYUN_FUSION_PACKAGE_SIGN: "a".repeat(32),
		...overrides,
	});
}

function dependencies(input?: {
	credential?: AliyunCredentialLike;
	smsCall?: ReturnType<typeof vi.fn>;
}): AliyunOfficialClientDependencies {
	const credential = input?.credential ?? {
		getCredential: vi.fn().mockResolvedValue({
			accessKeyId: "temporary-id",
			accessKeySecret: "temporary-secret",
			type: "ecs_ram_role",
			providerName: "default/ecs_ram_role",
		}),
	};
	return {
		createCredential: vi.fn(() => credential),
		createSmsSdkClient: vi.fn(() => ({
			sendSmsWithOptions:
				input?.smsCall ??
				vi.fn().mockResolvedValue({
					body: { code: "OK", bizId: "safe-reference" },
				}),
		})),
	};
}

const smsRuntime: AliyunSmsRuntimeOptions = Object.freeze({
	autoretry: false,
	maxAttempts: 1,
	connectTimeout: 1_500,
	readTimeout: 1_500,
	keepAlive: false,
	maxIdleConns: 1,
});

const fusionRuntime: AliyunFusionRuntimeOptions = Object.freeze({
	autoretry: false,
	maxAttempts: 1,
	connectTimeout: 1_500,
	readTimeout: 1_500,
	keepAlive: false,
	maxIdleConns: 1,
});

describe("official Alibaba Cloud SMS client", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not initialize the credential chain while delivery is disabled", async () => {
		const deps = dependencies();
		await expect(
			createAliyunCredential(loadAppConfig({ NODE_ENV: "test" }), deps),
		).resolves.toBeUndefined();
		expect(deps.createCredential).not.toHaveBeenCalled();
	});

	it("preflights a usable temporary credential before constructing clients", async () => {
		const deps = dependencies();
		const credential = await createAliyunCredential(config(), deps);
		expect(credential).toBeDefined();
		expect(deps.createCredential).toHaveBeenCalledOnce();
		expect(credential?.getCredential).toHaveBeenCalledOnce();
	});

	it("constructs the official SMS SDK client around a credential handle", () => {
		const credential: AliyunCredentialLike = {
			getCredential: vi.fn().mockResolvedValue({
				accessKeyId: "temporary-id",
				accessKeySecret: "temporary-secret",
				type: "ecs_ram_role",
				providerName: "default/ecs_ram_role",
			}),
		};
		expect(createOfficialAliyunSmsClient(config(), credential)).toBeDefined();
	});

	it("reuses the credential chain and official Dypns request models for fusion", async () => {
		const credential: AliyunCredentialLike = {
			getCredential: vi.fn().mockResolvedValue({
				accessKeyId: "temporary-id",
				accessKeySecret: "temporary-secret",
				type: "ecs_ram_role",
				providerName: "default/ecs_ram_role",
			}),
		};
		const getFusionAuthTokenWithOptions = vi.fn().mockResolvedValue({
			body: { code: "OK", success: true, model: "FusionAuthToken_1234567890" },
		});
		const verifyWithFusionAuthTokenWithOptions = vi.fn().mockResolvedValue({
			body: {
				code: "OK",
				success: true,
				model: { verifyResult: "PASS", phoneNumber: "13800138000" },
			},
		});
		const deps: AliyunFusionOfficialClientDependencies = {
			createFusionSdkClient: vi.fn(() => ({
				getFusionAuthTokenWithOptions,
				verifyWithFusionAuthTokenWithOptions,
			})),
		};
		const client = createOfficialAliyunFusionClient(
			fusionConfig(),
			credential,
			deps,
		);
		await client?.getFusionAuthTokenWithOptions(
			{
				durationSeconds: 900,
				packageName: "com.chishenme.app",
				packageSign: "a".repeat(32),
				platform: "Android",
				schemeCode: "100001",
			},
			fusionRuntime,
		);
		await client?.verifyWithFusionAuthTokenWithOptions(
			{ verifyToken: "FusionVerifyToken_1234567890" },
			fusionRuntime,
		);

		const [tokenRequest, tokenRuntime] =
			getFusionAuthTokenWithOptions.mock.calls[0] ?? [];
		expect(tokenRequest).toBeInstanceOf(GetFusionAuthTokenRequest);
		expect(tokenRequest).toMatchObject({
			packageName: "com.chishenme.app",
			packageSign: "a".repeat(32),
			schemeCode: "100001",
		});
		expect(tokenRuntime).toMatchObject(fusionRuntime);
		const [verifyRequest, verifyRuntime] =
			verifyWithFusionAuthTokenWithOptions.mock.calls[0] ?? [];
		expect(verifyRequest).toBeInstanceOf(VerifyWithFusionAuthTokenRequest);
		expect(verifyRequest).toMatchObject({
			verifyToken: "FusionVerifyToken_1234567890",
		});
		expect(verifyRuntime).toMatchObject(fusionRuntime);
	});

	it("fails startup on missing credentials without retaining upstream details", async () => {
		const marker = "AK-and-profile-path-must-never-leak";
		const deps = dependencies({
			credential: {
				getCredential: vi.fn().mockRejectedValue(new Error(marker)),
			},
		});
		const failure = await captureFailure(
			createAliyunCredential(config(), deps),
		);
		expect(failure.message).toBe("账号阿里云认证凭据不可用");
		expect(failure.message).not.toContain(marker);
		expect(failure).not.toHaveProperty("cause");
	});

	it("bounds credential preflight and releases its deadline timer", async () => {
		vi.useFakeTimers();
		const deps = dependencies({
			credential: { getCredential: vi.fn(() => new Promise(() => undefined)) },
		});
		const pending = createAliyunCredential(
			config({ ALIYUN_CREDENTIAL_TIMEOUT_MS: "500" }),
			deps,
		);
		const assertion = expect(pending).rejects.toThrow(
			"账号阿里云认证凭据不可用",
		);
		await vi.advanceTimersByTimeAsync(500);
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses the official request model and forwards only bounded runtime options", async () => {
		const sendSmsWithOptions = vi.fn().mockResolvedValue({
			body: { code: "OK", bizId: "safe-reference" },
		});
		const deps = dependencies({ smsCall: sendSmsWithOptions });
		const appConfig = config();
		const credential = await createAliyunCredential(appConfig, deps);
		const client = createOfficialAliyunSmsClient(appConfig, credential, deps);
		await expect(
			client?.sendSmsWithOptions(
				{
					phoneNumbers: "13800138000",
					signName: "吃什么",
					templateCode: "SMS_123456",
					templateParam: '{"code":"001204"}',
					outId: "challenge_1234567890",
				},
				smsRuntime,
			),
		).resolves.toMatchObject({ body: { code: "OK" } });

		const [officialRequest, officialRuntime] =
			sendSmsWithOptions.mock.calls[0] ?? [];
		expect(officialRequest).toBeInstanceOf(SendSmsRequest);
		expect(officialRequest).toMatchObject({
			phoneNumbers: "13800138000",
			templateParam: '{"code":"001204"}',
		});
		expect(officialRuntime).toMatchObject(smsRuntime);
	});

	it("rejects a credential resolved from a source other than the pinned provider", async () => {
		const deps = dependencies({
			credential: {
				getCredential: vi.fn().mockResolvedValue({
					accessKeyId: "temporary-id",
					accessKeySecret: "temporary-secret",
					type: "access_key",
					providerName: "default/env",
				}),
			},
		});
		await expect(
			createAliyunCredential(
				config({
					ALIYUN_CREDENTIAL_ALLOWED_PROVIDER: "default/ecs_ram_role",
				}),
				deps,
			),
		).rejects.toThrow("账号阿里云认证凭据不可用");
	});

	it.each([
		[
			{ code: "Throttling.User", message: "phone=13800138000" },
			"UPSTREAM_REJECTED",
		],
		[{ code: "ETIMEDOUT", message: "code=001204" }, "TIMEOUT"],
		[new Error("recipient=user@example.com"), "NETWORK_ERROR"],
	] as const)(
		"sanitizes SDK failure %# and maps it safely",
		async (upstream, reason) => {
			const deps = dependencies({
				smsCall: vi.fn().mockRejectedValue(upstream),
			});
			const appConfig = config();
			const credential = await createAliyunCredential(appConfig, deps);
			const client = createOfficialAliyunSmsClient(appConfig, credential, deps);
			const failure = await captureFailure(
				client?.sendSmsWithOptions(
					{
						phoneNumbers: "13800138000",
						signName: "吃什么",
						templateCode: "SMS_123456",
						templateParam: '{"code":"001204"}',
						outId: "challenge_1234567890",
					},
					smsRuntime,
				) ?? Promise.reject(new Error("client missing")),
			);
			expect(failure).toBeInstanceOf(SafeAliyunSdkError);
			expect(failure).toMatchObject({ reason });
			expect(failure.message).toBe("阿里云认证请求失败");
			expect(JSON.stringify(failure)).not.toContain("13800138000");
			expect(JSON.stringify(failure)).not.toContain("001204");
			expect(JSON.stringify(failure)).not.toContain("user@example.com");
			expect(failure).not.toHaveProperty("cause");
		},
	);
});

async function captureFailure(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
		throw new Error("expected failure");
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error("non-error failure");
	}
}
