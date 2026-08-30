# 架构与隐私边界

## 产品原则

“吃什么”解决的是“现在这一顿选哪家”，而不是提供无限餐厅信息流。客户端应优先呈现一个主答案和两个备选；任何分数都不能绕过营业、预算、距离、排除项和数据权利等硬规则。

Android 1.0 因此只保留自动定位、内置快捷地点和地点关键词手动选址来确定推荐起点；它不提供直接餐厅关键词搜索，不创建对应入口、列表/详情路由或网络调用。服务端 `/v1/place-search`、OpenAPI 与 provider 保持独立，以便继续验证供应商和契约边界，但服务端能力存在不能反向扩大 Android 1.0 产品范围。

## 单仓库结构

```text
apps/android      Kotlin + Jetpack Compose Android 客户端
apps/api          NestJS 模块化单体 API
apps/admin        Next.js 管理台与同源 BFF（仍受独立生产启动门禁）
packages/contracts  Zod 前置共享契约与 OpenAPI 漂移测试
infra             本地/测试环境容器编排
docs              产品、架构、OpenAPI 3.1、数据、测试和发布门禁
```

## 前后端与云端运行边界

Android 只负责隐私同意、用户主动定位或手动选择推荐起点、决策表单与会话内 UI、客户端契约校验和系统
Intent 门禁；餐厅供应商适配、推荐过滤/排序、账号事务、数据权利判断、数据库和所有
服务端 Secret 均留在 API/ECS。普通 Debug 和内部 Alpha 固定访问同一个
`https://api.unfinished-era.com/` API/PostgreSQL 实例；两者只是包名、可调试性、压缩和分发
用途不同的客户端，不创建第二套 Debug 服务、Compose project、端口、域名、Secret 或数据库。
因此两者共享服务能力、最低版本、IP 限流、高德配额、内存事件缓冲及未来启用后的账号数据。
客户端自报的 build channel 不得用于拆分限流、鉴权、数据授权或选择 provider Secret。

普通 Debug 的默认地址和任何覆盖地址都必须通过公网 HTTPS 门禁；回环 HTTP 只存在于不可
分发的 `fixture` build type，用于 deterministic instrumentation，避免自动化访问云端真实数据
或消耗第三方配额。Fixture 不属于日常 Debug，也不能作为测试包发给体验者。当前云端账号能力
保持关闭；手机号/邮箱未来可在同一环境联调，但 Debug 与 Alpha 因包名/签名不同而需要不同的
微信/QQ AppID。服务端在完成受批准的多 AppID、OAuth state 与 providerScope 绑定设计前，
Debug 的微信/QQ入口必须继续 fail closed，不能信任客户端环境头选择 Secret。

内部 Alpha 的客户端身份固定为 `com.chishenme.app.alpha` 和长期证书（MD5
`7c64a4f134a3ebe121c1fb055c09a70c`，SHA-256
`31f21374f2f5d40697efb3c50e14d4e8d228991f6acbcde262e37c72ae4c0289`）。私钥与密码只存在于
仓库外的本机签名配置；仓库只保留公开证书摘要。构建门禁要求 Debug/Fixture/FixtureTest
共用测试证书、Alpha 使用与其不同且完全匹配固定摘要的证书，缺失或错误签名时拒绝生成
Alpha APK。最终 Release 的 `com.chishenme.app` 继续使用另行生成、备份和登记的独立证书，
不能借用 Alpha signer。

公网 API 子域必须使用独立 DNS、证书和 API Nginx vhost，只把 `/health`、
`/health/ready`、`/v1` 与 `/v1/*` 代理到宿主机回环 `127.0.0.1:13001`；Compose 不得
直接占用宿主机 `80/443`。

`GET /health` 是 liveness，只证明 NestJS 进程可响应；`GET /health/ready` 是
readiness，在不访问外部供应商的前提下检查已启用数据库的有界查询和核心推荐
adapter 本地配置。容器健康、发布切流和公网 smoke 使用 readiness；监控进程是否仍
存活时才使用 liveness。二者不可互相替代。

