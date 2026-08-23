# 验证报告

验证日期：2026-08-22（模拟器历史验收）；2026-08-23（完整自动化、前后端分离与 ECS 候选发布预检）

本报告记录当前仓库快照在本机完成的自动化与 Android 模拟器验证。它不是公开发布批准，也不能替代真实供应商授权、真实云资源验收、Release 签名、法务审查、设备矩阵或 Alpha/Beta 指标。

## 本轮结论

- 2026-08-23 最终一次 `.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'` 全绿：Node 共享契约 65 / 65、API 79 个文件 670 / 670，类型检查、生产构建与代码规范检查全部通过；Android buildSrc 为 2 个测试套件、8 项测试，App JVM 为 78 个测试套件、355 项测试，失败 / 错误 / 跳过均为 0。
- Alpha 已与 Debug 地址彻底分离：Debug 继续使用本机回环开发地址，Alpha 构建必须显式提供非回环公网 HTTPS 地址。本轮门禁同时证明 `https://api.unfinished-era.com/` 通过地址策略并进入 Alpha `BuildConfig` 与 DEX，且 APK 不含服务端高德、SMTP、数据库或 OAuth Secret；这不等于该子域的 DNS、证书或公网 API 已可达。
- Android 对 `/v1/config.serviceCapabilities` 采用逐字段 fail-closed，并将餐厅关键词搜索能力绑定可信配置 generation；旧 generation 的 `true` 不能借用新配置的远程访问 lease。首页会显示云端状态并提供手动重连。API 新增 `/health/ready`，以有界数据库探测和核心推荐 adapter 配置区分“进程存活”与“可提供推荐”。
- ECS 已从 266 项、不含 Secret 的最小源码归档构建唯一 Linux/amd64 镜像 `sha256:ba1b76c76df8efa563df998a3630e3c77e74c7ed633afb0691a58fd33d8d58f4`，并将包含候选激活/自动回退与全局 mutation lock 的最终 release `20260823-024841-cloudsep-final` 封存。最终 bundle、13 项非敏感发布坐标、root-only 权限、镜像 ID/用户、共享 Secret 形状、PostgreSQL TLS 与 Compose 配置均通过本机及 ECS 严格预检；13 个 Shell 在 ECS 通过 `bash -n`，激活脚本 SHA-256 为 `1d7f024bb84cfad4ca8ce61bbe9a535ecff72524bc4b9df45770c72e9e808f1d`。候选没有启动、迁移、切流或修改 Nginx；真实成功/失败自动回退只能在高德凭据齐备后的受控窗口动态验收。随后对当前数据库生成 root-only 逻辑备份 `/opt/chi-shen-me/backups/postgres/20260823T022013Z`，SHA-256 与独立 `pg_restore --list` 复核均通过，大小 456 KiB；未执行生产库恢复。
- Android buildSrc/JVM 测试和 Lint 全部通过；Debug/AndroidTest/Alpha 均成功构建。统一门禁直接检查三份 APK 的 manifest、DEX 关键类、instrumentation 唯一性、权限/备份/明文流量边界、FileProvider authority、v2 签名、唯一 signer/证书一致性和 16 KiB zipalign，并要求 Gradle 只出现一处固定 `false` 的 `SHARE_FEATURE_ENABLED`，Debug/Alpha 实际生成的 `BuildConfig` 也必须为 `false`；Alpha 的 R8、资源压缩、独立包名和 `lintVital` 同样纳入门禁。
- Android 16 模拟器上的 8 条核心 Activity instrumentation 用例和 2 条分享封藏负例全部通过：兼容态 3 条、配置不可用 1 条、同进程最低版本提高 1 条、启动即强制更新 1 条、账号设备内合成 API 闭环 1 条、高德合成 `LIVE_DISPLAY_ONLY` 展示边界 1 条，以及分享封藏负例 2 条。账号夹具验证手机号登录、邮箱绑定、退出、邮箱登录、再次退出的 15 个请求严格顺序；高德夹具验证实时来源标注、无自有评分、保持供应商顺序、动作关闭和 WGS84 请求。两项新增夹具均不代表真实供应商联调。
- 最终同一组干净构建并重新安装的 APK 先完成“启动强制更新 1 条 → 恢复兼容 3 条”，随后完成“运行中提高 1 条 → 配置不可用 1 条 → 账号夹具 1 条 → 高德展示夹具 1 条 → 分享封藏 2 条”，全部得到精确 `OK`。验收后宿主服务端仍为原 PID 34068、最低版本 `0.1.0`，ADB `tcp:3001 → tcp:3001` 在四项设备内夹具后逐次恢复，证明门禁既能锁定也能安全解锁。
- 分享封藏前后使用完全相同的 DEMO 请求（北京大学东门坐标、午餐、1500 米、关闭 AI）比较，餐厅数量均为 3，名称和顺序均为“演示·校园面馆 → 演示·家常盖饭 → 演示·北方饺子铺”；封藏后每条结果的 `actions.share=false`，召回、过滤、评分与排序没有变化。
- 高德适配器新增安全响应分类和脱敏诊断，真实请求脚本使用“显式确认参数 + 私有环境变量”双门禁；离线 wrapper 测试证明普通 API 启动器不会继承或触发 live-smoke 开关。高德合成展示夹具 1 / 1 通过，验证 AMAP/LIVE 来源、`fitScore=null`、保持供应商顺序、动作关闭、WGS84、预算 25、半径 1500、AI 关闭和无账号凭据；它没有使用 Key、官方端点或真实餐厅数据。
- 账号公开矩阵固定为 PHONE REGISTER/LOGIN、EMAIL LOGIN/BIND、WECHAT REGISTER/LOGIN、QQ LOGIN/BIND；账号设备内夹具 1 / 1 通过，严格观察 15 个 API v1 请求，完成手机号登录、邮箱绑定、两次身份/会话读取、两次退出和邮箱登录；微信/QQ AppID 缺失时没有 OAuth 动作或请求，访问/刷新令牌不显示在界面。该证据不等于真实短信、邮箱、微信或 QQ 联调。
- 邮箱验证码已从阿里云 DirectMail 迁移到供应商无关的标准 SMTP；阿里云只保留短信用途。SMTP 启动连接校验、TLS/STARTTLS、固定纯文本验证码、收件人精确匹配、禁用附件和安全错误收敛均进入自动化回归；真实发件地址能否投递仍待所选邮箱服务商实测。
- 本地启动脚本已修复 Windows 同时发现多个 `pnpm.cmd` 路径时的数组拼接问题，并收紧为最小子进程环境：构建阶段不继承运行时 Secret，API 运行阶段只接收明确白名单配置，已通过 Windows PowerShell 5.1 参数、离线 wrapper 和 Secret 隔离验证。
- 统一门禁新增仓库与 APK Secret 扫描：私钥文件模式被 Git/Docker 忽略，Android 源码和三份 APK 的 DEX 均不得出现服务端 Key、SMTP 密码字段或高置信度私钥/AccessKey 模式；本轮检查通过，未发现真实凭据入库或进入 APK。
- 最终全量构建后重新安装同一份 Debug/Test APK，复跑启动强制更新 1 / 1、恢复决策与地点搜索 3 / 3、运行中版本提升 1 / 1、首次配置不可用 1 / 1、账号夹具 1 / 1、高德展示夹具 1 / 1、分享封藏负例 2 / 2；冷启动成功，logcat 中 FATAL EXCEPTION / ANR 为 0，设备不存在 `cache/share_cards` 目录。宿主 API 始终保持健康、最低版本 `0.1.0`，既有监听进程未被替换或停止。

