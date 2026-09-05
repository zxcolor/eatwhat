export const ADMIN_CONTRACT_HEADER = "X-ChiShenMe-Admin-Contract-Version";
export const ADMIN_CONTRACT_VERSION = "1";
export const ADMIN_DEVICE_HEADER = "X-Admin-Device-Id";
export const ADMIN_CLIENT_RELEASE_UNVERIFIED_MESSAGE = "尚未接入可信客户端发布清单，不能首次设置、提高最低版本或新增平台门槛";

export const ADMIN_PERMISSION_CODES = [
  "AUDIT_READ",
  "OPERATIONS_READ",
  "FEEDBACK_MANAGE",
  "PLACE_DATA_MANAGE",
  "ALGORITHM_CONFIG_READ",
  "ALGORITHM_CONFIG_WRITE",
  "SECURITY_ADMIN_READ",
  "SECURITY_ADMIN_WRITE",
  "CREDENTIAL_SELF_MANAGE"
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSION_CODES)[number];

export interface AdminSession {
  absoluteExpiresAt: string;
  idleTimeoutSeconds: 900;
  permissions: AdminPermission[];
}

export interface AdminCredentialRecord {
  credentialHandle: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AdminAuditEvent {
  auditEventId: string;
  action: string;
  targetType: "ADMIN_USER" | "ADMIN_SESSION" | "ADMIN_CREDENTIAL" | "APP_CONFIG";
  occurredAt: string;
  configKey?: AdminConfigKey;
  newVersion?: number;
  sourceVersion?: number | null;
  changeReason?: AdminConfigChangeReason;
}

export interface AdminAuditPage {
  items: AdminAuditEvent[];
  nextCursor: string | null;
}

export const ADMIN_CONFIG_DEFINITIONS = {
  "features.ai-assistance": {
    configSchema: "FEATURE_FLAGS_V1",
    classification: "PUBLIC"
  },
  "recommendations.rules": {
    configSchema: "RECOMMENDATION_RULES_V1",
    classification: "INTERNAL"
  },
  "recommendations.prompt": {
    configSchema: "PROMPT_SETTINGS_V1",
    classification: "INTERNAL"
  },
  "coverage.default": {
    configSchema: "COVERAGE_SETTINGS_V1",
    classification: "PUBLIC"
  },
  "clients.minimum-version": {
    configSchema: "MINIMUM_APP_VERSION_V1",
    classification: "PUBLIC"
  }
} as const;

export type AdminConfigKey = keyof typeof ADMIN_CONFIG_DEFINITIONS;
export type AdminConfigClassification = "PUBLIC" | "INTERNAL";
export type AdminConfigChangeReason =
  | "ROUTINE_TUNING"
  | "INCIDENT_RESPONSE"
  | "RELEASE_COMPATIBILITY"
  | "ROLLBACK";
export type AdminConfigUpdateReason = Exclude<AdminConfigChangeReason, "ROLLBACK">;

export const ADMIN_REGISTERED_PROMPT_VERSIONS = ["intent-prompt-v1"] as const;
export const ADMIN_REGISTERED_MODEL_VERSIONS = ["qwen3.7-flash-2026-07-15"] as const;

export interface AiAssistanceConfigValue {
  enabled: boolean;
}

export interface RecommendationRulesConfigValue {
  qualityWeight: number;
  timeWeight: number;
  budgetWeight: number;
  intentWeight: number;
  diversityWeight: number;
  operationsAdjustmentMaximum: number;
}

export interface RecommendationPromptConfigValue {
  enabled: boolean;
  promptVersion: (typeof ADMIN_REGISTERED_PROMPT_VERSIONS)[number];
  modelVersion: (typeof ADMIN_REGISTERED_MODEL_VERSIONS)[number];
  timeoutMs: number;
}

export interface CoverageDefaultConfigValue {
  defaultRadiusMeters: number;
  maximumRadiusMeters: number;
  areaCode: "NATIONWIDE";
}

export interface MinimumClientVersionConfigValue {
  android: string;
  ios?: string;
  miniprogram?: string;
}

export interface AdminConfigValueMap {
  "features.ai-assistance": AiAssistanceConfigValue;
  "recommendations.rules": RecommendationRulesConfigValue;
  "recommendations.prompt": RecommendationPromptConfigValue;
  "coverage.default": CoverageDefaultConfigValue;
  "clients.minimum-version": MinimumClientVersionConfigValue;
}

interface AdminConfigRecordCommon {
  version: number;
  changeReason: AdminConfigChangeReason;
  createdAt: string;
  activatedAt: string;
}

export type AdminConfigRecord = {
  [K in AdminConfigKey]: AdminConfigRecordCommon & {
    configKey: K;
    configSchema: (typeof ADMIN_CONFIG_DEFINITIONS)[K]["configSchema"];
    classification: (typeof ADMIN_CONFIG_DEFINITIONS)[K]["classification"];
    value: AdminConfigValueMap[K];
  }
}[AdminConfigKey];

export interface AdminConfigurationPage {
  items: AdminConfigRecord[];
}

export interface AdminConfigUpdateRequest<K extends AdminConfigKey = AdminConfigKey> {
  expectedActiveVersion: number | null;
  value: AdminConfigValueMap[K];
  changeReason: AdminConfigUpdateReason;
}

export interface AdminConfigRollbackRequest {
  expectedActiveVersion: number;
  targetVersion: number;
  changeReason: "ROLLBACK";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMIN_AUDIT_ACTIONS = new Set([
  "ADMIN_LOGIN_FAILED",
  "ADMIN_LOGIN_SUCCEEDED",
  "ADMIN_WEBAUTHN_COUNTER_ROLLBACK",
  "ADMIN_SESSION_REVOKED",
  "ADMIN_CREDENTIAL_ENROLLED",
  "ADMIN_CREDENTIAL_REVOKED",
  "ADMIN_ROLE_GRANTED_AUDITOR",
  "ADMIN_ROLE_GRANTED_OPERATOR",
  "ADMIN_ROLE_GRANTED_ALGORITHM_ADMIN",
  "ADMIN_ROLE_GRANTED_SECURITY_ADMIN",
  "ADMIN_ROLE_REVOKED_AUDITOR",
  "ADMIN_ROLE_REVOKED_OPERATOR",
  "ADMIN_ROLE_REVOKED_ALGORITHM_ADMIN",
  "ADMIN_ROLE_REVOKED_SECURITY_ADMIN",
  "ADMIN_STATUS_CHANGED_ACTIVE",
  "ADMIN_STATUS_CHANGED_LOCKED",
  "ADMIN_STATUS_CHANGED_DISABLED",
  "ADMIN_BOOTSTRAP_COMPLETED",
  "ADMIN_CONFIG_PUBLISHED",
  "ADMIN_CONFIG_ROLLED_BACK"
]);

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isFutureDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isAdminConfigKey(value: unknown): value is AdminConfigKey {
  return typeof value === "string" && Object.hasOwn(ADMIN_CONFIG_DEFINITIONS, value);
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function isFourDecimalNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum &&
    Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-7
  );
}

function isSemver(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/.test(value)
  );
}

