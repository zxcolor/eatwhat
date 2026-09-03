# 测试与验收计划

## 自动化层级

- 共享契约：边界值、默认值、URL/UUID/时间格式、事件严格拒绝额外字段；来源代码接受符合约束的新授权 provider、拒绝非法格式；每条推荐必须有 43 字符 Base64URL `resultToken`、`LIVE/DEMO` 和严格的导航/拨号/复制/分享四项动作对象，公开结果与事件不得出现稳定 POI ID。API v1 暂时保留 `share` 以兼容既有客户端，但当前全部 provider 必须返回 `false`。
- 推荐领域：全国合法坐标、显式 CRS、WGS84/GCJ-02 一次性转换、混合坐标系拒绝、距离、时间预算、停业/预算/排除硬过滤、未知价格、去重、多样性、授权模式适合度；未知但格式合法的 provider 不改变领域规则，非法来源、模式或动作结构必须安全拒绝。
- AI：有效 JSON、超时、网络错误、无效 Schema、一次短重试和确定性回退；AI 虚构餐厅事实必须为零。
- 地点搜索：关键词长度、危险输入拒绝、独立限流、全国结果、最多 5 条、显式 CRS、无稳定 POI ID；高德请求不得锁定城市，成功/业务失败/超时/超大响应/字段缺失，以及 development/test DEMO 和 production 无来源安全失败均需覆盖。
- 高德 Web Service 专项：文本搜索、周边推荐、附近餐厅关键词搜索和已授权 ID 详情四条链路都必须只请求精确 `https://restapi.amap.com` 且携带可独立复算的官方 `sig`，签名私钥不得进入 URL/错误/序列化。覆盖官方签名样例、重复参数/非法主机拒绝、生产缺少签名私钥或 IP 白名单确认启动失败、ID 每批最多 10 个、安全 infocode 分类与无上游 `info` 回显。PowerShell live-smoke 门禁用假 `pnpm`/假 `node` 验证六变量选择、构建时清空密钥、缺少签名/白名单时零网络拒绝和调用者环境恢复。
- API：健康、配置、推荐、地点搜索、推荐事件和支持反馈；账号能力矩阵固定验证 PHONE OTP 直接注册/登录，EMAIL/WECHAT/QQ 仅已绑定登录，以及登录后三者主动 BIND；未绑定 OAuth/邮箱不得建号，所有账号恢复路径继续拒绝。QQ Server-Side 专项覆盖一次性 authorization code、AppID/AppKey 换票、固定 redirect URI、token 与 `/me` 两阶段超时/超大/重定向/畸形响应、AppID 不匹配、UnionID 开关及错误脱敏；access/refresh token、OpenID/UnionID 和供应商原文不得持久化或记录。覆盖 refresh/logout、身份与设备会话、导出、注销、收藏、历史、私有反馈；隔离管理员 passkey、会话、凭据自助、RBAC 与脱敏审计。邮箱投递必须覆盖 SMTP 启动 `verify()`、465 隐式 TLS、587/25 强制 STARTTLS、固定纯文本、收件人精确匹配、禁用附件/URL/file 内容及错误脱敏。号码认证客户端只允许服务端调用 `SendSmsVerifyCode` / `CheckSmsVerifyCode`，发送固定 `ReturnVerifyCode=false`。token/challenge 覆盖防伪造、跨请求复用、同类重放、过期、覆盖、撤销、并发 lease 和销毁清理；能力或数据库就绪性不足时各领域 fail closed；错误响应不得包含堆栈、请求体、手机号、验证码、凭据或供应商响应原文。
- 数据库纯单测：production/development/test 启停与 URL/TLS/角色脱敏，Pool 启动失败释放顺序和事务 commit/rollback/release，迁移固定路径、严格 UTF-8、事务控制扫描、连续版本/checksum/未知记录、有界 advisory lock、幂等与失败回滚，retention dry-run/execute 固定策略，以及 SQL 隐私/枚举/受限函数/角色脚本静态门禁。`AUTH_SCHEMA_TRANSITION_MODE` 只接受 `none` / `legacy_phone_drain`；bridge 必须停号，只接受完整 schema 或仅缺精确最后一项 `0011_phone_only_auth.sql`，缺两项、名称漂移或账号开启都拒绝。纯单测不宣称 SQL 已被 PostgreSQL 执行。
- 支持反馈 PostgreSQL HTTP E2E：专用命令 `pnpm --filter @chi-shen-me/api test:support-feedback-postgres` 必须同时显式设置 `SUPPORT_FEEDBACK_POSTGRES_E2E=true`、runtime 角色的 `SUPPORT_FEEDBACK_POSTGRES_E2E_DATABASE_URL` 和独立清理角色的 `SUPPORT_FEEDBACK_POSTGRES_E2E_CLEANUP_DATABASE_URL`。前置 wrapper 缺任一条件即非零退出，防止 Vitest 的条件跳过被当成绿色；启用后覆盖 readiness/能力声明、游客纠错幂等、冲突、数据库配额、关闭重启失败关闭和前后精确清理。普通无 opt-in 单测中的 skip 不构成真实 PostgreSQL 证据。
- ECS bridge 脚本门禁：`--legacy-drain` 必须关闭六个账号开关、逐字节保留共享 `api.env`、只放行固定旧 hash/OTP、SMS、Fusion、微信字段；未知/重复/空字段拒绝。`--apply` / `--disable` 必须恢复 transition=`none` 并继续使用普通严格字段集合，且两者在创建候选文件前都必须直接核验活动 bridge、0011 和最小 ACL。CI 构造旧 Fusion/SMS/微信字段但未激活 bridge 的错误顺序，分别对 `--apply`、`--disable` 断言非零退出、共享 `api.env`/`deployment.env` 摘要不变且无临时候选。CI 还必须真实持有 `/run/lock/chi-shen-me/mutation.lock` 后分别调用 provision、隔离 restore 和生产 rollback，证明三者均在 preflight/备份校验/数据库动作前拒绝；bundle 自检覆盖锁路径、root 权限、继承 FD8 和完整关键区间顺序。候选激活回退、迁移前备份、0011+角色授权/ACL smoke 和“schema 已迁移时只能回停号 bridge”的恢复语义仍须在 ECS 演练，不由本机静态检查冒充。
- ECS 紧急停号连续性：正常 PHONE_ONLY 的 `--disable` 必须原样保留身份/会话 HMAC、dedup version 和已有 OTP pepper，同时清退通道字段。CI 随后用不同 dedup version 执行 `--apply`，要求在 Docker、preflight 和文件替换前失败，`api.env` / `deployment.env` 摘要不变且临时文件清零；只有相同连续性材料可以重新启用，且 EMAIL 仍关闭时也不得顺带销毁已保留的 OTP pair。
- 真实 PostGIS CI：固定 `postgis/postgis:17-3.5-alpine` 从空库开始，以独立 bootstrap/migration/runtime/maintenance 角色完成扩展 owner/version 预检、连续迁移、事务化 role grants、缺变量/未知角色非零退出、中途失败 ACL 回滚、历史列 ACL 收敛、runtime schema verify 和 API 启动。正反例覆盖 runtime 不能直写 user/identity，却能调用最小函数；PHONE OTP 消费后原子建号、同一 challenge 并发 lease 只有一个供应商核验者、失败释放/成功完成、OAuth state 一次性消费、WECHAT/QQ 绑定身份抢占拒绝、refresh 重放拒绝。maintenance 无敏感读取但可实际调用通用 cleanup，并独占执行历史 `FUSION_AUTH_24H` preview/execute；runtime/admin/export 对这两个历史数据最小化函数的 EXECUTE 必须为 false。
- 真实数据库尚未在当前 Windows 会话运行：本机没有 Docker、psql 或 PostgreSQL。首次 CI 绿灯后仍须在阿里云预发布 RDS/PostGIS 重跑 extension bootstrap、迁移/幂等、角色矩阵、备份恢复和 runtime smoke；CI 不能替代托管环境权限与恢复演练。
- OpenAPI：JSON 和本地引用可解析，全部实际公共与隔离管理员 controller operation 的路径/方法/成功状态码与文档自动对齐；Zod input/output 关键约束、通用来源/数据模式/动作对象、坐标或搜索词 body-only 规则，以及普通 Bearer 与管理员 passkey/session 契约隔离均不得漂移。
- 能力发现与健康：`serviceCapabilities` 完整、缺失和部分缺失三种响应都要覆盖。服务端仍独立声明 `recommendationsEnabled`、`locationSearchEnabled` 与 `placeSearchEnabled`；Android 1.0 只有看到前两项明确为 `true` 才能开放对应远程入口，并必须忽略 `placeSearchEnabled`。即使该字段为 `true`，Android 也不得出现直接餐厅关键词搜索 UI、路由、API client 或网络调用；服务端 `/v1/place-search`、OpenAPI 与 provider 的契约、失败关闭和 generation 行为继续在 API 层独立验证。`/health` 只测进程存活，`/health/ready` 分别覆盖数据库就绪/失败和核心推荐 adapter 可用/不可用；readiness 不调用高德等外部供应商，也不得在 503 中泄漏数据库或 provider 细节。
- Android：餐段默认值、显式 WGS84 请求映射、精确/仅大致位置、首次取消/普通拒绝/永久拒绝、定位关闭/超时/页面离开取消、固定地点与关键词手动选址、搜索输入变化取消、晚到响应丢弃、客户端硬约束、加载/空/错误/成功状态，以及 30 条/90 天本地历史与隐私撤回清理；账号侧必须在发网或拉起 SDK 前执行同一身份矩阵，隐私撤回要同步废止认证 lease、取消微信/QQ state/proof，并证明不配合取消的迟到登录、注册或 refresh 不能写回 Keystore。QQ 还要覆盖 `loginServerSide` code 证明、89,999/90,000 ms 超时边界、取消/失败、无 QQ/TIM、能力关闭、账号 epoch 变化、迟到 callback 和进程重建不恢复授权状态。地点选择器、输入草稿、加载和成功结果只能由 Activity 级内存 ViewModel 跨配置重建保留，显式关闭、真实退后台、隐私撤回、配置代际变化或进程死亡必须清除。严格校验且只透传两小时、请求作用域的 `resultToken`，旧结果不能与新请求 ID 混合上报，详情/导航/历史和任何出站动作均不得泄漏 token，客户端不得接收或推断稳定地点 ID；契约不兼容异常即使被网络层包装也必须经有限、防循环的 cause 链识别，远程配置要区分成功、不可用和不兼容且两种失败均关闭 AI。首次配置不可用只能为游客开放关闭 AI 的规则展示 lease，结果只可查看或按相同条件重新请求（结果可能相同）且不得进入详情、执行动作或上报事件；该操作不得宣称跨请求反重复，不得新增稳定 POI ID 的上传、暴露或持久化。一旦确认需要更新，后续配置不可用不得再开放该回退。进程级最低版本门禁必须覆盖初次未知、兼容、需要更新、配置不可用/不兼容、进程单调可信配置代际和从锁定态恢复，两个旧新 ViewModel 的乱序响应不能倒退代际或发布旧 UI；已确认的更新要求在下一次可信兼容配置到达前保持粘滞，可信兼容恢复必须同时清除旧更新 Snackbar/表单错误但不得复活旧结果；普通接口与配置复查/必要 refresh/退出/注销的例外必须按 HTTP 方法和精确路径匹配；每项已开放详情动作都要分别覆盖允许与拒绝，未知合法 provider 不触发供应商分支，非法 provider/模式/动作响应不得进入 UI。
- Android 结果生命周期：配置刷新或最低版本提高时，推荐、地点搜索、账号、收藏和反馈的在途响应不能写回；旧推荐详情、导航/拨号/复制和事件上报必须在实际出站前复查当前会话。推荐结果和详情选择只保留在内存 ViewModel；可恢复 UI 状态只允许保存安全的筛选和列表/方位图偏好，严禁保存餐厅对象、坐标或 token。Activity 配置重建后推荐结果、筛选、详情和地点搜索草稿/结果应恢复，进程死亡后敏感会话应失效。Android 1.0 还必须验证直接餐厅关键词搜索入口、路由、client 与请求均不存在，并验证 `SHARE_FEATURE_ENABLED` 在 Gradle 中只有一个固定 `false` 定义，Debug/Fixture/Alpha 生成的 `BuildConfig` 均为 `false`，界面没有分享入口，且不存在 Gradle 属性或远程开关。封存分享测试仍参与编译与 JVM 回归，但不作为 1.0 设备验收或发布门禁。
- Android 1.1 候选回归：主动场景需逐项验证确定性参数映射、地点/菜系保留及手动调整后标签清除；偏好向量需覆盖严格五字段 0–100 边界、默认值、本机保存/清除/隐私撤回、快速连续编辑不被旧 DataStore 回声覆盖，以及请求序列化。推荐领域必须证明该向量只影响 `LICENSED_ENRICHMENT` 的软评分，权重为零时不生成误导性的对应排序理由；`LIVE_DISPLAY_ONLY` 即使收到不同向量也保持供应商顺序、`fitScore=null` 且不做自有重排。桌面小组件需验证 manifest 元数据、无新增权限、显式不可变 `PendingIntent` 和无位置/POI/token 数据；相同条件重试文案不得出现“换一批”或跨请求反重复承诺。
- Android 1.2 候选回归：共享契约需覆盖旧请求默认 `MEAL/NONE`、三餐与奶茶/咖啡/甜品的 profile/版本组合、三个有界用户体感及严格 weather application 映射；六字段 `specialtyCapabilities` 缺失时应全部关闭，完整对象可用，部分对象必须拒绝。API 需证明 AMAP 只接受三餐 + `NONE` 且在任何垂类/用户体感的上游 I/O 前失败关闭，DEMO 只在 development/test 接受全部候选 query plan，production 仍拒绝 DEMO；特殊 profile 必须零 Qwen 调用并回显实际 profile/weather application。Android JVM 测试需覆盖入口按可信能力逐项显示、配置刷新撤销和安全重置、提交/重试前二次能力检查、特殊路径强制 AI off、响应 echo 不匹配拒绝，以及体感不进入 DataStore/SavedState/日志。`LIVE_DISPLAY_ONLY` 回归仍必须证明保持 provider 顺序、`fitScore=null`、无自有重排和无跨请求 POI 持久化。上述定向测试与静态编译只构成代码候选证据；新增设备流程、真实供应商分类授权、生产部署和天气服务仍需独立验收。
- Android 工件：普通 Debug 必须是 `com.chishenme.app.debug`、可调试、全局禁止明文流量，并在 `BuildConfig` 与 APK DEX 中包含与 Alpha 相同的公网 HTTPS 地址；不得包含服务端 Secret。不可分发的 Fixture 仍使用同一 applicationId，但必须输出到独立 `fixture` 路径、固定回环 API 且单独携带允许 localhost 的 network security config；AndroidTest 必须只以 Fixture 为 target。内部 Alpha 必须是 `com.chishenme.app.alpha`、不可调试、启用 R8/资源压缩，且只能使用固定证书 MD5 `7c64a4f134a3ebe121c1fb055c09a70c` / SHA-256 `31f21374f2f5d40697efb3c50e14d4e8d228991f6acbcde262e37c72ae4c0289`。缺少、部分、错误或过期签名材料必须在生成 APK 前失败，不得回退到 Debug signer；Debug/Fixture/FixtureTest 必须保持同一测试证书，Alpha 必须与其不同。GitHub CI 不持有 Alpha 私钥，并必须反向证明无签名配置时 `assembleAlpha` 因缺少固定签名而失败且没有生成 `app-alpha.apk`。完整本机门禁必须先在当前进程通过 `CHISHENME_ALPHA_WECHAT_APP_ID`、`CHISHENME_ALPHA_QQ_APP_ID` 注入受控的 Alpha 微信和 QQ 公开 AppID（不得使用微信 AppSecret 或 QQ AppKey），并验证 QQ JAR 固定哈希、BuildConfig/DEX、scheme、两项 Activity、SDK/R8 类和客户端无 Secret，再使用
  `.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'`，同时证明 Debug/Alpha 云端地址一致、Fixture 未进入可分发 Debug 工件，并复核 Alpha 单 signer、v2、固定 MD5/SHA-256 和 16 KiB 对齐；Release 缺少公网 HTTPS 地址或其独立正式签名材料时安全失败。地址策略、APK 嵌入与签名检查不等于 DNS、TLS、Nginx 或公网 API 可达，后者必须单独执行公网 smoke 和关闭 Wi-Fi 真机验收。
