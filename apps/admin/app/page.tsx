import Link from "next/link";
import { MetricCard, PageHeader, SourceNotice, StatusBadge } from "../components/admin-ui";
import { loadConfig, loadHealth } from "../lib/admin-data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [config, health] = await Promise.all([loadConfig(), loadHealth()]);
  return (
    <>
      <PageHeader eyebrow="运营总览" title="今天的系统，一眼看清" description="聚焦推荐可用性、数据权益与发布风险。运营指标保持只读，Passkey 自助安全操作独立审计；演示值会被显著标记。" />
      <SourceNotice source={config.source === "LIVE" && health.source === "LIVE" ? "LIVE" : "DEMO"} endpoint="/v1/config · /health">
        {config.source === "LIVE" && health.source === "LIVE" ? "配置与健康接口均已连接。" : "至少一个接口不可达，页面使用安全演示数据补全展示。"}
      </SourceNotice>
      <section className="metric-grid" aria-label="核心状态指标">
        <MetricCard label="系统健康" value={health.data.status === "HEALTHY" ? "正常" : "需关注"} helper={health.data.checkedAt} tone={health.data.status === "HEALTHY" ? "good" : "warning"} />
        <MetricCard label="数据权益" value={config.data.dataRightsMode === "LIVE_DISPLAY_ONLY" ? "仅实时展示" : "授权增强"} helper="未获书面许可不得缓存或重排" tone="good" />
        <MetricCard label="AI 辅助" value={config.data.aiEnabled ? "已启用" : "未启用"} helper={`模型 ${config.data.modelVersion}`} />
        <MetricCard label="最低客户端版本" value={config.data.minimumSupportedVersion} helper={config.data.coverageName} />
      </section>
      <section className="dashboard-grid">
        <article className="panel priority-panel">
          <div className="panel-heading"><div><p className="eyebrow">发布优先级</p><h2>当前阻断项</h2></div><span className="count">4</span></div>
          <ol className="action-list">
            <li><span>01</span><div><strong>第三方数据授权</strong><p>高德 POI 重排、引用保存与模型处理需要书面边界。</p></div></li>
            <li><span>02</span><div><strong>外部服务资质</strong><p>千问、微信、短信与监控密钥尚未配置到生产环境。</p></div></li>
            <li><span>03</span><div><strong>管理员安全</strong><p>Passkey、15 分钟空闲会话、独立 RBAC 与脱敏审计已接入；生产仍必须使用 HTTPS 和独立管理员数据库角色。</p></div></li>
            <li><span>04</span><div><strong>备案与发布检查</strong><p>App 备案、隐私检测与恢复演练尚未完成。</p></div></li>
          </ol>
        </article>
        <article className="panel">
          <div className="panel-heading"><div><p className="eyebrow">运行配置</p><h2>推荐能力</h2></div><StatusBadge status={config.data.dataRightsMode === "LIVE_DISPLAY_ONLY" ? "SAFE" : "ON"} /></div>
          <dl className="definition-list">
            <div><dt>规则版本</dt><dd>{config.data.ruleVersion}</dd></div>
            <div><dt>提示词版本</dt><dd>{config.data.promptVersion}</dd></div>
            <div><dt>账号能力</dt><dd>{config.data.accountsEnabled ? "已启用" : "未启用"}</dd></div>
            <div><dt>收藏能力</dt><dd>{config.data.favoritesEnabled ? "已启用" : "未启用"}</dd></div>
          </dl>
          <Link className="text-link" href="/configuration">查看完整配置 <span aria-hidden="true">→</span></Link>
        </article>
      </section>
      <section className="panel sample-metrics">
        <div className="panel-heading"><div><p className="eyebrow">目标对照</p><h2>内测质量指标</h2></div><span className="demo-chip">目标值，不是实时指标</span></div>
        <div className="target-grid"><div><strong>≥ 99.5%</strong><span>无崩溃会话</span></div><div><strong>&lt; 6 s</strong><span>推荐 P95</span></div><div><strong>&lt; 2%</strong><span>范围/停业违约</span></div><div><strong>≤ ¥500</strong><span>内测月成本</span></div></div>
      </section>
    </>
  );
}
