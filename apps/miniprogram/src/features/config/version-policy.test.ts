import { describe, expect, it } from "vitest";
import { evaluateVersion } from "./version-policy";

describe("evaluateVersion", () => {
	it("requires an update when the server minimum is newer", () => {
		expect(evaluateVersion("0.1.0", "0.2.0")).toEqual({
			kind: "UPDATE_REQUIRED",
			minimumVersion: "0.2.0",
		});
	});

	it("accepts equal and newer clients", () => {
		expect(evaluateVersion("1.10.0", "1.2.9")).toEqual({
			kind: "COMPATIBLE",
			minimumVersion: "1.2.9",
		});
	});

	it("fails closed for malformed remote versions", () => {
		expect(evaluateVersion("0.1.0", "latest")).toEqual({
			kind: "CONFIGURATION_UNAVAILABLE",
		});
	});
});
