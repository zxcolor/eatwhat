import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminClientError, isAdminConfigurationVersionConflict, updateAdminConfiguration } from "./admin-client";
import { ADMIN_CLIENT_RELEASE_UNVERIFIED_MESSAGE } from "./admin-contract";

afterEach(() => vi.unstubAllGlobals());

describe("configuration error classification", () => {
  it("retains a release-gate code without treating HTTP 409 as concurrent editing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      code: "CLIENT_RELEASE_UNVERIFIED", message: "unexpected body message",
    }, { status: 409 })));
    const error = await updateAdminConfiguration("clients.minimum-version", {
      expectedActiveVersion: 1, value: { android: "1.2.0" }, changeReason: "RELEASE_COMPATIBILITY",
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: "CLIENT_RELEASE_UNVERIFIED", message: ADMIN_CLIENT_RELEASE_UNVERIFIED_MESSAGE });
    expect(isAdminConfigurationVersionConflict(error)).toBe(false);
  });

  it("offers conflict reload only for the BFF's fixed concurrency code", () => {
    expect(isAdminConfigurationVersionConflict(new AdminClientError(409, "conflict", "ADMIN_CONFLICT"))).toBe(true);
    expect(isAdminConfigurationVersionConflict(new AdminClientError(409, "unknown"))).toBe(false);
    expect(isAdminConfigurationVersionConflict(new AdminClientError(503, "unavailable", "ADMIN_CONFLICT"))).toBe(false);
  });
});
