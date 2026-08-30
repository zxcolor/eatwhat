import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseFeatureConfig } from "./admin-data";

const legacyConfig = {
  coverageName: "全国范围",
  dataRightsMode: "LIVE_DISPLAY_ONLY",
  aiEnabled: false,
  accountsEnabled: true,
  favoritesEnabled: false,
  minimumSupportedVersion: "0.1.0",
  ruleVersion: "rules-v1",
  promptVersion: "prompt-v1",
  modelVersion: "model-v1",
  authCapabilities: {
    accountsEnabled: true,
    registrationEnabled: true,
    phoneEnabled: true,
    wechatEnabled: false,
    emailEnabled: true,
    qqEnabled: false
  },
  serviceCapabilities: {
    recommendationsEnabled: true
  }
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public feature configuration compatibility", () => {
  it("keeps an older valid response live and defaults newly advertised capabilities to false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: legacyConfig }))
    );

    const snapshot = await loadConfig();

    expect(snapshot.source).toBe("LIVE");
    expect(snapshot.data.authCapabilities).toEqual({
      ...legacyConfig.authCapabilities,
      dataExportEnabled: false
    });
    expect(snapshot.data.serviceCapabilities).toEqual({
      recommendationsEnabled: true,
      locationSearchEnabled: false,
      placeSearchEnabled: false
    });
  });

  it("fails closed for an omitted legacy auth field that was never optional", () => {
    const parsed = parseFeatureConfig({
      ...legacyConfig,
      authCapabilities: {
        accountsEnabled: true,
        registrationEnabled: true,
        phoneEnabled: true,
        wechatEnabled: false,
        emailEnabled: true
      }
    });

    expect(parsed).toBeNull();
  });

  it("rejects unknown capability fields instead of reflecting them into the dashboard", () => {
    expect(
      parseFeatureConfig({
        ...legacyConfig,
        serviceCapabilities: {
          recommendationsEnabled: true,
          apiSecret: "must-not-be-reflected"
        }
      })
    ).toBeNull();
  });
});
