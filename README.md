# 吃什么

面向全国用户的附近美食决策产品。当前仓库包含 Android 原生客户端、NestJS API、Next.js 运营后台和共享接口契约。

## 当前可运行范围

- 本地开发默认使用虚构演示餐厅和确定性意图引擎，不调用或缓存任何第三方 POI 数据；生产环境从代码层禁止演示餐厅。
- Android 已支持内置快捷地点和全国地点关键词手动选址；关键词经自有 `POST /v1/location-search` JSON body 提交，最多返回 5 个显式标记 `LIVE/DEMO` 的通用地点结果，快捷地点在拒绝定位、无网或上游不可用时仍可回退。
- Android 1.0 聚焦“帮用户做决定”：保留自动定位和手动选址作为推荐起点，不展示、不注册路由，也不调用直接餐厅关键词搜索。服务端 `/v1/place-search`、OpenAPI 与 provider 继续作为独立 API 能力保留，不据此在 Android 1.0 恢复搜索入口。
- ECS 封闭 Alpha 已使用服务端 Web Service Key、匹配数字签名和固定出口 IP 白名单启用 `AMAP_ENABLED=true`，真实地点搜索与推荐技术 smoke 已通过。当前仍固定为 `LIVE_DISPLAY_ONLY`；技术链路可用不等于商业授权、重排、缓存、持久化或公开发布已经获批。
- 推荐结果的 provider 是受约束、可扩展的数据源代码，并逐条携带 `LIVE/DEMO` 与导航、拨号、复制、分享四项 API v1 动作。为保持契约兼容暂时保留 `share` 字段，但当前 AMAP/DEMO provider 均返回 `false`；Android 1.0 的分享入口由唯一的编译期常量固定关闭，不存在 Gradle 属性或远程开关。底层分享代码只作封存，不属于 1.0 能力或发布门禁，若在 2.0 重新启用必须重新完成产品、数据授权、隐私与安全评审。
- 公开推荐结果不包含供应商稳定 POI ID，只携带两小时、请求作用域的 43 字符 `resultToken`；行为事件只回传该 token，服务端从短期登记表解析来源并防伪造、跨请求复用和同类重放。
- 当前只实现 AMAP 与 development/test DEMO adapter。公共契约、推荐引擎和 Android 不依赖高德枚举；未来美团、大众点评等来源只通过正式 API 或商务合作新增 adapter，不抓取、不逆向，也不虚构尚不存在的接口。
- Android 1.2 已落入一批代码候选：早餐、午餐、晚餐分别使用可回显和校验的版本化推荐 profile；奶茶、咖啡、甜品及用户主动选择的体感条件只有在当前 provider 通过原子能力声明明确支持时才显示。当前 AMAP 只支持三餐 profile 与 `NONE` 天气条件，不开放垂类或用户体感；development/test 的 DEMO 可覆盖这些路径，但生产环境禁止启用 DEMO。
- 用户体感只是一项请求级、主动选择且不持久化的查询条件，不读取实时天气、温度或后台位置，也不构成天气服务接入。早餐、晚餐、垂类和用户体感路径当前均强制使用确定性规则并关闭 AI；响应会回显 profile 与体感应用版本，Android 在展示前校验其与本次请求一致。该批次仍只是代码/JVM 候选，不代表设备、生产、供应商授权或天气服务闭环已经完成。
- 配置百炼北京地域工作空间地址、API Key 与 `QWEN_ENABLED=true` 后可启用千问；失败时自动回退确定性规则。
- Android 工程已用 JDK 17、SDK 36、Gradle 8.13 完成 buildSrc/App JVM 测试、Lint、Debug、AndroidTest 与内部 Alpha 构建；模拟器验收结果和当前 APK SHA-256 以验证报告为准。仓库内 `.tools` 仅为本机忽略目录，不会提交到版本库。
- 登录已在不使用真实供应商凭据的设备内合成 API 夹具中验证手机号登录、邮箱绑定、退出、邮箱登录和再次退出；微信/QQ AppID 缺失时保持 fail closed。高德的 Android 合成展示边界与 ECS 真实 Web Service 技术链路均已验证：云端地点搜索和推荐明确返回 `AMAP/LIVE`、`fitScore=null`、GCJ-02 结果且分享关闭；这不等于商业授权、App 备案或公开发布已经获批。
- 前后端已按独立部署边界拆分：Android 只持有一个环境对应的 API 基址和公开 v1 契约，不包含数据库或供应商 Secret。普通 Debug 与内部 Alpha 均连接 `https://api.unfinished-era.com/` 的同一 API/PostgreSQL 实例，不复制第二套 Debug 服务、端口、域名或数据库；Debug 仍是独立、可调试且不可公开发布的客户端包。只有不可分发的 `fixture` 自动化测试构建固定使用设备/ADB 可达的 `127.0.0.1:3001` 隔离接口。API 的 `serviceCapabilities` 仍分别声明推荐、地点搜索和服务端独立餐厅关键词搜索是否可用；Android 1.0 只消费推荐与地点搜索能力并逐字段失败关闭，忽略 `placeSearchEnabled`，不会创建对应入口、路由或请求。ECS 当前 release 为 `20260823T071142Z-nationwide`，API 只监听 `127.0.0.1:13001`，数据库只在内部 Docker 网络开放；公网子域已使用独立 DNS、Let's Encrypt 证书和 API vhost 对外提供 v1 API。全国版候选的隔离验收、数据库备份、动态激活和失败自动回退门禁均已通过。

## 本地启动

```powershell
pnpm install
pnpm test
pnpm build
pnpm dev:api
pnpm dev:admin
```

