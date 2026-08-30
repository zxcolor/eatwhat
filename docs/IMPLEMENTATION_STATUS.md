# 实施状态

更新日期：2026-08-30

本仓库目前是“吃什么”Android 1.0 的封闭测试候选工程，不代表外部资质、真实基础设施或公开发布门禁已经全部完成。

## 已落地的 Android 1.0 候选能力

- pnpm 单仓库，包含共享契约、NestJS API、Next.js 运营台和原生 Android 工程。
- Android 隐私同意门、系统原生前台定位、手动地点关键词搜索、内置快捷地点回退、早餐/午餐/晚餐、预算、可用时间、交通方式、稳妥/探索选择。定位只在用户点击“自动定位”后请求，支持仅大致位置、拒绝、定位关闭、超时和手动回退，不申请后台位置。
- 已实现供应商无关的 `POST /v1/location-search`：关键词只进入自有 JSON POST body；服务端在全国范围内最多返回 5 个带显式 CRS 的地点，不返回稳定 POI ID；Android 支持加载、空结果、错误、取消旧请求和丢弃晚到响应，内置测试点始终可用。地点选择器、输入草稿、加载和成功结果只保留在 Activity 级内存 ViewModel 中，配置重建可恢复，显式关闭、真正退到后台、隐私撤回、配置代际失效或进程死亡会清除；旧请求即使不配合取消也不能写回。高德启用时由服务端 `v5/place/text` adapter 处理，默认开发模式使用清楚标记的虚构 DEMO 地点。
- Android 1.0 的产品目标是完成选择而不是提供餐厅搜索：自动定位、内置快捷地点和地点关键词手动选址继续作为推荐起点；直接餐厅关键词搜索不展示入口、不注册列表或详情路由，也不会构造或发送 `/v1/place-search` 请求。
- 一次推荐返回 1 个主推荐和最多 2 个备选，并展示来源评分、可选适合度、距离、时间、置信度、警告和“为什么推荐”。
- 推荐公共契约已把来源改为受约束、可扩展的代码，并为每条结果携带 `dataMode: LIVE | DEMO` 和导航、拨号、复制地址、分享四项布尔 `actions`。为保持 API v1 兼容暂时保留 `share`，但当前 AMAP/DEMO provider 统一返回 `false`，Android 1.0 也不会展示或执行它。推荐引擎与 Android 不根据供应商名称分支；当前仅有 AMAP 和 development/test 的 DEMO adapter，没有虚构美团或大众点评接口。
- 推荐与地点关键词搜索共用通用 provider registry/selector，但分别以 `PLACE_RECOMMENDATION`、`LOCATION_TEXT_SEARCH` 真实能力注册，并分别配置 `RECOMMENDATION_PROVIDER_PRIORITY`、`LOCATION_SEARCH_PROVIDER_PRIORITY`。禁用、能力不匹配或无可用 adapter 时安全跳过或失败，不跨能力推断，也不伪造未来供应商。
- `/v1/config` 已增加供应商无关的 `serviceCapabilities`，分别声明推荐、地点搜索和餐厅关键词搜索当前是否可用；共享契约与服务端继续保留 `placeSearchEnabled`，`/v1/place-search`、OpenAPI 和 provider 也继续作为独立 API 能力维护。Android 1.0 只消费推荐与地点搜索字段，缺少整个对象、缺少对应字段或值不是明确 `true` 时按 `false` 关闭，并无条件忽略 `placeSearchEnabled`。地点搜索能力与可信配置 generation 一起交给 ViewModel；旧 generation 的开放状态不能取得新 generation 的远程访问 lease，也不能在配置刷新后继续触网。
- `/v1/config` 还返回当前运行配置的脱敏 `recommendationDefaults`（固定 `NATIONWIDE`、客户端建议半径、服务端最大半径）与 `minimumSupportedVersions`（Android 及可选 iOS/小程序）。建议半径不是服务端自动默认，推荐请求仍必须显式提交 `radiusMeters`。为兼容已部署旧响应，两个新对象在共享契约中可缺省，但当前服务总是发出。旧 `minimumSupportedVersion` 继续等于 Android 值。公开投影不含坐标、供应商身份、Secret、管理员或版本历史，也不代表上游健康/readiness。
- 公开推荐结果已移除稳定 `providerPlaceId`，只返回两小时、请求作用域的 43 字符 HMAC `resultToken`。推荐事件只提交 `requestId/resultToken/type/occurredAt`；服务端从短期映射解析真实来源，同一 token 的同类事件只能接受一次。
- 客户端在展示前再次拒绝明确停业、超半径、已知超预算和明确命中排除菜系的响应；未知价格或营业信息只做风险提示，不伪造事实。
- 会话内推荐餐厅详情同时按服务端逐项 `actions` 与本地必要字段决定是否提供地图查询、复制地址和安全拨号；动作未授权、缺少电话、缺少地址或缺少导航查询信息时，对应按钮保持禁用并显示明确原因，Intent 工厂仍会再次拒绝执行。第三方 POI 不进入导航参数、SavedState 或本地持久化。推荐结果和详情选择只在 Activity 级内存 ViewModel 中跨配置重建保留；结果页仅把“仅营业中”等安全筛选和列表/方位图展示偏好写入可恢复 UI 状态，餐厅对象、坐标和 `resultToken` 不进入 Bundle、SavedState 或持久化。DEMO 结果的已开放动作只用于本地 UI 验收并带虚构数据警示；分享字段在全部 provider 上关闭。
- 本机最近决策使用字段白名单，只保留时间、餐段、模式、预算、用时、交通和结果数量，最多 30 条、90 天；不保存位置或餐厅信息，可单独清空，撤回隐私同意时原子删除。
- API 全国坐标与半径校验、硬过滤、透明排序、Top 3 多样性、规则版本和确定性 AI 回退；不存在北京或四环地理门禁。
- `LIVE_DISPLAY_ONLY` 与 `LICENSED_ENRICHMENT` 双数据权利模式；后者已按实际供应商逐项查询数据库 authorization operation。
- 授权缺失、撤销、过期、供应商不匹配或数据库不可用时，会在运行中对公开配置、排序和事件留存立即降级，不依赖进程重启；模型处理 POI 的独立 operation 当前仍未开放。
- 高德和千问适配层；Android/手动输入统一标记为 WGS84，仅在高德出站边界转换为 GCJ-02，门店距离不再混用坐标系。高德文本、周边、附近关键词和已授权 ID 详情四条 Web Service 调用链共用官方参数签名、严格业务状态/安全错误分类、512 KiB 上限、超时和字段保守解析。生产启用还必须有独立签名私钥并明确确认出口 IP 白名单，否则启动失败；在没有可验证图片域名边界前不展示第三方图片。
- 仅在 development/test 明确允许时使用带 `DEMO` 标记的虚构餐厅，生产环境无合法供应商会安全失败。
- 推荐事件严格校验，不接受精确坐标等未声明字段；当前仅使用进程内汇总，不落用户轨迹库。
- 推荐事件必须关联两小时内真实返回的候选，且同类事件去重；登记表使用进程随机密钥和请求作用域 HMAC，短期保存 token 到最小服务端引用的映射，但公开协议与 Android 均不接触稳定 POI ID。推荐限流、请求登记和事件汇总目前仍是单进程内存实现，尚不能替代公开环境网关与共享存储。
- 生产启动要求显式受信任代理 CIDR；默认不采信转发头并拒绝通配网段，避免代理后所有用户误入同一限流身份。
- API 对非法 JSON、超过 100 KiB 的 JSON 和非 JSON POST 分别返回统一安全的 400/413/415；错误不回显解析器原文或非法请求 ID，并统一下发 `nosniff`、`DENY`、`no-referrer`、`no-store` 响应头。
- API 已区分 `GET /health` 存活探针与 `GET /health/ready` 就绪探针：前者只证明 NestJS 进程能响应，后者才在不调用外部供应商的前提下检查已启用数据库的有界 `SELECT 1` 和核心推荐 adapter 的本地配置。Compose 健康检查、部署预检后的运行时验证和未来公网切流必须使用 readiness；生产没有可用推荐 adapter 时返回受控 503 是失败关闭，不得用 liveness 冒充可服务。
- 管理员服务与运营台已实现独立的 WebAuthn/passkey 登录、15 分钟空闲会话、逐请求 RBAC、当前会话、passkey 自助管理和脱敏审计读取；浏览器 BFF 使用 HttpOnly 会话 Cookie，普通用户 token/数据库角色与管理员链路隔离。真实生产 RP ID/origin、HTTPS、首位管理员离线 bootstrap、独立 `admin_api_runtime`、完整 step-up assertion、真实数据库权限和恢复演练仍未验收，因此不能把代码存在表述为管理后台已上线。
- 管理员配置中心已收口为五个非 Secret 白名单键：`features.ai-assistance`、`recommendations.rules`、`recommendations.prompt`、`coverage.default`、`clients.minimum-version`。提示词与模型标签不是自由文本，只能选择当前服务端构建注册值；未注册值在 UI、共享契约、API 和数据库四层拒绝。推荐权重仅 `LICENSED_ENRICHMENT` 生效，`LIVE_DISPLAY_ONLY` 保持上游顺序。隔离管理员 API 提供活动列表、逐键历史、带 `expectedActiveVersion` 的发布和复制旧值生成新版本的回滚；PUT 首次发布期望版本为 `null`、已有活动版本时精确匹配，rollback 始终要求正整数活动版本，漂移返回 409。AI 辅助键严格只有全局 `enabled` 布尔开关。配置审计只投影固定键、新/源版本和枚举变更原因，不含 value 或自由文本。读写分别要求 `ALGORITHM_CONFIG_READ/WRITE`。它不接收或返回高德/千问/短信/SMTP/OAuth/数据库/管理员加密 Secret，也不下发可执行代码。接口中的活动状态只表示数据库版本状态，不等于上游健康、运行进程已经采用或生产 readiness；生产管理员启动门禁仍未验收。
- 本地开发、CI、容器部署和安全基线文件已落盘。ECS 当前运行全国版 root-only release `20260823T071142Z-nationwide`，Linux/amd64 镜像为 `sha256:44041f99d06b1758088b58a22af83707e56db81783c8c4daadc7347e9da7c3a7`；bundle、镜像 ID/用户、发布坐标、共享 Secret 形状、PostgreSQL TLS 与 Compose 均通过严格预检、上海隔离候选验收和动态激活。激活只重建 API，PostgreSQL 容器未变化；本地 Windows 不承担 Docker 构建。
- PostgreSQL/PostGIS 基础已落盘：非生产默认无连接、生产强制直连/TLS/角色身份，Nest Pool 生命周期与安全事务入口，固定路径 SHA-256 迁移、schema 启动校验、初始账号/收藏/历史/反馈/导出/注销/配置/后台审计/数据权利 schema，以及固定 90/180/7/30 天 retention runner。数据库没有用户精确坐标；OTP/opaque token/身份只保存 Argon2id、HMAC 或密文。
- migration/runtime/maintenance 与一次性 extension owner 的权限边界已写入事务化 `role-grants.sql`；脚本会拒绝缺变量、同角色、高权或互相继承，收敛历史表级和列级 ACL。Docker 镜像复制只读 migrations，本地 Compose 顺序是数据库健康→迁移成功→API schema 校验后启动。
- GitHub CI 已配置独立 `postgis/postgis:17-3.5-alpine` job，从空库迁移、重复迁移、权限失败回滚、runtime 正反例、授权过期/并发撤销、retention dry-run/execute 和 API startup schema verify。ECS 已真实完成 PostGIS 3.5 扩展、版本化迁移、角色授予和 API 启动基线，但这不等于整套 CI 负例、retention execute 或备份恢复矩阵都已在 ECS 重跑。
- ECS 当前采用宝塔 Nginx `80/443` → `127.0.0.1:13001` → API 的活动拓扑，PostgreSQL 仅在内部 Docker 网络提供 `postgres.internal:5432`。`https://api.unfinished-era.com` 的独立 DNS、Let's Encrypt 证书、vhost 和续期 hook 已激活；`/health/ready` 为 200，`AMAP_ENABLED=true`，真实地点搜索与推荐在隔离、活动容器和公网三层通过。原 WordPress 文件、宝塔数据库、证书和恢复点均保留，主站 vhost SHA-256 仍为 `215a48d7e2c5e43493e89f6ed27f6fa304e7b6b9782a1c72cab3420476b0888e`。
- ECS 发布工具已收口为无 Secret 的不可变 bundle、固定 `SHA256SUMS` 和服务器侧 `preflight-deployment.sh`；共享 Secret、PostgreSQL 外部卷与 release 分离。仓库还提供固定 root-only 目录的数据库备份、备份复核和仅恢复到全新隔离数据库的脚本；本轮 schema 10 迁移前已真实生成并复核 `/opt/chi-shen-me/backups/postgres/20260827T042434Z`，但没有对生产库执行恢复。该同机备份不等于异机副本、ECS 快照、隔离恢复演练或生产回滚已经完成。
- Android 已接固定版本微信 OpenSDK：AppID 缺失时关闭；仅在隐私同意后由用户点击初始化；服务端 state 单次消费并校验 purpose/有效期，回调不记录 code/state/错误原文。当前固定身份政策是 `PHONE_ONLY`：手机验证码成功可直接创建账号和会话；微信、QQ、邮箱只登录已绑定身份；登录后可绑定微信。隐私撤回先同步封锁认证代际并清理 OAuth 状态，迟到登录、绑定或刷新响应不得写回 Keystore。
- 本分支正在把手机主链迁移为阿里云号码认证短信的纯服务端 `SendSmsVerifyCode` / `CheckSmsVerifyCode`：供应商动态生成验证码、`ReturnVerifyCode=false`，并增加同 challenge 数据库 lease、失败释放、成功消费和原子建号。Android 已删除号码认证供应商 SDK/source set/专属权限与旧入口；ECS 候选改用 `ALIYUN_PNVS_*`、最小 RAM 动作、动态 QQ/SMTP/微信字段及失败回滚。0010→0011 另有一次性 `legacy_phone_drain` 停号 bridge：只容忍完整 schema 或仅缺精确 0011，首次激活期间保留旧 `api.env` 以便回旧 API；迁移后失败只回停号 bridge，恢复旧 Fusion 需要迁移前数据库备份。0010 Fusion 表只为完成 24 小时历史数据清理而暂留，maintenance 仅获两项专用清理函数，不能据此认证。工程改造尚未等于生产部署或真实短信验收；当前活动 release 的账号能力仍关闭。
- 账号数据导出的 Android 与服务端安全链路已经实现：客户端可选择行为历史范围、恢复/刷新任务并通过系统文档选择器流式下载和校验；服务端包含鉴权、幂等任务、隔离 worker、私有 OSS 工件、短时下载、长度/SHA-256 校验及内存/并发/超时边界。当前实现不等于生产可用，真实阿里云 RDS、OSS 与 RAM 角色/权限组合仍未完成端到端验收。
- 支持反馈的共享契约、加密持久化、幂等与限流链路已经实现。公开配置只有在反馈服务完成数据库、双密钥环和历史密钥覆盖启动检查后才宣告 `supportFeedbackEnabled=true`；任一条件缺失、检查失败或服务关闭时都 fail closed，Android 设置页不提供提交入口，ViewModel 也不会触达反馈 API。
- Android 已实现进程级最低版本门禁：只有可信且兼容的远程配置才能开放普通接口；首次配置不可用且尚未确认更新要求时，游客只能取得关闭 AI 的规则推荐 lease，结果仅可展示或换一批，不能进入详情、执行出站动作或上报事件。一旦确认需要更新，加载失败、配置暂不可用或不兼容响应都不能把旧导航图或游客回退短暂恢复。锁定态仅放行配置复查、必要的 refresh、退出登录、账号注销和本机隐私撤回；已有会话的数据权利入口独立于普通账号产品入口。配置刷新代际由进程级单调门禁统一分配，旧 Activity/ViewModel 的晚到配置响应不能倒退代际或发布 UI；代际变化还会撤销推荐、地点搜索、账号、收藏与反馈的在途结果，旧推荐详情、动作和事件会话随即失效。运行中从强制更新恢复到可信兼容配置时会清除旧 `transientMessage` 与 `formError`，避免更新 Snackbar 重新遮挡主操作，但不会复活旧结果会话。
- 分享卡底层渲染、只读 FileProvider、单次生成租约、生命周期清理及其测试代码仍在仓库中封存，但 Android 1.0 由唯一的 `BuildConfig.SHARE_FEATURE_ENABLED=false` 编译期常量关闭入口，provider 同时统一返回 `share=false`，且不存在 Gradle 属性或远程开关。这些代码不再作为 1.0 能力、缺口或发布门禁；2.0 重新启用前必须重新完成产品、数据权利、隐私、安全和设备验证评审。
- Android Studio API 36 模拟器已通过 8 条核心 Activity 用例和 2 条分享封藏负例：兼容态 3 条、配置不可用 1 条、同进程最低版本提高 1 条、启动即强制更新 1 条；账号设备内合成 API 夹具 1 条覆盖手机号登录→邮箱绑定→退出→邮箱登录→退出及 15 个请求严格顺序；高德合成 `LIVE_DISPLAY_ONLY` 展示夹具 1 条覆盖实时来源标注、无自有评分、保持供应商顺序、出站动作关闭及 WGS84/25 元/1500 米/AI 关闭请求边界；分享负例 2 条继续证明 Android 1.0 无入口、Intent 或临时文件。账号与高德夹具均不调用真实外部供应商，不得作为真实凭据或真实数据验收。最终同签名 APK 先通过冷启动强制更新 1 条和恢复兼容 3 条，再通过运行中提高、配置不可用、账号、高德各 1 条及分享封藏 2 条；`scripts/run-android-instrumentation.ps1` 对设备内夹具执行类/参数精确白名单、按设备端口互斥、映射前后复核和外部变更拒绝覆盖。
- ECS 的真实高德技术 smoke 是独立证据：隔离容器、活动容器和工作站公网均得到 5 条地点结果与 3 条推荐结果；这不改变 Android 模拟器夹具仍为合成数据，也不能替代关闭 Wi-Fi 真机与商业授权验收。
- 普通 Android Debug 已改为默认直连 `https://api.unfinished-era.com/`，并与 Alpha 复用当前单实例 API/PostgreSQL；不新增 Debug 服务容器、端口、域名或数据库。Debug 地址门禁只接受公网 HTTPS，主 Debug APK 使用全局禁止明文的 network security config。确定性 AndroidTest 已迁移到独立 `fixture` build type：它固定使用 `127.0.0.1:3001`、输出到独立路径、不可分发，也不会成为日常 Debug 的隐式回退。当前云端 `accountsEnabled=false`；Debug 的微信/QQ AppID 继续为空，单实例服务端支持受批准的多 AppID 绑定前不得开放。
- Android `0.1.2-alpha01-internal` 已完整移除直接餐厅关键词搜索的入口、路由、页面、ViewModel、repository 和 client；手动地点搜索只用于选择推荐起点。此前在 API 36 模拟器全新安装后，选中“北京电子科技学院”取得 3 条真实高德推荐；2026-08-24 完整门禁构建的 Alpha APK SHA-256 `DD7257BCE3098DD658D30A8E7D6EAFECB980D627CCCB9C3B516BF7B32DCCEC07` 属于迁移前 Debug signer 历史基线，不能再作为当前固定签名 Alpha 工件或平台登记依据。
- Android 内部 Alpha 已固定为 `com.chishenme.app.alpha` 和长期证书：MD5 `7c64a4f134a3ebe121c1fb055c09a70c`、SHA-256 `31f21374f2f5d40697efb3c50e14d4e8d228991f6acbcde262e37c72ae4c0289`。私钥与密码位于仓库外；Gradle 支持默认 `%LOCALAPPDATA%\ChiShenMe\signing\alpha-signing.properties` 或四项 `CHISHENME_ALPHA_*` 环境变量，缺失、部分配置、错误 alias、过期或摘要不匹配都会拒绝构建，不再回退到 Debug signer。Debug/Fixture/FixtureTest 保持测试证书一致，Alpha 必须与其不同。当前完整门禁必须显式执行：

  ```powershell
  .\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
  ```

  门禁会复核地址策略并检查同一地址已进入 Debug/Alpha `BuildConfig` 与 APK DEX，同时证明 Fixture 只含固定回环地址且 AndroidTest 只指向 Fixture；还会核对 Alpha 固定证书摘要、唯一 signer、v2 签名以及与 Debug 测试证书隔离。它不会发起公网探测。DNS、TLS、独立 API vhost 与 `/health/ready` 已由独立公网 smoke 验收，关闭 Wi-Fi 真机与最终 Release 的独立签名仍不能由构建门禁替代。
