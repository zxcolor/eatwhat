import type { AdminConfigKey, AdminConfigRecord } from "./admin-contract";

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