## 自动化验证

### Node 工作区

| 范围 | 当前结果 |
|---|---:|
| 共享契约 | 65 / 65 通过 |
| API | 79 个文件、670 / 670 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | contracts、NestJS API、Next.js Admin 全部通过 |
| `pnpm lint` | 通过 |

这些结果覆盖仓库当前的请求/响应契约、API 领域与安全边界、账号和数据导出代码路径，但不代表外部供应商、真实 PostgreSQL/OSS 或生产网络已经联调成功。

### Android

本轮通过仓库统一验证脚本完整执行 buildSrc/JVM 测试、Lint、Debug/AndroidTest/Alpha 构建、R8/资源压缩和 APK 完整性检查：

```powershell
.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
```

| 范围 | 当前结果 |
|---|---:|
| buildSrc 测试 | 2 个测试套件、8 项测试 |
| App JVM 测试 | 78 个测试套件、355 项测试 |
| JVM 失败 / 错误 / 跳过 | 0 / 0 / 0 |
| `lintDebug` | 通过 |
| `assembleDebug` | 通过 |
| `assembleDebugAndroidTest` | 通过 |
| `assembleAlpha` | 通过 |
| Alpha R8 / 资源压缩 / `lintVital` / 包名 / 签名 / DEX 门禁 | 通过 |

