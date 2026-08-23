export const ADMIN_CONTRACT_HEADER = "X-ChiShenMe-Admin-Contract-Version";
export const ADMIN_CONTRACT_VERSION = "1";
export const ADMIN_DEVICE_HEADER = "X-Admin-Device-Id";

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
  targetType: "ADMIN_USER" | "ADMIN_SESSION" | "ADMIN_CREDENTIAL";
  occurredAt: string;
}

export interface AdminAuditPage {
  items: AdminAuditEvent[];
  nextCursor: string | null;
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
  "ADMIN_BOOTSTRAP_COMPLETED"
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
  for (const item of value.items) {
    if (!isExactObject(item, ["auditEventId", "action", "targetType", "occurredAt"])) return null;
    if (
      typeof item.auditEventId !== "string" ||
      !UUID_PATTERN.test(item.auditEventId) ||
      typeof item.action !== "string" ||
      !ADMIN_AUDIT_ACTIONS.has(item.action) ||
      !["ADMIN_USER", "ADMIN_SESSION", "ADMIN_CREDENTIAL"].includes(String(item.targetType)) ||
      !isDateTime(item.occurredAt)
    ) return null;
    items.push({
      auditEventId: item.auditEventId,
      action: item.action,
      targetType: item.targetType as AdminAuditEvent["targetType"],
      occurredAt: item.occurredAt
    });
  }
  if (!(value.nextCursor === null || isOpaqueToken(value.nextCursor))) return null;
  return { items, nextCursor: value.nextCursor };
}