- ECS 发布与恢复：部署 bundle 必须是无 Secret 的固定文件集，工作站校验 `SHA256SUMS` 后上传到新的不可变 release；服务器预检要拒绝错误路径、权限、所有者、镜像坐标、共享状态、数据库证书或 Compose 配置。数据库备份测试必须覆盖固定 root-only 目录、禁止覆盖、精确文件清单、SHA-256、`pg_restore --list`，恢复只能进入全新隔离数据库；本机恢复成功不能替代 ECS 快照、异机副本和显式生产回滚演练。
- 端到端：所有确定性 instrumentation 使用独立 Fixture App/Test APK，绝不让普通云端 Debug 访问本机接口。API 演示模式配合 Android Studio API 36 模拟器执行兼容态 3 条语义用例，覆盖隐私门、关键词地点输入/结果重建、快捷地点回退、选择地点后回到决策流程、直接餐厅关键词搜索入口不存在、推荐结果筛选/方位图重建、推荐详情重建及返回、详情动作门禁和反馈关闭态；以设备内隔离夹具执行 `MainActivityConfigUnavailableTest` + `configUnavailable=true`，验证首次配置 503 的 guest 规则展示态、Activity 重建和零额外事件；再执行 `MainActivityRuntimeVersionRaiseTest` + `runtimeVersionRaise=true`，验证同进程 `0.1.1 → 99.0.0 → 503 → 0.1.1`、旧在途结果/事件撤销、失败复查粘滞锁定、兼容恢复清理旧错误及显式新请求。第七个基础语义场景使用 `MainActivitySupportFeedbackLocalFixtureTest` + `supportFeedbackLocalFixture=true` 与设备内回环 API，验证游客餐厅纠错正文只在 JSON body、URL 无 query、无 Authorization，以及能力关闭后的零额外 POST；必须通过 `-UseDeviceLocalApiFixture` 的精确白名单运行。该新增用例截至 2026-09-03 仅纳入 AndroidTest 编译门禁，本批次没有连接设备，未执行真机或模拟器 instrumentation，不能表述为设备通过。
- 登录设备闭环：执行账号 Fixture，验证隐私同意前零请求、手机号验证码发送/输入/成功后建号、身份与会话读取、退出，以及微信/QQ/邮箱未绑定失败。Fixture 只验证 Android/API 边界，不伪造真实短信、邮件、微信或 QQ 供应商。真实 QQ 验收必须在原账号内先绑定，再经用户明确同意退出并用 QQ 登录同一账号，最后强停冷启验证自有会话恢复。
- 手机短信工程门禁：源码、依赖、merged manifest、Debug/Fixture/FixtureTest/Alpha APK
  均不得包含号码认证供应商 Android SDK、`READ_PHONE_STATE`、旧手机号快捷登录或图形
  验证文案。API/PostgreSQL 测试覆盖供应商动态验证码、`ReturnVerifyCode=false`、
  错误/过期验证码、限流、超时、同 challenge 并发 lease、失败释放、成功原子建号与
  重放拒绝。真实验收使用 ARM64 + 中国大陆 SIM 真机覆盖发送、重发、弱网和供应商限流。
