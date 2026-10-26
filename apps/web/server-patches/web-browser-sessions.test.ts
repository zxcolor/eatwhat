import {
  AuthDeviceContextSchema,
  ListSessionsQuerySchema,
  LoginRequestSchema,
  WechatMiniProgramLoginRequestSchema,
} from "@chi-shen-me/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database/database-pool.js";
import { loadMigrationPlan } from "../database/migration-plan.js";
import { PostgresAuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";

const device = {
  installationId: "20000000-0000-4000-8000-000000000001",
  label: "合成网页设备",
  platform: "WEB",
  appVersion: "0.1.39-web",
};

describe("browser session compatibility", () => {
  it.each(["PHONE", "EMAIL"])("accepts WEB for the %s OTP flow", (method) => {
    expect(AuthDeviceContextSchema.safeParse(device).success).toBe(true);
    expect(LoginRequestSchema.safeParse({
      method,
      challengeId: "20000000-0000-4000-8000-000000000002",
      otpCode: "123456",
      ...(method === "PHONE" ? { phoneNumber: "+8613800138000" } : {}),
      device,
    }).success).toBe(true);
  });

  it.each(["WECHAT", "QQ"])("never treats WEB as native %s OAuth", (method) => {
    expect(LoginRequestSchema.safeParse({
      method, oauthState: "A".repeat(43),
      authorizationCode: "synthetic-authorization-code", device,
    }).success).toBe(false);
  });

  it("never treats a browser as the WeChat code2Session client", () => {
    expect(WechatMiniProgramLoginRequestSchema.safeParse({
      code: "synthetic-wechat-code", device,
    }).success).toBe(false);
  });

  it.each([
    [{}, false, false],
    [{ includePlatforms: "ALL" }, true, false],
    [{ includePlatforms: "ALL_WITH_WEB" }, true, true],
  ] as const)("negotiates session platform visibility for %j", async (query, all, web) => {
    const session = { userId: "owner", sessionId: "current" };
    const listSessions = vi.fn(async () => []);
    const host = {
      authenticatedUserResolver: { resolveAccessToken: async () => session },
      repository: { listSessions },
      repositoryCall: async (run: () => unknown) => run(),
    };
    await AuthService.prototype.listSessions.call(
      host as unknown as AuthService, "synthetic-bearer", ListSessionsQuerySchema.parse(query),
    );
    expect(listSessions).toHaveBeenCalledWith(session, all, web);
  });

  it.each([[false, false], [true, false], [true, true]])(
    "filters legacy responses before LIMIT (all=%s, web=%s)", async (all, web) => {
      const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
        if (sql.includes("SELECT family.id")) return { rows: [{ id: "current" }], rowCount: 1 };
        expect(values).toEqual(["owner", "current", all, web]);
        expect(sql).toContain("WHERE user_id = $1");
        expect(sql).toContain("AND ($3::boolean OR platform = 'ANDROID')");
        expect(sql).toContain("AND ($4::boolean OR platform <> 'WEB')");
        expect(sql.indexOf("$4::boolean")).toBeLessThan(sql.indexOf("LIMIT 50"));
        return { rows: [], rowCount: 0 };
      });
      const database = { withTransaction: (run: (transaction: { query: typeof query }) => unknown) => run({ query }) };
      const repository = new PostgresAuthRepository(database as unknown as DatabasePool);
      await repository.listSessions({ userId: "owner", sessionId: "current" } as never, all, web);
      expect(query).toHaveBeenCalledTimes(2);
    },
  );

  it("loads the continuous forward schema without changing historical migrations", async () => {
    const plan = await loadMigrationPlan();
    expect(plan).toHaveLength(17);
    expect(plan.map(item => item.version)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(plan[0]?.checksum).toBe("ebdda07eba3f68b88de87078facab9aa42e71288efcfce753269601ea35a34aa");
    expect(plan.at(-1)?.fileName).toBe("0017_web_browser_sessions.sql");
    expect(plan.at(-1)?.sql).toContain("CHECK (platform IN ('ANDROID', 'IOS', 'MINIPROGRAM', 'WEB'))");
    expect(plan.at(-1)?.sql).not.toMatch(/\b(?:DELETE|UPDATE|TRUNCATE|DROP TABLE|GRANT)\b/u);
  });
});
