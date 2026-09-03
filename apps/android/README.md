# 吃什么 Android

原生 Kotlin + Jetpack Compose 客户端，当前实现游客核心闭环：

- 首次隐私同意及本地持久化；同意前不会创建推荐 ViewModel 或网络客户端。
- Android 系统原生前台定位（无 Google Play 依赖）：只有用户点击“自动定位”时才同时申请大致/精确位置权限，支持仅大致位置、拒绝权限、定位关闭和超时回退。
- 全国范围内可通过系统定位或手动选址发起推荐；内置快捷地点始终可用，也可明确提交全国地点关键词，通过供应商无关的 `POST /v1/location-search` 获取最多 5 个结果。输入变化、关闭选择器或页面进入后台会取消旧请求并丢弃晚到响应；选中后只保留当前决策需要的名称和显式 CRS 坐标。精确坐标不写入 DataStore、历史或日志。
- 手动地点关键词搜索只用于选择本次决策的出发地点，不是餐厅搜索。Android 1.0 不展示直接餐厅关键词搜索入口，不注册其列表或详情路由，也不调用 `/v1/place-search`；用户选定地点后继续使用“帮我决定”。
- 极速决定与精细匹配：餐段、预算、时间、半径、交通、人数、探索偏好和菜系条件；另提供“赶时间、工作日午餐、朋友聚餐、旅行出差”主动场景，一键套用现有参数且不会改变地点或已选菜系。
- 严格按 `packages/contracts` 调用 `POST /v1/recommendations`。
- 加载、错误、空结果和最多 3 个候选，并展示可核对理由、警告、置信度、AI 标识和结果说明。`LIVE_DISPLAY_ONLY` 使用“首个候选/其他候选”并保持数据源原始顺序；只有 `LICENSED_ENRICHMENT` 才显示主推荐、备选和自有排序。
- 推荐来源是受约束的通用字符串代码，并显式区分 `LIVE/DEMO`；客户端不按 `AMAP` 等供应商名称分支。
- 每条推荐只携带不可解释的请求作用域 `resultToken`，不包含高德或其他来源的稳定 POI ID；事件 JSON 仅使用 `requestId/resultToken/type/occurredAt`，token 不展示、不分享，也不进入本地历史。
- 进程级最低版本门禁只在可信兼容配置到达后开放普通远程功能；首次配置不可用时，游客只能请求关闭 AI 的规则推荐，并以不可进入详情、不可执行动作、不可上报事件的展示态查看或按相同条件重新请求（结果可能相同）。该操作不承诺跨请求反重复，也不上传、暴露或持久化稳定 POI ID。已确认的强制更新保持粘滞，后续配置失败也不会重新开放游客回退；配置代际变化会撤销推荐、地点搜索、账号、收藏和反馈的旧在途结果。锁定态仍保留本机隐私撤回，以及已有会话必要的退出、注销和数据权利路径；同一进程收到新的可信兼容配置后会清除旧更新提示和表单错误，但不会恢复已经失效的旧结果。
- `/v1/config` 的 `serviceCapabilities` 仍包含推荐、地点搜索和服务端独立餐厅关键词搜索三个 API 能力。Android 1.0 只消费 `recommendationsEnabled` 与 `locationSearchEnabled`，字段缺失时失败关闭；它忽略 `placeSearchEnabled`，即使服务端返回 `true` 也不会创建搜索入口、路由或请求。能力授权与可信配置 generation 绑定，旧配置中的 `true` 不能借用新配置 lease 发起请求；服务关闭或配置失败时首页只报告当前 Android 功能的状态并提供“重新连接服务”。
- 会话内餐厅详情只按每条结果的 `actions` 能力提供地图查询、复制地址和安全拨号；UI 先做 capability 检查，`AndroidRestaurantActions` 在实际出站前再次检查当前结果会话，动作关闭或配置刷新后不会启动旧 Intent。API v1 为兼容旧客户端继续携带 `share`，但 AMAP/DEMO provider 统一返回 `false`，Android 1.0 也不会展示或执行该动作。不会把 POI 塞进导航参数或持久化。
- Android 1.0 的分享入口由 `BuildConfig.SHARE_FEATURE_ENABLED=false` 在编译期唯一固定关闭，没有 Gradle 属性、服务端配置或其他远程开关。渲染器、只读 FileProvider、临时文件租约与清理测试仅作为不可达的封存实现保留，不构成 1.0 已开放能力、待验收缺口或发布门禁；2.0 如需重新启用，必须重新评审产品范围、数据权利、隐私、安全和设备兼容性。
- 本机最近决策只保存餐段、模式、预算、时间、交通和结果数量等白名单摘要，最多 30 条、90 天；不保存位置或餐厅信息，可在设置中清空。
- 设置中的定位状态、端到端 AI 偏好、数据来源、算法摘要、隐私撤回和浅色/深色模式；“可控偏好向量”可在本机保存质量、时间、预算、餐段匹配和多样性五个 0–100 整数，界面只说明“存在本机设置”，清除后恢复应用默认值。它只调节 `LICENSED_ENRICHMENT` 下既有透明软评分，不改变停业、距离、预算和排除菜系等硬规则；`LIVE_DISPLAY_ONLY` 不使用这些数值重排，仍保持供应商顺序且 `fitScore=null`。
- 账号为可选能力：游客核心推荐不依赖登录；Android 使用普通短信验证码完成手机号注册/登录，注册验证码成功后直接创建账号与会话，不要求微信。邮箱、微信和 QQ 登录都只面向已绑定账号；登录后可绑定邮箱、微信和 QQ。微信使用官方 OpenSDK 6.8.40，QQ 使用官方 OpenSDK 3.5.19 Lite；只有隐私同意后且用户主动点击时才创建对应 SDK 会话。挑战导航元数据可通过 `SavedStateHandle` 恢复，但验证码、完整手机号、OAuth state/code/token 始终只在内存中持有且不会持久化。
- QQ 登录已有账号及登录后绑定使用腾讯官方下载的 QQ 互联 OpenSDK 3.5.19 Lite 包。后端先签发绑定 installation 与用途的一次性 state；客户端调用官方 `loginServerSide`，只在内存中短暂持有回调 code 并交给自有后端，不采信或发送客户端 open identity。QQ access/refresh token 只由服务端换取并在本次核验内存中使用。QQ 不能创建账号，能力关闭或 AppID 缺失时游客推荐不受影响。
- 账号数据导出支持显式选择是否包含近 90 天推荐行为、恢复最近任务、刷新状态及 7 天内下载。下载前由用户通过系统 `ACTION_CREATE_DOCUMENT` 选择位置，随后 App 通过固定的 Bearer 鉴权 API 流式写入；不申请存储权限、不生成签名 URL、不持久化保存 URI/令牌，并在长度或 SHA-256 校验失败时尽力删除或截断未完成文件。
- “问题反馈与餐厅纠错”已有共享契约、Android 入口和服务端加密持久化/幂等/限流代码，但生产配置默认关闭。只有数据库、独立加密与 HMAC 密钥环及历史密钥覆盖检查全部就绪时，服务端才会公开 `supportFeedbackEnabled=true`；否则设置入口与提交链路均失败关闭，代码存在不代表生产已经启用。
- Android 1.2 候选为早餐、午餐、晚餐使用独立版本化 profile，并为奶茶、咖啡、甜品及用户主动体感提供能力门控入口。客户端只根据可信配置中完整的六字段 `specialtyCapabilities` 显示和提交这些选项；整个对象缺失时全部关闭，部分字段缺失属于无效配置，不能把遗漏字段推断为开放。

