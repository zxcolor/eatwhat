import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decryptExportArtifactLocator,
	ExportLocatorKeyRing,
	encryptExportArtifactLocator,
} from "./export-artifact-crypto.js";

function ring(): ExportLocatorKeyRing {
	return new ExportLocatorKeyRing(
		"locator-v1",
		new Map([["locator-v1", randomBytes(32)]]),
	);
}

describe("export artifact locator crypto", () => {
	it("round trips only a canonical app-owned object key", () => {
		const keyRing = ring();
		const locator =
			"exports/v1/2026/08/123e4567-e89b-42d3-a456-426614174000.json";
		const encrypted = encryptExportArtifactLocator(locator, keyRing);
		expect(encrypted.ciphertext.toString("utf8")).not.toContain(locator);
		expect(
			decryptExportArtifactLocator(
				encrypted.ciphertext,
				encrypted.keyVersion,
				keyRing,
			),
		).toBe(locator);
		keyRing.destroy();
	});

	it("rejects traversal, URLs, tampering and destroyed key rings", () => {
		const keyRing = ring();
		for (const invalid of [
			"https://example.com/file",
			"exports/v1/2026/08/../secret.json",
			"exports/v1/2026/08/not-a-uuid.json",
		]) {
			expect(() => encryptExportArtifactLocator(invalid, keyRing)).toThrow(
				"定位符格式无效",
			);
		}
		const encrypted = encryptExportArtifactLocator(
			"exports/v1/2026/08/123e4567-e89b-42d3-a456-426614174000.json",
			keyRing,
		);
		const tampered = Buffer.from(encrypted.ciphertext);
		tampered[tampered.length - 1] ^= 1;
		expect(() =>
			decryptExportArtifactLocator(tampered, encrypted.keyVersion, keyRing),
		).toThrow("密文认证失败");
		keyRing.destroy();
		expect(() =>
			decryptExportArtifactLocator(
				encrypted.ciphertext,
				encrypted.keyVersion,
				keyRing,
			),
		).toThrow("密钥环已销毁");
	});
});
