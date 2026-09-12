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
      groupRecommendationsEnabled: false,
      locationSearchEnabled: false,
      placeSearchEnabled: false
    });
  });

  it("accepts specialty fields and rejects enabling the retired group capability", () => {
    const specialty = {
      breakfastProfileEnabled: true,
      dinnerProfileEnabled: true,
      milkTeaEnabled: false,
      coffeeEnabled: false,
      dessertEnabled: false,
      userReportedWeatherEnabled: false
    };
    const current = {
      ...legacyConfig,
      serviceCapabilities: { recommendationsEnabled: true, groupRecommendationsEnabled: false },
      specialtyCapabilities: specialty
    };
    expect(parseFeatureConfig(current)?.serviceCapabilities.groupRecommendationsEnabled).toBe(false);
    expect(parseFeatureConfig({ ...current, serviceCapabilities: { ...current.serviceCapabilities, groupRecommendationsEnabled: true } })).toBeNull();
    expect(parseFeatureConfig(current)?.specialtyCapabilities).toEqual(specialty);
    expect(parseFeatureConfig({ ...current, specialtyCapabilities: { ...specialty, apiSecret: "rejected" } })).toBeNull();
    expect(parseFeatureConfig({ ...current, specialtyCapabilities: { ...specialty, coffeeEnabled: "true" } })).toBeNull();
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

  it("validates operational diagnostics against the public AI capability", () => {
    const diagnostics = {
      source: "DATABASE", lastSuccessfulReadAt: "2026-09-06T01:00:00.000Z", cacheTtlMs: 5000,
      versions: {
        "features.ai-assistance": 1, "recommendations.rules": null, "recommendations.prompt": null,
        "coverage.default": null, "clients.minimum-version": null
      },
      aiStatus: "SERVER_DISABLED"
    };
    expect(parseFeatureConfig({ ...legacyConfig, operationalConfig: diagnostics })?.operationalConfig).toEqual(diagnostics);
    expect(parseFeatureConfig({ ...legacyConfig, aiEnabled: true, operationalConfig: diagnostics })).toBeNull();
    expect(parseFeatureConfig({ ...legacyConfig, operationalConfig: { ...diagnostics, apiSecret: "rejected" } })).toBeNull();
    expect(parseFeatureConfig({ ...legacyConfig, rulesConfigVersion: null, operationalConfig: diagnostics })?.rulesConfigVersion).toBeNull();
    expect(parseFeatureConfig({ ...legacyConfig, rulesConfigVersion: 3, operationalConfig: diagnostics })).toBeNull();
    expect(parseFeatureConfig({ ...legacyConfig, rulesConfigVersion: -1 })).toBeNull();
    expect(parseFeatureConfig({ ...legacyConfig, rulesConfigVersion: "3" })).toBeNull();
    expect(parseFeatureConfig({ ...legacyConfig, rulesConfigVersion: 3 })?.rulesConfigVersion).toBe(3);
  });
});
