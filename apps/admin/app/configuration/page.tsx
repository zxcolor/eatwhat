import type { Metadata } from "next";
import { PageHeader } from "../../components/admin-ui";
import { ConfigurationWorkspace } from "../../components/configuration-workspace";
import { loadConfig } from "../../lib/admin-data";

export const metadata: Metadata = { title: "配置中心" };
export const dynamic = "force-dynamic";

export default async function ConfigurationPage() {
  const runtime = await loadConfig();
  return (
    <>
      <PageHeader
        eyebrow="配置中心"
        title="像内容分组一样清楚，像发布系统一样克制"
        description="五类配置分别保存、校验权限和版本，并保留历史。保存成功后，仍需核对 API 的运行状态和各客户端采用情况。"
      />
      <ConfigurationWorkspace runtimeConfig={runtime.source === "LIVE" ? runtime.data.operationalConfig ?? null : null} />
    </>
  );
}
