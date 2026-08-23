"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/admin-ui";
import { useAdminSession } from "../../components/admin-shell";
import type { AdminCredentialRecord } from "../../lib/admin-contract";
import {
  AdminClientError,
  enrollPasskey,
  listCredentials,
  revokeCredential
} from "../../lib/admin-client";

function formatTime(value: string | null): string {
  if (value === null) return "尚未使用";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
    : "时间不可用";
}

export default function AdminSecurityPage() {
  const { session, hasPermission, endSession } = useAdminSession();
  const [items, setItems] = useState<AdminCredentialRecord[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const allowed = hasPermission("CREDENTIAL_SELF_MANAGE");

  const refresh = useCallback(async () => {
    if (!allowed) {
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      setItems(await listCredentials());
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof AdminClientError ? error.message : "无法读取 Passkey");
    } finally {
      setBusy(false);
    }
  }, [allowed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addCredential() {
    setBusy(true);
    try {
      await enrollPasskey();
      await refresh();
      setMessage("新 Passkey 已添加");
    } catch (error) {
      setMessage(error instanceof AdminClientError ? error.message : "无法添加 Passkey");
      setBusy(false);
    }
  }

  async function removeCredential(handle: string) {
    if (items.length <= 1 || !window.confirm("确认撤销这枚 Passkey？撤销后不能恢复。")) return;
    setBusy(true);
    try {
      await revokeCredential(handle);
      await refresh();
      setMessage("Passkey 已撤销");
    } catch (error) {
      setMessage(error instanceof AdminClientError ? error.message : "无法撤销 Passkey");
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="SECURITY" title="Passkey 与管理员会话" description="管理自己的无密码凭据并查看当前会话边界。服务端仍会逐次校验设备、IP 绑定、角色权限和空闲超时。" />
      <section className="panel table-panel">
        <div className="panel-heading">
          <div><h2>已登记 Passkey</h2><p className="page-description">句柄只用于当前管理员自助撤销，不显示 credential ID 或公钥。</p></div>
          <button className="primary-button compact" type="button" disabled={busy || !allowed} onClick={() => void addCredential()}>添加 Passkey</button>
        </div>
        {!allowed && <p className="form-message form-error">当前角色没有凭据自助管理权限。</p>}
        {busy && <p aria-live="polite">正在读取…</p>}
        {!busy && allowed && items.length === 0 && <p>没有可用 Passkey；请联系安全管理员。</p>}
        {items.length > 0 && (
          <div className="table-scroll"><table><thead><tr><th>凭据</th><th>创建时间</th><th>最近使用</th><th>操作</th></tr></thead><tbody>
            {items.map((item, index) => <tr key={item.credentialHandle}><td>Passkey {index + 1}</td><td>{formatTime(item.createdAt)}</td><td>{formatTime(item.lastUsedAt)}</td><td><button className="danger-button" type="button" disabled={busy || items.length <= 1} onClick={() => void removeCredential(item.credentialHandle)}>撤销</button></td></tr>)}
          </tbody></table></div>
        )}
        {message !== null && <p className="form-message" role="status">{message}</p>}
      </section>
      <section className="panel">
        <h2>当前会话</h2>
        <dl className="definition-list roomy">
          <div><dt>绝对到期</dt><dd>{formatTime(session.absoluteExpiresAt)}</dd></div>
          <div><dt>空闲超时</dt><dd>{session.idleTimeoutSeconds / 60} 分钟</dd></div>
          <div><dt>权限数量</dt><dd>{session.permissions.length}</dd></div>
        </dl>
        <button className="quiet-button" type="button" onClick={() => void endSession()}>立即退出全部当前页面</button>
      </section>
    </>
  );
}