function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function safeAdminConfigValue<K extends AdminConfigKey>(
  configKey: K,
  value: unknown
): AdminConfigValueMap[K] | null {
  if (configKey === "features.ai-assistance") {
    if (!isExactObject(value, ["enabled"]) || typeof value.enabled !== "boolean") return null;
    return {
      enabled: value.enabled
    } as AdminConfigValueMap[K];
  }

  if (configKey === "recommendations.rules") {
    const keys = [
      "qualityWeight",
      "timeWeight",
      "budgetWeight",
      "intentWeight",
      "diversityWeight",
      "operationsAdjustmentMaximum"
    ] as const;
    if (!isExactObject(value, keys)) return null;
    if (
      !isFourDecimalNumber(value.qualityWeight, 0, 95) ||
      !isFourDecimalNumber(value.timeWeight, 0, 95) ||
      !isFourDecimalNumber(value.budgetWeight, 0, 95) ||
      !isFourDecimalNumber(value.intentWeight, 0, 95) ||
      !isFourDecimalNumber(value.diversityWeight, 0, 95) ||
      !isFourDecimalNumber(value.operationsAdjustmentMaximum, 0, 5)
    ) return null;
    const total = value.qualityWeight + value.timeWeight + value.budgetWeight + value.intentWeight + value.diversityWeight;
    if (Math.abs(total - 95) > 0.000001) return null;
    return {
      qualityWeight: value.qualityWeight,
      timeWeight: value.timeWeight,
      budgetWeight: value.budgetWeight,
      intentWeight: value.intentWeight,
      diversityWeight: value.diversityWeight,
      operationsAdjustmentMaximum: value.operationsAdjustmentMaximum
    } as AdminConfigValueMap[K];
  }

  if (configKey === "recommendations.prompt") {
    if (!isExactObject(value, ["enabled", "promptVersion", "modelVersion", "timeoutMs"])) return null;
    if (
      typeof value.enabled !== "boolean" ||
      !ADMIN_REGISTERED_PROMPT_VERSIONS.includes(value.promptVersion as never) ||
      !ADMIN_REGISTERED_MODEL_VERSIONS.includes(value.modelVersion as never) ||
      typeof value.timeoutMs !== "number" ||
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 500 ||
      value.timeoutMs > 2_500
    ) return null;
    return {
      enabled: value.enabled,
      promptVersion: value.promptVersion,
      modelVersion: value.modelVersion,
      timeoutMs: value.timeoutMs
    } as AdminConfigValueMap[K];
  }

  if (configKey === "coverage.default") {
    if (!isExactObject(value, ["defaultRadiusMeters", "maximumRadiusMeters", "areaCode"])) return null;
    if (
      typeof value.defaultRadiusMeters !== "number" ||
      !Number.isSafeInteger(value.defaultRadiusMeters) ||
      value.defaultRadiusMeters < 200 ||
      value.defaultRadiusMeters > 10_000 ||
      typeof value.maximumRadiusMeters !== "number" ||
      !Number.isSafeInteger(value.maximumRadiusMeters) ||
      value.maximumRadiusMeters < 200 ||
      value.maximumRadiusMeters > 10_000 ||
      value.defaultRadiusMeters > value.maximumRadiusMeters ||
      value.areaCode !== "NATIONWIDE"
    ) return null;
    return {
      defaultRadiusMeters: value.defaultRadiusMeters,
      maximumRadiusMeters: value.maximumRadiusMeters,
      areaCode: value.areaCode
    } as AdminConfigValueMap[K];
  }

  if (!isExactObject(value, ["android", "ios", "miniprogram"]) &&
      !isExactObject(value, ["android", "ios"]) &&
      !isExactObject(value, ["android", "miniprogram"]) &&
      !isExactObject(value, ["android"])) return null;
  if (
    !isSemver(value.android) ||
    !(value.ios === undefined || isSemver(value.ios)) ||
    !(value.miniprogram === undefined || isSemver(value.miniprogram))
  ) return null;
  return {
    android: value.android,
    ...(value.ios === undefined ? {} : { ios: value.ios }),
    ...(value.miniprogram === undefined ? {} : { miniprogram: value.miniprogram })
  } as AdminConfigValueMap[K];
}

