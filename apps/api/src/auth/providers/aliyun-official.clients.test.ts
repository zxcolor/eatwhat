import {
	CheckSmsVerifyCodeRequest,
	SendSmsVerifyCodeRequest,
} from "@alicloud/dypnsapi20170525";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../../config/app-config.js";
import {
	type AliyunCredentialLike,
	type AliyunOfficialClientDependencies,
	createAliyunCredential,
	createOfficialAliyunPnvsClient,
	SafeAliyunSdkError,
} from "./aliyun-official.clients.js";
import type {
	AliyunPnvsRuntimeOptions,
	AliyunPnvsSendResponse,
} from "./aliyun-pnvs-otp.provider.js";

const hashKey = Buffer.alloc(32, 5).toString("base64");

function config(overrides: NodeJS.ProcessEnv = {}) {
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@127.0.0.1/chishenme",
		ACCOUNTS_ENABLED: "true",
		PHONE_AUTH_ENABLED: "true",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_PNVS_SIGN_NAME: "吃什么",
		ALIYUN_PNVS_TEMPLATE_CODE: "100001",
		...overrides,
	});
}

function dependencies(input?: {
	credential?: AliyunCredentialLike;
	sendCall?: ReturnType<typeof vi.fn>;
	checkCall?: ReturnType<typeof vi.fn>;
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
		createPnvsSdkClient: vi.fn(() => ({
			sendSmsVerifyCodeWithOptions:
				input?.sendCall ??
				vi.fn().mockResolvedValue({
					body: {
						code: "OK",
						success: true,
						model: { bizId: "123^456" },
					},
				}),
			checkSmsVerifyCodeWithOptions:
				input?.checkCall ??
				vi.fn().mockResolvedValue({
					body: {
						code: "OK",
						success: true,
						model: { verifyResult: "PASS" },
					},
				}),
		})),
	};
}

const runtime: AliyunPnvsRuntimeOptions = Object.freeze({
	autoretry: false,
	maxAttempts: 1,
	connectTimeout: 1_500,
	readTimeout: 1_500,
	keepAlive: false,
	maxIdleConns: 1,
});

