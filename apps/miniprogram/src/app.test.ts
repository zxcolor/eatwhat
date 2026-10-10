import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChiShenMeMiniProgramApp } from "./app";
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from "./core/contracts";
import { PRIVACY_POLICY_VERSION, TERMS_VERSION } from "./features/consent/consent-authority";

const base = {
  coverageName: "全国", dataRightsMode: "LIVE_DISPLAY_ONLY", aiEnabled: false,
  accountsEnabled: false, favoritesEnabled: false, supportFeedbackEnabled: false,
  minimumSupportedVersion: "9.0.0", minimumSupportedVersions: { android: "9.0.0", miniprogram: "0.1.0" },
  ruleVersion: "rules-v1", promptVersion: "prompt-v1", modelVersion: "none",
  persistenceCapabilities: { favoritesEnabled: false, historyEnabled: false, privateFeedbackEnabled: false, savedResourceIdsEnabled: false },
  authCapabilities: { accountsEnabled: false, registrationEnabled: false, phoneEnabled: false, wechatEnabled: false, emailEnabled: false, qqEnabled: false, dataExportEnabled: false },
  serviceCapabilities: { groupRecommendationsEnabled: false, recommendationsEnabled: true, locationSearchEnabled: true, placeSearchEnabled: true },
};

async function harness(accepted = true) {
  vi.resetModules();
  const storage = new Map<string, unknown>();
  if (accepted) storage.set("chi-shen-me.privacy-consent.v1", {
    version: 1, privacyPolicyVersion: PRIVACY_POLICY_VERSION, termsVersion: TERMS_VERSION, acceptedAt: "2026-09-01T00:00:00.000Z",
  });
  const requests: Array<Parameters<WxRuntime["request"]>[0]> = [];
  let app: ChiShenMeMiniProgramApp | undefined;
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    request: (options: Parameters<WxRuntime["request"]>[0]) => { requests.push(options); return { abort: vi.fn() }; },
    reLaunch: vi.fn(), hideShareMenu: vi.fn(),
  });
  vi.stubGlobal("App", (registered: ChiShenMeMiniProgramApp) => { app = registered; });
  vi.stubGlobal("getCurrentPages", () => []);
  await import("./app");
  if (!app) throw new Error("App was not registered");
  return {
    app, requests, storage,
    respond(data: unknown = base, index = requests.length - 1) {
      requests[index]?.success({ statusCode: 200, data, header: { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION } });
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("mini-program app lifecycle", () => {
  it("does not request configuration or location before consent", async () => {
    const { app, requests } = await harness(false);
    app.onShow();
    await expect(app.globalData.initializeAfterConsent()).resolves.toEqual({ kind: "PRIVACY_REQUIRED" });
    expect(requests).toHaveLength(0);
  });
  it("uses the mini-program minimum independently of Android", async () => {
    const h = await harness();
    const pending = h.app.globalData.initializeAfterConsent(); h.respond();
    await expect(pending).resolves.toMatchObject({ kind: "READY" });
  });
  it("does not borrow Android's legacy minimum when no mini-program version was published", async () => {
    const h = await harness();
    const pending = h.app.globalData.initializeAfterConsent();
    const { minimumSupportedVersions: _, ...legacy } = base;
    h.respond(legacy);
    await expect(pending).resolves.toMatchObject({ kind: "READY" });
  });
  it("keeps a confirmed update gate after a network failure, then clears only on trusted compatible config", async () => {
    const h = await harness();
    const blocked = h.app.globalData.initializeAfterConsent();
    h.respond({ ...base, minimumSupportedVersions: { android: "9.0.0", miniprogram: "0.2.0" } });
    await expect(blocked).resolves.toEqual({ kind: "UPDATE_REQUIRED", minimumVersion: "0.2.0" });
    const failed = h.app.globalData.initializeAfterConsent(); h.requests.at(-1)?.fail();
    await expect(failed).resolves.toEqual({ kind: "UPDATE_REQUIRED", minimumVersion: "0.2.0" });
    expect(h.app.globalData.featureConfig.current().kind).toBe("UNAVAILABLE");
    const restored = h.app.globalData.initializeAfterConsent(); h.respond();
    await expect(restored).resolves.toMatchObject({ kind: "READY" });
  });
  it("ignores configuration that arrives after backgrounding and clears location", async () => {
    const h = await harness();
    const pending = h.app.globalData.initializeAfterConsent();
    h.app.onHide(); h.respond();
    await expect(pending).resolves.toEqual({ kind: "PRIVACY_REQUIRED" });
    expect(h.app.globalData.decision.controller.state.form.location).toBeNull();
    expect(h.app.globalData.decision.controller.state.accessPolicy.state).not.toBe("TRUSTED_COMPATIBLE");
    await expect(h.app.globalData.initializeAfterConsent()).resolves.toEqual({ kind: "PRIVACY_REQUIRED" });
    expect(h.requests).toHaveLength(1);
    h.app.onShow(); h.respond();
    await expect(h.app.globalData.initializeAfterConsent()).resolves.toMatchObject({ kind: "READY" });
  });
  it("does not revive a withdrawn consent with an already pending configuration", async () => {
    const h = await harness();
    const pending = h.app.globalData.initializeAfterConsent();
    expect(h.app.globalData.withdrawPrivacy()).toBe(true); h.respond();
    await expect(pending).resolves.toEqual({ kind: "PRIVACY_REQUIRED" });
    expect(h.app.globalData.consent.isAllowed()).toBe(false);
    expect(h.app.globalData.featureConfig.current().kind).toBe("UNAVAILABLE");
  });
});
