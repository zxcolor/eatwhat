# 测试与验收计划

## 自动化层级

- 共享契约：边界值、默认值、URL/UUID/时间格式、事件严格拒绝额外字段；来源代码接受符合约束的新授权 provider、拒绝非法格式；每条推荐必须有 43 字符 Base64URL `resultToken`、`LIVE/DEMO` 和严格的导航/拨号/复制/分享四项动作对象，公开结果与事件不得出现稳定 POI ID。API v1 暂时保留 `share` 以兼容既有客户端，但当前全部 provider 必须返回 `false`。
- 推荐领域：四环覆盖、显式 CRS、WGS84/GCJ-02 一次性转换、混合坐标系拒绝、距离、时间预算、停业/预算/排除硬过滤、未知价格、去重、多样性、授权模式适合度；未知但格式合法的 provider 不改变领域规则，非法来源、模式或动作结构必须安全拒绝。
- AI：有效 JSON、超时、网络错误、无效 Schema、一次短重试和确定性回退；AI 虚构餐厅事实必须为零。
- 地点搜索：关键词长度、危险输入拒绝、独立限流、北京严格过滤、最多 5 条、显式 CRS、无稳定 POI ID；高德成功/业务失败/超时/超大响应/字段缺失，以及 development/test DEMO 和 production 无来源安全失败。
- 高德 Web Service 专项：文本搜索、周边推荐、附近餐厅关键词搜索和已授权 ID 详情四条链路都必须只请求精确 `https://restapi.amap.com` 且携带可独立复算的官方 `sig`，签名私钥不得进入 URL/错误/序列化。覆盖官方签名样例、重复参数/非法主机拒绝、生产缺少签名私钥或 IP 白名单确认启动失败、ID 每批最多 10 个、安全 infocode 分类与无上游 `info` 回显。PowerShell live-smoke 门禁用假 `pnpm`/假 `node` 验证六变量选择、构建时清空密钥、缺少签名/白名单时零网络拒绝和调用者环境恢复。
- API：健康、配置、推荐、地点搜索、推荐事件、支持反馈；账号能力矩阵固定验证 PHONE REGISTER/LOGIN、EMAIL LOGIN/BIND、WECHAT REGISTER/LOGIN、QQ LOGIN/BIND，并反向拒绝 PHONE/WECHAT BIND、所有 RECOVERY 及跨用途字段；同时覆盖 refresh/logout、身份与设备会话、导出、注销、收藏、历史、私有反馈；隔离管理员 passkey、会话、凭据自助、RBAC 与脱敏审计。邮箱投递必须覆盖 SMTP 启动 `verify()`、465 隐式 TLS、587/25 强制 STARTTLS、固定纯文本、收件人精确匹配、禁用附件/URL/file 内容及错误脱敏；阿里云客户端只允许承担短信。token 覆盖防伪造、跨请求复用、同类重放、过期、覆盖、撤销、容量淘汰和销毁清理；`LIVE_DISPLAY_ONLY` 不留存外部 ID，`LICENSED_ENRICHMENT` 只使用服务端解析的引用；能力或数据库就绪性不足时各领域 fail closed；非法 JSON、超过 100 KiB、错误 Content-Type 的 400/413/415；错误响应不得包含堆栈、请求体、坐标、搜索词、非法请求 ID、凭据或供应商响应原文；必须对 `tsc` 编译产物启动独立进程，在随机本机端口验证健康、配置和地点搜索演示接口均为 200，并在测试结束后回收进程，以防开发启动链路绕过 Nest 装饰器元数据生成。数据库/管理员的更细安全矩阵分别以 `DATA_EXPORT_ARCHITECTURE.md`、`ADMIN_SECURITY_ARCHITECTURE.md` 和真实 PostGIS CI 为准。
- 数据库纯单测：production/development/test 启停与 URL/TLS/角色脱敏，Pool 启动失败释放顺序和事务 commit/rollback/release，迁移固定路径、严格 UTF-8、事务控制扫描、连续版本/checksum/未知记录、有界 advisory lock、幂等与失败回滚，retention dry-run/execute 固定策略，以及 SQL 隐私/枚举/受限函数/角色脚本静态门禁。纯单测不宣称 SQL 已被 PostgreSQL 执行。
- 真实 PostGIS CI：固定 `postgis/postgis:17-3.5-alpine` 从空库开始，以独立 bootstrap/migration/runtime/maintenance 角色完成扩展 owner/version 预检、0001、重复迁移、事务化 role grants、缺变量/未知角色非零退出、中途失败 ACL 回滚、历史列 ACL 收敛、runtime schema verify 和 API 启动。正反例覆盖 runtime 看不到权利/provider 基表且不能直写 user/identity，却能调用最小函数；OTP/OAuth/refresh 一次性消费与重放拒绝；OAuth verified subject proof 封存；PHONE+WECHAT REGISTER 同 flow/device 配对；ACTIVE 父账号；含已旋转 refresh 链和未删除/已删除 OSS 导出物的注销；30 天 tombstone；provider 必填的授权 operation 查询；并发 provider upsert/撤销、过期授权+回填事件拒绝、过期引用不可复活，以及 maintenance 无敏感读取但能 preview/execute cleanup。
- 真实数据库尚未在当前 Windows 会话运行：本机没有 Docker、psql 或 PostgreSQL。首次 CI 绿灯后仍须在阿里云预发布 RDS/PostGIS 重跑 extension bootstrap、迁移/幂等、角色矩阵、备份恢复和 runtime smoke；CI 不能替代托管环境权限与恢复演练。
- OpenAPI：JSON 和本地引用可解析，全部实际公共与隔离管理员 controller operation 的路径/方法/成功状态码与文档自动对齐；Zod input/output 关键约束、通用来源/数据模式/动作对象、坐标或搜索词 body-only 规则，以及普通 Bearer 与管理员 passkey/session 契约隔离均不得漂移。
- 能力发现与健康：`serviceCapabilities` 完整、缺失和部分缺失三种响应都要覆盖，Android 只有看到明确 `true` 才能开放对应远程入口；餐厅关键词搜索的能力必须与可信配置 generation 同时校验，旧 generation 的 `true` 在新配置到达后不得触发 repository。`/health` 只测进程存活，`/health/ready` 分别覆盖数据库就绪/失败和核心推荐 adapter 可用/不可用；readiness 不调用高德等外部供应商，也不得在 503 中泄漏数据库或 provider 细节。
- Android：餐段默认值、显式 WGS84 请求映射、精确/仅大致位置、首次取消/普通拒绝/永久拒绝、定位关闭/超时/页面离开取消、固定地点与关键词手动选址、搜索输入变化取消、晚到响应丢弃、客户端硬约束、加载/空/错误/成功状态，以及 30 条/90 天本地历史与隐私撤回清理；账号侧必须在发网或拉起 SDK 前执行同一身份矩阵，隐私撤回要同步废止认证 lease、取消微信/QQ state/proof，并证明不配合取消的迟到登录、注册或 refresh 不能写回 Keystore。地点选择器、输入草稿、加载和成功结果只能由 Activity 级内存 ViewModel 跨配置重建保留，显式关闭、真实退后台、隐私撤回、配置代际变化或进程死亡必须清除。严格校验且只透传两小时、请求作用域的 `resultToken`，旧结果不能与新请求 ID 混合上报，详情/导航/历史和任何出站动作均不得泄漏 token，客户端不得接收或推断稳定地点 ID；契约不兼容异常即使被网络层包装也必须经有限、防循环的 cause 链识别，远程配置要区分成功、不可用和不兼容且两种失败均关闭 AI。首次配置不可用只能为游客开放关闭 AI 的规则展示 lease，结果只可查看/换一批且不得进入详情、执行动作或上报事件；一旦确认需要更新，后续配置不可用不得再开放该回退。进程级最低版本门禁必须覆盖初次未知、兼容、需要更新、配置不可用/不兼容、进程单调可信配置代际和从锁定态恢复，两个旧新 ViewModel 的乱序响应不能倒退代际或发布旧 UI；已确认的更新要求在下一次可信兼容配置到达前保持粘滞，可信兼容恢复必须同时清除旧更新 Snackbar/表单错误但不得复活旧结果；普通接口与配置复查/必要 refresh/退出/注销的例外必须按 HTTP 方法和精确路径匹配；每项已开放详情动作都要分别覆盖允许与拒绝，未知合法 provider 不触发供应商分支，非法 provider/模式/动作响应不得进入 UI。
- Android 结果生命周期：配置刷新或最低版本提高时，推荐、附近搜索、账号、收藏和反馈的在途响应不能写回；旧推荐详情、导航/拨号/复制和事件上报必须在实际出站前复查当前会话。推荐/搜索结果和选择只保留在内存 ViewModel；可恢复 UI 状态只允许保存安全的筛选和列表/方位图偏好，严禁保存餐厅对象、坐标或 token。Activity 配置重建后结果、筛选、详情和地点搜索草稿/结果应恢复，进程死亡后敏感会话应失效。Android 1.0 还必须验证 `SHARE_FEATURE_ENABLED` 在 Gradle 中只有一个固定 `false` 定义，Debug/Alpha 生成的 `BuildConfig` 均为 `false`，界面没有分享入口，且不存在 Gradle 属性或远程开关。封存分享测试仍参与编译与 JVM 回归，但不作为 1.0 设备验收或发布门禁。
- Android 工件：Debug APK 关键运行时类完整；内部 Alpha 独立包名、签名、R8/资源压缩和 DEX 数量门禁；完整门禁必须使用
  `.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'`，并同时确认该地址存在于 Alpha `BuildConfig` 与 APK DEX；Release 缺少公网 HTTPS 地址或正式签名材料时安全失败。地址策略和 APK 嵌入检查不等于 DNS、TLS、Nginx 或公网 API 可达，后者必须单独执行公网 smoke 和关闭 Wi-Fi 真机验收。
