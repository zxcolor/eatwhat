import "server-only";

import { parseConfigurationRuntime, type ConfigurationRuntime } from "./configuration-runtime";

export type DataSource = "LIVE" | "DEMO";

export interface PersistenceCapabilities {
  favoritesEnabled: boolean;
  historyEnabled: boolean;
  privateFeedbackEnabled: boolean;
  savedResourceIdsEnabled: boolean;
}

export interface AuthCapabilities {
  accountsEnabled: boolean;
  registrationEnabled: boolean;
  phoneEnabled: boolean;
  wechatEnabled: boolean;
  emailEnabled: boolean;
  qqEnabled: boolean;
  dataExportEnabled: boolean;
}

export interface ServiceCapabilities {
  recommendationsEnabled: boolean;
  groupRecommendationsEnabled: boolean;
  locationSearchEnabled: boolean;
  placeSearchEnabled: boolean;
}

export interface SpecialtyCapabilities {
  breakfastProfileEnabled: boolean;
  dinnerProfileEnabled: boolean;
  milkTeaEnabled: boolean;
  coffeeEnabled: boolean;
  dessertEnabled: boolean;
  userReportedWeatherEnabled: boolean;
}

const DISABLED_SPECIALTY_CAPABILITIES: SpecialtyCapabilities = {
  breakfastProfileEnabled: false,
  dinnerProfileEnabled: false,
  milkTeaEnabled: false,
  coffeeEnabled: false,
  dessertEnabled: false,
  userReportedWeatherEnabled: false
};

export interface RecommendationDefaults {
  areaCode: "NATIONWIDE";
  defaultRadiusMeters: number;
  maximumRadiusMeters: number;
}

export interface MinimumSupportedVersions {
  android: string;
  ios?: string;
  miniprogram?: string;
}

export interface FeatureConfig {
  coverageName: string;
  dataRightsMode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT";
  aiEnabled: boolean;
  accountsEnabled: boolean;
  favoritesEnabled: boolean;
  supportFeedbackEnabled: boolean;
  minimumSupportedVersion: string;
  ruleVersion: string;
  rulesConfigVersion?: number | null;
  promptVersion: string;
  modelVersion: string;
  recommendationDefaults?: RecommendationDefaults;
  minimumSupportedVersions?: MinimumSupportedVersions;
  persistenceCapabilities: PersistenceCapabilities;
  authCapabilities: AuthCapabilities;
  serviceCapabilities: ServiceCapabilities;
  specialtyCapabilities: SpecialtyCapabilities;
  operationalConfig?: ConfigurationRuntime;
}