## 环境

- JDK 17
- Android SDK 36
- Gradle 8.13（wrapper）
- Android Gradle Plugin 8.11.1
- `minSdk 26` / `targetSdk 36`

首次生成或修复 wrapper jar（仓库未包含二进制时）：

```powershell
gradle wrapper --gradle-version 8.13
```

从仓库根目录执行完整可复现门禁（包含 buildSrc、云端 Debug、隔离 Fixture AndroidTest、Alpha 混淆和工件检查）。执行前必须仅在当前进程把受控的 Alpha 微信、QQ 公开 AppID 设置为 `CHISHENME_ALPHA_WECHAT_APP_ID`、`CHISHENME_ALPHA_QQ_APP_ID`，不得使用微信 AppSecret 或 QQ AppKey：

```powershell
.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
```

只在 Android 工程内做快速开发检查时可运行 `testDebugUnitTest lintDebug assembleDebug`；普通 Debug 默认连接云端公网 API，该命令不替代上面的完整门禁。

| 构建 | 包名 | API | 用途 |
| --- | --- | --- | --- |
| Debug | `com.chishenme.app.debug` | 默认 `https://api.unfinished-era.com/`；只允许受控公网 HTTPS | 日常开发诊断，可与 Alpha 并存；可调试，不得公开发布 |
| Fixture | `com.chishenme.app.debug` | 固定 `http://127.0.0.1:3001/` | 只供确定性 instrumentation；会替换设备上的 Debug，禁止分发 |
| Alpha | `com.chishenme.app.alpha` | 与 Debug 复用当前云端 API | 邀请制、R8/资源压缩、不可调试；使用固定的长期 Alpha signer，仍不能当 Release |

