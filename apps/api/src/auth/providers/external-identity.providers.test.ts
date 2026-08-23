import { describe, expect, it, vi } from "vitest";
import { IDENTITY_RESPONSE_MAX_BYTES } from "./bounded-identity-json.js";
import { ExternalIdentityUnavailableError } from "./external-identity.provider.js";
import { OfficialQqIdentityProvider } from "./qq-identity.provider.js";
import { OfficialWechatIdentityProvider } from "./wechat-identity.provider.js";

describe("official external identity adapters", () => {
	it("exchanges a WeChat code without returning or logging platform credentials", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				access_token: "platform-access-secret",
				expires_in: 7_200,
				refresh_token: "platform-refresh-secret",
				openid: "wechat_open_id",
				scope: "snsapi_userinfo",
				unionid: "wechat_union_id",
			}),
		);
		const provider = new OfficialWechatIdentityProvider(
			{
				enabled: true,
				appId: "wx-app-id",
				appSecret: "wechat-app-secret",
				timeoutMs: 500,
			},
			fetchMock,
		);

		const identity = await provider.verify({
			authorizationCode: "temporary-code",
		});
		expect(identity).toEqual({
			provider: "WECHAT",
			providerScope: "wx-app-id",
			subject: "wechat_open_id",
			unionSubject: "wechat_union_id",
		});
		expect(JSON.stringify(identity)).not.toContain("platform-access-secret");
		expect(JSON.stringify(identity)).not.toContain("platform-refresh-secret");
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(url.origin).toBe("https://api.weixin.qq.com");
		expect(url.searchParams.get("grant_type")).toBe("authorization_code");
		expect(init.cache).toBe("no-store");
		expect(init.redirect).toBe("error");
	});

	it("fails closed on WeChat error payloads and never echoes proof or secret", async () => {
		const provider = new OfficialWechatIdentityProvider(
			{
				enabled: true,
				appId: "wx-app-id",
				appSecret: "wechat-app-secret",
				timeoutMs: 500,
			},
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					Response.json({ errcode: 40029, errmsg: "invalid code" }),
				),
		);

		const failure = await captureFailure(
			provider.verify({ authorizationCode: "temporary-code" }),
		);
		expect(failure.reason).toBe("UPSTREAM_REJECTED");
		expect(failure.message).not.toContain("temporary-code");
		expect(failure.message).not.toContain("wechat-app-secret");
	});

	it("rejects incomplete WeChat success payloads", async () => {
		const provider = new OfficialWechatIdentityProvider(
			{
				enabled: true,
				appId: "wx0123456789abcdef",
				appSecret: "wechat-app-secret",
				timeoutMs: 500,
			},
			vi.fn<typeof fetch>().mockResolvedValue(
				Response.json({
					access_token: "platform-access-secret",
					expires_in: "7200",
					openid: "wechat_open_id",
					scope: "snsapi_userinfo",
				}),
			),
		);

		const failure = await captureFailure(
			provider.verify({ authorizationCode: "temporary-code" }),
		);
		expect(failure.reason).toBe("INVALID_RESPONSE");
	});

	it("verifies QQ client_id and uses only the official returned openid", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ client_id: "qq-app-id", openid: "official_open_id" }),
			);
		const provider = new OfficialQqIdentityProvider(
			{ enabled: true, appId: "qq-app-id", timeoutMs: 500 },
			fetchMock,
		);

		await expect(
			provider.verify({ accessToken: "temporary-token" }),
		).resolves.toEqual({
			provider: "QQ",
			providerScope: "qq-app-id",
			subject: "official_open_id",
			unionSubject: null,
		});
		const [url] = fetchMock.mock.calls[0] as [URL];
		expect(url.origin).toBe("https://graph.qq.com");
		expect(url.pathname).toBe("/oauth2.0/me");
	});

	it("rejects a QQ token issued to another AppID", async () => {
		const provider = new OfficialQqIdentityProvider(
			{ enabled: true, appId: "qq-app-id", timeoutMs: 500 },
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					Response.json({ client_id: "other-app", openid: "open_id" }),
				),
		);
		const failure = await captureFailure(
			provider.verify({ accessToken: "temporary-token" }),
		);
		expect(failure.reason).toBe("UPSTREAM_REJECTED");
	});

	it("rejects a nonzero QQ return code even if identity-shaped fields exist", async () => {
		const provider = new OfficialQqIdentityProvider(
			{ enabled: true, appId: "123456789", timeoutMs: 500 },
			vi.fn<typeof fetch>().mockResolvedValue(
				Response.json({
					ret: 100030,
					client_id: "123456789",
					openid: "untrusted_open_id",
				}),
			),
		);
		const failure = await captureFailure(
			provider.verify({ accessToken: "temporary-token" }),
		);
		expect(failure.reason).toBe("UPSTREAM_REJECTED");
	});

	it("enforces a response size limit before JSON parsing", async () => {
		const provider = new OfficialQqIdentityProvider(
			{ enabled: true, appId: "qq-app-id", timeoutMs: 500 },
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response("{}", {
					headers: {
						"content-length": String(IDENTITY_RESPONSE_MAX_BYTES + 1),
					},
				}),
			),
		);
		const failure = await captureFailure(
			provider.verify({ accessToken: "temporary-token" }),
		);
		expect(failure.reason).toBe("RESPONSE_TOO_LARGE");
	});

	it("classifies aborts as a fixed timeout and disabled adapters do not call out", async () => {
		const hangingFetch = vi.fn<typeof fetch>((_input, init) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new Error("transport included a secret URL")),
					{ once: true },
				);
			});
		});
		const provider = new OfficialQqIdentityProvider(
			{ enabled: true, appId: "qq-app-id", timeoutMs: 10 },
			hangingFetch,
		);
		const timeout = await captureFailure(
			provider.verify({ accessToken: "temporary-token" }),
		);
		expect(timeout.reason).toBe("TIMEOUT");
		expect(timeout.message).not.toContain("secret URL");

		const disabledFetch = vi.fn<typeof fetch>();
		const disabled = new OfficialWechatIdentityProvider(
			{ enabled: false, appId: null, appSecret: null, timeoutMs: 500 },
			disabledFetch,
		);
		const disabledFailure = await captureFailure(
			disabled.verify({ authorizationCode: "temporary-code" }),
		);
		expect(disabledFailure.reason).toBe("DISABLED");
		expect(disabledFetch).not.toHaveBeenCalled();
	});
});

async function captureFailure(
	promise: Promise<unknown>,
): Promise<ExternalIdentityUnavailableError> {
	try {
		await promise;
		throw new Error("expected provider failure");
	} catch (error) {
		if (error instanceof ExternalIdentityUnavailableError) return error;
		throw error;
	}
}