## 推荐数据流

```text
Android 请求体中的单次坐标（显式 CRS）
        |
        v
API Schema 校验 -> 全国坐标、半径和用户约束校验
        |                              |
        |                              +-> 失败：安全错误或覆盖提示
        v
仅用非敏感场景字段生成 IntentProfile
        |  Qwen 2.5 秒超时/一次短重试
        +------------------------------> 规则回退
        v
服务端选择已实现、已启用且权利边界允许的 PlaceProvider
        |  当前真实 adapter 只有 AMAP；development/test 可用 DEMO
        |  坐标转换和上游字段解析只发生在各 provider adapter 内
        |
        v
统一 PlaceCandidate（provider + dataMode + actions + 显式 CRS）
        |
        v
同一坐标系计算距离 -> 硬过滤 -> 授权范围内排序 -> 去重/多样性 -> 事实校验
        |
        v
内部稳定引用替换为请求作用域 resultToken
        |
        v
1 主推荐 + 2 备选 + 原因 + 置信度 + 版本信息
```

## 不可信边界

- Android 输入、第三方 API 和 AI 输出均视为不可信，进入领域层前必须校验。
- Android 系统定位和内置手动测试点标记为 WGS84；高德 around 请求前只转换一次为 GCJ-02，高德 POI 响应也显式标记为 GCJ-02。距离函数拒绝混合坐标系，禁止用未标记或重复偏移的坐标计算距离。
- 精确坐标不得进入自有客户端/API URL、事件、错误信息或持久化日志。若获授权的数据供应商官方接口强制使用 HTTPS query，只能作为经过 PIA 和书面授权的出站例外，并必须在代理、APM、SLS 和诊断层禁止采集完整 URL；否则更换支持请求体的供应商。
- 千问只接收餐段、预算、可用分钟、人数、交通、主动菜系及主动模式标签；不接收手机号、第三方账号、设备标识或精确位置。
- 在未获得书面授权前，第三方餐厅名称、评分、图片和 POI 属性不得发送给千问。
- 客户端不保存服务端、高德、千问、短信或社交平台 Secret。
- `DEMO` 数据只用于 development/test；production 会拒绝启用。未配置合法供应商时推荐接口安全失败。
- Android 为所有 API 请求发送固定的 v1 契约版本并要求响应恰好确认同一版本；缺失、重复或不匹配会在反序列化前关闭响应。网络层即使包装该异常，也只通过有深度上限和循环检测的 cause 链归类，不读取或展示异常、URL、请求体或响应元数据。远程配置在客户端内部明确区分成功、暂不可用和契约不兼容，后两者都保持 AI 关闭并给出不同提示。
- `/v1/config.serviceCapabilities` 只声明当前选中推荐、地点搜索和餐厅关键词搜索 adapter 的本地可用性，不执行上游探测，也不暴露供应商身份。服务端与共享契约继续保留三个字段；Android 1.0 只消费推荐与地点搜索字段，对缺失或不是明确 `true` 的值按关闭处理，并无条件忽略 `placeSearchEnabled`。地点搜索能力与签发它的可信配置 generation 绑定，旧 generation 的开放值不能取得新 generation 的远程访问 lease；任何配置值都不能在 Android 1.0 动态恢复直接餐厅关键词搜索。
- `/v1/config` 同时公开当前运行配置的脱敏 `recommendationDefaults`（广义区域代码、默认/最大半径）和 `minimumSupportedVersions`（Android 及可选 iOS/小程序）。二者为兼容旧响应而可缺省，但当前服务总是发出；旧 `minimumSupportedVersion` 保留且必须等于 Android 值。它们不含坐标、供应商身份、Secret 或管理员版本历史，也不构成健康/readiness 证明。

## 供应商无关边界

