import "server-only";

export type DataSource = "LIVE" | "DEMO";

export interface FeatureConfig {
  coverageName: string;
  dataRightsMode: "LIVE_DISPLAY_ONLY" | "LICENSED_ENRICHMENT";
  aiEnabled: boolean;
  accountsEnabled: boolean;
  favoritesEnabled: boolean;
  minimumSupportedVersion: string;
  ruleVersion: string;
  promptVersion: string;
  modelVersion: string;
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
  minimumSupportedVersion: "0.1.0",
  ruleVersion: "rules-2026.08-demo",
  promptVersion: "prompt-2026.08-demo",
  modelVersion: "qwen3.7-flash-2026-07-15"
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
  return typeof value === "object" && value !== null;
}

function isFeatureConfig(value: unknown): value is FeatureConfig {
  if (!isRecord(value)) return false;
  return (
    typeof value.coverageName === "string" &&
    (value.dataRightsMode === "LIVE_DISPLAY_ONLY" ||
      value.dataRightsMode === "LICENSED_ENRICHMENT") &&
    typeof value.aiEnabled === "boolean" &&
    typeof value.accountsEnabled === "boolean" &&
    typeof value.favoritesEnabled === "boolean" &&
    typeof value.minimumSupportedVersion === "string" &&
    typeof value.ruleVersion === "string" &&
    typeof value.promptVersion === "string" &&
    typeof value.modelVersion === "string"
  );
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
    if (!isFeatureConfig(value)) throw new Error("INVALID_RESPONSE");
    return {
      data: value,
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
