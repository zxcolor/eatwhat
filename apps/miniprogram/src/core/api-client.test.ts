import { describe, expect, it, vi } from "vitest";

import { normalizeApiBaseUrl } from "../config/runtime";
import {
	type ApiError,
	HttpApi,
	type RequestRuntime,
	WechatMiniProgramApi,
} from "./api-client";
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from "./contracts";

type RequestOptions = Parameters<RequestRuntime["request"]>[0];

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const CHALLENGE_ID = "44444444-4444-4444-8444-444444444444";
const ACCESS_TOKEN = "a".repeat(43);
const REFRESH_TOKEN = "r".repeat(43);
const FUTURE = "2099-01-01T00:00:00.000Z";

function successRuntime(
	responseData: unknown,
	calls: RequestOptions[],
	headers: Record<string, unknown> = {
		[CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
	},
): RequestRuntime {
	return {
		request(options) {
			calls.push(options);
			options.success({ statusCode: 200, data: responseData, header: headers });
			return undefined;
		},
	};
}

describe("HttpApi", () => {
	it("blocks every HTTP request before privacy authority is granted", async () => {
		let called = false;
		const http = new HttpApi(
			{
				request() {
					called = true;
				},
			},
			"https://api.unfinished-era.com",
			() => false,
		);

		await expect(
			http.request({
				method: "GET",
				path: "/v1/config",
				parser: () => undefined,
			}),
		).rejects.toMatchObject<ApiError>({
			kind: "PRIVACY_REQUIRED",
			code: "PRIVACY_CONSENT_REQUIRED",
		});
		expect(called).toBe(false);
	});

	it("builds a normalized query URL, bearer header and no GET request body", async () => {
		const calls: RequestOptions[] = [];
		const baseUrl = normalizeApiBaseUrl("https://api.unfinished-era.com///");
		const http = new HttpApi(successRuntime({ ok: true }, calls), baseUrl);

		const result = await http.request({
			method: "GET",
			path: "/v1/example",
			query: { z: false, page: 2, omitted: undefined, keyword: "午 饭" },
			bearer: ACCESS_TOKEN,
			parser: (value) => value as { readonly ok: boolean },
		});

		expect(result).toEqual({ ok: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://api.unfinished-era.com/v1/example?keyword=%E5%8D%88%20%E9%A5%AD&page=2&z=false",
		);
		expect(calls[0]?.url).not.toContain(".com//");
		expect(calls[0]?.header.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
		expect(calls[0]).not.toHaveProperty("data");
	});

	it("rejects a successful response without the exact contract version", async () => {
		const http = new HttpApi(
			successRuntime({}, [], {}),
			"https://api.unfinished-era.com",
		);

		await expect(
			http.request({
				method: "GET",
				path: "/v1/example",
				parser: () => undefined,
			}),
		).rejects.toMatchObject<ApiError>({
			kind: "CONTRACT_INCOMPATIBLE",
			status: 200,
		});
	});

	it("rejects paths outside the versioned API before using the runtime", async () => {
		let called = false;
		const http = new HttpApi(
			{
				request() {
					called = true;
				},
			},
			"https://api.unfinished-era.com",
		);

		await expect(
			http.request({
				method: "GET",
				path: "/outside" as "/v1/example",
				parser: () => undefined,
			}),
		).rejects.toMatchObject<ApiError>({ kind: "INVALID_RESPONSE" });
		expect(called).toBe(false);
	});

	it("aborts in-flight HTTP requests when privacy authority is withdrawn", async () => {
		const abort = vi.fn();
		const http = new HttpApi(
			{
				request() {
					return { abort };
				},
			},
			"https://api.unfinished-era.com",
		);
		const pending = http.request({
			method: "GET",
			path: "/v1/config",
			parser: () => undefined,
		});

		http.abortAll();

		await expect(pending).rejects.toMatchObject<ApiError>({
			kind: "PRIVACY_REQUIRED",
		});
		expect(abort).toHaveBeenCalledOnce();
	});
});

describe("WechatMiniProgramApi auth request shapes", () => {
	it("opts into the cross-platform session response without changing legacy clients", async () => {
		const calls: RequestOptions[] = [];
		const api = new WechatMiniProgramApi(new HttpApi(successRuntime({ items: [] }, calls), "https://api.unfinished-era.com"));
		await api.listSessions(ACCESS_TOKEN);
		expect(calls[0]?.url).toBe("https://api.unfinished-era.com/v1/auth/sessions?includePlatforms=ALL");
	});
	it("sends MINIPROGRAM device context for phone login", async () => {
		const calls: RequestOptions[] = [];
		const api = new WechatMiniProgramApi(
			new HttpApi(
				successRuntime(
					{
						userId: USER_ID,
						sessionId: SESSION_ID,
						tokenType: "Bearer",
						accessToken: ACCESS_TOKEN,
						accessTokenExpiresAt: FUTURE,
						refreshToken: REFRESH_TOKEN,
						refreshTokenExpiresAt: FUTURE,
					},
					calls,
				),
				"https://api.unfinished-era.com",
			),
		);

		await api.loginPhone("+8613800000000", CHALLENGE_ID, "123456", {
			installationId: INSTALLATION_ID,
			label: "微信小程序",
			platform: "MINIPROGRAM",
			appVersion: "0.1.0",
		});

		expect(calls[0]?.data).toEqual({
			method: "PHONE",
			phoneNumber: "+8613800000000",
			challengeId: CHALLENGE_ID,
			otpCode: "123456",
			device: {
				installationId: INSTALLATION_ID,
				label: "微信小程序",
				platform: "MINIPROGRAM",
				appVersion: "0.1.0",
			},
		});
	});

	it("keeps the disabled WeChat adapter aligned to the proposed clientPlatform field", async () => {
		const calls: RequestOptions[] = [];
		const api = new WechatMiniProgramApi(
			new HttpApi(
				successRuntime(
					{
						provider: "WECHAT",
						purpose: "LOGIN",
						state: "s".repeat(43),
						expiresAt: FUTURE,
					},
					calls,
				),
				"https://api.unfinished-era.com",
			),
		);

		await api.createOAuthState(INSTALLATION_ID, "LOGIN");

		expect(calls[0]?.data).toEqual({
			provider: "WECHAT",
			purpose: "LOGIN",
			installationId: INSTALLATION_ID,
			clientPlatform: "MINIPROGRAM",
		});
	});
});
