import type { Metadata } from "next";
import { PageHeader, SourceNotice } from "../../components/admin-ui";
import { demoDiagnostics } from "../../lib/admin-data";

export const metadata: Metadata = { title: "推荐诊断" };

export default function DiagnosticsPage() {
  return (
    <>
      <PageHeader eyebrow="推荐诊断" title="看得到问题，看不到隐私" description="本页仅演示未来的诊断字段。请求标识已截断，精确坐标、账号标识与第三方令牌永不展示。" />
      <SourceNotice source="DEMO" endpoint="尚未开放诊断 API">以下记录为虚构脱敏样例，不来自真实用户或真实餐厅。</SourceNotice>
      <section className="panel table-panel"><div className="panel-heading"><div><p className="eyebrow">最近请求</p><h2>脱敏诊断样例</h2></div><span className="demo-chip">静态演示</span></div><div className="table-scroll"><table><thead><tr><th>请求标识</th><th>时间</th><th>餐段</th><th>决策路径</th><th>耗时</th><th>结果</th><th>坐标</th></tr></thead><tbody>{demoDiagnostics.map((row) => <tr key={row.requestId}><td><code>{row.requestId}</code></td><td>{row.occurredAt}</td><td>{row.meal}</td><td>{row.mode}</td><td>{row.latency}</td><td>{row.result}</td><td>{row.coordinates}</td></tr>)}</tbody></table></div></section>
      <section className="two-column"><article className="panel"><p className="eyebrow">允许展示</p><h2>低风险派生信息</h2><ul className="plain-list positive"><li>餐段、规则/模型版本</li><li>耗时、回退状态与候选数量</li><li>覆盖范围结果与通用错误码</li><li>已截断、不可反查的请求标识</li></ul></article><article className="panel"><p className="eyebrow">禁止展示</p><h2>敏感与秘密数据</h2><ul className="plain-list negative"><li>精确经纬度与行踪</li><li>手机号、微信号、邮箱、QQ</li><li>访问令牌、验证码与服务密钥</li><li>未经授权的第三方 POI 内容</li></ul></article></section>
    </>
  );
}
