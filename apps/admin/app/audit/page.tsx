"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../components/admin-ui";
import { useAdminSession } from "../../components/admin-shell";
import type { AdminAuditEvent } from "../../lib/admin-contract";
import { AdminClientError, loadAuditPage } from "../../lib/admin-client";

export default function AdminAuditPage() {
  const { hasPermission } = useAdminSession();
  const [items, setItems] = useState<AdminAuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const allowed = hasPermission("AUDIT_READ");

  const load = useCallback(async (next?: string) => {
    if (!allowed || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const page = await loadAuditPage(next);
      setItems((current) => next === undefined ? page.items : [...current, ...page.items]);
      setCursor(page.nextCursor);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof AdminClientError ? error.message : "无法读取审计记录");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [allowed]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader eyebrow="AUDIT" title="脱敏安全审计" description="普通事件只显示固定动作、目标类型和发生时间；配置变更额外显示固定键、新/源版本和枚举原因。不返回 value、自由文本、手机号、邮箱、IP、设备标识、经纬度、令牌或原始上下文 JSON。" />
      {!allowed && <aside className="read-only-note"><strong>没有审计读取权限</strong><p>请由安全管理员按最小权限分配 AUDIT_READ。</p></aside>}
      {allowed && <section className="panel table-panel">
        <div className="table-scroll"><table><thead><tr><th>时间</th><th>动作</th><th>目标类型</th><th>配置变更</th><th>审计记录</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.auditEventId}><td>{new Date(item.occurredAt).toLocaleString("zh-CN")}</td><td><code>{item.action}</code></td><td>{item.targetType}</td><td>{item.configKey === undefined ? "—" : <><code>{item.configKey}</code><br />v{item.newVersion} ← {item.sourceVersion === null ? "首次发布" : `v${item.sourceVersion}`} · {item.changeReason}</>}</td><td>{item.auditEventId.slice(0, 8)}…</td></tr>)}
        </tbody></table></div>
        {!busy && items.length === 0 && <p>暂无可显示的审计记录。</p>}
        {message !== null && <p className="form-message form-error" role="alert">{message}</p>}
        {cursor !== null && <button className="quiet-button" type="button" disabled={busy} onClick={() => void load(cursor)}>{busy ? "加载中…" : "加载更多"}</button>}
      </section>}
    </>
  );
}
