import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../../config/app-config.js";
import { SafeAliyunSdkError } from "./aliyun-official.clients.js";
import {
	AliyunFusionAuthProvider,
	type AliyunFusionClient,
	FusionAuthUnavailableError,
} from "./fusion-auth.provider.js";

const hashKey = Buffer.alloc(32, 5).toString("base64");
const otpPepper = Buffer.alloc(32, 6).toString("base64");

function fusionConfig() {
	return loadAppConfig({
		NODE_ENV: "test",
		DATABASE_ENABLED: "true",
		DATABASE_URL: "postgresql://runtime:password@127.0.0.1/chishenme",
		ACCOUNTS_ENABLED: "true",
		FUSION_AUTH_ENABLED: "true",
		WECHAT_AUTH_ENABLED: "true",
		AUTH_HASH_ACTIVE_VERSION: "v1",
		AUTH_HASH_KEYS_JSON: JSON.stringify({ v1: hashKey }),
		AUTH_OTP_PEPPER_ACTIVE_VERSION: "v1",
		AUTH_OTP_PEPPER_KEYS_JSON: JSON.stringify({ v1: otpPepper }),
		AUTH_IDENTITY_DEDUP_KEY_VERSION: "v1",
		ALIYUN_FUSION_SCHEME_CODE: "100001",
		ALIYUN_FUSION_PACKAGE_NAME: "com.chishenme.app",
		ALIYUN_FUSION_PACKAGE_SIGN: "a".repeat(32),
		WECHAT_APP_ID: "wx0123456789abcdef",
		WECHAT_APP_SECRET: "wechat-secret",
	}).auth.fusion;
}

function client(input: {
	token?: unknown;
	verify?: unknown;
} = {}): AliyunFusionClient {
	return {
		getFusionAuthTokenWithOptions: vi.fn(async () =>
			(input.token ?? {
				body: {
					code: "OK",
					success: true,
					model: "FusionAuthToken_1234567890",
				},
			}),
		) as AliyunFusionClient["getFusionAuthTokenWithOptions"],
		verifyWithFusionAuthTokenWithOptions: vi.fn(async () =>
			(input.verify ?? {
				body: {
					code: "OK",
					success: true,
					model: { verifyResult: "PASS", phoneNumber: "13800138000" },
				},
			}),
		) as AliyunFusionClient["verifyWithFusionAuthTokenWithOptions"],
	};
}

describe("Aliyun fusion authentication provider", () => {
	it("pins the server-owned scheme, app identity and a no-retry runtime", async () => {
		const sdk = client();
		const provider = new AliyunFusionAuthProvider(fusionConfig(), sdk);

		await expect(provider.issueToken()).resolves.toEqual({
			authToken: "FusionAuthToken_1234567890",
		});
		expect(sdk.getFusionAuthTokenWithOptions).toHaveBeenCalledWith(
			{
				durationSeconds: 900,
				packageName: "com.chishenme.app",
				packageSign: "a".repeat(32),
				platform: "Android",
				schemeCode: "100001",
			},
			expect.objectContaining({
				autoretry: false,
				maxAttempts: 1,
				keepAlive: false,
				maxIdleConns: 1,
			}),
		);
	});

	it.each([
		{ body: { code: "Denied", success: true, model: "A".repeat(20) } },
		{ body: { code: "OK", success: false, model: "A".repeat(20) } },
		{ body: { code: "OK", success: true } },
		{ body: { code: "OK", success: true, model: "has whitespace" } },
	])("rejects incomplete or unsafe token response %#", async (token) => {
		await expect(
			new AliyunFusionAuthProvider(fusionConfig(), client({ token })).issueToken(),
		).rejects.toMatchObject({ reason: "UPSTREAM_REJECTED" });
	});

	it("accepts only PASS with a full mainland mobile number", async () => {
		const provider = new AliyunFusionAuthProvider(fusionConfig(), client());
		await expect(
			provider.verifyToken("FusionVerifyToken_1234567890"),
		).resolves.toEqual({ e164PhoneNumber: "+8613800138000" });
	});

	it("does not assume an undocumented minimum provider-token length", async () => {
		const sdk = client({
			token: { body: { code: "OK", success: true, model: "A" } },
		});
		const provider = new AliyunFusionAuthProvider(fusionConfig(), sdk);
		await expect(provider.issueToken()).resolves.toEqual({ authToken: "A" });
		await expect(provider.verifyToken("B")).resolves.toEqual({
			e164PhoneNumber: "+8613800138000",
		});
	});

	it.each([
		{ code: "Denied", success: true, model: { verifyResult: "PASS", phoneNumber: "13800138000" } },
		{ code: "OK", success: false, model: { verifyResult: "PASS", phoneNumber: "13800138000" } },
		{ code: "OK", success: true, model: { verifyResult: "UNKNOWN", phoneNumber: "13800138000" } },
		{ code: "OK", success: true, model: { verifyResult: "PASS", phoneNumber: "+8613800138000" } },
		{ code: "OK", success: true, model: { verifyResult: "PASS", phoneNumber: "12800138000" } },
	])("rejects unsafe verification response %#", async (body) => {
		await expect(
			new AliyunFusionAuthProvider(
				fusionConfig(),
				client({ verify: { body } }),
			).verifyToken("FusionVerifyToken_1234567890"),
		).rejects.toMatchObject({ reason: "INVALID_PROOF" });
	});

	it("maps the sanitized official-client reason without exposing its payload", async () => {
		const sdk = client();
		vi.mocked(sdk.verifyWithFusionAuthTokenWithOptions).mockRejectedValueOnce(
			new SafeAliyunSdkError("TIMEOUT"),
		);
		const error = await captureFailure(
			new AliyunFusionAuthProvider(fusionConfig(), sdk).verifyToken(
				"FusionVerifyToken_1234567890",
			),
		);
		expect(error).toBeInstanceOf(FusionAuthUnavailableError);
		expect(error).toMatchObject({ reason: "TIMEOUT" });
		expect(error.message).toBe("手机号认证暂不可用");
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