export interface HealthSummary {
  status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  version: string;
  environment: string;
  checkedAt: string;
  services: Array<{ name: string; status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"; note: string }>;
}

export interface Snapshot<T> {
  data: T;
  source: DataSource;
  endpoint: string;
  notice: string;
}

const demoConfig: FeatureConfig = {
  coverageName: "全国范围",
  dataRightsMode: "LIVE_DISPLAY_ONLY",
  aiEnabled: false,
  accountsEnabled: false,
  favoritesEnabled: false,
  supportFeedbackEnabled: false,
  minimumSupportedVersion: "0.1.0",
  ruleVersion: "rules-2026.08-demo",
  promptVersion: "prompt-2026.08-demo",
  modelVersion: "qwen3.7-flash-2026-07-15",
  recommendationDefaults: {
    areaCode: "NATIONWIDE",
    defaultRadiusMeters: 1_500,
    maximumRadiusMeters: 10_000
  },
  minimumSupportedVersions: {
    android: "0.1.0"
  },
  persistenceCapabilities: {
    favoritesEnabled: false,
    historyEnabled: false,
    privateFeedbackEnabled: false,
    savedResourceIdsEnabled: false
  },
  authCapabilities: {
    accountsEnabled: false,
    registrationEnabled: false,
    phoneEnabled: false,
    wechatEnabled: false,
    emailEnabled: false,
    qqEnabled: false,
    dataExportEnabled: false
  },
  serviceCapabilities: {
    recommendationsEnabled: false,
    groupRecommendationsEnabled: false,
    locationSearchEnabled: false,
    placeSearchEnabled: false
  },
  specialtyCapabilities: DISABLED_SPECIALTY_CAPABILITIES
};

const demoHealth: HealthSummary = {
  status: "DEGRADED",
  version: "0.1.0-demo",
  environment: "演示环境",
  checkedAt: "未连接实时健康接口",
  services: [
    { name: "API 服务", status: "HEALTHY", note: "静态演示；不代表生产状态" },
    { name: "PostgreSQL", status: "HEALTHY", note: "静态演示；未读取数据库指标" },
    { name: "高德适配器", status: "UNAVAILABLE", note: "等待正式授权与服务端密钥" },
    { name: "千问意图引擎", status: "UNAVAILABLE", note: "等待北京地域资质与密钥" }
  ]
};

function apiBaseUrl(): string {
  // Consumed only by server components, so the container's internal service
  // address never needs to be exposed in a browser bundle.
  return (
    process.env.PUBLIC_API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function exactBooleanRecord<T extends object>(
  value: unknown,
  keys: readonly (keyof T)[]
): T | null {
  if (!isRecord(value) || !hasOnlyKeys(value, keys as readonly string[])) return null;
  if (Object.keys(value).length !== keys.length || !keys.every((key) => typeof value[key as string] === "boolean")) {
    return null;
  }
  return Object.fromEntries(keys.map((key) => [key, value[key as string]])) as T;
}

function compatibleBooleanRecord<T extends object>(
  value: unknown,
  requiredKeys: readonly (keyof T)[],
  defaultFalseKeys: readonly (keyof T)[]
): T | null {
  const keys = [...requiredKeys, ...defaultFalseKeys];
  if (!isRecord(value) || !hasOnlyKeys(value, keys as readonly string[])) return null;
  if (
    !requiredKeys.every(
      (key) => Object.hasOwn(value, key as string) && typeof value[key as string] === "boolean"
    ) ||
    !defaultFalseKeys.every(
      (key) => !Object.hasOwn(value, key as string) || typeof value[key as string] === "boolean"
    )
  ) return null;
  return Object.fromEntries([
    ...requiredKeys.map((key) => [key, value[key as string]]),
    ...defaultFalseKeys.map((key) => [key, value[key as string] ?? false])
  ]) as T;
}

function isStrictSemver(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/.test(value)
  );
}

function parseRecommendationDefaults(value: unknown): RecommendationDefaults | null {
  const keys = ["areaCode", "defaultRadiusMeters", "maximumRadiusMeters"] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || Object.keys(value).length !== keys.length) return null;
  if (
    value.areaCode !== "NATIONWIDE" ||
    typeof value.defaultRadiusMeters !== "number" || !Number.isSafeInteger(value.defaultRadiusMeters) ||
    value.defaultRadiusMeters < 200 || value.defaultRadiusMeters > 10_000 ||
    typeof value.maximumRadiusMeters !== "number" || !Number.isSafeInteger(value.maximumRadiusMeters) ||
    value.maximumRadiusMeters < 200 || value.maximumRadiusMeters > 10_000 ||
    value.defaultRadiusMeters > value.maximumRadiusMeters
  ) return null;
  return {
    areaCode: value.areaCode,
    defaultRadiusMeters: value.defaultRadiusMeters,
    maximumRadiusMeters: value.maximumRadiusMeters
  };
}

function parseMinimumSupportedVersions(value: unknown): MinimumSupportedVersions | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["android", "ios", "miniprogram"])) return null;
  if (
    !isStrictSemver(value.android) ||
    !(value.ios === undefined || isStrictSemver(value.ios)) ||
    !(value.miniprogram === undefined || isStrictSemver(value.miniprogram))
  ) return null;
  return {
    android: value.android,
    ...(value.ios === undefined ? {} : { ios: value.ios }),
    ...(value.miniprogram === undefined ? {} : { miniprogram: value.miniprogram })
  };
}

