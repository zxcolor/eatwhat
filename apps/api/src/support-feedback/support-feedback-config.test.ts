import { describe, expect, it } from "vitest";
import {
	loadExportWorkerSupportFeedbackEncryptionKeyRing,
	loadSupportFeedbackRuntimeConfig,
} from "./support-feedback-config.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const HMAC_KEY = Buffer.alloc(32, 8).toString("base64");

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		SUPPORT_FEEDBACK_ENABLED: "true",
		SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION: "enc-v1",
		SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON: JSON.stringify({
			"enc-v1": ENCRYPTION_KEY,
		}),
		SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION: "hmac-v1",
		SUPPORT_FEEDBACK_HMAC_KEYS_JSON: JSON.stringify({
			"hmac-v1": HMAC_KEY,
		}),
		...overrides,
	};
}

describe("loadSupportFeedbackRuntimeConfig", () => {
	it("is fail-closed and retains no stray key while disabled", () => {
		const config = loadSupportFeedbackRuntimeConfig(
			{
				SUPPORT_FEEDBACK_ENABLED: "false",
				SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON: JSON.stringify({
					v1: ENCRYPTION_KEY,
				}),
			},
			{ databaseEnabled: false },
		);
		expect(config).toEqual({
			enabled: false,
			encryptionKeyRing: null,
			hmacKeyRing: null,
		});
	});

	it("requires a database and a matching active AES-256 key", () => {
		expect(() =>
			loadSupportFeedbackRuntimeConfig(enabledEnv(), {
				databaseEnabled: false,
			}),
		).toThrow("PostgreSQL");
		expect(() =>
			loadSupportFeedbackRuntimeConfig(
				enabledEnv({
					SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION: "enc-v2",
				}),
				{ databaseEnabled: true },
			),
		).toThrow("当前版本");
	});

	it("loads only bounded version metadata and copied key bytes", () => {
		const config = loadSupportFeedbackRuntimeConfig(enabledEnv(), {
			databaseEnabled: true,
		});
		expect(config.enabled).toBe(true);
		expect(config.encryptionKeyRing?.activeVersion).toBe("enc-v1");
		expect(config.encryptionKeyRing?.versions()).toEqual(["enc-v1"]);
		expect(config.hmacKeyRing?.activeVersion).toBe("hmac-v1");
		expect(config.hmacKeyRing?.versions()).toEqual(["hmac-v1"]);
	});

	it("rejects non-canonical Base64 and duplicate key material", () => {
		for (const encoded of [
			ENCRYPTION_KEY.replace(/=$/u, ""),
			`${ENCRYPTION_KEY}=`,
		]) {
			expect(() =>
				loadSupportFeedbackRuntimeConfig(
					enabledEnv({
						SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON: JSON.stringify({
							"enc-v1": encoded,
						}),
					}),
					{ databaseEnabled: true },
				),
			).toThrow("规范 Base64");
		}
		expect(() =>
			loadSupportFeedbackRuntimeConfig(
				enabledEnv({
					SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON: JSON.stringify({
						"enc-v1": ENCRYPTION_KEY,
						"enc-v2": ENCRYPTION_KEY,
					}),
				}),
				{ databaseEnabled: true },
			),
		).toThrow("不得复用");
	});

	it("requires purpose-separated encryption and HMAC key material", () => {
		expect(() =>
			loadSupportFeedbackRuntimeConfig(
				enabledEnv({
					SUPPORT_FEEDBACK_HMAC_KEYS_JSON: JSON.stringify({
						"hmac-v1": ENCRYPTION_KEY,
					}),
				}),
				{ databaseEnabled: true },
			),
		).toThrow("不得复用");
	});
});

describe("loadExportWorkerSupportFeedbackEncryptionKeyRing", () => {
	it("loads only encryption keys and ignores unavailable HMAC configuration", () => {
		const ring = loadExportWorkerSupportFeedbackEncryptionKeyRing({
			SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION: "enc-v1",
			SUPPORT_FEEDBACK_ENCRYPTION_KEYS_JSON: JSON.stringify({
				"enc-v1": ENCRYPTION_KEY,
			}),
			SUPPORT_FEEDBACK_HMAC_ACTIVE_VERSION: "must-not-be-read",
			SUPPORT_FEEDBACK_HMAC_KEYS_JSON: "not-json",
		});
		try {
			expect(ring.activeVersion).toBe("enc-v1");
			expect(ring.versions()).toEqual(["enc-v1"]);
		} finally {
			ring.destroy();
		}
	});

	it("fails closed when the export worker encryption key is missing", () => {
		expect(() => loadExportWorkerSupportFeedbackEncryptionKeyRing({})).toThrow(
			"SUPPORT_FEEDBACK_ENCRYPTION_ACTIVE_VERSION",
		);
	});
});
