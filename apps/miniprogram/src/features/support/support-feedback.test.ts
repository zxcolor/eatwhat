import { describe, expect, it, vi } from "vitest";
import { PrivacyConsentAuthority } from "../consent/consent-authority";
import {
	normalizeFeedbackMessage,
	type SupportFeedbackApi,
	SupportFeedbackService,
} from "./support-feedback";

class MemoryStorage {
	readonly values = new Map<string, unknown>();
	getStorageSync(key: string): unknown {
		return this.values.get(key);
	}
	setStorageSync(key: string, value: unknown): void {
		this.values.set(key, value);
	}
	removeStorageSync(key: string): void {
		this.values.delete(key);
	}
}

describe("support feedback", () => {
	it("normalizes newlines and never accepts a short body", () => {
		expect(
			normalizeFeedbackMessage("  这是足够长的反馈正文。\r\n谢谢。  "),
		).toBe("这是足够长的反馈正文。\n谢谢。");
		expect(normalizeFeedbackMessage("太短了")).toBeNull();
	});

	it("does not generate an id or touch auth before consent", async () => {
		const api = {
			submitSupportFeedback: vi.fn(),
		} as unknown as SupportFeedbackApi;
		const auth = { accessToken: vi.fn() };
		const createUuid = vi.fn();
		const service = new SupportFeedbackService(
			api,
			auth,
			new PrivacyConsentAuthority(new MemoryStorage()),
			() => true,
			createUuid,
		);
		await expect(
			service.submit("PRODUCT", "这是一个足够长的产品反馈正文。"),
		).resolves.toEqual({
			ok: false,
			message: "请先阅读并同意隐私说明；本次没有发送反馈",
		});
		expect(createUuid).not.toHaveBeenCalled();
		expect(auth.accessToken).not.toHaveBeenCalled();
	});

	it("never downgrades an authenticated submission to guest after capability revocation", async () => {
		const storage = new MemoryStorage();
		const consent = new PrivacyConsentAuthority(storage);
		consent.accept(new Date("2026-08-30T00:00:00.000Z"));
		let enabled = true;
		const api = {
			submitSupportFeedback: vi.fn(),
		} as unknown as SupportFeedbackApi;
		const auth = {
			accessToken: vi.fn(async () => {
				enabled = false;
				return null;
			}),
		};
		const service = new SupportFeedbackService(
			api,
			auth,
			consent,
			() => enabled,
			vi.fn(async () => "33333333-3333-4333-8333-333333333333"),
		);

		await expect(
			service.submit("PRODUCT", "这是一个足够长的产品反馈正文。"),
		).resolves.toEqual({
			ok: false,
			message: "反馈服务授权已变化，本次没有降级为游客提交",
		});
		expect(api.submitSupportFeedback).not.toHaveBeenCalled();
	});
});