export function parseFeatureConfig(value: unknown): FeatureConfig | null {
  const topLevelKeys = [
    "coverageName",
    "dataRightsMode",
    "aiEnabled",
    "accountsEnabled",
    "favoritesEnabled",
    "supportFeedbackEnabled",
    "minimumSupportedVersion",
    "ruleVersion",
    "rulesConfigVersion",
    "promptVersion",
    "modelVersion",
    "recommendationDefaults",
    "minimumSupportedVersions",
    "persistenceCapabilities",
    "authCapabilities",
    "serviceCapabilities",
    "specialtyCapabilities",
    "operationalConfig"
  ] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, topLevelKeys)) return null;
  if (
    typeof value.coverageName !== "string" || value.coverageName.length === 0 || value.coverageName.length > 80 ||
    (value.dataRightsMode !== "LIVE_DISPLAY_ONLY" && value.dataRightsMode !== "LICENSED_ENRICHMENT") ||
    typeof value.aiEnabled !== "boolean" ||
    typeof value.accountsEnabled !== "boolean" ||
    typeof value.favoritesEnabled !== "boolean" ||
    !(value.supportFeedbackEnabled === undefined || typeof value.supportFeedbackEnabled === "boolean") ||
    !isStrictSemver(value.minimumSupportedVersion) ||
    typeof value.ruleVersion !== "string" || value.ruleVersion.length > 120 ||
    !(value.rulesConfigVersion === undefined || value.rulesConfigVersion === null ||
      (typeof value.rulesConfigVersion === "number" && Number.isSafeInteger(value.rulesConfigVersion) && value.rulesConfigVersion > 0)) ||
    typeof value.promptVersion !== "string" || value.promptVersion.length > 120 ||
    typeof value.modelVersion !== "string" || value.modelVersion.length > 120
  ) return null;

  const persistenceCapabilities = value.persistenceCapabilities === undefined
    ? {
        favoritesEnabled: false,
        historyEnabled: false,
        privateFeedbackEnabled: false,
        savedResourceIdsEnabled: false
      }
    : exactBooleanRecord<PersistenceCapabilities>(value.persistenceCapabilities, [
        "favoritesEnabled",
        "historyEnabled",
        "privateFeedbackEnabled",
        "savedResourceIdsEnabled"
      ]);
  const authCapabilities = value.authCapabilities === undefined
    ? {
        accountsEnabled: false,
        registrationEnabled: false,
        phoneEnabled: false,
        wechatEnabled: false,
        emailEnabled: false,
        qqEnabled: false,
        dataExportEnabled: false
      }
    : compatibleBooleanRecord<AuthCapabilities>(value.authCapabilities, [
        "accountsEnabled",
        "registrationEnabled",
        "phoneEnabled",
        "wechatEnabled",
        "emailEnabled",
        "qqEnabled"
      ], [
        "dataExportEnabled"
      ]);
  const serviceCapabilities = value.serviceCapabilities === undefined
    ? {
        recommendationsEnabled: false,
        groupRecommendationsEnabled: false,
        locationSearchEnabled: false,
        placeSearchEnabled: false
      }
    : compatibleBooleanRecord<ServiceCapabilities>(value.serviceCapabilities, [], [
        "recommendationsEnabled",
        "groupRecommendationsEnabled",
        "locationSearchEnabled",
        "placeSearchEnabled"
      ]);
  const specialtyCapabilities = value.specialtyCapabilities === undefined
    ? { ...DISABLED_SPECIALTY_CAPABILITIES }
    : exactBooleanRecord<SpecialtyCapabilities>(value.specialtyCapabilities, [
        "breakfastProfileEnabled", "dinnerProfileEnabled", "milkTeaEnabled",
        "coffeeEnabled", "dessertEnabled", "userReportedWeatherEnabled"
      ]);
  const recommendationDefaults = value.recommendationDefaults === undefined
    ? undefined
    : parseRecommendationDefaults(value.recommendationDefaults);
  const minimumSupportedVersions = value.minimumSupportedVersions === undefined
    ? undefined
    : parseMinimumSupportedVersions(value.minimumSupportedVersions);
  const operationalConfig = value.operationalConfig === undefined
    ? undefined
    : parseConfigurationRuntime(value.operationalConfig);
  if (
    persistenceCapabilities === null ||
    authCapabilities === null ||
    serviceCapabilities === null ||
    specialtyCapabilities === null ||
    recommendationDefaults === null ||
    minimumSupportedVersions === null
    || operationalConfig === null
  ) return null;
  if (operationalConfig !== undefined && (operationalConfig.aiStatus === "ENABLED") !== value.aiEnabled) return null;
  if (operationalConfig !== undefined && value.rulesConfigVersion !== undefined &&
    value.rulesConfigVersion !== operationalConfig.versions["recommendations.rules"]) return null;
  if (value.persistenceCapabilities !== undefined && persistenceCapabilities.favoritesEnabled !== value.favoritesEnabled) return null;
  if (minimumSupportedVersions !== undefined && minimumSupportedVersions.android !== value.minimumSupportedVersion) return null;
  if (
    value.dataRightsMode === "LIVE_DISPLAY_ONLY" &&
    (value.favoritesEnabled || Object.values(persistenceCapabilities).some(Boolean))
  ) return null;

  return {
    coverageName: value.coverageName,
    dataRightsMode: value.dataRightsMode,
    aiEnabled: value.aiEnabled,
    accountsEnabled: value.accountsEnabled,
    favoritesEnabled: value.favoritesEnabled,
    supportFeedbackEnabled: value.supportFeedbackEnabled ?? false,
    minimumSupportedVersion: value.minimumSupportedVersion,
    ruleVersion: value.ruleVersion,
    ...(value.rulesConfigVersion === undefined ? {} : { rulesConfigVersion: value.rulesConfigVersion }),
    promptVersion: value.promptVersion,
    modelVersion: value.modelVersion,
    ...(recommendationDefaults === undefined ? {} : { recommendationDefaults }),
    ...(minimumSupportedVersions === undefined ? {} : { minimumSupportedVersions }),
    ...(operationalConfig === undefined ? {} : { operationalConfig }),
    persistenceCapabilities,
    authCapabilities,
    serviceCapabilities,
    specialtyCapabilities
  };
}