- ECS 发布与恢复：部署 bundle 必须是无 Secret 的固定文件集，工作站校验 `SHA256SUMS` 后上传到新的不可变 release；服务器预检要拒绝错误路径、权限、所有者、镜像坐标、共享状态、数据库证书或 Compose 配置。数据库备份测试必须覆盖固定 root-only 目录、禁止覆盖、精确文件清单、SHA-256、`pg_restore --list`，恢复只能进入全新隔离数据库；本机恢复成功不能替代 ECS 快照、异机副本和显式生产回滚演练。
- 端到端：API 演示模式配合 Android Studio API 36 模拟器执行兼容态 3 条语义用例，覆盖隐私门、关键词地点输入/结果重建、固定试点回退、推荐结果筛选/方位图重建、推荐与附近搜索详情重建及返回、详情动作门禁和反馈关闭态；以设备内隔离夹具执行 `MainActivityConfigUnavailableTest` + `configUnavailable=true`，验证首次配置 503 的 guest 规则展示态、Activity 重建和零额外事件；再执行 `MainActivityRuntimeVersionRaiseTest` + `runtimeVersionRaise=true`，验证同进程 `0.1.0 → 99.0.0 → 503 → 0.1.0`、旧在途结果/事件撤销、失败复查粘滞锁定、兼容恢复清理旧错误及显式新请求。
- 登录设备闭环：执行 `MainActivityAuthLocalFixtureTest` + `authLocalFixture=true`，验证隐私同意前零请求、手机号验证码登录、身份/会话读取、邮箱绑定、退出、邮箱验证码登录、再次退出的 15 个请求严格顺序，以及未配置微信/QQ AppID 时原生 OAuth 无入口、无调用、令牌不进入界面；该夹具只验证 Android/API v1 边界，不伪造短信、邮件、微信或 QQ 供应商。
- 高德展示边界：执行 `MainActivityAmapLiveFixtureTest` + `amapLiveFixture=true`，验证合成的 AMAP `LIVE_DISPLAY_ONLY` 响应保持实时来源标注、`fitScore=null`、供应商顺序、出站动作关闭，客户端发送 WGS84、预算 25 元、半径 1500 米、AI 关闭且无账号凭据；该夹具不使用高德 Key 或官方端点，不得表述为真实高德联网验收。
- 最低版本与恢复：以独立高最低版本配置执行 `MainActivityMinimumVersionGateTest` + `minimumVersionGate=true`，验证启动即强制更新、普通远程入口关闭、重查仍锁定、数据权利/隐私撤回可达，并恢复兼容配置后重跑 3 条正常链路，防止只锁不解。ADB 严格运行器必须只接受配置不可用、运行中最低版本提高、账号、本地高德展示四项设备内夹具的测试类与唯一参数精确配对；端口操作需持有按设备/端口互斥锁，移除和恢复前复核实时映射，外部状态改变时不得覆盖。分享设备测试不属于 Android 1.0 验收矩阵或发布门禁；内部 Alpha 冷启动仍需无超时或 ANR。
- 公网闭环：`api.unfinished-era.com` 必须使用独立于主站的 DNS、证书和宝塔 Nginx vhost；先从公网区分验证 `/health` 与 `/health/ready`，再验证 `/v1/config` 的失败关闭能力声明和真实推荐，最后由关闭 Wi-Fi 的真实手机运行同一 Alpha。不得把本机回环、APK 中出现域名或基础 liveness 作为公网闭环证据。

## 黄金场景

正式 Beta 前建立至少 200 个固定场景，覆盖：

- 四环内外、边界点、定位精度不同、关键词地点搜索、取消/晚到响应和固定地点回退。
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
| 换一批率 | < 50% |
| 连换三批仍未选择 | < 15% |
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
