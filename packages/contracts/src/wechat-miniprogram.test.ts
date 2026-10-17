import { describe, expect, it } from "vitest";
import { AuthCapabilitiesSchema, LoginRequestSchema, WechatMiniProgramLoginRequestSchema } from "./index.js";

const device = { installationId: "20000000-0000-4000-8000-000000000001", platform: "MINIPROGRAM", label: "合成小程序设备", appVersion: "0.1.11-alpha" };
describe("dedicated WeChat mini-program login contract", () => {
	it("accepts only a temporary code and a mini-program device", () => {
		expect(WechatMiniProgramLoginRequestSchema.safeParse({ code: "synthetic-wechat-code", device }).success).toBe(true);
	});
	it.each(["appid", "appSecret", "unionid", "openid", "realm", "userId"])("rejects client-selected %s", key => {
		expect(WechatMiniProgramLoginRequestSchema.safeParse({ code: "synthetic-wechat-code", device, [key]: "untrusted" }).success).toBe(false);
	});
	it("keeps native OAuth and mini-program code exchange separate", () => {
		expect(WechatMiniProgramLoginRequestSchema.safeParse({ code: "synthetic-wechat-code", device: { ...device, platform: "ANDROID" } }).success).toBe(false);
		expect(LoginRequestSchema.safeParse({ method: "WECHAT", authorizationCode: "synthetic-wechat-code", oauthState: "A".repeat(43), device }).success).toBe(false);
	});
	it("preserves compatibility with servers that have not enabled the new channel", () => {
		const base = { accountsEnabled: true, registrationEnabled: true, phoneEnabled: true, wechatEnabled: true, emailEnabled: true, qqEnabled: true, dataExportEnabled: false };
		expect(AuthCapabilitiesSchema.parse(base).wechatMiniProgramEnabled).toBeUndefined();
		expect(AuthCapabilitiesSchema.parse({ ...base, wechatMiniProgramEnabled: true }).wechatMiniProgramEnabled).toBe(true);
		expect(AuthCapabilitiesSchema.safeParse({ ...base, wechatMiniProgramEnabled: "true" }).success).toBe(false);
	});
});