账号相关回归验证了公开用途/方式矩阵 PHONE REGISTER/LOGIN、EMAIL LOGIN/BIND、WECHAT REGISTER/LOGIN、QQ LOGIN/BIND，并验证隐私撤回会先同步阻断登录持久化、使旧 attempt/session 失效，再做尽力而为的 SDK/服务端清理；撤回前发起但之后才到达的 SDK 或网络回调不能写入 token 或恢复账号状态。设备内合成 API 闭环另完成手机号登录、邮箱绑定、退出、邮箱登录和再次退出；账号能力或平台凭证未配置时保持 fail closed。这些自动化证据不等同于真实短信、邮箱、微信或 QQ 联调。

本轮 JVM 测试覆盖进程级单调最低版本门禁、首次配置不可用 guest 规则 lease、两个旧新 ViewModel 的乱序配置响应、可信配置代际与在途请求撤销、结果会话失效、强制更新后的 503 粘滞锁定，以及可信兼容恢复时清除旧 `transientMessage` / `formError`。地点选择器草稿/加载/结果与推荐/搜索详情的跨配置重建状态有 ViewModel 和 Activity 两层回归，敏感结果、坐标和 token 不进入 SavedState。分享卡的渲染、FileProvider、租约、清理与测试代码只作为封存实现继续编译和执行非发布回归；Android 1.0 没有分享入口，全部 provider 返回 `share=false`，不存在远程开关，分享设备测试也不再构成 1.0 能力证据或发布门禁。Android 单元测试没有依赖真实第三方账号、地图应用或外部 POI。

高德回归覆盖 HTTP/业务状态分类、缺失或异常响应的安全降级、诊断信息脱敏、live-smoke 双门禁和离线 wrapper；普通 `start-api-local.ps1` 启动路径与 `AMAP_LIVE_SMOKE_ENABLED` 隔离。Android 合成展示夹具还直接验证 AMAP/LIVE 来源、`fitScore=null`、供应商顺序、动作关闭与 WGS84/25 元/1500 米/AI 关闭请求。离线测试和该夹具都不会加载真实 Key 或访问高德官方端点；本机 `.env.local` 仅保留为可选预检，当前权威下一步是在 ECS 候选 release 使用 root-only Secret、固定出口 IP 白名单、回环 readiness 和三链路真实 smoke，因此本报告不声称真实高德数据、配额、授权或网络已联调。

## Android 16 模拟器验证

设备：Android 16，序列号 `emulator-5554`。

测试使用 Compose 语义查找与断言，不依赖固定屏幕坐标。由于本机 Gradle UTP 宿主控制进程不可用，本轮安装统一构建出的 Debug/Test APK 后，通过设备登记的 `AndroidJUnitRunner` 直接执行；严格运行器动态提取唯一 instrumentation component、接受动态的非零用例数并拒绝 runner 失败标记，ADB 兜底没有绕过失败。配置不可用、运行中最低版本提高、账号与高德四项设备内夹具只接受测试类与唯一 `true` 参数的精确白名单；运行器在接触 `tcp:3001` 前取得按设备/端口命名的互斥锁，并在移除和恢复前复核实时映射。测试结束时停止 App 的失败不会跳过恢复；原映射缺失时恢复、已经恢复时保持不变，被外部进程改成其他目标时则拒绝覆盖并报告清理失败。

