import type { Metadata } from "next";
import { PageHeader, SourceNotice, StatusBadge } from "../../components/admin-ui";
import { loadConfig } from "../../lib/admin-data";

export const metadata: Metadata = { title: "推荐配置" };
export const dynamic = "force-dynamic";

export default async function ConfigurationPage() {
  const snapshot = await loadConfig();
  const config = snapshot.data;
  return (
    <>
      <PageHeader eyebrow="推荐配置" title="规则可解释，变更可追溯" description="展示当前覆盖范围、功能开关和算法版本。MVP 不提供任何写操作。" />
      <SourceNotice source={snapshot.source} endpoint={snapshot.endpoint}>{snapshot.notice}</SourceNotice>
      <section className="config-hero panel">
        <div><p className="eyebrow">数据权益模式</p><h2>{config.dataRightsMode === "LIVE_DISPLAY_ONLY" ? "仅实时展示" : "授权增强"}</h2><p>{config.dataRightsMode === "LIVE_DISPLAY_ONLY" ? "不缓存第三方 POI，不向模型发送 POI 内容，不展示自有适合度。" : "仅可在书面授权明确的范围内启用重排、引用留存和跨设备能力。"}</p></div>
        <StatusBadge status={config.dataRightsMode === "LIVE_DISPLAY_ONLY" ? "SAFE" : "ON"} />
      </section>
      <section className="two-column">
        <article className="panel"><p className="eyebrow">功能开关</p><h2>产品能力</h2><dl className="definition-list roomy"><div><dt>AI 辅助</dt><dd><StatusBadge status={config.aiEnabled ? "ON" : "OFF"} /></dd></div><div><dt>账号体系</dt><dd><StatusBadge status={config.accountsEnabled ? "ON" : "OFF"} /></dd></div><div><dt>收藏同步</dt><dd><StatusBadge status={config.favoritesEnabled ? "ON" : "OFF"} /></dd></div><div><dt>覆盖区域</dt><dd>{config.coverageName}</dd></div></dl></article>
        <article className="panel"><p className="eyebrow">版本锚点</p><h2>问题可复现</h2><dl className="definition-list roomy"><div><dt>规则</dt><dd><code>{config.ruleVersion}</code></dd></div><div><dt>提示词</dt><dd><code>{config.promptVersion}</code></dd></div><div><dt>模型</dt><dd><code>{config.modelVersion}</code></dd></div><div><dt>最低 App</dt><dd><code>{config.minimumSupportedVersion}</code></dd></div></dl></article>
      </section>
      <aside className="read-only-note"><strong>写操作尚未开放</strong><p>权重、模型、覆盖范围和最低版本只能通过经过审计的服务端变更流程调整；本页面不会发送修改请求。</p></aside>
    </>
  );
}