普通 Debug 与 Alpha 只是不同的 Android 客户端包装，不是两套服务端环境。它们共用同一服务端配置、数据库状态、IP 限流、高德配额和未来启用后的账号数据；当前不新建第二套 API 容器、端口、域名或数据库。若要隔离破坏性迁移、测试账号或不同微信/QQ AppID，必须另建具备独立域名、Secret、数据库角色/卷和配额的 staging，不能信任客户端自报环境来选择服务端 Secret。

当前服务端真实 adapter 只有 AMAP，另有仅限 development/test 的 DEMO；Android 的公共模型不会因此锁死到高德。未来新增美团、大众点评或其他来源时，必须先有正式 API/商务授权，再由服务端 adapter 归一化为相同契约；客户端不接入抓取、逆向接口或虚构 provider。

### 云端 Debug 与隔离测试 Fixture

普通 Debug 默认访问 `https://api.unfinished-era.com/`，无需本机 API 或 `adb reverse`。从仓库根目录执行：

```powershell
.\apps\android\gradlew.bat -p .\apps\android `
    clean testDebugUnitTest lintDebug assembleDebug `
    --stacktrace --no-daemon --no-build-cache --rerun-tasks
```

若未来有正式 staging，可临时用 `-PCHISHENME_DEBUG_API_BASE_URL=https://.../` 指向另一个经批准的公网 HTTPS 地址。该属性拒绝 HTTP、localhost、回环、私网、保留地址、user-info、query、fragment 和缺少末尾 `/` 的地址；禁止写入仓库或用户级 `gradle.properties`。Debug 继续使用主源码中的全局明文流量禁用配置。

只有 instrumentation 的 `fixture` 构建固定使用 `127.0.0.1:3001`，以免确定性用例访问真实云端、写入真实账号数据或消耗高德配额。完整 `verify.ps1` 会生成独立的 Fixture App/Test APK。运行需要宿主本地 DEMO API 的 fixture 用例前，才用仓库脚本完成健康检查、唯一设备选择、同目标 `adb reverse` 的安全刷新和映射复核；不同目标的既有映射不会被静默覆盖：

```powershell
pnpm dev:api
# 在另一个 PowerShell 中执行：
.\scripts\connect-android-debug.ps1
```

有多台已就绪设备时必须明确序列号；只有显式增加 `-OpenApp` 才会打开设备上已经安装的 Fixture App：

```powershell
.\scripts\connect-android-debug.ps1 -Serial emulator-5554 -OpenApp
# adb.exe 不在常规位置时：
.\scripts\connect-android-debug.ps1 -AdbPath 'C:\Android\platform-tools\adb.exe'
```

### 模拟器语义验收

Fixture APK、本机 development API 和上述反向映射就绪后，可运行真实启动页 UI 验收。当前列出七个
基于 Compose semantics、不会依赖屏幕坐标的 Activity 用例：

1. 从首次隐私同意开始，手动选择内置“北京大学东门”，使用默认极速条件请求本地
   DEMO 后端；断言主推荐和虚构数据标识，选择“仅营业中”和“附近方位图”后重建
   Activity，打开主推荐详情并再次重建，最后返回并确认结果会话、筛选和展示模式仍保留。