本轮核心七段成功验收使用以下测试筛选和 instrumentation 参数；`-Install` 只负责安装已经统一构建的干净 APK，可在首次运行或需要重装时添加，不改变用例语义。分享封藏的两条负例单独执行，不纳入 Android 1.0 分享能力或发布门禁：

```powershell
# 1. 设备内夹具：同进程运行中提高最低版本
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityRuntimeVersionRaiseTest' `
    -InstrumentationArguments @{ runtimeVersionRaise = 'true' } `
    -UseDeviceLocalApiFixture `
    -Serial 'emulator-5554'

# 2. 设备内夹具：首次配置不可用
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityConfigUnavailableTest' `
    -InstrumentationArguments @{ configUnavailable = 'true' } `
    -UseDeviceLocalApiFixture `
    -Serial 'emulator-5554'

# 3. 宿主 API minimumSupportedVersion=0.1.0：3 条兼容链路
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityDecisionFlowTest' `
    -ExpectedMinimumSupportedVersion '0.1.0' `
    -Serial 'emulator-5554'

# 4. 设备内夹具：账号手机号/邮箱闭环与原生 OAuth fail closed
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityAuthLocalFixtureTest' `
    -InstrumentationArguments @{ authLocalFixture = 'true' } `
    -UseDeviceLocalApiFixture `
    -Serial 'emulator-5554'

# 5. 设备内夹具：高德 LIVE_DISPLAY_ONLY 展示边界
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityAmapLiveFixtureTest' `
    -InstrumentationArguments @{ amapLiveFixture = 'true' } `
    -UseDeviceLocalApiFixture `
    -Serial 'emulator-5554'

# 6. 独立 API minimumSupportedVersion=99.0.0：启动即强制更新
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityMinimumVersionGateTest' `
    -InstrumentationArguments @{ minimumVersionGate = 'true' } `
    -ExpectedMinimumSupportedVersion '99.0.0' `
    -Serial 'emulator-5554'

# 7. 主 API 恢复 minimumSupportedVersion=0.1.0 后重跑第 3 条命令。

# 分享封藏负例：固定关闭的 UI/出站/缓存边界
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityShareCardTest' `
    -ExpectedMinimumSupportedVersion '0.1.0' `
    -Serial 'emulator-5554'
```

兼容态结果为 3 / 3 通过，覆盖：

```text
首次隐私同意
  → 手动选择“北京大学东门”
  → 使用默认极速条件发起决定
  → 接收明确标记为 DEMO 的推荐
  → 选择“仅营业中”和“附近方位图”
  → 重建 Activity，结果会话、筛选和展示模式仍保留
  → 打开主推荐详情并再次重建 Activity
  → 返回推荐结果页，筛选和展示模式仍保留

服务端 `supportFeedbackEnabled=false`
  → 进入设置与透明度
  → 反馈卡片保持不可点击
  → 不存在提交入口

地点选择器输入关键词
  → 输入草稿后重建 Activity
  → 搜索到带来源披露的 DEMO 地点后再次重建 Activity
  → 草稿、结果和来源披露仍保留
  → 选择地点并搜索附近餐厅
  → 打开附近搜索详情、重建 Activity 并返回结果页
```

分享封藏负例结果为 2 / 2 通过：推荐详情和地点搜索详情均无分享入口；测试未观察到 `ACTION_SEND`、chooser 或新增 `share_cards` 文件。隔离夹具即使注入 `actions.share=true`，图片与文字分享调用也会在读取 `cacheDir`、解析 FileProvider authority 或启动 Intent 之前拒绝。验收结束后 `run-as com.chishenme.app.debug ls cache/share_cards` 明确返回目录不存在。Android 1.0 的 `SHARE_FEATURE_ENABLED` 固定为编译期 `false`，所有 provider 返回 `actions.share=false`，且没有远程重新启用路径。

