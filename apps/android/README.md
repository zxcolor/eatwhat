# 吃什么 Android

原生 Kotlin + Jetpack Compose 客户端，当前实现游客核心闭环：

- 首次隐私同意及本地持久化；同意前不会创建推荐 ViewModel 或网络客户端。
- Android 系统原生前台定位（无 Google Play 依赖）：只有用户点击“自动定位”时才同时申请大致/精确位置权限，支持仅大致位置、拒绝权限、定位关闭和超时回退。
- 全国范围内可通过系统定位或手动选址发起推荐；内置快捷地点始终可用，也可明确提交全国地点关键词，通过供应商无关的 `POST /v1/location-search` 获取最多 5 个结果。输入变化、关闭选择器或页面进入后台会取消旧请求并丢弃晚到响应；选中后只保留当前决策需要的名称和显式 CRS 坐标。精确坐标不写入 DataStore、历史或日志。
- 手动地点关键词搜索只用于选择本次决策的出发地点，不是餐厅搜索。Android 1.0 不展示直接餐厅关键词搜索入口，不注册其列表或详情路由，也不调用 `/v1/place-search`；用户选定地点后继续使用“帮我决定”。
- 极速决定与精细匹配：餐段、预算、时间、半径、交通、人数、探索偏好和菜系条件。
- 严格按 `packages/contracts` 调用 `POST /v1/recommendations`。
- 加载、错误、空结果，以及 1 个主推荐 + 最多 2 个备选、推荐理由、警告、置信度、AI 标识和“为什么推荐”。
- 推荐来源是受约束的通用字符串代码，并显式区分 `LIVE/DEMO`；客户端不按 `AMAP` 等供应商名称分支。
- 每条推荐只携带不可解释的请求作用域 `resultToken`，不包含高德或其他来源的稳定 POI ID；事件 JSON 仅使用 `requestId/resultToken/type/occurredAt`，token 不展示、不分享，也不进入本地历史。
- 进程级最低版本门禁只在可信兼容配置到达后开放普通远程功能；首次配置不可用时，游客只能请求关闭 AI 的规则推荐，并以不可进入详情、不可执行动作、不可上报事件的展示态查看或换一批。已确认的强制更新保持粘滞，后续配置失败也不会重新开放游客回退；配置代际变化会撤销推荐、地点搜索、账号、收藏和反馈的旧在途结果。锁定态仍保留本机隐私撤回，以及已有会话必要的退出、注销和数据权利路径；同一进程收到新的可信兼容配置后会清除旧更新提示和表单错误，但不会恢复已经失效的旧结果。
- `/v1/config` 的 `serviceCapabilities` 仍包含推荐、地点搜索和服务端独立餐厅关键词搜索三个 API 能力。Android 1.0 只消费 `recommendationsEnabled` 与 `locationSearchEnabled`，字段缺失时失败关闭；它忽略 `placeSearchEnabled`，即使服务端返回 `true` 也不会创建搜索入口、路由或请求。能力授权与可信配置 generation 绑定，旧配置中的 `true` 不能借用新配置 lease 发起请求；服务关闭或配置失败时首页只报告当前 Android 功能的状态并提供“重新连接服务”。
- 会话内餐厅详情只按每条结果的 `actions` 能力提供地图查询、复制地址和安全拨号；UI 先做 capability 检查，`AndroidRestaurantActions` 在实际出站前再次检查当前结果会话，动作关闭或配置刷新后不会启动旧 Intent。API v1 为兼容旧客户端继续携带 `share`，但 AMAP/DEMO provider 统一返回 `false`，Android 1.0 也不会展示或执行该动作。不会把 POI 塞进导航参数或持久化。
- Android 1.0 的分享入口由 `BuildConfig.SHARE_FEATURE_ENABLED=false` 在编译期唯一固定关闭，没有 Gradle 属性、服务端配置或其他远程开关。渲染器、只读 FileProvider、临时文件租约与清理测试仅作为不可达的封存实现保留，不构成 1.0 已开放能力、待验收缺口或发布门禁；2.0 如需重新启用，必须重新评审产品范围、数据权利、隐私、安全和设备兼容性。
- 本机最近决策只保存餐段、模式、预算、时间、交通和结果数量等白名单摘要，最多 30 条、90 天；不保存位置或餐厅信息，可在设置中清空。
- 设置中的定位状态、端到端 AI 偏好、数据来源、算法摘要、隐私撤回和浅色/深色模式。
- 账号为可选能力：游客核心推荐不依赖登录；Android 1.0 固定支持手机号注册/登录、邮箱登录/绑定、微信注册/登录和 QQ 登录/绑定，不开放手机号/微信绑定或任何账号恢复入口。微信登录及“手机号验证码 + 微信授权”双验证注册使用官方 OpenSDK 6.8.40；只有隐私同意后且用户主动点击时才创建并注册 SDK。撤回隐私会先同步废止所有在途认证代际并清除第三方授权状态，迟到回调不能写回 Keystore。
- QQ 登录已有账号及登录后绑定使用腾讯官方下载的 QQ 互联 OpenSDK 3.5.19 Lite 包。后端先签发绑定安装 ID 和用途的一次性 state，客户端只在内存中保留到当前授权回调；只把 access token 交给后端，不采信或发送客户端 open identity。QQ 不能创建账号，能力关闭或 AppID 缺失时游客推荐不受影响。
- 账号数据导出支持显式选择是否包含近 90 天推荐行为、恢复最近任务、刷新状态及 7 天内下载。下载前由用户通过系统 `ACTION_CREATE_DOCUMENT` 选择位置，随后 App 通过固定的 Bearer 鉴权 API 流式写入；不申请存储权限、不生成签名 URL、不持久化保存 URI/令牌，并在长度或 SHA-256 校验失败时尽力删除或截断未完成文件。

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