2. 在服务端 `supportFeedbackEnabled=false` 时进入设置页；断言“问题反馈与餐厅纠错”
   显示“当前未开放”，标题和状态文本都没有点击语义，并且不存在“提交”或“提交反馈”
   操作入口。
3. 打开地点选择器，输入关键词后重建 Activity，搜索并再次重建；断言输入草稿、DEMO
   地点结果和来源披露均保留。选择地点后回到决策首页，并断言不存在直接餐厅关键词搜索入口。
4. 设备内隔离 API 首次对 `/v1/config` 返回 503 时，断言游客仍可取得显式关闭 AI 的规则
   推荐；结果只可展示或按相同条件重新请求（结果可能相同），不能进入详情、执行任何出站动作或发送推荐事件，
   并在 Activity 重建后保持相同展示态。
5. 在同一个 Activity/ViewModel 进程中依次返回最低版本 `0.1.1 → 99.0.0 → 503 → 0.1.1`：
   先挂起旧推荐，再以前后台生命周期刷新提高最低版本；断言旧在途响应和旧 token 在该进程
   后续恢复兼容后仍保持失效，
   503 复查保持更新锁定且不开放游客回退，可信兼容配置恢复后清除旧更新 Snackbar/表单错误，
   只允许用户显式发起的新推荐显示并产生唯一曝光事件。
6. 在隔离的本地 API 把 `minimumSupportedVersion` 提高到高于 App 的版本后，断言更新专页
   显示当前/最低版本和重新检查；推荐、地点搜索、普通账号、收藏、反馈入口全部消失，只保留
   本机隐私撤回、数据权利区域和游客“无可管理登录状态”空状态。再次检查同一配置仍保持
   锁定，撤回后返回首次隐私同意页。已有登录状态下的退出/注销由 JVM 测试覆盖，设备用例
   尚未创建真实账号或伪造会话。
7. 设备内隔离 API 明确开启支持反馈后，从设置进入“问题反馈”，以游客身份提交一条合成
   餐厅纠错；断言正文只在 JSON body、URL 无 query、没有 Authorization。随后运行时关闭能力，
   断言提交控件与设置入口同步失效且不会产生第二个 POST。

七项用例都使用真实 `MainActivity` 和生产 Hilt 图，不请求系统定位、不创建账号。前六项不
发送反馈；第七项只向测试进程内的设备回环夹具发送合成纠错，不访问生产或第三方服务。前三项位于 `MainActivityDecisionFlowTest`，需要最低版本兼容的本地 DEMO API；
若后端未返回预期地点或推荐，测试会失败并带出界面上的诊断。第四、五项分别位于
`MainActivityConfigUnavailableTest` 和 `MainActivityRuntimeVersionRaiseTest`，只允许配合
精确的 `configUnavailable=true` / `runtimeVersionRaise=true` instrumentation 参数和
`-UseDeviceLocalApiFixture` 执行。第六项位于 `MainActivityMinimumVersionGateTest`，只有
`minimumVersionGate=true` 时才执行；第七项位于 `MainActivitySupportFeedbackLocalFixtureTest`，
只允许 `supportFeedbackLocalFixture=true` 与设备内夹具精确配对，防止在普通 API 配置下误跑。普通兼容配置下的
Gradle/UTP 入口是：

```powershell
.\gradlew.bat connectedFixtureAndroidTest
```

这个无过滤入口会让带显式 opt-in 的专用类安全跳过，不能同时证明各套服务端配置序列。
专用验收必须按下方严格运行器分环境、分测试类执行。

截至 2026-09-03 的本批次验证未连接 Android 设备，因此新增的第七项目前只纳入源码与
Fixture AndroidTest 编译门禁，尚未在真机或模拟器执行；不得把它记录为设备验收通过。

若宿主机只能构建 APK，但 Gradle 的 UTP 控制台进程无法启动，可在确认这是测试基础设施
故障、而不是断言失败后，使用 ADB 安装已经构建的 App/Test APK，再调用设备实际登记的
instrumentation component。当前 Fixture 构建和设备 `pm` 事实分别是目标包
`com.chishenme.app.debug`、测试包 `com.chishenme.app.debug.test`、runner
`androidx.test.runner.AndroidJUnitRunner`；下面仍会从 `pm list instrumentation` 动态提取
唯一组件，切换构建类型后不得复用旧值：