- `scripts/start-api-local.ps1` 可从已忽略的 `.env.local` 注入服务端配置并隐藏密钥值；构建子进程不继承运行时 Secret，API 子进程只接收明确白名单字段。邮件验证码使用标准 SMTP，阿里云只负责短信；仓库内所有中文 PowerShell 脚本均以 UTF-8 BOM 保存，并由验证脚本检查 Windows PowerShell 5.1 兼容性。
- `pnpm dev:api` 现在先按项目 TypeScript 配置生成带 Nest 装饰器元数据的编译产物，再监听源码并以 Node 运行 `dist`；独立运行时冒烟测试会在随机本机端口验证健康、配置和地点搜索，防止以后退回会破坏依赖注入的直接 esbuild/tsx 执行路径。
- 已落地 [`openapi.v1.json`](./openapi.v1.json) 作为 OpenAPI 3.1 v1 单一文档源；生成门禁会校验 JSON、本地引用、controller 路由/方法/状态码、Zod input/output、Bearer、安全错误和管理员 passkey/RBAC 隔离，并覆盖配置中心四条路由、严格五键 schema 与 409 乐观并发冲突。账号契约正在同步为 PHONE_ONLY，生成产物必须在接口收束后重新生成，不能把旧文档、配置状态或路由存在冒充功能可用。

