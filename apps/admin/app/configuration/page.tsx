import type { Metadata } from "next";
import { PageHeader } from "../../components/admin-ui";
import { ConfigurationWorkspace } from "../../components/configuration-workspace";

export const metadata: Metadata = { title: "配置中心" };

export default function ConfigurationPage() {
  return (
    <>
      <PageHeader
        eyebrow="配置中心"
        title="像内容分组一样清楚，像发布系统一样克制"
        description="五类运行配置使用专用字段编辑。每次发布都会校验权限、当前版本和更改原因，并保留可展开的历史版本。"
      />
      <ConfigurationWorkspace />
    </>
  );
}