export function safeAdminConfigRecord(value: unknown): AdminConfigRecord | null {
  if (!isExactObject(value, [
    "configKey",
    "configSchema",
    "classification",
    "version",
    "value",
    "changeReason",
    "createdAt",
    "activatedAt"
  ])) return null;
  if (!isAdminConfigKey(value.configKey)) return null;
  const definition = ADMIN_CONFIG_DEFINITIONS[value.configKey];
  if (
    value.configSchema !== definition.configSchema ||
    value.classification !== definition.classification ||
    !isPositiveVersion(value.version) ||
    !["ROUTINE_TUNING", "INCIDENT_RESPONSE", "RELEASE_COMPATIBILITY", "ROLLBACK"].includes(String(value.changeReason)) ||
    !isIsoDateTime(value.createdAt) ||
    !isIsoDateTime(value.activatedAt)
  ) return null;
  const parsedValue = safeAdminConfigValue(value.configKey, value.value);
  if (parsedValue === null) return null;
  return {
    configKey: value.configKey,
    configSchema: definition.configSchema,
    classification: definition.classification,
    version: value.version,
    value: parsedValue,
    changeReason: value.changeReason as AdminConfigChangeReason,
    createdAt: value.createdAt,
    activatedAt: value.activatedAt
  } as AdminConfigRecord;
}