- 微信 UnionID alias：真实 PostgreSQL 分两阶段验证 exact schema11 的 PHONE_ONLY ACL，再执行
  0012 并验证 exact schema12；同一 consumed 微信 state 与匹配 AppID+OpenID binding 可写入
  `realm + UnionID HMAC`，重复回调幂等更新验证时间，缺 UnionID 时不创建 alias 但允许已有
  binding 登录。不同用户争抢同 realm+hash、同用户返回不同 hash、state 与 binding 哈希不匹配
  均必须原子冲突且不创建会话/新绑定。解绑保留 alias，账号最终删除级联清除；API/runtime
  角色不能直接访问 alias 表，只有 API runtime 可执行三项受限函数。schema11→12 必须先以
  微信关闭的 pending bridge 创建并验证备份；alias 非空后 schema12→11 普通回滚必须拒绝。
- QQ realm 去重：唯一权威是 root:root、`0600` 的共享
  `/opt/chi-shen-me/shared/auth-identity-state.env`，精确三键为 format version 1、realm 和单调 marker；
  `deployment.env`、认证候选与 API 环境均不得携带 marker。缺文件首次启用或 `false→true` 提升
  必须让活动 QQ 通道保持关闭，只输出聚合计数并确认旧 QQ binding 为零。CI 必须覆盖：缺文件且
  非零时共享状态/API/deployment 均不变；零计数直接持久化 marker=`true`；随后强制 preflight
  失败时 API/deployment 回滚而共享状态不回滚；旧 release 没有 marker 时以 shared=`true` 恢复
  候选且非零 binding 不再触发计数；disable 保留、re-enable 成功、OpenID-only 降级及候选 marker
  注入拒绝。lookup 固定使用 AppID+OpenID HMAC，dedup 使用
  `open-platform:<稳定 realm>`+UnionID HMAC。相同 realm/UnionID 必须冲突或命中同一账号，不同
  realm 的同字符串不得相撞；开关关闭时即使上游意外返回 UnionID 也必须忽略。
