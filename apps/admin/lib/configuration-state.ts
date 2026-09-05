import type { AdminConfigKey, AdminConfigRecord, MinimumClientVersionConfigValue } from "./admin-contract";

const CLIENT_PLATFORMS = ["android", "ios", "miniprogram"] as const;
const CLIENT_LABELS = { android: "Android", ios: "iOS", miniprogram: "小程序" } as const;

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Without independently verified release evidence, the console cannot raise a minimum. */
export function minimumVersionChangeProblem(
  current: MinimumClientVersionConfigValue | undefined,
  target: MinimumClientVersionConfigValue
): string | null {
  if (current === undefined) {
    return "尚无可核对的最低版本基线，也未接入已发布客户端证明；暂不允许首次设置。";
  }
  for (const platform of CLIENT_PLATFORMS) {
    const nextVersion = target[platform];
    if (nextVersion === undefined) continue;
    const previousVersion = current[platform];
    if (previousVersion === undefined || compareVersions(nextVersion, previousVersion) > 0) {
      return `${CLIENT_LABELS[platform]} 最低版本提高或新增会阻断旧客户端。尚无可验证的已发布版本证明，已阻止保存；现有配置不是发布证明。`;
    }
  }
  return null;
}

export function minimumVersionChangeConfirmation(
  current: MinimumClientVersionConfigValue,
  target: MinimumClientVersionConfigValue
): string {
  const changes = CLIENT_PLATFORMS.filter((platform) => current[platform] !== target[platform])
    .map((platform) => `${CLIENT_LABELS[platform]}：${current[platform] ?? "未声明"} → ${target[platform] ?? "移除最低版本声明"}`);
  return `确认保存客户端兼容策略？\n${changes.join("\n")}\n这会改变客户端收到的兼容要求；降低或移除门槛也不代表这些旧客户端已经完成兼容测试。保存后须核对运行采用情况。`;
}

export function replaceReloadedConfigurationRecord(
  current: AdminConfigRecord[],
  loaded: AdminConfigRecord[],
  configKey: AdminConfigKey
): AdminConfigRecord[] {
  const latest = loaded.find((record) => record.configKey === configKey);
  const otherRecords = current.filter((record) => record.configKey !== configKey);
  return latest === undefined ? otherRecords : [latest, ...otherRecords];
}

export function updateDirtyConfigKeys(
  current: ReadonlySet<AdminConfigKey>,
  configKey: AdminConfigKey,
  dirty: boolean
): ReadonlySet<AdminConfigKey> {
  if (current.has(configKey) === dirty) return current;
  const next = new Set(current);
  if (dirty) next.add(configKey);
  else next.delete(configKey);
  return next;
}
