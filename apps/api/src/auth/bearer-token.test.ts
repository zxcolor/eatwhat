import { describe, expect, it } from "vitest";
import { AuthUnauthorizedException } from "./auth-errors.js";
import {
	optionalBearerAccessToken,
	requireBearerAccessToken,
} from "./bearer-token.js";

describe("App Bearer extraction", () => {
	it("accepts exactly one opaque App access token", () => {
		const token = "A".repeat(43);
		expect(requireBearerAccessToken(`Bearer ${token}`)).toBe(token);
		expect(requireBearerAccessToken(`bearer ${token}`)).toBe(token);
		expect(optionalBearerAccessToken(undefined)).toBeNull();
	});

	it.each([
		undefined,
		"",
		"Basic private-value",
		`Bearer ${"A".repeat(42)}`,
		`Bearer  ${"A".repeat(43)}`,
		`Bearer ${"A".repeat(43)}, Bearer ${"B".repeat(43)}`,
	])("rejects malformed credentials without reflecting them", (raw) => {
		let failure: unknown;
		try {
			requireBearerAccessToken(raw);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AuthUnauthorizedException);
		const rawText = String(raw);
		if (rawText.length > 0) {
			expect(JSON.stringify(failure)).not.toContain(rawText);
		}
	});
});