仓库根目录的严格运行器会完成上述动态提取、包/映射/API 检查和结果解析。它默认不安装
APK；首次运行或重新构建后显式加 `-Install`：

```powershell
# 兼容最低版本的 DEMO API：当前执行 3 个用例。
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityDecisionFlowTest' `
    -ExpectedMinimumSupportedVersion '0.1.1' `
    -Serial 'emulator-5554' `
    -Install

# 首次配置 503 的游客规则展示态：设备内隔离夹具，当前 1 个用例。
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityConfigUnavailableTest' `
    -InstrumentationArguments @{ configUnavailable = 'true' } `
    -UseDeviceLocalApiFixture `
    -Serial 'emulator-5554' `
    -Install

# 同一进程运行中最低版本提高、失败复查与兼容恢复：设备内隔离夹具，当前 1 个用例。
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityRuntimeVersionRaiseTest' `
    -InstrumentationArguments @{ runtimeVersionRaise = 'true' } `
    -UseDeviceLocalApiFixture `
    -Serial 'emulator-5554' `
    -Install

# 仅在隔离的本地 API 已把 minimumSupportedVersion 提高到 99.0.0 后执行：当前 1 个用例。
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityMinimumVersionGateTest' `
    -InstrumentationArguments @{ minimumVersionGate = 'true' } `
    -ExpectedMinimumSupportedVersion '99.0.0' `
    -Serial 'emulator-5554'

# 支持反馈开启、游客餐厅纠错提交及运行时关闭：设备内隔离夹具，当前 1 个用例。
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivitySupportFeedbackLocalFixtureTest' `
    -InstrumentationArguments @{ supportFeedbackLocalFixture = 'true' } `
    -UseDeviceLocalApiFixture `
    -Serial 'emulator-5554' `
    -Install
```

ADB 直跑是 UTP 宿主故障时的等价执行兜底，不会生成标准 Gradle/UTP 报告，也不能用来
绕过失败的测试断言。成功判断故意接受动态的非零用例数，同时拒绝 runner 失败标记；不能
再用硬编码的总用例数掩盖新增或跳过的场景。运行器只接受专用类与唯一 `true` 参数的精确
配对；设备内夹具模式会用按设备和 `tcp:3001` 命名的互斥锁串行化端口操作，在移除与恢复
映射前都重新读取实时状态。测试结束时即使停止 App 失败仍会继续尝试恢复；映射缺失时恢复
原目标、已经是原目标时保持不变，若被外部进程改成其他目标则拒绝覆盖并把清理失败上报。
强制更新用例与普通用例必须使用各自匹配的服务端最低版本，完成后要恢复兼容配置并重新
运行普通类，证明门禁能够正常解锁。
`run-android-instrumentation.ps1` 与 `connect-android-debug.ps1` 都只服务 Fixture 验收，
不会启动、停止或重启宿主机后端；设备内夹具由对应 instrumentation 用例在测试进程中
启动。前者也只有显式 `-Install` 才安装当前统一构建出的 Fixture App/Test APK，后者
不会安装 APK，默认也不会打开 App。这两个脚本都不是普通云端 Debug 的连接步骤。
模拟器重启、真机重连或 ADB 服务重置后需再次执行连接脚本。
普通 Debug、Alpha 和 Release 的地址都必须是公网 HTTPS。Debug 默认使用当前云端地址；
只有迁移到正式 staging 时才可临时用同名 Gradle 属性覆盖，且仍不得使用本机、回环或私网
地址。Fixture 的固定回环地址没有 Gradle 开关，不能被误带入可分发构建：

```properties
CHISHENME_DEBUG_API_BASE_URL=https://api.unfinished-era.com/
CHISHENME_ALPHA_API_BASE_URL=https://api.unfinished-era.com/
CHISHENME_API_BASE_URL=https://api.your-company.example/
```

