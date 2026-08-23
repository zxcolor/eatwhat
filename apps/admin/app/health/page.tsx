import type { Metadata } from "next";
import { PageHeader, SourceNotice, StatusBadge } from "../../components/admin-ui";
import { loadHealth } from "../../lib/admin-data";

export const metadata: Metadata = { title: "系统健康" };
export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const snapshot = await loadHealth();
  const health = snapshot.data;
  return (
    <>
      <PageHeader eyebrow="系统健康" title="先看可用性，再看推荐质量" description="基础健康状态来自 API；第三方依赖与数据库明细在监控接口开放前使用脱敏演示。" />
      <SourceNotice source={snapshot.source} endpoint={snapshot.endpoint}>{snapshot.notice}</SourceNotice>
      <section className="health-summary panel"><div><p className="eyebrow">总体状态</p><h2>{health.status === "HEALTHY" ? "服务运行正常" : "服务尚未完全就绪"}</h2><p>{health.environment} · {health.version}</p></div><StatusBadge status={health.status} /></section>
      <section className="service-grid" aria-label="服务状态">
        {health.services.map((service) => <article className="service-card" key={service.name}><div><span className={`health-dot dot-${service.status.toLowerCase()}`} aria-hidden="true" /><h2>{service.name}</h2></div><StatusBadge status={service.status} /><p>{service.note}</p></article>)}
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">健康边界</p><h2>当前检查不包含</h2></div></div><ul className="plain-list"><li>SLS 日志与 EMAS 崩溃数据</li><li>数据库连接池、备份新鲜度与恢复演练</li><li>高德、千问、短信和微信的真实配额</li><li>P50/P95 延迟与推荐成功率时序指标</li></ul></section>
    </>
  );
}