- 公共契约中的 `provider` 是受正则约束的可扩展来源代码，不是只允许 `AMAP/DEMO` 的封闭枚举；领域引擎和 Android 不能根据某个供应商名称分支业务逻辑。
- 每条推荐显式携带 `dataMode: LIVE | DEMO`，避免把虚构测试数据伪装成真实商户。
- 每条推荐显式携带严格的 `actions` 对象，分别控制导航、拨号、复制地址和分享。API v1 为兼容保留 `share`，但当前全部 provider 返回 `false`；Android 1.0 通过唯一且固定为 `false` 的编译期常量移除分享入口，没有 Gradle 属性或远程开关。客户端必须逐项遵守，不能因响应中出现坐标、电话或地址就自行开放外传动作；封存实现只能在 2.0 完成新的产品、数据权利、隐私与安全评审后重新启用。
- 每条公开推荐只携带 43 字符、请求作用域的 `resultToken`，不携带稳定 `providerPlaceId`。事件请求只回传 token；供应商引用由服务端短期登记表解析。
- 当前真实来源只有高德，另有仅限 development/test 的 DEMO adapter。未来美团、大众点评等来源只能通过正式 API 或商务合作接入；项目不抓取、不逆向，也不会先创建虚假 adapter 或接口来冒充已经接入。
- 官方 endpoint、参数、响应、坐标系和业务成功码属于 adapter 必须遵守的技术事实；正式授权、合同和法律要求属于上线硬门禁；provider 选择、超时预算、排序编排和 UI 呈现属于可评测、可回滚的产品架构决策，不因某一家供应商的建议而永久锁死。完整规则见[多数据源架构与接入治理](./DATA_PROVIDER_ARCHITECTURE.md)。

## 数据权利模式

### LIVE_DISPLAY_ONLY

- 对官方接口结果只做本次请求中的展示和必要硬过滤。
- 不持久化 POI 属性或图片，不跨请求缓存外部数据。
- 为校验两小时内的行为事件，进程内保存由随机进程密钥签发、同时绑定 `requestId` 的短期 HMAC token 到最小供应商引用的映射。公开响应、Android 和事件请求均不出现稳定 POI ID；相同 POI 在不同请求中的 token 不同，映射会定时过期，并在覆盖、撤销、容量淘汰或进程关闭时清空。
- 不把 POI 候选交给第三方模型。
- `fitScore` 必须为 `null`，界面不得显示自有适合度。
- 收藏和历史只能保存不受限制的本地会话信息；是否允许保存 POI 引用以书面许可为准。

### LICENSED_ENRICHMENT

只能由服务端部署配置声明启用，并要求授权记录可追溯。运行期会按实际供应商逐项查询数据库 authorization/operation：自有重排和适合度同时要求 `DISPLAY_LIVE_RESULT`、`RESORT_LIVE_RESULT`、`DISPLAY_OWN_SUITABILITY`；事件中的稳定 provider 引用另行要求 `PERSIST_PLACE_REFERENCE`。数据库不可用、授权不存在/过期/撤销、供应商不匹配或缺少任一 operation 时立即 fail closed。provider ID 仍只能通过受控持久化函数进入唯一基表；工程记录不等同于法律授权。

`MODEL_PROCESS_PLACE_DATA` 保持独立且当前未开放；千问仍不接收 POI 内容。环境变量中的授权 UUID 和本地到期时间只是额外门禁，不能替代数据库记录、合同或书面许可。

## PostgreSQL/PostGIS 基础