Debug/Alpha 使用 HTTP、localhost、回环/私网/保留地址或保留域名时构建会失败；Alpha 仍要求显式提供地址。完整验证还会检查同一云端地址确实进入 Debug 与 Alpha DEX，并检查 Fixture DEX 只使用固定回环地址；这不证明 DNS、TLS 或公网 API 可达。

Alpha 的私钥和密码只保存在仓库外。Gradle 默认读取
`%LOCALAPPDATA%\ChiShenMe\signing\alpha-signing.properties`，也可在当前进程同时提供
`CHISHENME_ALPHA_STORE_FILE`、`CHISHENME_ALPHA_STORE_PASSWORD`、
`CHISHENME_ALPHA_KEY_ALIAS`、`CHISHENME_ALPHA_KEY_PASSWORD` 四项环境变量；四项必须完整，
且环境变量优先于本机属性文件。缺失配置、错误 alias、过期证书或证书摘要不匹配都会在
构建前失败，不会回退到 Debug signer。公开身份固定为包名
`com.chishenme.app.alpha`、证书 MD5
`7c64a4f134a3ebe121c1fb055c09a70c`、SHA-256
`31f21374f2f5d40697efb3c50e14d4e8d228991f6acbcde262e37c72ae4c0289`。
Debug/Fixture/FixtureTest 继续共用测试证书，Alpha 必须使用上述不同的固定证书。

Release 另需通过进程环境提供 `CHISHENME_RELEASE_STORE_FILE`、
`CHISHENME_RELEASE_STORE_PASSWORD`、`CHISHENME_RELEASE_KEY_ALIAS`、
`CHISHENME_RELEASE_KEY_PASSWORD`。Release 与 Alpha 是不同包名和不同签名生命周期，
不得复用或把 Alpha signer 当作正式发布签名。缺少任一项时构建会主动失败，避免产生
指向占位 API 或未签名的包。

微信 AppID 是公开应用标识，不是 Secret；按具体开放平台应用登记的包名与签名，通过 Gradle 属性配置：

```properties
CHISHENME_WECHAT_APP_ID=<release 对应的真实 AppID>
CHISHENME_DEBUG_WECHAT_APP_ID=<debug 对应的真实 AppID>
CHISHENME_ALPHA_WECHAT_APP_ID=<alpha 对应的真实 AppID>
```

三个属性分别只进入对应构建，不能互相回退：release 使用包名
`com.chishenme.app` 与回调 `com.chishenme.app.wxapi.WXEntryActivity`；debug 使用
`com.chishenme.app.debug` 与回调 `com.chishenme.app.debug.wxapi.WXEntryActivity`；Alpha 使用
`com.chishenme.app.alpha` 与回调 `com.chishenme.app.alpha.wxapi.WXEntryActivity`。Fixture
始终关闭微信。Release 与 Debug 对应属性未配置时
`BuildConfig.CHISHENME_WECHAT_APP_ID` 固定为空，Manifest 中的微信回调 Activity 也保持禁用，
不会使用假 AppID。Alpha 是可安装的真机验证候选，必须显式提供其专用 AppID；缺失时
`validateAlphaConfiguration` 会直接失败，完整验证还会核对 AppID 已进入最终 DEX 且回调
Activity 已启用并导出。每个包名、签名、AppID 必须与各自开放平台登记完全一致；AppSecret
只属于服务端，禁止写入 Gradle 属性或 APK。

QQ 互联 AppID 同样是公开应用标识，不是 Secret；它只允许 5 至 16 位、不以 0 开头的纯数字，并通过 Gradle 属性配置：

```properties
CHISHENME_QQ_APP_ID=<release 对应的真实 AppID>
CHISHENME_DEBUG_QQ_APP_ID=<debug 对应的真实 AppID>
CHISHENME_ALPHA_QQ_APP_ID=<alpha 对应的真实 AppID>
```

三个属性互不回退；Fixture 始终关闭 QQ。Release/Debug 对应属性未配置时 QQ SDK Activity 和入口失败关闭。Alpha 是真实验收候选，必须显式提供专用 AppID；缺失时 `validateAlphaConfiguration` 直接失败，完整门禁还会核对 BuildConfig、最终 DEX、`tencent<AppID>` scheme、AuthActivity/AssistActivity、固定 JAR 哈希和 R8 后必需类。运行时 FileProvider authority、QQ 回调任务归属和宿主包名都取实际 `applicationId`，因此 debug、alpha、release 分别是 `com.chishenme.app.debug`、`com.chishenme.app.alpha`、`com.chishenme.app`；每个包名、签名、AppID 必须与腾讯平台登记完全一致。QQ AppKey 只属于服务端 Server-Side 换票，禁止写入这些属性、BuildConfig、Manifest 或 APK。

