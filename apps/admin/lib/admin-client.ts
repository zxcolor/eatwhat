"use client";

import type {
  AdminAuditPage,
  AdminConfigKey,
  AdminConfigRecord,
  AdminConfigRollbackRequest,
  AdminConfigUpdateRequest,
  AdminCredentialRecord,
  AdminConfigurationPage,
  AdminSession
} from "./admin-contract";

interface PublicKeyDescriptorJSON {
  id: string;
  type: "public-key";
  transports?: AuthenticatorTransport[];
}

interface LoginOptionsResponse {
  ceremonyId: string;
  publicKey: {
    challenge: string;
    timeout: number;
    rpId: string;
    allowCredentials: PublicKeyDescriptorJSON[];
    userVerification: "required";
  };
}

interface EnrollOptionsResponse {
  ceremonyId: string;
  publicKey: {
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    challenge: string;
    pubKeyCredParams: PublicKeyCredentialParameters[];
    timeout: number;
    excludeCredentials: PublicKeyDescriptorJSON[];
    authenticatorSelection: {
      residentKey: "required";
      userVerification: "required";
    };
    attestation: "none";
  };
}

export class AdminClientError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AdminClientError";
  }
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function bufferToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function descriptor(value: PublicKeyDescriptorJSON): PublicKeyCredentialDescriptor {
  return {
    id: base64UrlToBuffer(value.id),
    type: value.type,
    ...(value.transports === undefined ? {} : { transports: value.transports })
  };
}

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json; charset=utf-8");
  if (init.method !== undefined && init.method !== "GET") {
    headers.set("X-ChiShenMe-Admin-Ui", "1");
  }
  const response = await fetch(`/api/admin/${path}`, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers
  });
  if (!response.ok) {
    let message = "管理员服务暂不可用";
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message.length <= 100) message = body.message;
    } catch {
      // The BFF deliberately hides malformed upstream responses.
    }
    throw new AdminClientError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function assertWebAuthnReady(): void {
  if (!window.isSecureContext || !("PublicKeyCredential" in window)) {
    throw new AdminClientError(400, "当前浏览器环境不支持安全的 Passkey，请使用 HTTPS 或本机 localhost");
  }
}

function authenticationResponse(credential: PublicKeyCredential) {
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new AdminClientError(400, "Passkey 返回类型无效");
  }
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle === null ? null : bufferToBase64Url(response.userHandle)
    },
    type: "public-key" as const,
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(credential.authenticatorAttachment === null
      ? {}
      : { authenticatorAttachment: credential.authenticatorAttachment })
  };
}

function registrationResponse(credential: PublicKeyCredential) {
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    throw new AdminClientError(400, "Passkey 返回类型无效");
  }
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports: response.getTransports()
    },
    type: "public-key" as const,
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(credential.authenticatorAttachment === null
      ? {}
      : { authenticatorAttachment: credential.authenticatorAttachment })
  };
}

export async function loginWithPasskey(login: string): Promise<AdminSession> {
  assertWebAuthnReady();
  const options = await request<LoginOptionsResponse>("login/options", {
    method: "POST",
    body: JSON.stringify({ login })
  });
  let selected: Credential | null;
  try {
    selected = await navigator.credentials.get({
      publicKey: {
        ...options.publicKey,
        challenge: base64UrlToBuffer(options.publicKey.challenge),
        allowCredentials: options.publicKey.allowCredentials.map(descriptor)
      }
    });
  } catch {
    throw new AdminClientError(400, "Passkey 验证已取消或失败");
  }
  if (!(selected instanceof PublicKeyCredential)) {
    throw new AdminClientError(400, "未取得有效 Passkey 凭据");
  }
  return request<AdminSession>("login/verify", {
    method: "POST",
    body: JSON.stringify({
      ceremonyId: options.ceremonyId,
      response: authenticationResponse(selected)
    })
  });
}

export function loadSession(): Promise<AdminSession> {
  return request<AdminSession>("session");
}

export function logout(): Promise<void> {
  return request<void>("logout", { method: "POST", body: "{}" });
}

export async function enrollPasskey(): Promise<AdminCredentialRecord> {
  assertWebAuthnReady();
  const options = await request<EnrollOptionsResponse>("credentials/enroll/options", {
    method: "POST",
    body: "{}"
  });
  let created: Credential | null;
  try {
    created = await navigator.credentials.create({
      publicKey: {
        ...options.publicKey,
        challenge: base64UrlToBuffer(options.publicKey.challenge),
        user: {
          ...options.publicKey.user,
          id: base64UrlToBuffer(options.publicKey.user.id)
        },
        excludeCredentials: options.publicKey.excludeCredentials.map(descriptor)
      }
    });
  } catch {
    throw new AdminClientError(400, "Passkey 添加已取消或失败");
  }
  if (!(created instanceof PublicKeyCredential)) {
    throw new AdminClientError(400, "未取得有效 Passkey 凭据");
  }
  const result = await request<{ credential: AdminCredentialRecord }>(
    "credentials/enroll/verify",
    {
      method: "POST",
      body: JSON.stringify({
        ceremonyId: options.ceremonyId,
        response: registrationResponse(created)
      })
    }
  );
  return result.credential;
}

export async function listCredentials(): Promise<AdminCredentialRecord[]> {
  const response = await request<{ items: AdminCredentialRecord[] }>("credentials");
  return response.items;
}

export function revokeCredential(handle: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) {
    throw new AdminClientError(400, "凭据句柄无效");
  }
  return request<void>(`credentials/${encodeURIComponent(handle)}`, { method: "DELETE" });
}

export function loadAuditPage(cursor?: string): Promise<AdminAuditPage> {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor !== undefined) query.set("cursor", cursor);
  return request<AdminAuditPage>(`audit?${query.toString()}`);
}

export function loadAdminConfiguration(): Promise<AdminConfigurationPage> {
  return request<AdminConfigurationPage>("configuration");
}

export function loadAdminConfigurationHistory(
  configKey: AdminConfigKey,
  limit = 20
): Promise<AdminConfigurationPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new AdminClientError(400, "历史版本数量必须在 1–20 之间");
  }
  const query = new URLSearchParams({ limit: String(limit) });
  return request<AdminConfigurationPage>(
    `configuration/${encodeURIComponent(configKey)}/history?${query.toString()}`
  );
}

export function updateAdminConfiguration<K extends AdminConfigKey>(
  configKey: K,
  update: AdminConfigUpdateRequest<K>
): Promise<AdminConfigRecord> {
  return request<AdminConfigRecord>(`configuration/${encodeURIComponent(configKey)}`, {
    method: "PUT",
    body: JSON.stringify(update)
  });
}

export function rollbackAdminConfiguration(
  configKey: AdminConfigKey,
  rollback: AdminConfigRollbackRequest
): Promise<AdminConfigRecord> {
  return request<AdminConfigRecord>(
    `configuration/${encodeURIComponent(configKey)}/rollback`,
    {
      method: "POST",
      body: JSON.stringify(rollback)
    }
  );
}
