import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decryptSupportFeedback,
	encryptSupportFeedback,
	fingerprintSupportFeedback,
	fingerprintSupportFeedbackGuestIp,
	SupportFeedbackKeyRing,
} from "./support-feedback-crypto.js";

function ring(active = "v2") {
	return new SupportFeedbackKeyRing(
		active,
		new Map([
			["v1", Buffer.alloc(32, 1)],
			["v2", Buffer.alloc(32, 2)],
		]),
	);
}

describe("support feedback encryption", () => {
	it("round trips UTF-8 content and records only a key version", () => {
		const context = {
			feedbackId: randomUUID(),
			category: "PLACE_CORRECTION" as const,
		};
		const encrypted = encryptSupportFeedback(
			"餐厅营业时间已经变化，请核实。",
			context,
			ring(),
		);

		expect(encrypted.keyVersion).toBe("v2");
		expect(encrypted.ciphertext.toString("utf8")).not.toContain("营业时间");
		expect(
			decryptSupportFeedback(
				encrypted.ciphertext,
				encrypted.keyVersion,
				context,
				ring(),
			),
		).toBe("餐厅营业时间已经变化，请核实。");
	});

	it("fails closed when category, owner, id, tag, or key version changes", () => {
		const context = {
			feedbackId: randomUUID(),
			category: "PRODUCT" as const,
		};
		const encrypted = encryptSupportFeedback("按钮无法使用", context, ring());
		const tampered = Buffer.from(encrypted.ciphertext);
		tampered[tampered.length - 1] ^= 1;

		for (const [candidate, version] of [
			[tampered, encrypted.keyVersion],
			[encrypted.ciphertext, "missing"],
		] as const) {
			expect(() =>
				decryptSupportFeedback(candidate, version, context, ring()),
			).toThrow();
		}
		expect(() =>
			decryptSupportFeedback(
				encrypted.ciphertext,
				encrypted.keyVersion,
				{ ...context, category: "COMPLAINT" },
				ring(),
			),
		).toThrow("认证失败");
		expect(() =>
			decryptSupportFeedback(
				encrypted.ciphertext,
				encrypted.keyVersion,
				{ ...context, feedbackId: randomUUID() },
				ring(),
			),
		).toThrow("认证失败");
	});

	it("rejects oversized content and invalid key material", () => {
		const context = {
			feedbackId: randomUUID(),
			category: "PRIVACY" as const,
		};
		expect(() =>
			encryptSupportFeedback("x".repeat(16_385), context, ring()),
		).toThrow("长度无效");
		expect(
			() =>
				new SupportFeedbackKeyRing("v1", new Map([["v1", randomBytes(31)]])),
		).toThrow("32 字节");
		expect(
			() =>
				new SupportFeedbackKeyRing(
					"v1",
					new Map([
						["v1", Buffer.alloc(32, 9)],
						["v2", Buffer.alloc(32, 9)],
					]),
				),
		).toThrow("不得在不同版本复用");
	});

	it("zeroes and permanently closes key access on shutdown", () => {
		const keys = ring();
		const exportedCopy = keys.activeKey();
		keys.destroy();
		keys.destroy();
		expect(exportedCopy.equals(Buffer.alloc(32, 2))).toBe(true);
		expect(() => keys.activeKey()).toThrow("已销毁");
		expect(() => keys.key("v1")).toThrow("已销毁");
		expect(() => keys.versions()).toThrow("已销毁");
		exportedCopy.fill(0);
	});

	it("creates deterministic versioned and domain-separated HMAC candidates", () => {
		const context = {
			feedbackId: randomUUID(),
			category: "PRODUCT" as const,
		};
		const fingerprints = fingerprintSupportFeedback(
			"这是不会进入数据库的规范化反馈正文。",
			context,
			ring(),
		);
		expect(fingerprints.activeKeyVersion).toBe("v2");
		expect(Object.keys(fingerprints.candidates)).toEqual(["v1", "v2"]);
		expect(fingerprints.activeFingerprint).toMatch(/^[0-9a-f]{64}$/u);
		expect(
			fingerprintSupportFeedback(
				"这是不会进入数据库的规范化反馈正文。",
				context,
				ring(),
			).candidates,
		).toEqual(fingerprints.candidates);
		expect(
			fingerprintSupportFeedback("这是另一条反馈正文。", context, ring())
				.activeFingerprint,
		).not.toBe(fingerprints.activeFingerprint);
		expect(
			fingerprintSupportFeedbackGuestIp("127.0.0.1", ring()).activeFingerprint,
		).not.toBe(fingerprints.activeFingerprint);
	});
});
