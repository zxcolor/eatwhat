import { describe, expect, it } from "vitest";
import {
	applyAmapWebServiceSignature,
	computeAmapWebServiceSignature,
} from "./amap-request-signature.js";

describe("AMap Web Service request signature", () => {
	it("matches the official sorted-parameter example", () => {
		const parameters = new URLSearchParams();
		for (const [name, value] of [
			["f", "8"],
			["c", "67"],
			["a", "23"],
			["d", "48"],
			["b", "12"],
		] as const) {
			parameters.set(name, value);
		}
		expect(computeAmapWebServiceSignature(parameters, "bbbbb")).toBe(
			"a89e8c2266d888860c46672d77d069f3",
		);
	});

	it("adds only sig and never puts the private key in the URL", () => {
		const endpoint = new URL("https://restapi.amap.com/v5/place/text");
		endpoint.searchParams.set("keywords", "北京大学");
		endpoint.searchParams.set("key", "public-key");
		applyAmapWebServiceSignature(endpoint, "private-signing-key");

		expect(endpoint.searchParams.get("sig")).toMatch(/^[0-9a-f]{32}$/u);
		expect(endpoint.toString()).not.toContain("private-signing-key");
		expect([...endpoint.searchParams.keys()].sort()).toEqual([
			"key",
			"keywords",
			"sig",
		]);
	});

	it("hashes a literal plus before URL encoding it for transport", () => {
		const endpoint = new URL("https://restapi.amap.com/v5/place/text");
		endpoint.searchParams.set("key", "test");
		endpoint.searchParams.set("keywords", "C++");

		expect(
			computeAmapWebServiceSignature(endpoint.searchParams, "private"),
		).toBe("0da02fc39e848f12fe5576349d40bc03");
		expect(endpoint.toString()).toContain("keywords=C%2B%2B");
	});

	it("is a no-op without a private key and rejects unsafe signing inputs", () => {
		const unsigned = new URL("https://restapi.amap.com/v5/place/around?key=k");
		applyAmapWebServiceSignature(unsigned, null);
		expect(unsigned.searchParams.has("sig")).toBe(false);

		expect(() =>
			applyAmapWebServiceSignature(
				new URL("https://example.com/v5/place/text?key=k"),
				"private",
			),
		).toThrow("AMAP_SIGNATURE_ENDPOINT_INVALID");
		expect(() =>
			computeAmapWebServiceSignature(
				new URLSearchParams("key=k&key=duplicate"),
				"private",
			),
		).toThrow("AMAP_SIGNATURE_DUPLICATE_PARAMETER");
	});
});