账号设备内夹具结果为 1 / 1 通过：隐私同意前零请求，随后按严格 15 请求顺序完成手机号验证码登录、身份/会话读取、邮箱绑定、退出、邮箱验证码登录、再次读取身份/会话并退出；未配置微信/QQ AppID 时没有 OAuth 动作或请求，访问/刷新令牌没有出现在界面。该夹具不调用真实短信、邮件、微信或 QQ 供应商。

高德合成展示夹具结果为 1 / 1 通过：AMAP/LIVE 来源明确、`fitScore=null`、供应商顺序不变、所有出站动作关闭；请求明确使用 WGS84、预算 25 元、半径 1500 米、AI 关闭且无账号凭据。该夹具只注入合成 API v1 响应，没有使用 Key、访问官方端点或提供真实餐厅证据。

首次配置不可用的设备内夹具结果为 1 / 1 通过，覆盖：

```text
隐私同意前服务端请求数为 0
  → `/v1/config` 返回 503，门禁保持 UNKNOWN 并仅开放 guest 规则 lease
  → 规则推荐请求显式 `aiAssistanceEnabled=false` 且无登录凭据
  → 结果显示“仅展示，详情与操作暂不可用”和虚构数据提示
  → 不存在详情点击、任何出站动作入口或推荐事件
  → “为什么”披露规则模型与 LIVE_DISPLAY_ONLY 边界，“换一批”仍可用
  → 重建 Activity 后展示态结果保持，服务端总计只有配置与推荐两个请求
```

同一进程运行中提高最低版本的设备内夹具结果为 1 / 1 通过，覆盖：

```text
取得最低版本 0.1.0 的可信兼容配置并挂起第一条推荐
  → 同一个 Activity / DecisionViewModel 经 ON_STOP / ON_START 返回前台
  → 刷新取得 99.0.0，立即进入强制更新并推进配置代际
  → 释放旧推荐响应，稳定观察窗口内始终不显示、不创建结果会话、不发送曝光
  → 复查返回 503，更新锁定保持粘滞且不得开放 guest 回退
  → 再复查取得可信 0.1.0，同一进程解锁但旧 token 在后续会话中仍为 EXPIRED
  → 旧更新 Snackbar 与表单错误均被清除，旧结果不自动恢复
  → 用户显式重新提交后只有新结果显示，且只有新 token 产生一次曝光事件
```

这条设备链路实际暴露过一个生产问题：门禁恢复为兼容态后，旧 `transientMessage` / `formError` 仍可能让强制更新 Snackbar 重新出现并遮挡底部“帮我决定”按钮。实现已改为在可信兼容配置到达时同时清除这两个旧错误；新增 JVM 回归与上述干净设备重跑均直接断言旧提示不存在，并成功完成显式新推荐。

随后仅把本机服务端 `minimumSupportedVersion` 提高为 `99.0.0`，强制停止 App 以重建进程级门禁，并单独执行启动强制更新用例，结果为 1 / 1 通过，覆盖：

```text
首次隐私同意
  → 显示“需要更新后继续”及当前/最低版本
  → 普通推荐、搜索、账号、收藏和反馈入口全部不可见
  → 重查同一高最低版本后仍保持锁定
  → 仅保留隐私撤回和数据权利区域；游客显示无可管理登录状态
  → 隐私撤回返回首次同意页
```

强制更新语义运行的视频证据位于 `artifacts/emulator/update-required-semantic-run.mp4`，稳定画面位于 `artifacts/emulator/gate-frame-3.png`。最终全量构建后的冷启动稳定画面位于 `artifacts/emulator/android1-final-20260822.png`；全部专项回归后再次执行 `am start -W` 得到 `LaunchState: COLD`、`TotalTime: 3338 ms`，清空后的 logcat 中 `com.chishenme.app.debug` 的 FATAL EXCEPTION / ANR 计数为 0。