## 尚未声称完成

- 高德商业授权、App 备案、商标核查、算法/等保判断以及应用商店审核。
- 真实阿里云号码认证短信、标准 SMTP 邮件、微信、QQ 的供应商凭据、平台资质、包名/签名登记以及账号绑定/冲突场景的外部环境验收；客户端与服务端代码存在不代表平台审核或真实投递通过。
- 最终 ECS API 镜像、RAM 最小权限/IMDSv2、当前可用签名与配套模板、真实发送/校验的成功/失败/限流/超时/并发/重放 smoke，以及 ARM64 + 中国大陆 SIM 真机的后台切换与页面恢复。SMTP 当前 DMARC 为 `false`，在 Alpha 记录为非阻断缺口，对外发布前必须完成。
- 可交互地图选点、任意地址自由编辑和逆地理编码；全国地点关键词搜索已经完成，内置手动测试点仍作为拒绝定位、无网或上游不可用时的回退。
- ECS 自托管 PostgreSQL 17/PostGIS 3.5 的 bootstrap、迁移、实际角色名（`api_runtime`、`schema_migrator`、`retention_worker`、`admin_api_runtime`、`data_export_worker`）和基础 API 启动已完成；GitHub PostGIS 完整负例矩阵、RDS/OSS/RAM/SLS/EMAS、导出 worker、保留期 execute、异机备份恢复和 RAM 角色隔离仍待真实环境验收。
- 跨设备收藏、跨设备历史、账号注销和备份滚动清除的真实环境验收；本机白名单决策历史已经完成，账号导出代码链路已完成但仍受上述 RDS/OSS/RAM 门禁约束。
- App 内地图浏览/筛选，以及真实电话、外部地图导航、复制动作的数据授权及全设备验证。高德 Web Service 基础地点搜索、独立餐厅关键词搜索和推荐技术链路由服务端继续维护，但商业许可、详情字段和动作矩阵仍未完成；其中直接餐厅关键词搜索不属于 Android 1.0 产品能力，不能因服务端接口仍存在而恢复客户端入口。分享推荐卡同样不属于 Android 1.0 待交付或待验收范围，不能把封存代码或契约字段存在解释为已开放外传能力。
- 300 家餐厅人工核验、200 个黄金场景、50–100 人 Beta 和 30 天稳定性数据。
- Android 1.1/1.2/2.x、微信小程序和 iOS。

