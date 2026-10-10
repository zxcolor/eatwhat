import { describe, expect, it } from "vitest";

import {
	parseAuthTokenResponse,
	parseIdentityBindingsResponse,
} from "./contracts";

const UUID = "11111111-1111-4111-8111-111111111111";
const FUTURE = "2099-01-01T00:00:00.000Z";

describe("strict mini-program response parsing", () => {
	it("rejects extra fields in token responses", () => {
		expect(() =>
			parseAuthTokenResponse({
				userId: UUID,
				sessionId: "22222222-2222-4222-8222-222222222222",
				tokenType: "Bearer",
				accessToken: "a".repeat(43),
				accessTokenExpiresAt: FUTURE,
				refreshToken: "r".repeat(43),
				refreshTokenExpiresAt: FUTURE,
				debugToken: "must-not-be-accepted",
			}),
		).toThrow("CONTRACT_RESPONSE_INVALID");
	});

	it("preserves existing QQ bindings when synchronizing the shared business account", () => {
		const result = parseIdentityBindingsResponse({
			items: [
				{
					bindingId: UUID,
					type: "PHONE",
					maskedValue: "+86138****0000",
					boundAt: "2026-01-01T00:00:00.000Z",
					primary: true,
					canUnbind: false,
				},
				{
					bindingId: "22222222-2222-4222-8222-222222222222",
					type: "QQ",
					maskedValue: "QQ 账号",
					boundAt: "2026-01-01T00:00:00.000Z",
					primary: false,
					canUnbind: true,
				},
			],
		});

		expect(result.items).toHaveLength(2);
		expect(result.items[0]?.type).toBe("PHONE");
		expect(result.items[1]).toMatchObject({
			type: "QQ",
			maskedValue: "QQ 账号",
		});
	});

	it("rejects raw QQ identifiers in place of the public masked label", () => {
		expect(() =>
			parseIdentityBindingsResponse({
				items: [
					{
						bindingId: UUID,
						type: "QQ",
						maskedValue: "private-provider-open-id",
						boundAt: "2026-01-01T00:00:00.000Z",
						primary: false,
						canUnbind: true,
					},
				],
			}),
		).toThrow("CONTRACT_RESPONSE_INVALID");
	});

	it("rejects malformed masked email values", () => {
		expect(() =>
			parseIdentityBindingsResponse({
				items: [
					{
						bindingId: UUID,
						type: "EMAIL",
						maskedValue: "real@example.com",
						boundAt: "2026-01-01T00:00:00.000Z",
						primary: false,
						canUnbind: true,
					},
				],
			}),
		).toThrow("CONTRACT_RESPONSE_INVALID");
	});
});
