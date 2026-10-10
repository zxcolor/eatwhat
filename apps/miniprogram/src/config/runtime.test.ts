import { describe, expect, it } from "vitest";
import { normalizeApiBaseUrl, resolveRuntimeConfig } from "./runtime";

describe("controlled public API origin", () => {
  it("uses the Android public API and normalizes trailing slashes", () => {
    expect(resolveRuntimeConfig({}).apiBaseUrl).toBe("https://api.unfinished-era.com");
    expect(normalizeApiBaseUrl(" https://api.unfinished-era.com/// ")).toBe("https://api.unfinished-era.com");
  });
  it.each([
    "http://api.unfinished-era.com", "https://localhost", "https://127.0.0.1",
    "https://10.0.0.1", "https://192.168.1.1", "https://[::1]", "https://2130706433",
    "https://api.unfinished-era.com.evil.example", "https://evil.example",
    "https://api.unfinished-era.com@evil.example", "https://api.unfinished-era.com:443",
    "https://api.unfinished-era.com/v1", "https://api.unfinished-era.com?token=sample",
  ])("rejects runtime override %s before any request", (apiBaseUrl) => {
    expect(() => resolveRuntimeConfig({ getExtConfigSync: () => ({ apiBaseUrl }) })).toThrow("API_BASE_URL_INVALID");
  });
});
