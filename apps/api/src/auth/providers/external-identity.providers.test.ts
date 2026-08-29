import { describe, expect, it, vi } from "vitest";
import { IDENTITY_RESPONSE_MAX_BYTES } from "./bounded-identity-json.js";
import { ExternalIdentityUnavailableError } from "./external-identity.provider.js";
import { OfficialQqIdentityProvider } from "./qq-identity.provider.js";
import { OfficialWechatIdentityProvider } from "./wechat-identity.provider.js";

const qqAppId = "1905202162";
const qqAppKey = "a".repeat(32);

function qqConfig(unionIdEnabled = false) {
	return {
		enabled: true,
		unionIdEnabled,
		appId: qqAppId,
		appKey: qqAppKey,
		timeoutMs: 500,
	};
}

function qqTokenResponse() {
	return Response.json({
		access_token: "provider-access-token",
		expires_in: 7_776_000,
		refresh_token: "provider-refresh-token",
	});
}

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

	it("accepts a valid WeChat identity without UnionID for AppID-scoped lookup", async () => {
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
					expires_in: 7_200,
					refresh_token: "platform-refresh-secret",
					openid: "wechat_open_id",
					scope: "snsapi_userinfo",
				}),
			),
		);

		await expect(
			provider.verify({ authorizationCode: "temporary-code" }),
		).resolves.toEqual({
			provider: "WECHAT",
			providerScope: "wx0123456789abcdef",
			subject: "wechat_open_id",
			unionSubject: null,
		});
	});

	it("exchanges a QQ server-side code and verifies the returned AppID identity", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(qqTokenResponse())
			.mockResolvedValueOnce(
				Response.json({ client_id: qqAppId, openid: "official_open_id" }),
			);
		const provider = new OfficialQqIdentityProvider(qqConfig(), fetchMock);

		const identity = await provider.verify({
			authorizationCode: "one-time-server-side-code",
		});
		expect(identity).toEqual({
			provider: "QQ",
			providerScope: qqAppId,
			subject: "official_open_id",
			unionSubject: null,
		});
		expect(JSON.stringify(identity)).not.toContain("provider-access-token");
		expect(JSON.stringify(identity)).not.toContain("provider-refresh-token");
		expect(JSON.stringify(identity)).not.toContain(qqAppKey);

		const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(tokenUrl.origin).toBe("https://graph.qq.com");
		expect(tokenUrl.pathname).toBe("/oauth2.0/token");
		expect(tokenUrl.searchParams.get("grant_type")).toBe("authorization_code");
		expect(tokenUrl.searchParams.get("client_id")).toBe(qqAppId);
		expect(tokenUrl.searchParams.get("client_secret")).toBe(qqAppKey);
		expect(tokenUrl.searchParams.get("code")).toBe("one-time-server-side-code");
		expect(tokenUrl.searchParams.get("redirect_uri")).toBe(
			"auth://tauth.qq.com/",
		);
		expect(tokenUrl.searchParams.get("fmt")).toBe("json");
		expect(tokenInit).toMatchObject({
			method: "GET",
			cache: "no-store",
			redirect: "error",
			referrerPolicy: "no-referrer",
		});

		const [identityUrl, identityInit] = fetchMock.mock.calls[1] as [
			URL,
			RequestInit,
		];
		expect(identityUrl.pathname).toBe("/oauth2.0/me");
		expect(identityUrl.searchParams.get("access_token")).toBe(
			"provider-access-token",
		);
		expect(identityUrl.searchParams.has("unionid")).toBe(false);
		expect(identityInit.redirect).toBe("error");
	});

	it("requests and requires QQ UnionID when cross-App deduplication is enabled", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(qqTokenResponse())
			.mockResolvedValueOnce(
				Response.json({
					client_id: qqAppId,
					openid: "official_open_id",
					unionid: "official_union_id",
				}),
			);
		const provider = new OfficialQqIdentityProvider(qqConfig(true), fetchMock);
		await expect(
			provider.verify({ authorizationCode: "temporary-code" }),
		).resolves.toMatchObject({
			provider: "QQ",
			subject: "official_open_id",
			unionSubject: "official_union_id",
		});
		const [url] = fetchMock.mock.calls[1] as [URL];
		expect(url.searchParams.get("unionid")).toBe("1");

		const missingUnion = new OfficialQqIdentityProvider(
			qqConfig(true),
			vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(qqTokenResponse())
				.mockResolvedValueOnce(
					Response.json({ client_id: qqAppId, openid: "official_open_id" }),
				),
		);
		await expect(
			missingUnion.verify({ authorizationCode: "temporary-code" }),
		).rejects.toMatchObject({ reason: "INVALID_RESPONSE" });
	});

	it("ignores unsolicited QQ UnionID values when cross-App deduplication is disabled", async () => {
		for (const unionid of ["unsolicited_union_id", "malformed union id!"]) {
			const provider = new OfficialQqIdentityProvider(
				qqConfig(),
				vi
					.fn<typeof fetch>()
					.mockResolvedValueOnce(qqTokenResponse())
					.mockResolvedValueOnce(
						Response.json({
							client_id: qqAppId,
							openid: "official_open_id",
							unionid,
						}),
					),
			);
			await expect(
				provider.verify({ authorizationCode: "temporary-code" }),
			).resolves.toEqual({
				provider: "QQ",
				providerScope: qqAppId,
				subject: "official_open_id",
				unionSubject: null,
			});
		}
	});

	it("rejects token exchange errors without echoing the code or AppKey", async () => {
		const authorizationCode = "one-time-secret-code";
		const provider = new OfficialQqIdentityProvider(
			qqConfig(),
			vi.fn<typeof fetch>().mockResolvedValue(
				Response.json({
					error: 100020,
					error_description: "invalid authorization code",
				}),
			),
		);
		const failure = await captureFailure(
			provider.verify({ authorizationCode }),
		);
		expect(failure.reason).toBe("UPSTREAM_REJECTED");
		expect(failure.message).not.toContain(authorizationCode);
		expect(failure.message).not.toContain(qqAppKey);
	});

	it("rejects malformed or oversized token exchange responses", async () => {
		const malformed = new OfficialQqIdentityProvider(
			qqConfig(),
			vi.fn<typeof fetch>().mockResolvedValue(
				Response.json({
					access_token: "provider-access-token",
					expires_in: 7_776_000,
				}),
			),
		);
		await expect(
			malformed.verify({ authorizationCode: "temporary-code" }),
		).rejects.toMatchObject({ reason: "INVALID_RESPONSE" });

		const oversized = new OfficialQqIdentityProvider(
			qqConfig(),
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response("{}", {
					headers: {
						"content-length": String(IDENTITY_RESPONSE_MAX_BYTES + 1),
					},
				}),
			),
		);
		await expect(
			oversized.verify({ authorizationCode: "temporary-code" }),
		).rejects.toMatchObject({ reason: "RESPONSE_TOO_LARGE" });
	});

	it("fails closed on token redirects and does not surface redirect details", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "https://attacker.invalid/leak" },
			}),
		);
		const provider = new OfficialQqIdentityProvider(qqConfig(), fetchMock);
		const failure = await captureFailure(
			provider.verify({ authorizationCode: "temporary-code" }),
		);
		expect(failure.reason).toBe("UPSTREAM_HTTP");
		expect(failure.message).not.toContain("attacker.invalid");
		expect(failure.message).not.toContain(qqAppKey);
		const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(init.redirect).toBe("error");
	});

	it("rejects QQ identities issued to another AppID or with a nonzero return code", async () => {
		for (const payload of [
			{ client_id: "123456789", openid: "open_id" },
			{ ret: 100030, client_id: qqAppId, openid: "untrusted_open_id" },
		]) {
			const provider = new OfficialQqIdentityProvider(
				qqConfig(),
				vi
					.fn<typeof fetch>()
					.mockResolvedValueOnce(qqTokenResponse())
					.mockResolvedValueOnce(Response.json(payload)),
			);
			await expect(
				provider.verify({ authorizationCode: "temporary-code" }),
			).rejects.toMatchObject({ reason: "UPSTREAM_REJECTED" });
		}
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
			{ ...qqConfig(), timeoutMs: 10 },
			hangingFetch,
		);
		const timeout = await captureFailure(
			provider.verify({ authorizationCode: "temporary-code" }),
		);
		expect(timeout.reason).toBe("TIMEOUT");
		expect(timeout.message).not.toContain("secret URL");
		expect(timeout.message).not.toContain(qqAppKey);

		const disabledFetch = vi.fn<typeof fetch>();
		const disabled = new OfficialQqIdentityProvider(
			{
				enabled: false,
				unionIdEnabled: false,
				appId: null,
				appKey: null,
				timeoutMs: 500,
			},
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
