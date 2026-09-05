import { ADMIN_CONFIG_DEFINITIONS, type AdminConfigKey } from "./admin-contract";

export const AI_STATUS_LABELS = {
  ENABLED: "服务端允许 AI；仍须用户同意且请求为受支持的单人午餐",
  SERVER_DISABLED: "服务端 AI 总开关未开启，后台保存开关不能替代部署配置",
  OPERATOR_DISABLED: "本次响应实例采用的运营 AI 开关为关闭",
  PROMPT_DISABLED: "本次响应实例采用的提示词开关为关闭",
  CONFIG_UNAVAILABLE: "运行配置不可用，AI 已关闭；须先恢复配置读取"
} as const;

export interface ConfigurationRuntime {
  source: "STARTUP_DEFAULT" | "DATABASE" | "STALE_CACHE" | "SAFE_FALLBACK";
  lastSuccessfulReadAt: string | null;
  cacheTtlMs: 5000;
  versions: Record<AdminConfigKey, number | null>;
  aiStatus: keyof typeof AI_STATUS_LABELS;
}

const SOURCES = ["STARTUP_DEFAULT", "DATABASE", "STALE_CACHE", "SAFE_FALLBACK"] as const;
const CONFIG_KEYS = Object.keys(ADMIN_CONFIG_DEFINITIONS) as AdminConfigKey[];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseConfigurationRuntime(value: unknown): ConfigurationRuntime | null {
  if (!record(value) || !exactKeys(value, ["source", "lastSuccessfulReadAt", "cacheTtlMs", "versions", "aiStatus"])) return null;
  if (
    typeof value.source !== "string" || !SOURCES.includes(value.source as ConfigurationRuntime["source"]) ||
    typeof value.aiStatus !== "string" || !Object.hasOwn(AI_STATUS_LABELS, value.aiStatus) ||
    value.cacheTtlMs !== 5000 || !record(value.versions) || !exactKeys(value.versions, CONFIG_KEYS)
  ) return null;
  const checkedAt = value.lastSuccessfulReadAt;
  if (!(checkedAt === null || (
    typeof checkedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(checkedAt) &&
    Number.isFinite(Date.parse(checkedAt))
  ))) return null;
  const versions = {} as ConfigurationRuntime["versions"];
  for (const key of CONFIG_KEYS) {
    const version = value.versions[key];
    if (!(version === null || (typeof version === "number" && Number.isSafeInteger(version) && version > 0))) return null;
    versions[key] = version;
  }
  if ((value.source === "STALE_CACHE" || value.source === "SAFE_FALLBACK") && value.aiStatus !== "CONFIG_UNAVAILABLE") return null;
  return {
    source: value.source as ConfigurationRuntime["source"],
    lastSuccessfulReadAt: checkedAt,
    cacheTtlMs: 5000,
    versions,
    aiStatus: value.aiStatus as ConfigurationRuntime["aiStatus"]
  };
}

export function configurationAdoption(
  key: AdminConfigKey,
  savedVersion: number | undefined,
  runtime: ConfigurationRuntime | null
): { label: string; detail: string } {
  if (runtime === null) return { label: "运行采用情况未验证", detail: "公开配置不可达或未提供诊断，请刷新运行状态；已保存记录仍保留。" };
  if (runtime.source === "STALE_CACHE" || runtime.source === "SAFE_FALLBACK") {
    return { label: "运行配置不可用", detail: "配置读取失败，历史版本号不作为采用证明；推荐及 AI 已按服务端规则关闭。" };
  }
  const adoptedVersion = runtime.versions[key];
  if (savedVersion === undefined) return { label: "尚无已保存版本", detail: "本次响应不能与管理配置库版本进行对照。" };
  if (runtime.source === "DATABASE" && adoptedVersion === savedVersion) {
    return { label: `本次响应采用 v${savedVersion}`, detail: "只确认本次 API 响应的配置版本；不证明所有实例、客户端或第三方服务已经同步。" };
  }
  return {
    label: "尚未核实采用已保存版本",
    detail: `管理库已保存 v${savedVersion}；本次响应${adoptedVersion === null ? "仍使用启动默认值" : `报告 v${adoptedVersion}`}。请刷新运行状态后核对。`
  };
}