- 高德展示边界：执行 `MainActivityAmapLiveFixtureTest` + `amapLiveFixture=true`，验证合成的 AMAP `LIVE_DISPLAY_ONLY` 响应保持实时来源标注、`fitScore=null`、供应商顺序、出站动作关闭，客户端发送 WGS84、预算 25 元、半径 1500 米、AI 关闭且无账号凭据；该夹具不使用高德 Key 或官方端点，不得表述为真实高德联网验收。
- 最低版本与恢复：以独立高最低版本配置执行 `MainActivityMinimumVersionGateTest` + `minimumVersionGate=true`，验证启动即强制更新、普通远程入口关闭、重查仍锁定、数据权利/隐私撤回可达，并恢复兼容配置后重跑 3 条正常链路，防止只锁不解。ADB 严格运行器必须只接受配置不可用、运行中最低版本提高、账号、本地高德展示、支持反馈五项设备内夹具的测试类与唯一参数精确配对；端口操作需持有按设备/端口互斥锁，移除和恢复前复核实时映射，外部状态改变时不得覆盖。分享设备测试不属于 Android 1.0 验收矩阵或发布门禁；内部 Alpha 冷启动仍需无超时或 ANR。
- 公网闭环：`api.unfinished-era.com` 必须使用独立 DNS、证书和 API Nginx vhost；先从公网区分验证 `/health` 与 `/health/ready`，再验证 `/v1/config` 的失败关闭能力声明和真实推荐。普通 Debug 需要无 `adb reverse` 的设备 smoke，覆盖配置、地点选择和推荐；关闭 Wi-Fi 的真实手机仍以同一 Alpha 完成发布前复验。不得把本机回环、APK 中出现域名或基础 liveness 作为公网闭环证据。