该测试证明的是单台模拟器、本机反向端口映射、设备内隔离夹具和虚构 DEMO/合成 API 数据下的核心闭环。`ActivityScenario.recreate()` 已直接验证配置重建语义，但不等同于真实横竖屏尺寸变化、系统后台回收或进程死亡。它没有使用真实高德 Key，没有验证真实餐厅、真实营业状态、真实电话或真实路线，也不能替代 API 26–36、主流厂商真机、弱网、无网、权限、字体放大、深色模式、读屏、真实旋转、后台回收和性能矩阵。分享设备负例只证明 Android 1.0 固定封藏；后续设备工作严格限定为真实登录供应商与真实高德联调及其必要发布门禁，不扩展其他产品功能。

## 当前本地 API 与数据边界

本轮设备验证使用以下模式：

```dotenv
NODE_ENV=development
ALLOW_DEMO_DATA=true
AMAP_ENABLED=false
DATA_RIGHTS_MODE=LIVE_DISPLAY_ONLY
```

因此：

- 推荐与地点仅来自 development/test 的虚构 DEMO adapter，并在客户端显著标记；没有调用高德 `v5/place/around` 或 `v5/place/text`。
- Android 高德展示夹具只注入合成 API v1 响应，不改变本轮没有调用高德官方端点的事实。
- `LIVE_DISPLAY_ONLY` 仍是当前安全基线，不能据此推定已取得重排、缓存、持久化、外传、分享、导航、拨号或模型处理第三方 POI 的许可；Android 1.0 对分享另有编译期固定关闭门禁。
- 高德 Web Service Key 只能在服务端环境变量中配置，不得进入 Android、仓库、APK、日志或报告。
- Android 的公共模型与动作门控消费供应商无关契约；未来接入美团、大众点评等来源仍必须通过正式 API 或商务授权，不能抓取、逆向或伪装数据来源。

## Android 工件

| 工件 | 路径 | 大小 | SHA-256 |
|---|---|---:|---|
| Debug APK | `apps/android/app/build/outputs/apk/debug/app-debug.apk` | 13,978,473 bytes | `2666FD275CA655557BADD21C390894A93BD22C0A086D5BF41F62D7A97884C594` |
| Debug AndroidTest APK | `apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk` | 1,119,630 bytes | `837DCB78C1445B03EFB47596DBBAD9A48FF317B832ED72C3ACEEA581AA579637` |
| 内部 Alpha APK | `apps/android/app/build/outputs/apk/alpha/app-alpha.apk` | 2,178,659 bytes | `4481F1A29A65362624B56544B968B248AC8BD3211AC9F89B4D06E2FA2425CE37` |

Debug APK 仅用于本地开发；内部 Alpha 启用 R8/资源压缩并已嵌入独立公网 HTTPS API 基址，但仍使用 Debug signer，只是邀请制测试工件。地址进入 APK 不代表 DNS、证书或服务可达，也不能替代独立 Release 签名和生产配置生成的正式发布包。

Alpha 混淆阶段仍会输出来自固定微信 OpenSDK 6.8.40 外部字节码的 stack-map 警告；当前 R8、资源压缩、`lintVital`、签名和 APK 完整性门禁均通过。该上游 SDK 警告不等于本轮构建失败，但在升级 SDK 或 Android Gradle Plugin 时必须重新审计，不能长期无条件忽略。

## ECS 基础运行时检查点

