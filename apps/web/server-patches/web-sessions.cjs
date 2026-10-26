'use strict';

// Every replacement is applied only after the entire source file passes the
// pinned baseline hash. Counts fail closed if a patch no longer fits the source.
const patches = {
  'packages/contracts/src/index.ts': [
    ['z.enum(["ANDROID", "MINIPROGRAM"])', 'z.enum(["ANDROID", "MINIPROGRAM", "WEB"])', 2],
    ['/** New clients opt in; absent preserves Android-only v1 clients. */', '/** Preserve Android-only and legacy ALL responses; WEB needs explicit opt-in. */', 1],
    ['includePlatforms: z.literal("ALL").optional()', 'includePlatforms: z.enum(["ALL", "ALL_WITH_WEB"]).optional()', 1],
  ],
  'apps/api/src/auth/auth.repository.ts': [
    ['\t\tincludeAllPlatforms?: boolean,\n\t): Promise<readonly SessionRecord[] | null>;', '\t\tincludeAllPlatforms?: boolean,\n\t\tincludeWebSessions?: boolean,\n\t): Promise<readonly SessionRecord[] | null>;', 1],
    ['\t\tincludeAllPlatforms = false,\n\t): Promise<readonly SessionRecord[] | null> {', '\t\tincludeAllPlatforms = false,\n\t\tincludeWebSessions = false,\n\t): Promise<readonly SessionRecord[] | null> {', 1],
    ["platform IN ('ANDROID', 'MINIPROGRAM')", "platform IN ('ANDROID', 'MINIPROGRAM', 'WEB')", 2],
    ["\t\t\t\t   AND ($3::boolean OR platform = 'ANDROID')", "\t\t\t\t   AND ($3::boolean OR platform = 'ANDROID')\n\t\t\t\t   AND ($4::boolean OR platform <> 'WEB')", 1],
    ['[session.userId, session.sessionId, includeAllPlatforms]', '[session.userId, session.sessionId, includeAllPlatforms, includeWebSessions]', 1],
  ],
  'apps/api/src/auth/auth.service.ts': [
    ['this.repository.listSessions(session, query.includePlatforms === "ALL")', 'this.repository.listSessions(\n\t\t\t\tsession,\n\t\t\t\tquery.includePlatforms === "ALL" || query.includePlatforms === "ALL_WITH_WEB",\n\t\t\t\tquery.includePlatforms === "ALL_WITH_WEB",\n\t\t\t)', 1],
  ],
  'docs/openapi.v1.json': [
    ['"enum": ["ANDROID", "MINIPROGRAM"]', '"enum": ["ANDROID", "MINIPROGRAM", "WEB"]', 2],
    ['"enum": ["ALL"]', '"enum": ["ALL", "ALL_WITH_WEB"]', 1],
    ['显式 includePlatforms=ALL 才返回同账号 ANDROID 与 MINIPROGRAM 会话。', 'includePlatforms=ALL 保持返回同账号 ANDROID 与 MINIPROGRAM 会话；只有显式 ALL_WITH_WEB 才另外包含 WEB 浏览器会话。', 1],
  ],
  'packages/contracts/src/index.test.ts': [
    ['accepts both client platforms for PHONE and EMAIL while rejecting unknown platforms', 'accepts all three client platforms for PHONE and EMAIL while rejecting unknown platforms', 1],
    ['const allowed = platform === "ANDROID" || platform === "MINIPROGRAM";', 'const allowed = platform === "ANDROID" || platform === "MINIPROGRAM" || platform === "WEB";', 1],
    ['returns sessions from both clients and rejects unsupported session platforms', 'returns sessions from all three clients and rejects unsupported session platforms', 1],
    ['items: ["ANDROID", "MINIPROGRAM"].map((platform)', 'items: ["ANDROID", "MINIPROGRAM", "WEB"].map((platform)', 1],
  ],
  'apps/api/src/auth/auth.repository.test.ts': [
    ['["MINIPROGRAM", otpProof],', '["MINIPROGRAM", otpProof],\n\t\t["WEB", otpProof],', 1],
    ['["MINIPROGRAM", emailLoginOtpProof],', '["MINIPROGRAM", emailLoginOtpProof],\n\t\t["WEB", emailLoginOtpProof],', 1],
    ['["MINIPROGRAM", registrationOtpProof],', '["MINIPROGRAM", registrationOtpProof],\n\t\t["WEB", registrationOtpProof],', 1],
    ["platform IN ('ANDROID', 'MINIPROGRAM')", "platform IN ('ANDROID', 'MINIPROGRAM', 'WEB')", 2],
    ['\t\t\t\t\tincludeAllPlatforms,\n\t\t\t\t]);', '\t\t\t\t\tincludeAllPlatforms,\n\t\t\t\t\tfalse,\n\t\t\t\t]);', 1],
    ['it.each(["ANDROID", "MINIPROGRAM"])(', 'it.each(["ANDROID", "MINIPROGRAM", "WEB"])(', 1],
  ],
  'apps/api/src/auth/auth.service.test.ts': [
    ['it.each(["ANDROID", "MINIPROGRAM"] as const)(', 'it.each(["ANDROID", "MINIPROGRAM", "WEB"] as const)(', 2],
  ],
  'apps/api/src/auth/auth-session-query.test.ts': [
    ['[{}, { includePlatforms: "ALL" as const }]', '[{}, { includePlatforms: "ALL" as const }, { includePlatforms: "ALL_WITH_WEB" as const }]', 1],
  ],
};

function applyPatch(relativePath, source) {
  let output = source;
  for (const [before, after, expected] of patches[relativePath] || []) {
    const actual = output.split(before).length - 1;
    if (actual !== expected) {
      throw new Error(`Patch does not match ${relativePath}: expected ${expected} matches, got ${actual}`);
    }
    output = output.split(before).join(after);
  }
  return output;
}

function reversePatch(relativePath, source) {
  let output = source;
  for (const [before, after, expected] of [...(patches[relativePath] || [])].reverse()) {
    const actual = output.split(after).length - 1;
    if (actual !== expected) throw new Error(`Reverse patch does not match ${relativePath}`);
    output = output.split(after).join(before);
  }
  return output;
}

module.exports = { applyPatch, reversePatch, patchedPaths: Object.freeze(Object.keys(patches)) };
