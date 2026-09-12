import type { Metadata } from "next";
import { PageHeader, SourceNotice } from "../../components/admin-ui";
import { loadConfig } from "../../lib/admin-data";
import { AI_STATUS_LABELS } from "../../lib/configuration-runtime";

export const metadata: Metadata = { title: "接口中心" };
export const dynamic = "force-dynamic";

interface IntegrationCardProps {
  title: string;
  category: string;
  enabled: boolean;
  summary: string;
  capabilities: string[];
  boundary: string;
}

function IntegrationCard({
  title,
  category,
  enabled,
  summary,
  capabilities,
  boundary
}: IntegrationCardProps) {
  return (
    <details className="integration-card">
      <summary>
        <span className="integration-mark" aria-hidden="true">{category.slice(0, 1)}</span>
        <span className="integration-title">
          <span className="integration-kicker">{category}</span>
          <strong>{title}</strong>
          <small>{summary}</small>
        </span>
        <span className={`status ${enabled ? "status-on" : "status-off"}`}>
          {enabled ? "已启用" : "未启用"}
        </span>
      </summary>
      <div className="integration-details">
        <div>
          <p className="integration-detail-title">公开能力</p>
          <ul className="plain-list">
            {capabilities.map((capability) => <li key={capability}>{capability}</li>)}
          </ul>
        </div>
        <div className="server-managed-note">
          <span className="status status-managed">服务器托管</span>
          <p>{boundary}</p>
        </div>
      </div>
    </details>
  );
}