- development/test 默认数据库关闭且不创建连接；production 强制 PostgreSQL、直接 `postgresql://` URL、`verify-full` TLS 和声明的目标/最小权限角色，缺一即拒绝启动。
- `DatabasePool` 是 Nest 单例生命周期资源。启用时先检查连接和完整 migration checksum/version；关闭时释放 Pool。业务事务只能通过 `withTransaction` 获取固定 query 接口，统一 `BEGIN`、受控 `search_path`、`COMMIT/ROLLBACK/release`，不暴露原始 Pool。
- 迁移只读取镜像/仓库固定 `apps/api/migrations`，拒绝 symlink、路径逃逸、非法 UTF-8、BOM、缺号、未知记录、checksum 漂移和迁移内事务控制。advisory lock 有界等待，每个版本独立事务；API 不自动迁移。
- `schema_migrations` 只有 `version/name/checksum/applied_at`。生产顺序必须是 bootstrap 扩展 → migration role 迁移 → 事务化 role grants → runtime role schema/权限 smoke → API。
- extension owner、migration owner、runtime role、maintenance role 分离。API 只有业务白名单权限；一次性 OTP/OAuth/refresh 状态只能经受限函数推进。OAuth provider subject 哈希在消费 state 时一次性封存，注册/绑定只能读取封存 proof；runtime 不能直写 user/identity。maintenance 只能执行顶层 preview/execute cleanup 与达到门禁的主体清除。
- `0013_admin_config_control.sql` 只开放五个非 Secret 配置键：`features.ai-assistance`、`recommendations.rules`、`recommendations.prompt`、`coverage.default` 和 `clients.minimum-version`。普通 runtime 与管理员 runtime 都无配置基表权限，只能分别调用固定 `SECURITY DEFINER` 读取/管理函数；schema、分类和 JSON 形状由服务端映射与数据库同时验证。普通 runtime 只把已采用的覆盖默认值与最低版本形成上述公开脱敏投影，不公开整条活动记录。
- 配置写入采用逐键 `expectedActiveVersion` 乐观锁（PUT 首次发布为 `null`、已有活动版本时精确匹配；rollback 始终为正整数活动版本）。发布追加新活动版本并 retire 旧版本；回滚复制目标历史值发布更高的新版本，不复活或覆盖旧行。两个 GET 要求 `ALGORITHM_CONFIG_READ`，PUT/rollback 要求 `ALGORITHM_CONFIG_WRITE`，409 表示并发版本冲突而不是可忽略告警。`features.ai-assistance` 的值严格只有全局 `enabled` 布尔开关，不含灰度百分比或任意扩展字段。
- 初始 schema 覆盖账号身份、OTP、session/token、OAuth state、收藏/历史/私有反馈、导出/注销、配置、后台角色/MFA、append-only audit、数据权利及广义覆盖区域。除覆盖区域几何外不存用户坐标；凭据、身份目的地、设备/IP 与第三方证据只存哈希或密文。
- `lookup_hash` 使用可轮换查询 key；`dedup_hash` 使用独立稳定 key。稳定 key 的任何变更必须经过双读、全量冲突审计与事务重键，禁止直接切换版本后继续写入。
- retention 只删除达到固定门禁的数据；导出工件的 OSS 删除、备份滚动清除和 RDS 恢复属于独立运维流程。

## 云端发布与恢复边界

- release 目录是不可变输入：源码与部署 bundle 位于新的
  `/opt/chi-shen-me/releases/<release-id>/`，`/opt/chi-shen-me/current` 只在候选
  release 完成校验、迁移、readiness 和 smoke 后切换。共享 Secret 与 PostgreSQL
  外部卷位于 release 之外，更新 release 不得重建密码、删除共享目录或删除数据卷。
- bundle 不包含 Secret。工作站必须先验证固定文件集合和 `SHA256SUMS`；ECS 上的
  `preflight-deployment.sh` 再检查路径、权限、所有者、镜像坐标、共享状态、数据库
  TLS 和 Compose 配置。预检失败时不得迁移、启动或修改 `current`。
- `backup-database.sh` 只在固定 root-only 目录创建不可覆盖的时间戳备份；
  `verify-database-backup.sh` 复核精确文件集合、SHA-256 和 `pg_restore --list`；
  `restore-database.sh` 只恢复到全新的隔离数据库，不覆盖活动数据库。服务器本地
  dump 仍必须配合 ECS 快照和异机副本，隔离恢复通过也不等于已经执行生产回滚。