从仓库根目录执行完整可复现门禁（包含 buildSrc、云端 Debug、隔离 Fixture AndroidTest、Alpha 混淆和工件检查）：

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

Fixture APK、本机 development API 和上述反向映射就绪后，可运行真实启动页 UI 验收。当前有六个
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
   推荐；结果只可展示或换一批，不能进入详情、执行任何出站动作或发送推荐事件，
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

六项用例都使用真实 `MainActivity` 和生产 Hilt 图，不请求系统定位、不创建账号，也不
发送反馈。前三项位于 `MainActivityDecisionFlowTest`，需要最低版本兼容的本地 DEMO API；
若后端未返回预期地点或推荐，测试会失败并带出界面上的诊断。第四、五项分别位于
`MainActivityConfigUnavailableTest` 和 `MainActivityRuntimeVersionRaiseTest`，只允许配合
精确的 `configUnavailable=true` / `runtimeVersionRaise=true` instrumentation 参数和
`-UseDeviceLocalApiFixture` 执行。第六项位于 `MainActivityMinimumVersionGateTest`，只有
`minimumVersionGate=true` 时才执行，防止在普通 API 配置下误跑。普通兼容配置下的
Gradle/UTP 入口是：

```powershell
.\gradlew.bat connectedFixtureAndroidTest
```

这个无过滤入口会让三项专用类因缺少显式 opt-in 参数而跳过，不能同时证明四种服务端
配置序列。专用验收必须按下方严格运行器分环境、分测试类执行。

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
CHISHENME_WECHAT_APP_ID=<微信开放平台分配的真实 AppID>
```

未配置时 `BuildConfig.CHISHENME_WECHAT_APP_ID` 固定为空，debug/alpha/release 都会诚实关闭本地微信入口，不会使用假 AppID。debug 与 alpha 分别使用 `com.chishenme.app.debug`、`com.chishenme.app.alpha` 回调包名，必须与对应开放平台登记完全一致；不能把一个环境的 AppID/签名假定为另一个环境可用。

QQ 互联 AppID 同样是公开应用标识，不是 Secret；它只允许 5 至 16 位、不以 0 开头的纯数字，并通过 Gradle 属性配置：

```properties
CHISHENME_QQ_APP_ID=<腾讯 QQ 互联分配的真实 AppID>
```

该属性默认空，debug/alpha/release 都会关闭 QQ SDK Activity 和入口；QQ 是可选登录方式，因此未获资质时不会阻断其他 Release 能力，但任何非空值都会先通过严格格式门禁。运行时 FileProvider authority、QQ 回调任务归属和宿主包名都取实际 `applicationId`，因此 debug、alpha、release 分别是 `com.chishenme.app.debug`、`com.chishenme.app.alpha`、`com.chishenme.app`，每个测试包的包名与签名必须在腾讯平台正确登记，不能互换。回调 scheme 固定为 `tencent<AppID>`。

QQ OpenSDK 不是从 JCenter 或第三方镜像获取。仓库固定保存腾讯官网压缩包中的 Lite JAR，其官方下载 URL、时间、大小和 SHA-256 见 [`THIRD_PARTY_ARTIFACTS.md`](THIRD_PARTY_ARTIFACTS.md)。腾讯官网/文件名标注 3.5.19，但包内版本常量及 Demo 仍报告 3.5.18；该上游差异已保留记录，公开发布前需向腾讯复核。

不要在客户端加入高德、千问、短信或登录服务的 Secret，也不要启用包含推荐请求体的网络日志。