export default async function IntegrationsPage() {
  const snapshot = await loadConfig();
  const config = snapshot.data;
  const auth = config.authCapabilities;
  const service = config.serviceCapabilities;

  const cards: IntegrationCardProps[] = [
    {
      title: "推荐与地点能力",
      category: "地点与推荐",
      enabled: service.recommendationsEnabled && service.locationSearchEnabled,
      summary: service.recommendationsEnabled && service.locationSearchEnabled
        ? "推荐与地点搜索适配器已由服务端公开声明可用"
        : "推荐或地点搜索至少一项未由公开配置启用",
      capabilities: [
        `推荐：${service.recommendationsEnabled ? "已启用" : "未启用"}`,
        `地点搜索：${service.locationSearchEnabled ? "已启用" : "未启用"}`,
        `餐厅关键词接口：${service.placeSearchEnabled ? "已启用" : "未启用"}`,
        config.recommendationDefaults === undefined
          ? "推荐默认范围：旧版公开配置未提供"
          : `推荐范围：${config.recommendationDefaults.areaCode} · 客户端建议 ${config.recommendationDefaults.defaultRadiusMeters} 米 · 服务端上限 ${config.recommendationDefaults.maximumRadiusMeters} 米`
      ],
      boundary: "供应商 Key、签名和配额均留在服务端。能力声明不执行上游探测，也不代表商业授权或实时健康已经验证。"
    },
    {
      title: "千问辅助决策",
      category: "AI 服务",
      enabled: config.aiEnabled,
      summary: config.aiEnabled
        ? `当前公开模型版本：${config.modelVersion}`
        : "当前运行配置保持规则回退",
      capabilities: [
        `AI 辅助：${config.aiEnabled ? "已启用" : "未启用"}`,
        config.operationalConfig === undefined
          ? "未提供 AI 多门禁诊断，不能判断具体未启用原因"
          : AI_STATUS_LABELS[config.operationalConfig.aiStatus],
        "早餐、晚餐、专项、用户体感和已明确菜系的请求使用规则；其余午餐请求经用户同意后可使用 AI",
        `提示词版本：${config.promptVersion}`,
        `规则代码版本：${config.ruleVersion}`,
        `运营规则修订：${config.rulesConfigVersion === undefined ? "未提供" : config.rulesConfigVersion === null ? "使用部署默认值" : `v${config.rulesConfigVersion}`}`
      ],
      boundary: "API Key、地域工作空间和完整提示词不会下发到浏览器；公开配置只说明选择了何种运行能力。"
    },
    {
      title: "手机号与邮箱",
      category: "账号通道",
      enabled: auth.phoneEnabled || auth.emailEnabled,
      summary: `手机号${auth.phoneEnabled ? "已启用" : "未启用"} · 邮箱${auth.emailEnabled ? "已启用" : "未启用"}`,
      capabilities: [
        `账号体系：${auth.accountsEnabled ? "已启用" : "未启用"}`,
        `新账号注册：${auth.registrationEnabled ? "已启用" : "未启用"}`,
        `手机号：${auth.phoneEnabled ? "已启用" : "未启用"}`,
        `邮箱：${auth.emailEnabled ? "已启用" : "未启用"}`
      ],
      boundary: "短信、号码认证与邮件供应商凭据只由服务端持有；本页面不展示验证码、手机号、邮箱或投递明细。"
    },
    {
      title: "微信与 QQ",
      category: "社交登录",
      enabled: auth.wechatEnabled || auth.qqEnabled,
      summary: `微信${auth.wechatEnabled ? "已启用" : "未启用"} · QQ${auth.qqEnabled ? "已启用" : "未启用"}`,
      capabilities: [
        `微信：${auth.wechatEnabled ? "已启用" : "未启用"}`,
        `QQ：${auth.qqEnabled ? "已启用" : "未启用"}`,
        "第三方身份只用于已绑定账号的受控登录"
      ],
      boundary: "AppSecret、AppKey、授权 code、OpenID、UnionID 与令牌不会进入后台页面或浏览器日志。"
    },
    {
      title: "个人数据导出",
      category: "数据权利",
      enabled: auth.dataExportEnabled,
      summary: auth.dataExportEnabled ? "导出链路已完成公开就绪声明" : "公开配置未启用导出能力",
      capabilities: [
        `数据导出：${auth.dataExportEnabled ? "已启用" : "未启用"}`,
        `历史持久化：${config.persistenceCapabilities.historyEnabled ? "已启用" : "未启用"}`,
        `收藏持久化：${config.persistenceCapabilities.favoritesEnabled ? "已启用" : "未启用"}`
      ],
      boundary: "能力状态不包含导出文件、用户标识或存储地址；实际请求仍由用户会话、权限和生命周期策略约束。"
    },
    {
      title: "问题反馈",
      category: "支持服务",
      enabled: config.supportFeedbackEnabled,
      summary: config.supportFeedbackEnabled ? "反馈服务已完成公开启动就绪声明" : "反馈服务尚未公开启用",
      capabilities: [
        `问题反馈：${config.supportFeedbackEnabled ? "已启用" : "未启用"}`,
        `私有反馈持久化：${config.persistenceCapabilities.privateFeedbackEnabled ? "已启用" : "未启用"}`
      ],
      boundary: "这里只展示布尔能力，不读取反馈内容、联系方式、附件或内部处理记录。"
    }
  ];

  return (
    <>
      <PageHeader
        eyebrow="接口中心"
        title="知道什么已开放，也知道什么没被证明"
        description="页面只读取公开 /v1/config 的脱敏能力。展开卡片查看边界；这里没有 Secret 输入框，也不会把“已配置”包装成“已健康验证”。"
      />
      <SourceNotice source={snapshot.source} endpoint={snapshot.endpoint}>
        {snapshot.source === "LIVE"
          ? "以下状态来自公开能力声明，不是第三方实时探测或授权证明。"
          : "公开配置当前不可达；所有能力按关闭展示，演示内容不代表生产状态。"}
      </SourceNotice>
      <section className="integration-grid" aria-label="外部接口与产品能力">
        {cards.map((card) => <IntegrationCard key={card.title} {...card} />)}
      </section>
      <section className="public-contract panel" aria-label="公开客户端兼容契约">
        <div><p className="eyebrow">公开客户端契约</p><h2>最低支持版本</h2><p>这些版本号来自公开配置，不是 Secret，也不代表应用商店已经完成发布。</p></div>
        <dl>
          <div><dt>Android</dt><dd>{config.minimumSupportedVersions?.android ?? config.minimumSupportedVersion}</dd></div>
          <div><dt>iOS</dt><dd>{config.minimumSupportedVersions?.ios ?? "未声明"}</dd></div>
          <div><dt>小程序</dt><dd>{config.minimumSupportedVersions?.miniprogram ?? "未声明"}</dd></div>
        </dl>
      </section>
      <aside className="integration-boundary panel">
        <div>
          <p className="eyebrow">安全边界</p>
          <h2>配置状态与健康验证是两件事</h2>
        </div>
        <p>“已启用”只表示公开配置允许该能力；连通性、配额、数据授权、供应商账户状态与真实调用成功率，应在独立监控和发布门禁中验证。</p>
      </aside>
    </>
  );
}
