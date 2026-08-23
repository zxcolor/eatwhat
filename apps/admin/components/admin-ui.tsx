import type { ReactNode } from "react";
import type { DataSource, HealthSummary } from "../lib/admin-data";

export function SourceNotice({ source, endpoint, children }: { source: DataSource; endpoint: string; children: ReactNode }) {
  return (
    <aside className={`source-notice ${source === "LIVE" ? "source-live" : "source-demo"}`} aria-live="polite">
      <span className="source-label">{source === "LIVE" ? "实时只读" : "演示状态"}</span>
      <p>{children}</p>
      <code>{endpoint}</code>
    </aside>
  );
}

export function StatusBadge({ status }: { status: HealthSummary["status"] | "ON" | "OFF" | "SAFE" }) {
  const labels = { HEALTHY: "健康", DEGRADED: "需关注", UNAVAILABLE: "未接入", ON: "已启用", OFF: "未启用", SAFE: "安全模式" };
  return <span className={`status status-${status.toLowerCase()}`}>{labels[status]}</span>;
}

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="page-header">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="page-description">{description}</p>
    </header>
  );
}

export function MetricCard({ label, value, helper, tone = "neutral" }: { label: string; value: string; helper: string; tone?: "neutral" | "good" | "warning" }) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{helper}</small>
    </article>
  );
}