## 当前运行模式

本地默认配置是 `LIVE_DISPLAY_ONLY`、高德关闭、千问关闭，用于离线开发和安全演示；ECS 封闭 Alpha 在凭据和白名单门禁通过后单独启用了高德：

- 适合度为 `null`，不伪装为已授权的自有评分。
- 演示餐厅明确标记 `DEMO`，不能用于生产或对外宣传。
- 演示地点搜索也明确标记 `DEMO`；真实高德地点搜索和推荐都只在服务端开关与 Key 同时有效时启用。
- 千问关闭或失败时由确定性规则生成结构化意图。
- 真实供应商密钥只允许从服务端环境变量注入，禁止写入客户端或仓库。

## 下一里程碑

1. 登录主线：完成 PHONE_ONLY 契约/API/数据库/Android/ECS 改造和完整门禁后，才从当前 HEAD 产出候选镜像；先复核 RAM/IMDSv2、控制台当前签名/模板和失败关闭，再做真实短信发送/校验及 ARM64 + 中国大陆 SIM 真机闭环。微信/QQ/邮箱保持“仅已绑定登录”，未具备真实材料和验收时各自关闭，不伪造外部验收。
2. 高德主线：ECS root-only 凭据、固定出口 IP 白名单、readiness、真实地点搜索/推荐、release 切换、独立 API 子域与公网 HTTPS 已通过。下一步只做关闭 Wi-Fi 的外部真机、弱网/配额/故障恢复和授权边界复验；Key/私钥继续不得写入 Android、仓库、APK、日志、报告或聊天记录。
3. 除登录与高德之外的 Android 1.0/后续功能开发暂缓；现有成果和发布门禁继续保留，不在这两条主线推进期间顺带扩展。