describe("official Alibaba Cloud PNVS client", () => {
	afterEach(() => vi.useRealTimers());

	it("does not initialize credentials while the phone channel is disabled", async () => {
		const deps = dependencies();
		await expect(
			createAliyunCredential(loadAppConfig({ NODE_ENV: "test" }), deps),
		).resolves.toBeUndefined();
		expect(deps.createCredential).not.toHaveBeenCalled();
	});

	it("preflights one usable temporary credential", async () => {
		const deps = dependencies();
		const credential = await createAliyunCredential(config(), deps);
		expect(credential).toBeDefined();
		expect(deps.createCredential).toHaveBeenCalledOnce();
		expect(credential?.getCredential).toHaveBeenCalledOnce();
	});

	it("uses official PNVS request models for send and check", async () => {
		const sendCall = vi.fn().mockResolvedValue({
			body: {
				code: "OK",
				success: true,
				model: { bizId: "123^456" },
			},
		} satisfies AliyunPnvsSendResponse);
		const checkCall = vi.fn().mockResolvedValue({
			body: { code: "OK", success: true, model: { verifyResult: "PASS" } },
		});
		const deps = dependencies({ sendCall, checkCall });
		const credential = await createAliyunCredential(config(), deps);
		const client = createOfficialAliyunPnvsClient(config(), credential, deps);
		await client?.sendSmsVerifyCodeWithOptions(
			{
				countryCode: "86",
				phoneNumber: "13800138000",
				signName: "吃什么",
				templateCode: "100001",
				templateParam: '{"code":"##code##","min":"5"}',
				codeLength: 6,
				validTime: 300,
				duplicatePolicy: 1,
				interval: 60,
				codeType: 1,
				returnVerifyCode: false,
				outId: "3bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			},
			runtime,
		);
		await client?.checkSmsVerifyCodeWithOptions(
			{
				countryCode: "86",
				phoneNumber: "13800138000",
				verifyCode: "001204",
				outId: "3bf405ae-82a1-4f87-86b7-1c97c4a8683f",
			},
			runtime,
		);

		const [sendRequest, sendRuntime] = sendCall.mock.calls[0] ?? [];
		expect(sendRequest).toBeInstanceOf(SendSmsVerifyCodeRequest);
		expect(sendRequest).toMatchObject({
			countryCode: "86",
			phoneNumber: "13800138000",
			returnVerifyCode: false,
		});
		expect(sendRuntime).toMatchObject(runtime);
		const [checkRequest, checkRuntime] = checkCall.mock.calls[0] ?? [];
		expect(checkRequest).toBeInstanceOf(CheckSmsVerifyCodeRequest);
		expect(checkRequest).toMatchObject({
			countryCode: "86",
			phoneNumber: "13800138000",
			verifyCode: "001204",
		});
		expect(checkRuntime).toMatchObject(runtime);
	});

	it("fails startup without leaking credential details", async () => {
		const marker = "AK-and-profile-path-must-never-leak";
		const failure = await captureFailure(
			createAliyunCredential(
				config(),
				dependencies({
					credential: {
						getCredential: vi.fn().mockRejectedValue(new Error(marker)),
					},
				}),
			),
		);
		expect(failure.message).toBe("账号阿里云认证凭据不可用");
		expect(failure.message).not.toContain(marker);
		expect(failure).not.toHaveProperty("cause");
	});

	it("bounds credential preflight and clears its deadline timer", async () => {
		vi.useFakeTimers();
		const pending = createAliyunCredential(
			config({ ALIYUN_CREDENTIAL_TIMEOUT_MS: "500" }),
			dependencies({
				credential: {
					getCredential: vi.fn(() => new Promise(() => undefined)),
				},
			}),
		);
		const assertion = expect(pending).rejects.toThrow(
			"账号阿里云认证凭据不可用",
		);
		await vi.advanceTimersByTimeAsync(500);
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects credentials resolved from a source other than the pin", async () => {
		await expect(
			createAliyunCredential(
				config({
					ALIYUN_CREDENTIAL_ALLOWED_PROVIDER: "default/ecs_ram_role",
				}),
				dependencies({
					credential: {
						getCredential: vi.fn().mockResolvedValue({
							accessKeyId: "temporary-id",
							accessKeySecret: "temporary-secret",
							type: "access_key",
							providerName: "default/env",
						}),
					},
				}),
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
	] as const)("sanitizes SDK failure %#", async (upstream, reason) => {
		const sendCall = vi.fn().mockRejectedValue(upstream);
		const deps = dependencies({ sendCall });
		const credential = await createAliyunCredential(config(), deps);
		const client = createOfficialAliyunPnvsClient(config(), credential, deps);
		const failure = await captureFailure(
			client?.sendSmsVerifyCodeWithOptions(
				{
					countryCode: "86",
					phoneNumber: "13800138000",
					signName: "吃什么",
					templateCode: "100001",
					templateParam: '{"code":"##code##"}',
					codeLength: 6,
					validTime: 300,
					duplicatePolicy: 1,
					interval: 60,
					codeType: 1,
					returnVerifyCode: false,
					outId: "3bf405ae-82a1-4f87-86b7-1c97c4a8683f",
				},
				runtime,
			) ?? Promise.reject(new Error("client missing")),
		);
		expect(failure).toBeInstanceOf(SafeAliyunSdkError);
		expect(failure).toMatchObject({ reason });
		expect(failure.message).toBe("阿里云认证请求失败");
		expect(JSON.stringify(failure)).not.toContain("13800138000");
		expect(JSON.stringify(failure)).not.toContain("001204");
		expect(failure).not.toHaveProperty("cause");
	});
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