async function request(path: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(2_500),
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function loadConfig(): Promise<Snapshot<FeatureConfig>> {
  const endpoint = "/v1/config";
  try {
    const raw = await request(endpoint);
    const value = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
    const parsed = parseFeatureConfig(value);
    if (parsed === null) throw new Error("INVALID_RESPONSE");
    return {
      data: parsed,
      source: "LIVE",
      endpoint,
      notice: "已连接 API，只读展示当前运行配置。"
    };
  } catch {
    return {
      data: demoConfig,
      source: "DEMO",
      endpoint,
      notice: "API 暂不可用，当前为清晰标注的演示配置，不代表生产环境。"
    };
  }
}

function normalizeServiceStatus(value: unknown): HealthSummary["status"] {
  const text = String(value ?? "").toLowerCase();
  if (["ok", "healthy", "up", "pass"].includes(text)) return "HEALTHY";
  if (["degraded", "warning", "warn"].includes(text)) return "DEGRADED";
  return "UNAVAILABLE";
}

export async function loadHealth(): Promise<Snapshot<HealthSummary>> {
  const endpoint = "/health";
  try {
    const raw = await request(endpoint);
    const value = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
    if (!isRecord(value)) throw new Error("INVALID_RESPONSE");
    const status = normalizeServiceStatus(value.status);
    return {
      data: {
        status,
        version: typeof value.version === "string" ? value.version : "API 未提供",
        environment: typeof value.environment === "string" ? value.environment : "API 运行环境",
        checkedAt: new Intl.DateTimeFormat("zh-CN", {
          dateStyle: "medium",
          timeStyle: "medium",
          timeZone: "Asia/Shanghai"
        }).format(new Date()),
        services: [{ name: "API 基础健康检查", status, note: "来自 /health，只反映接口公开的基础状态" }]
      },
      source: "LIVE",
      endpoint,
      notice: "已连接 API 健康检查；尚未接入 SLS、数据库和第三方服务监控。"
    };
  } catch {
    return { data: demoHealth, source: "DEMO", endpoint, notice: "健康接口不可达，以下为脱敏演示状态。" };
  }
}

export const demoDiagnostics = [
  { requestId: "rec_••••7A2F", occurredAt: "10:42:18", meal: "午餐", mode: "规则回退", latency: "1.84 s", result: "返回 3 个候选", coordinates: "未记录" },
  { requestId: "rec_••••91C4", occurredAt: "10:39:06", meal: "早餐", mode: "AI 辅助", latency: "2.31 s", result: "返回 3 个候选", coordinates: "未记录" },
  { requestId: "rec_••••B018", occurredAt: "10:33:47", meal: "晚餐", mode: "规则回退", latency: "0.96 s", result: "无可靠候选", coordinates: "未记录" }
] as const;