API 默认位于 `http://localhost:3001`，管理后台默认位于 `http://localhost:3000`。
管理后台代码已实现 passkey 登录、会话、RBAC 与审计读取，但真实生产 RP ID/origin、首位管理员离线 bootstrap、独立管理员数据库角色和恢复流程尚未验收；当前仍只能用于封闭开发，不得直接发布到公网。

`pnpm dev:api` 会先用项目 TypeScript 配置编译共享契约与 API，再监听源码并只运行
`dist` 中的编译产物。请勿改回 `tsx`/esbuild 直接执行 Nest TypeScript；该路径不会
生成依赖注入所需的 `emitDecoratorMetadata`，会让全局 Guard 在运行时失败。可单独执行
`pnpm --filter @chi-shen-me/api test:runtime`，在随机本机端口对编译产物进行三接口冒烟测试。

需要联调高德或登录供应商时，不要把密钥写进命令行或聊天记录。先把仅面向
公开 API 进程的 `.env.local.example` 复制为已被 Git 忽略的 `.env.local`，只在
本机填写，然后运行：

```powershell
.\scripts\start-api-local.ps1 -ValidateOnly
.\scripts\start-api-local.ps1
```

脚本只接受公开 API 已声明的配置，不执行文件内容、不回显数据库、高德、千问
或认证密钥值。它先在无运行时 Secret 的最小环境中构建，再只把白名单配置注入
API 运行进程；管理员、迁移、维护、导出 worker 和其他父终端变量不会进入子进程。

本机已准备 Android 工具时，可执行一条完整验证命令：

执行前必须仅在当前进程把受控的 Alpha 微信、QQ 公开 AppID 分别设置为
`CHISHENME_ALPHA_WECHAT_APP_ID`、`CHISHENME_ALPHA_QQ_APP_ID`；不得在此处或命令中
使用微信 AppSecret、QQ AppKey 或其他服务端 Secret。

```powershell
.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
```

完整验证要求显式给出 Debug 与 Alpha 将共同嵌入的公网 HTTPS 地址。该脚本会验证 URL 策略、两者生成的 `BuildConfig` 与 DEX 确实包含同一地址，并单独构建固定回环地址的 `fixture` App/AndroidTest APK；fixture 只用于确定性自动化，不得分发或作为日常 Debug。脚本也会验证 ECS bundle，但不会把“地址成功嵌入”误当成 DNS、证书或公网可达。当前公网连通已另行通过 ECS `scripts/smoke-test.sh` 及工作站 TLS、跳转、readiness、真实高德搜索/推荐和管理端点 404 验收；关闭 Wi-Fi 的外部真机仍需单独复验。Windows 中文工作区下的临时 ASCII 盘符会在结束后撤销。

普通 Debug 直接构建后即可通过网络访问云端 API，不需要启动本机服务端或配置 `adb reverse`：

```powershell
.\apps\android\gradlew.bat -p .\apps\android assembleDebug
```

`connect-android-debug.ps1` 仅保留给 `fixture` instrumentation 测试准备 `tcp:3001` 映射，不属于日常 Debug 使用流程。

## 项目文档

- [Android 1.0：ECS 最小云端部署计划](./docs/ECS_MINIMAL_DEPLOYMENT_PLAN.md)
- [ECS 运维、备份、恢复与回滚手册](./docs/ECS_OPERATIONS_RUNBOOK.md)
- [Android 1.0 外部平台与密钥配置手册](./docs/EXTERNAL_CREDENTIALS_SETUP.md)
- [高德开放平台 API 接入说明](./docs/AMAP_API_INTEGRATION.md)
- [多数据源架构与接入治理](./docs/DATA_PROVIDER_ARCHITECTURE.md)
- [OpenAPI v1 规范](./docs/openapi.v1.json)
- [当前实现边界](./docs/IMPLEMENTATION_STATUS.md)
- [架构与隐私边界](./docs/ARCHITECTURE.md)
- [数据字典](./docs/DATA_DICTIONARY.md)
- [测试计划](./docs/TEST_PLAN.md)
- [当前验证报告](./docs/VERIFICATION_REPORT.md)
- [合规与发布门禁](./docs/COMPLIANCE_GATES.md)
- [12 周及跨平台路线](./docs/ROADMAP.md)

## 安全约束

- 不要提交 `.env`、签名文件、短信/微信/高德/千问密钥。
- 精确坐标只允许出现在自有 `POST /v1/recommendations` 请求体中；日志与行为事件禁止包含坐标。若经书面授权的供应商官方接口强制使用 HTTPS query，只能按架构文档完成 PIA、最小传输和全链路 URL 禁采集后作为出站例外。
- 未获得数据提供方书面许可前，保持 `DATA_RIGHTS_MODE=LIVE_DISPLAY_ONLY`。
- `LICENSED_ENRICHMENT` 还必须同时提供数据库授权记录 UUID 和未来到期时间；每项能力会按实际供应商查询数据库 operation，环境变量校验不是法律授权本身。
- 授权缺失、撤销、过期、供应商不匹配或数据库不可用时，服务会在运行中自动降为 `LIVE_DISPLAY_ONLY`；生产 API 还必须配置直接上游的 `TRUSTED_PROXY_CIDRS`，不得无条件信任转发头。
- 当前计划不包含抓取或复制第三方平台数据。

供应商文档按三层处理：官方 endpoint、参数、响应和坐标系是必须匹配的技术事实；合同、书面授权、隐私与法律要求是不能绕过的发布门禁；接口组合、超时、排序和 UI 建议则由产品指标、测试、灰度与回滚决定，不会因为首个供应商是高德就把核心逻辑锁死。详见[多数据源架构与接入治理](./docs/DATA_PROVIDER_ARCHITECTURE.md)。
