import { describe, expect, it } from "vitest";
import type { AdminConfigRecord } from "./admin-contract";
import {
  replaceReloadedConfigurationRecord,
  minimumVersionChangeProblem,
  minimumVersionChangeConfirmation,
  updateDirtyConfigKeys
} from "./configuration-state";

const aiRecord = {
  configKey: "features.ai-assistance",
  configSchema: "FEATURE_FLAGS_V1",
  classification: "PUBLIC",
  version: 1,
  value: { enabled: false },
  changeReason: "ROUTINE_TUNING",
  createdAt: "2026-08-30T01:00:00.000Z",
  activatedAt: "2026-08-30T01:00:00.000Z"
} as const satisfies AdminConfigRecord;

const coverageRecord = {
  configKey: "coverage.default",
  configSchema: "COVERAGE_SETTINGS_V1",
  classification: "PUBLIC",
  version: 1,
  value: {
    defaultRadiusMeters: 1500,
    maximumRadiusMeters: 10000,
    areaCode: "NATIONWIDE"
  },
  changeReason: "ROUTINE_TUNING",
  createdAt: "2026-08-30T01:00:00.000Z",
  activatedAt: "2026-08-30T01:00:00.000Z"
} as const satisfies AdminConfigRecord;

describe("configuration workspace state", () => {
  it("blocks unverified minimum-version raises and new platforms including a rollback target", () => {
    expect(minimumVersionChangeProblem(undefined, { android: "0.1.0" })).not.toBeNull();
    expect(minimumVersionChangeProblem({ android: "1.9.0" }, { android: "1.10.0" })).not.toBeNull();
    expect(minimumVersionChangeProblem({ android: "1.9.0" }, { android: "1.9.0", ios: "0.1.0" })).not.toBeNull();
    expect(minimumVersionChangeProblem({ android: "1.9.0" }, { android: "1.9.0", miniprogram: "0.1.0" })).not.toBeNull();
    expect(minimumVersionChangeProblem({ android: "1.10.0", ios: "1.0.0" }, { android: "1.9.0" })).toBeNull();
    expect(minimumVersionChangeProblem({ android: "1.10.0" }, { android: "1.10.0" })).toBeNull();
  });

  it("states the exact platform changes before a permitted compatibility change", () => {
    const message = minimumVersionChangeConfirmation(
      { android: "1.2.0", ios: "1.0.0" }, { android: "1.1.0" }
    );
    expect(message).toContain("Android：1.2.0 → 1.1.0");
    expect(message).toContain("iOS：1.0.0 → 移除最低版本声明");
    expect(message).toContain("不代表这些旧客户端已经完成兼容测试");
  });
  it("replaces only the requested record and preserves other card identities", () => {
    const refreshedAi = { ...aiRecord, version: 2, value: { enabled: true } };
    const result = replaceReloadedConfigurationRecord(
      [aiRecord, coverageRecord],
      [refreshedAi, { ...coverageRecord }],
      "features.ai-assistance"
    );

    expect(result[0]).toBe(refreshedAi);
    expect(result.find((record) => record.configKey === "coverage.default")).toBe(
      coverageRecord
    );
  });

  it("removes only a requested record that is absent from the latest response", () => {
    const result = replaceReloadedConfigurationRecord(
      [aiRecord, coverageRecord],
      [coverageRecord],
      "features.ai-assistance"
    );
    expect(result).toEqual([coverageRecord]);
  });

  it("tracks dirty groups without allocating when membership is unchanged", () => {
    const empty = new Set<"features.ai-assistance">();
    const dirty = updateDirtyConfigKeys(empty, "features.ai-assistance", true);
    expect(dirty).not.toBe(empty);
    expect([...dirty]).toEqual(["features.ai-assistance"]);
    expect(updateDirtyConfigKeys(dirty, "features.ai-assistance", true)).toBe(dirty);
    expect(updateDirtyConfigKeys(dirty, "features.ai-assistance", false)).toEqual(
      new Set()
    );
  });
});
