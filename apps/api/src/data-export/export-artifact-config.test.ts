import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadExportArtifactRuntimeConfig } from "./export-artifact-config.js";

function enabledEnvironment(): NodeJS.ProcessEnv {
	return {
		DATA_EXPORT_ENABLED: "true",
		DATA_EXPORT_OSS_REGION: "oss-cn-beijing",
		DATA_EXPORT_OSS_BUCKET: "chi-shen-me-private-exports",
		DATA_EXPORT_OSS_INTERNAL: "true",
		ALIBABA_CLOUD_ECS_METADATA: "chi-shen-me-data-export-worker",
		ALIBABA_CLOUD_IMDSV1_DISABLED: "true",
		ALIBABA_CLOUD_ECS_IMDSV2_ENABLE: "true",
		DATA_EXPORT_LOCATOR_ACTIVE_VERSION: "locator-v1",
		DATA_EXPORT_LOCATOR_KEYS_JSON: JSON.stringify({
			"locator-v1": randomBytes(32).toString("base64"),
		}),
	};
}

describe("loadExportArtifactRuntimeConfig", () => {
	it("is inert without decoding secrets when the capability is disabled", () => {
		const config = loadExportArtifactRuntimeConfig(
			{ DATA_EXPORT_ENABLED: "false", DATA_EXPORT_LOCATOR_KEYS_JSON: "bad" },
			"production",
		);
		expect(config.enabled).toBe(false);
		expect(config.locatorKeyRing).toBeNull();
	});

	it("accepts a private Beijing production configuration", () => {
		const config = loadExportArtifactRuntimeConfig(
			enabledEnvironment(),
			"production",
		);
		expect(config).toMatchObject({
			enabled: true,
			region: "oss-cn-beijing",
			internal: true,
			maximumArtifactBytes: 10 * 1024 * 1024,
		});
		config.locatorKeyRing?.destroy();
	});

	it("fails closed for a non-Beijing or public production endpoint", () => {
		expect(() =>
			loadExportArtifactRuntimeConfig(
				{ ...enabledEnvironment(), DATA_EXPORT_OSS_REGION: "oss-cn-hangzhou" },
				"production",
			),
		).toThrow("北京地域");
		expect(() =>
			loadExportArtifactRuntimeConfig(
				{ ...enabledEnvironment(), DATA_EXPORT_OSS_INTERNAL: "false" },
				"production",
			),
		).toThrow("北京内网");
	});

	it("requires a named IMDSv2-only ECS RAM role", () => {
		expect(() =>
			loadExportArtifactRuntimeConfig(
				{ ...enabledEnvironment(), ALIBABA_CLOUD_ECS_METADATA: "" },
				"test",
			),
		).toThrow("RAM角色名");
		expect(() =>
			loadExportArtifactRuntimeConfig(
				{ ...enabledEnvironment(), ALIBABA_CLOUD_IMDSV1_DISABLED: "false" },
				"test",
			),
		).toThrow("IMDSv2");
		expect(() =>
			loadExportArtifactRuntimeConfig(
				{
					...enabledEnvironment(),
					ALIBABA_CLOUD_ECS_METADATA_DISABLED: "true",
				},
				"test",
			),
		).toThrow("禁止关闭");
	});

	it("rejects malformed key material and unsafe bounds", () => {
		expect(() =>
			loadExportArtifactRuntimeConfig(
				{
					...enabledEnvironment(),
					DATA_EXPORT_LOCATOR_KEYS_JSON: JSON.stringify({
						"locator-v1": "AA==",
					}),
				},
				"test",
			),
		).toThrow("32字节");
		expect(() =>
			loadExportArtifactRuntimeConfig(
				{
					...enabledEnvironment(),
					DATA_EXPORT_MAX_ARTIFACT_BYTES: "999999999",
				},
				"test",
			),
		).toThrow("DATA_EXPORT_MAX_ARTIFACT_BYTES");
	});
});