export function safeAdminConfigurationPage(value: unknown): AdminConfigurationPage | null {
  if (!isExactObject(value, ["items"]) || !Array.isArray(value.items) || value.items.length > 5) return null;
  const items = value.items.map(safeAdminConfigRecord);
  if (items.some((item) => item === null)) return null;
  const parsed = items as AdminConfigRecord[];
  if (new Set(parsed.map((item) => item.configKey)).size !== parsed.length) return null;
  return { items: parsed };
}

export function safeAdminConfigurationHistory(
  value: unknown,
  configKey: AdminConfigKey
): AdminConfigurationPage | null {
  if (!isExactObject(value, ["items"]) || !Array.isArray(value.items) || value.items.length > 20) return null;
  const items = value.items.map(safeAdminConfigRecord);
  if (items.some((item) => item === null)) return null;
  const parsed = items as AdminConfigRecord[];
  if (parsed.some((item) => item.configKey !== configKey)) return null;
  if (new Set(parsed.map((item) => item.version)).size !== parsed.length) return null;
  return { items: parsed };
}

export function safeAdminConfigUpdateRequest<K extends AdminConfigKey>(
  value: unknown,
  configKey: K
): AdminConfigUpdateRequest<K> | null {
  if (!isExactObject(value, ["expectedActiveVersion", "value", "changeReason"])) return null;
  if (
    !(value.expectedActiveVersion === null || isPositiveVersion(value.expectedActiveVersion)) ||
    !["ROUTINE_TUNING", "INCIDENT_RESPONSE", "RELEASE_COMPATIBILITY"].includes(String(value.changeReason))
  ) return null;
  const parsedValue = safeAdminConfigValue(configKey, value.value);
  if (parsedValue === null) return null;
  return {
    expectedActiveVersion: value.expectedActiveVersion,
    value: parsedValue,
    changeReason: value.changeReason as AdminConfigUpdateReason
  };
}

export function safeAdminConfigRollbackRequest(value: unknown): AdminConfigRollbackRequest | null {
  if (!isExactObject(value, ["expectedActiveVersion", "targetVersion", "changeReason"])) return null;
  if (
    !isPositiveVersion(value.expectedActiveVersion) ||
    !isPositiveVersion(value.targetVersion) ||
    value.changeReason !== "ROLLBACK"
  ) return null;
  return {
    expectedActiveVersion: value.expectedActiveVersion,
    targetVersion: value.targetVersion,
    changeReason: "ROLLBACK"
  };
}

export function isOpaqueToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isAdminSession(value: unknown): value is AdminSession {
  if (!isExactObject(value, ["absoluteExpiresAt", "idleTimeoutSeconds", "permissions"])) return false;
  const permissions = value.permissions;
  return (
    isFutureDateTime(value.absoluteExpiresAt) &&
    value.idleTimeoutSeconds === 900 &&
    Array.isArray(permissions) &&
    permissions.length <= ADMIN_PERMISSION_CODES.length &&
    new Set(permissions).size === permissions.length &&
    permissions.every((item) =>
      ADMIN_PERMISSION_CODES.includes(item as AdminPermission)
    )
  );
}

export function safeAdminSession(value: unknown): AdminSession | null {
  if (!isAdminSession(value)) return null;
  return {
    absoluteExpiresAt: value.absoluteExpiresAt,
    idleTimeoutSeconds: 900,
    permissions: [...value.permissions]
  };
}

