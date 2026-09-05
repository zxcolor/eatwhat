import { describe, expect, it } from "vitest";
import { configurationAdoption, parseConfigurationRuntime, type ConfigurationRuntime } from "./configuration-runtime";

const runtime: ConfigurationRuntime = {
  source: "DATABASE",
  lastSuccessfulReadAt: "2026-09-06T01:00:00.000Z",
  cacheTtlMs: 5000,
  versions: {
    "features.ai-assistance": 2,
    "recommendations.rules": null,
    "recommendations.prompt": 1,
    "coverage.default": null,
    "clients.minimum-version": null
  },
  aiStatus: "SERVER_DISABLED"
};

describe("runtime adoption evidence", () => {
  it("distinguishes a saved version from an adopted version and limits the claim to one response", () => {
    const same = configurationAdoption("features.ai-assistance", 2, runtime);
    expect(same.label).toBe("本次响应采用 v2");
    expect(same.detail).toContain("不证明所有实例");
    expect(configurationAdoption("features.ai-assistance", 3, runtime).label).toContain("尚未核实");
    expect(configurationAdoption("features.ai-assistance", 2, null).label).toBe("运行采用情况未验证");
  });

  it("never treats a matching stale or fallback version as adopted", () => {
    for (const source of ["STALE_CACHE", "SAFE_FALLBACK"] as const) {
      expect(configurationAdoption("features.ai-assistance", 2, { ...runtime, source, aiStatus: "CONFIG_UNAVAILABLE" }).label)
        .toBe("运行配置不可用");
    }
  });

  it("accepts only fixed diagnostic fields and version keys without reflecting secrets", () => {
    expect(parseConfigurationRuntime(runtime)).toEqual(runtime);
    expect(parseConfigurationRuntime({ ...runtime, secret: "rejected" })).toBeNull();
    expect(parseConfigurationRuntime({ ...runtime, versions: { ...runtime.versions, apiKey: "rejected" } })).toBeNull();
    expect(parseConfigurationRuntime({ ...runtime, versions: { ...runtime.versions, "features.ai-assistance": -1 } })).toBeNull();
    expect(parseConfigurationRuntime({ ...runtime, source: "STALE_CACHE", aiStatus: "ENABLED" })).toBeNull();
    expect(parseConfigurationRuntime({ ...runtime, lastSuccessfulReadAt: "not-a-time" })).toBeNull();
    expect(parseConfigurationRuntime({ ...runtime, aiStatus: "UNKNOWN" })).toBeNull();
    expect(parseConfigurationRuntime({ ...runtime, cacheTtlMs: 6000 })).toBeNull();
  });
});