- Android 完整工件门禁统一为：

  ```powershell
  .\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
  ```

  该命令验证公网 HTTPS 地址策略，并确认指定地址进入 Alpha `BuildConfig` 和 APK
  DEX；同时核对固定 Alpha signer 的单 signer/v2、公开 MD5/SHA-256、与 Debug 测试
  证书隔离及 16 KiB 对齐。它不发起 DNS/TLS/公网访问，不能替代独立子域切流、
  `/health/ready` 公网 smoke 或关闭 Wi-Fi 的真机闭环。

## 透明排序

硬过滤后，仅当当次数据权益模式为 `LICENSED_ENRICHMENT` 时，才应用质量 25%、时间可行性 25%、预算 20%、餐段/意图 15%、反重复/多样性 10% 与经审核运营精选 5% 的加权排序。`LIVE_DISPLAY_ONLY` 不计算加权适合度，只在硬过滤后保持上游顺序。运营调整最大正负 5 分，必须记录原因、操作者和失效日期。付费推广永远不能修改自然适合度。

每次响应携带：

- `ruleVersion`
- `promptVersion`
- `modelVersion`
- `dataRightsMode`
- `aiFallbackUsed`

并且每条结果携带通用 `provider`、`resultToken`、`dataMode` 和四项 `actions` 能力。`ruleVersion` 只能与同一响应的 `dataRightsMode` 一起解读：后者为 `LIVE_DISPLAY_ONLY` 时，配置中的权重未应用。`dataRightsMode` 是当前迁移期的全局保守门禁，不能代替每条结果的动作授权，也不能由客户端反向推导某项动作可用。

这样才能复现推荐问题并安全回滚。

## 演进方式

- [`openapi.v1.json`](./openapi.v1.json) 是当前实际公共 API 与隔离管理员 API 的唯一 OpenAPI 3.1 v1 文档源；共享请求/响应结构由自动化测试与 Zod input/output JSON Schema 对照，路由、状态码、引用、通用来源/动作约束以及精确输入坐标的 body-only 边界也有漂移门禁。文档中的接口存在不等于对应服务能力已启用，客户端仍以 `/v1/config` 的失败关闭能力声明和运行期门禁为准。管理员配置接口显示“活动/已发布”也只表示数据库版本状态，不是上游健康探测、Secret 校验、运行进程刷新确认或生产 readiness。
- OpenAPI 客户端代码生成仍未接入；接入前必须继续以 Zod 运行时校验为执行边界，不能用生成类型替代不可信输入校验。

- 内测期采用 NestJS 模块化单体和事务型任务表，避免过早引入 Kafka。
- PostgreSQL/PostGIS 基础、迁移、权限和 retention 已落盘；推荐的无账号访客内核在 development/test 仍可显式无数据库运行，production 不允许数据库回退。
- 当前限流、推荐请求登记和事件汇总均为单进程内存实现，只适合封闭 Alpha；多实例或公开环境必须在可信代理/网关及共享存储层重新实现和验证，不能把进程内保护当成完整防护。
- 默认不采信 `X-Forwarded-For`。生产因 HTTPS 终止必须显式配置直接上游的受信任代理 IP/CIDR；通配网段会被拒绝，漏配则生产服务拒绝启动。
- API v1 冻结后保持当前版本和前一版本兼容。
- 远程配置只允许上述五个固定键及其严格 JSON schema；禁止下发可执行代码、模板源码、任意 URL、供应商凭据或任何 Secret。扩展键必须先经过独立契约、数据库、RBAC、审计和发布评审，不能借通用 JSON 临时加入。
- Android 达标后按用户最新指定顺序开发微信小程序，再开发 iOS；三个客户端共用契约、账号、规则和设计令牌。