export function safeAdminCredential(value: unknown): AdminCredentialRecord | null {
  if (!isExactObject(value, ["credentialHandle", "createdAt", "lastUsedAt"])) return null;
  if (
    !isOpaqueToken(value.credentialHandle) ||
    !isDateTime(value.createdAt) ||
    !(value.lastUsedAt === null || isDateTime(value.lastUsedAt))
  ) return null;
  return {
    credentialHandle: value.credentialHandle,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt
  };
}

export function safeAdminCredentialList(value: unknown): { items: AdminCredentialRecord[] } | null {
  if (!isExactObject(value, ["items"]) || !Array.isArray(value.items) || value.items.length > 20) return null;
  const items = value.items.map(safeAdminCredential);
  if (items.some((item) => item === null)) return null;
  return { items: items as AdminCredentialRecord[] };
}

export function safeAdminCredentialCreated(
  value: unknown
): { credential: AdminCredentialRecord } | null {
  if (!isExactObject(value, ["credential"])) return null;
  const credential = safeAdminCredential(value.credential);
  return credential === null ? null : { credential };
}

export function safeAdminAuditPage(value: unknown): AdminAuditPage | null {
  if (!isExactObject(value, ["items", "nextCursor"]) || !Array.isArray(value.items) || value.items.length > 100) return null;
  const items: AdminAuditEvent[] = [];
  for (const rawItem of value.items) {
    if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) return null;
    const item = rawItem as Record<string, unknown>;
    const isConfigEvent =
      item.targetType === "APP_CONFIG" &&
      (item.action === "ADMIN_CONFIG_PUBLISHED" || item.action === "ADMIN_CONFIG_ROLLED_BACK");
    const expectedKeys = isConfigEvent
      ? [
          "auditEventId", "action", "targetType", "occurredAt", "configKey",
          "newVersion", "sourceVersion", "changeReason"
        ]
      : ["auditEventId", "action", "targetType", "occurredAt"];
    if (!isExactObject(item, expectedKeys)) return null;
    if (
      typeof item.auditEventId !== "string" ||
      !UUID_PATTERN.test(item.auditEventId) ||
      typeof item.action !== "string" ||
      !ADMIN_AUDIT_ACTIONS.has(item.action) ||
      !["ADMIN_USER", "ADMIN_SESSION", "ADMIN_CREDENTIAL", "APP_CONFIG"].includes(String(item.targetType)) ||
      !isDateTime(item.occurredAt)
    ) return null;
    const baseItem = {
      auditEventId: item.auditEventId,
      action: item.action,
      targetType: item.targetType as AdminAuditEvent["targetType"],
      occurredAt: item.occurredAt
    };
    if (!isConfigEvent) {
      if (
        item.action === "ADMIN_CONFIG_PUBLISHED" ||
        item.action === "ADMIN_CONFIG_ROLLED_BACK" ||
        item.targetType === "APP_CONFIG"
      ) return null;
      items.push(baseItem);
      continue;
    }
    if (
      !isAdminConfigKey(item.configKey) ||
      !isPositiveVersion(item.newVersion) ||
      !(item.sourceVersion === null || isPositiveVersion(item.sourceVersion)) ||
      typeof item.changeReason !== "string" ||
      !["ROUTINE_TUNING", "INCIDENT_RESPONSE", "RELEASE_COMPATIBILITY", "ROLLBACK"].includes(item.changeReason) ||
      (item.action === "ADMIN_CONFIG_PUBLISHED" && item.changeReason === "ROLLBACK") ||
      (item.action === "ADMIN_CONFIG_ROLLED_BACK" && item.changeReason !== "ROLLBACK")
    ) return null;
    items.push({
      ...baseItem,
      configKey: item.configKey,
      newVersion: item.newVersion,
      sourceVersion: item.sourceVersion,
      changeReason: item.changeReason as AdminConfigChangeReason
    });
  }
  if (!(value.nextCursor === null || isOpaqueToken(value.nextCursor))) return null;
  return { items, nextCursor: value.nextCursor };
}
