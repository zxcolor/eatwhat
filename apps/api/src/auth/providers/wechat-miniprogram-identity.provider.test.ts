import { describe, expect, it, vi } from "vitest";
import { IDENTITY_RESPONSE_MAX_BYTES } from "./bounded-identity-json.js";
import { OfficialWechatMiniProgramIdentityProvider } from "./wechat-miniprogram-identity.provider.js";

const config = {
	enabled: true,
	appId: "wx1111111111111111",
	appSecret: "synthetic-mini-secret",
	timeoutMs: 500,
};
const proof = { authorizationCode: "synthetic-mini-code" };
const sessionKey = Buffer.alloc(16, 7).toString("base64");
const payload = {
	openid: "synthetic_mini_openid",
	unionid: "synthetic_unionid",
	session_key: sessionKey,
};

describe("official Mini Program code2Session adapter", () => {
	it("uses only dedicated credentials and returns identity without session key or code", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ ...payload, errcode: 0 }));
		const result = await new OfficialWechatMiniProgramIdentityProvider(
			config,
			fetchMock,
		).verify(proof);
		expect(result).toEqual({
			provider: "WECHAT",
			providerScope: config.appId,
			subject: payload.openid,
			unionSubject: payload.unionid,
		});
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(url.origin + url.pathname).toBe(
			"https://api.weixin.qq.com/sns/jscode2session",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			appid: config.appId,
			secret: config.appSecret,
			js_code: proof.authorizationCode,
			grant_type: "authorization_code",
		});
		expect(init).toMatchObject({
			method: "GET",
			redirect: "error",
			cache: "no-store",
			referrerPolicy: "no-referrer",
		});
		for (const secret of [
			sessionKey,
			proof.authorizationCode,
			config.appSecret,
		])
			expect(JSON.stringify(result)).not.toContain(secret);
	});
	it("returns a missing UnionID as null for the service to reject safely", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ openid: payload.openid, session_key: sessionKey }),
			);
		await expect(
			new OfficialWechatMiniProgramIdentityProvider(config, fetchMock).verify(
				proof,
			),
		).resolves.toMatchObject({ unionSubject: null });
	});
	it.each([
		{ errcode: 40029, errmsg: "synthetic-mini-code synthetic-mini-secret" },
		{ ...payload, session_key: "bad" },
		{ ...payload, openid: "invalid id" },
		{ ...payload, unionid: "invalid union" },
		{ ...payload, errcode: "0" },
		null,
	])(
		"rejects malformed and rejected responses without response text",
		async (body) => {
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValue(Response.json(body));
			await expect(
				new OfficialWechatMiniProgramIdentityProvider(config, fetchMock).verify(
					proof,
				),
			).rejects.toMatchObject({ message: "第三方身份服务暂时不可用" });
		},
	);
	it("fails closed before network while disabled or given unsafe code", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		await expect(
			new OfficialWechatMiniProgramIdentityProvider(
				{ ...config, enabled: false },
				fetchMock,
			).verify(proof),
		).rejects.toMatchObject({ reason: "DISABLED" });
		await expect(
			new OfficialWechatMiniProgramIdentityProvider(config, fetchMock).verify({
				authorizationCode: "bad code",
			}),
		).rejects.toMatchObject({ reason: "INVALID_PROOF" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("bounds response bodies and sanitizes transport failures", async () => {
		const oversized = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response("x".repeat(IDENTITY_RESPONSE_MAX_BYTES + 1)),
			);
		await expect(
			new OfficialWechatMiniProgramIdentityProvider(config, oversized).verify(
				proof,
			),
		).rejects.toMatchObject({ reason: "RESPONSE_TOO_LARGE" });
		const failing = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error(config.appSecret));
		await expect(
			new OfficialWechatMiniProgramIdentityProvider(config, failing).verify(
				proof,
			),
		).rejects.toMatchObject({
			reason: "NETWORK_ERROR",
			message: "第三方身份服务暂时不可用",
		});
	});
	it("aborts an upstream that exceeds the configured timeout", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error(config.appSecret)),
						{ once: true },
					);
				}),
		);
		await expect(
			new OfficialWechatMiniProgramIdentityProvider(
				{ ...config, timeoutMs: 5 },
				fetchMock,
			).verify(proof),
		).rejects.toMatchObject({ reason: "TIMEOUT" });
	});
});