QQ OpenSDK 不是从 JCenter 或第三方镜像获取。仓库固定保存腾讯官网压缩包中的 Lite JAR，其官方下载 URL、时间、大小和 SHA-256 见 [`THIRD_PARTY_ARTIFACTS.md`](THIRD_PARTY_ARTIFACTS.md)。腾讯官网/文件名标注 3.5.19，但包内版本常量及 Demo 仍报告 3.5.18；该上游差异已保留记录，公开发布前需向腾讯复核。

不要在客户端加入高德、千问、短信或登录服务的 Secret，也不要启用包含推荐请求体的网络日志。

## Android 1.1 候选批次（非完整交付）

本批次已把四项能力落入候选代码与自动化门禁：四个主动场景套用既有决策参数；设置中的
可控偏好向量；从桌面打开现有决策首页的小组件；以及明确标注“结果可能相同”的相同条件
重新请求。最后一项不是跨请求反重复或“换一批”保证，也没有引入稳定 POI ID。

### 桌面小组件

首版小组件使用 Android 平台 `RemoteViews` 实现，不新增依赖或权限。它只显示“吃什么”和“开始决定”；点击按钮通过不可变的显式 `PendingIntent` 打开现有 `MainActivity` 首页，仍遵循首次启动的隐私同意门禁。小组件无配置页、无周期更新，不读取、保存或显示位置、精确坐标、餐厅或任何第三方 POI 信息。

可在系统桌面的小组件选择器中找到“吃什么：开始决定”并添加；安装新 APK 后若选择器未立即刷新，请重新打开一次选择器。

这些实现与 JVM/静态构建证据不等于 Android 1.1 已全部完成，也不能替代真机、供应商授权、
生产反馈配置、应用商店或发布验收。

## Android 1.2 候选批次（非完整交付）

- 普通用餐按早餐、午餐、晚餐解析为分别版本化的 profile；奶茶、咖啡、甜品使用独立目标与 profile。首页只显示当前 provider 在可信配置中明确支持的入口，配置刷新开始时立即撤销旧能力、取消旧请求并回到午餐、普通用餐、无体感的安全基线。
- `specialtyCapabilities` 是原子的六字段对象：早餐、晚餐、奶茶、咖啡、甜品、用户主动体感均需明确布尔值。旧服务未返回整个对象时全部失败关闭；返回不完整对象不会被接受。当前 AMAP 只确认三餐 profile 和 `weatherContext.kind=NONE`，因此不开放三个垂类或用户体感；development/test DEMO 可覆盖全部候选路径，但生产环境禁止 DEMO。
- “手动体感”只有少在户外停留、偏暖、偏清凉三种有界选择，只随当前请求发送且不会持久化。它不读取、推断或声称掌握实时天气、温度、降水，也不申请后台位置；当前没有天气供应商或自动天气闭环。
- 早餐、晚餐、奶茶、咖啡、甜品和任何用户体感请求均在客户端与服务端强制关闭 AI，走确定性规则。服务端响应必须回显本次 profile 和体感应用版本，Android 会在进入结果页前校验目标、餐段、版本、能力要求和体感映射；不匹配响应失败关闭。
- `LIVE_DISPLAY_ONLY` 的边界没有因专项能力改变：只做本次请求必要过滤，保持 provider 返回顺序，不做自有重排，全部 `fitScore=null`，不持久化或跨请求关联第三方 POI。

当前代码候选只以共享契约、API query-plan/provider/config 定向测试和 Android JVM/静态编译门禁作为工程证据；最终命令与通过数以本批次验证报告为准。尚未连接设备执行新增流程，也未完成生产部署、真实供应商专项分类授权或天气服务验收，不能把 Android 1.2 或 2.x 记为已全部完成。