- 北京 ECS 上的不可变 release `20260823-080633` 已完成 Linux/amd64 API 镜像构建、PostgreSQL 17/PostGIS 3.5 启动、扩展与版本化迁移、实际数据库角色授予和基础 API 启动。
- 当前 `current` 实际仍指向 `/opt/chi-shen-me/releases/20260823-080633-r2`；API 与 PostgreSQL 已通过旧版容器健康检查且重启计数均为 0，宿主机本地 `127.0.0.1:13001/health` 返回 200，PostgreSQL 没有向宿主机发布 `5432`。旧 API 的 `/health/ready` 返回 404，不能把它误报为新版 readiness 已上线。
- 最终候选 release `20260823-024841-cloudsep-final` 的 bundle、13 个 Shell 语法、权限、唯一 API 镜像和部署坐标已通过服务器端 `preflight-deployment.sh`。预检后 `current`、两个运行容器的镜像 ID/重启计数和主站 vhost SHA-256 `215a48d7e2c5e43493e89f6ed27f6fa304e7b6b9782a1c72cab3420476b0888e` 完全不变，API 子域 vhost 仍不存在。
- 当前数据库已通过 `backup-database.sh` 生成 `/opt/chi-shen-me/backups/postgres/20260823T022013Z`，目录为 root-only `0700`、四个归档/清单文件为 `0600`；`verify-database-backup.sh` 已重新计算 SHA-256、比较记录与实时 `pg_restore` 清单并通过。该证据仍只是同机备份校验，不等于异机副本或恢复演练完成。
- 当前 `AMAP_ENABLED=false`，因为真实高德 Web Service Key、匹配的签名私钥和 ECS 出口 IP 白名单尚未齐备；没有执行真实地点搜索或餐厅推荐 smoke。
- 宝塔 Nginx 仍使用原停止页 vhost；`api.unfinished-era.com` 尚无 DNS 记录、独立证书或激活 vhost，域名 HTTPS 和外部手机闭环未验收。原 WordPress 文件、宝塔数据库、证书和恢复点均保留。
- 当前公开状态仍为 No-Go。下一检查点必须先补齐高德服务端 Key/签名/IP 白名单并使候选 `/health/ready` 就绪，再配置 API 子域 DNS 与证书，以独立 vhost 完成公网 smoke 和关闭 Wi-Fi 的真机验收；此前不得切换 `current`。

## 公开发布 No-Go

以下门禁仍未关闭；任一项未完成时，不得把当前 APK 作为 Android 1.0 公开发布版本：

1. **正式高德 Key 与授权**：以实际运营主体取得 Web 服务类型 Key、与该 Key 匹配的服务端数字签名私钥、技术服务/商业使用许可及逐项书面授权，完成分环境 Key、固定出口 IP 白名单、配额与日志脱敏；随后在封闭预发布环境用 `AMAP_ENABLED=true`、`ALLOW_DEMO_DATA=false` 真实验证北京地点搜索、四环内推荐、坐标、距离、营业状态、错误码和供应商降级。当前报告不包含这项验收。
2. **完整云基础设施与数据权利链路**：ECS 自托管 PostgreSQL 17/PostGIS 3.5 的基础迁移、实际角色和 API 启动已通过，但 GitHub PostGIS 完整负例矩阵、ECS RAM 最小权限与 IMDSv2、RDS/OSS、导出 worker、密钥覆盖、完整性校验、永久 tombstone、保留期 execute、账号注销阻断及异机备份恢复仍未验收。基础健康检查不能替代这些真实联调。
3. **Release 签名与发布材料**：配置正式公网 HTTPS API、独立 Release keystore 和离线备份，重新生成并校验正式 APK/AAB；完成 App 备案、商标/名称核查、用户协议、隐私政策、第三方 SDK 清单、位置 PIA、算法/等保判断、应用商店素材与审核材料。
4. **真实账号与个人权利链路**：在正式阿里云短信、所选 SMTP 邮件服务商、微信、QQ 资质及真实数据库/对象存储上，严格按 PHONE REGISTER/LOGIN、EMAIL LOGIN/BIND、WECHAT REGISTER/LOGIN、QQ LOGIN/BIND 验收，并覆盖隐私撤回后的迟到回调拒绝、令牌撤销、导出、清除和注销；Android 1.0 不验收或开放手机号/微信绑定及账号恢复。当前默认 capability 为 `false`，只证明关闭路径、契约矩阵和客户端门控正确。
5. **发布质量门槛**：完成 API 26–36 与主流厂商真机矩阵、至少 200 个黄金场景、50–100 人 Beta、稳定性/ANR/性能/成本指标和发布负责人版本化 Go/No-Go 签署。

在以上门禁关闭前，准确状态是“开发与封闭测试工件可用，DEMO 核心闭环与 ECS 基础运行时已通过”，而不是“真实餐厅推荐已验收”“公网手机可体验”或“Android 1.0 已获准公开发布”。