## 黄金场景

正式 Beta 前建立至少 200 个固定场景，覆盖：

- 北京、上海及至少一个其他城市的有效坐标、定位精度不同、跨城市关键词地点搜索、取消/晚到响应和快捷地点回退。
- 早餐、午餐、晚餐及跨日营业。
- 15/25/40 元和不限预算。
- 30/45/60/90 分钟；步行、骑行和公交。
- 一人/多人、排除菜系、稳妥/探索。
- 全部停业、价格全部未知、供应商超时、AI 无效 JSON、弱网和断网恢复。

每次规则、提示词、模型或供应商字段映射变化都要跑完整黄金集，并保存差异报告。

## 质量目标

| 指标 | 内测目标 |
|---|---:|
| 首次使用无需帮助完成推荐 | >= 80% |
| 推荐请求 P50 / P95 | < 3 秒 / < 6 秒 |
| AI 故障回退 | < 2.5 秒 |
| 进入首页到选择 | <= 45 秒 |
| 同条件重新请求率 | < 50% |
| 连续三次同条件重新请求仍未选择 | < 15% |
| 明确停业或明显越界推荐 | < 2% |
| 明显超预算 | < 5% |
| Top 3 至少两种选择 | >= 80% |
| 连续三次重复主推荐 | < 10% |
| AI 结构化输出有效率 | >= 99.9% |
| 崩溃无故障会话 | >= 99.5% |
| ANR | < 0.3% |

这些指标只有在真实 Alpha/Beta 样本达到计划规模后才能宣称达标，自动化测试通过不能替代线上观测。

## 设备矩阵

API 26、28、31、33、34、35、36；华为、小米、OPPO、vivo、荣耀、三星；有/无 GMS；低内存、折叠屏、刘海屏、字体放大、深色模式、读屏、权限自动重置、2G/3G 弱网和后台回收。
