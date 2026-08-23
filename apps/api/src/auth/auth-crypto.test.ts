import { describe, expect, it } from "vitest";
import {
	AuthSecretKeyRing,
	constantTimeHashEquals,
	generateOAuthState,
	generateSixDigitOtp,
	hashAccountDeletionSubject,
	hashIdentityLookup,
	hashOpaqueToken,
	hashOtpCode,
	issueOpaqueToken,
	verifyOtpCode,
} from "./auth-crypto.js";

const TEST_OTP_PARAMETERS = Object.freeze({
	memoryKiB: 1_024,
	passes: 2,
	parallelism: 1,
});

function keyRing(activeVersion = "v2") {
	return new AuthSecretKeyRing(
		activeVersion,
		new Map([
			["v1", Buffer.alloc(32, 0x11)],
			["v2", Buffer.alloc(32, 0x22)],
		]),
	);
}

describe("auth cryptographic primitives", () => {
	it("issues opaque 32-byte tokens and domain-separated hashes", () => {
		const ring = keyRing();
		const access = issueOpaqueToken(ring, "access-token");
		const refresh = hashOpaqueToken(access.token, ring, "refresh-token");

		expect(access.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(access.hash.keyVersion).toBe("v2");
		expect(access.hash.value).toMatch(/^[0-9a-f]{64}$/u);
		expect(refresh.value).not.toBe(access.hash.value);
		expect(constantTimeHashEquals(access.hash.value, access.hash.value)).toBe(
			true,
		);
		expect(constantTimeHashEquals(access.hash.value, refresh.value)).toBe(
			false,
		);
	});

	it("separates identity provider scope and key version", () => {
		const ring = keyRing();
		const first = hashIdentityLookup("WECHAT", "wx-app-a", "openid", ring);
		const otherScope = hashIdentityLookup("WECHAT", "wx-app-b", "openid", ring);
		const legacy = hashIdentityLookup(
			"WECHAT",
			"wx-app-a",
			"openid",
			ring,
			"v1",
		);

		expect(first.value).not.toBe(otherScope.value);
		expect(first.value).not.toBe(legacy.value);
		expect(legacy.keyVersion).toBe("v1");
	});

	it("uses a dedicated non-reversible account deletion subject", () => {
		const userId = "2af305ae-82a1-4f87-86b7-1c97c4a8683f";
		const first = hashAccountDeletionSubject(userId, keyRing());
		const legacy = hashAccountDeletionSubject(userId, keyRing(), "v1");
		expect(first.value).toMatch(/^[0-9a-f]{64}$/u);
		expect(first.value).not.toContain(userId);
		expect(first.value).not.toBe(legacy.value);
		expect(() =>
			hashAccountDeletionSubject("not-a-user-id", keyRing()),
		).toThrow("账号标识格式无效");
	});

	it("hashes OTP with a random salt and verifies only the right pepper version", async () => {
		const ring = keyRing();
		const first = await hashOtpCode("001204", ring, TEST_OTP_PARAMETERS);
		const second = await hashOtpCode("001204", ring, TEST_OTP_PARAMETERS);

		expect(first.value).not.toBe(second.value);
		expect(first.value.length).toBeLessThanOrEqual(128);
		expect(await verifyOtpCode("001204", first.value, "v2", ring)).toBe(true);
		expect(await verifyOtpCode("001205", first.value, "v2", ring)).toBe(false);
		expect(await verifyOtpCode("001204", first.value, "missing", ring)).toBe(
			false,
		);
	});

	it("rejects malformed keys, tokens and hashes without echoing secrets", async () => {
		expect(
			() => new AuthSecretKeyRing("v1", new Map([["v1", Buffer.alloc(8)]])),
		).toThrow("认证密钥长度");
		expect(() => hashOpaqueToken("secret", keyRing(), "access-token")).toThrow(
			"认证令牌格式无效",
		);
		expect(await verifyOtpCode("123456", "malformed", "v2", keyRing())).toBe(
			false,
		);
		expect(constantTimeHashEquals("not-a-hash", "not-a-hash")).toBe(false);
	});

	it("generates fixed-format OTP and OAuth state values", () => {
		for (let index = 0; index < 50; index += 1) {
			expect(generateSixDigitOtp()).toMatch(/^\d{6}$/u);
			expect(generateOAuthState()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		}
	});
});
