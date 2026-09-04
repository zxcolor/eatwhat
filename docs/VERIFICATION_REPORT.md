# 验证报告

验证日期：2026-09-04（同设备匿名群组本地候选验证）；2026-08-22（模拟器历史验收）；2026-08-23（完整自动化、ECS 正式切换、真实高德与公网 HTTPS 验收）；2026-08-24（云端 Debug 默认与独立 Fixture 构建门禁）；2026-08-26（固定 Alpha signer 历史构建验证）；2026-08-28（PHONE_ONLY 短信认证改造中）

本报告记录当前仓库快照的本机自动化、Android 模拟器、ECS 回环与公网 HTTPS 验证。它不是公开发布批准，也不能替代供应商商业授权、Release 签名、法务审查、关闭 Wi-Fi 真机矩阵或 Alpha/Beta 指标。

## 2026-09-04：同设备匿名群组本地候选验证

验证对象为本地 `codex/group-constraint-intersection` 分支的同设备匿名群组工程候选。以下结果只证明本轮所列本地检查，不代表 Android 1.0、2.0 及后续路线全部完成，也不代表供应商授权、生产部署或公开发布获批。下方历史结论、计数、APK 哈希及设备记录仍保留，但不能替代本节的当前证据。

### Node 工作区与共享契约消费方

| 实际执行命令 | 本轮结果 |
|---|---|
| `pnpm lint` | 249 个文件通过，未自动修改文件 |
| `pnpm typecheck` | contracts、admin、API 全部通过 |
| `pnpm test` | contracts：2 个文件、81 个测试通过；API：87 个文件通过、1 个文件跳过，768 个测试通过、3 个测试跳过；随后 runtime smoke 通过 |
| `pnpm build` | contracts、Next.js admin 生产构建和 API 全部通过；admin 完成 6 个静态页生成 |
| `pnpm --filter @chi-shen-me/contracts test:openapi` | 1 个文件、23 个测试通过；该数量已包含在 contracts 的 81 个测试内，不重复累计 |
| 本批变更及新增 TS/OpenAPI 的 `biome check` | 19 个文件通过，未应用修改 |
| `git diff --check` | 通过 |

以上命令的最终退出码均为 `0`。另行执行的 contracts `test` / `typecheck` 与 API `test:unit` / `typecheck` / `test:runtime` 同样通过。API 的 3 个跳过项来自 `support-feedback.postgres.e2e.test.ts`：当前进程未显式启用 `SUPPORT_FEEDBACK_POSTGRES_E2E`，因此没有运行需要独立测试数据库及 cleanup 连接配置的真实 PostgreSQL 专用 HTTP 集成套件。

runtime smoke 在随机本机回环端口启动编译后的 API，验证 `/health`、`/health/ready`、`/v1/config`、DEMO `/v1/location-search`、全国范围 `/v1/recommendations` 和 `/v1/place-search` 六条路径均为 `200`。它不是群组端点的真实供应商验收，也没有调用真实高德、短信或 OAuth 供应商。

### Android 构建、JVM 与 APK

在临时 ASCII `W:` 工作区路径下，使用项目 JDK 17 执行：

```powershell
.\apps\android\gradlew.bat -p .\apps\android `
    :app:testDebugUnitTest :app:compileFixtureAndroidTestKotlin `
    :app:assembleFixture :app:assembleFixtureAndroidTest `
    lintDebug assembleDebug --stacktrace --no-daemon --no-build-cache
```

- 最终结果为 `BUILD SUCCESSFUL`，耗时约 4 分钟；临时 `W:` 映射在结束后清理。
- App JVM：85 个测试套件、431 个测试，失败 / 错误 / 跳过均为 `0`。
- `lintDebug`：`0` errors、`16` warnings；没有把警告记作零警告。
- Debug、Fixture 和 Fixture AndroidTest 三份 APK 构建完成并通过本轮独立 APK 门禁；本节不覆盖 Alpha 构建或 Alpha signer 验证。
- Fixture AndroidTest 源码编译和 APK 生成成功不等于设备执行成功；本轮群组单台模拟器结果另列于下节，不沿用下方历史模拟器结果作为本轮验收。

测试侧滚动定位、合成截图、支持反馈用例修复及截图前活动窗口 `packageName` 断言完成后的最终 test-only 构建以 `BUILD SUCCESSFUL` 结束，耗时 1 分 50 秒。Debug 与 Fixture APK 哈希未变，Fixture AndroidTest APK 最终哈希已更新如下；三份 APK 的独立门禁再次全部通过。工件校验与单台模拟器的断言、截图复验分别记录，不将其扩称为真机或稳定性矩阵通过：

| 工件 | SHA-256 |
|---|---|
| `apps/android/app/build/outputs/apk/debug/app-debug.apk` | `BF9B33BA5AB9C4EDD8D2A8B3E5F643B47B277E83FB0B0500A5FF4505B36503B8` |
| `apps/android/app/build/outputs/apk/fixture/app-fixture.apk` | `AB58E7F4A0A9495DDBD8016CDA4A2B60A6F6D475A9402DB9EA249D8B0972EC04` |
| `apps/android/app/build/outputs/apk/androidTest/fixture/app-fixture-androidTest.apk` | `022C97528D993813CE4B728DF6F5CC6001A7A1FB4A49DDC3E90DE6DBF3A1CD97` |

### API 36 单台模拟器：群组设备内合成夹具

设备为独立临时 API 36 / Pixel 6 AVD，序列号 `emulator-5560`。本轮严格执行：

```powershell
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityGroupDecisionLocalFixtureTest' `
    -InstrumentationArguments @{ groupDecisionLocalFixture = 'true' } `
    -UseDeviceLocalApiFixture `
    -Serial 'emulator-5560' `
    -Install
```

- 首轮 3 个测试均失败：测试试图定位尚未由外层 `LazyColumn` composition 的确认按钮；没有把该轮记录为通过。
- 修复仅作用于测试滚动定位：先由外层 `LazyColumn.performScrollToNode` 使目标项进入 composition，再使用 `performScrollTo` 和分项滚动。原有请求字段、隐私、只读结果和生命周期断言没有删除或放宽；群组生产代码和默认关闭开关未改变。
- 该次 test-only 重编译以 `BUILD SUCCESSFUL` 结束，耗时 1 分 44 秒。随后第二轮 3 个 `@Test` 的逐项 instrumentation status 均为 `0`，最终 `OK (3 tests)`，耗时 `33.608s`；严格运行器退出码为 `0`，端口映射完成恢复。
- 通过范围是同机两位匿名成员完整提交至 LIVE 只读结果、Activity 配置重建保留进度，以及真实后台返回清空且不提交；请求只发送给测试进程内的回环合成 API，不访问真实 provider、账号或生产服务。
- 支持反馈的 1 个用例首轮同样因懒加载控件定位失败。1 分 41 秒的 test-only 构建后，群组 3 个用例以 `OK (3 tests)` / `33.881s` 通过，支持反馈 1 个用例以 `OK (1 test)` / `15.807s` 通过；两次严格运行器退出码均为 `0` 且映射恢复。该轮随后发现截图被系统对话框遮挡，因此仅保留为断言证据，不能作为最终无阻挡视觉结果。日志为 `artifacts/group-device-2026-09-04/fixture-final-run.log`。
- 上述被遮挡轮次的截图出现 `System UI isn't responding` 系统对话框；初始截图仍保留为 `group-readonly-result-initial-system-anr.png` 与 `group-live-rights-initial-system-anr.png`，位于同一 artifacts 目录，不能作为无阻挡视觉验收证据。该轮 events 证据只识别到 `com.android.systemui`、`com.android.phone` 与 Google Play services 的首次启动 ANR，没有本 App ANR 的证据，不将系统异常误记为产品 ANR。
- 已关闭精确的临时 AVD，以 4 GB 内存、4 核和 GPU auto 配置重新启动同一隔离环境，并增加截图前活动窗口 `packageName` 断言：系统或其他 App 窗口遮挡时测试必须失败。最终 test-only 构建后，群组 3 个用例以 `OK (3 tests)` / `58.286s` 通过，支持反馈 1 个用例以 `OK (1 test)` / `26.615s` 通过；逐项 status 均为 `0`，两次严格运行器退出码均为 `0`，端口映射恢复。完整日志为 `artifacts/group-device-2026-09-04/fixture-stable-run.log`；该次 boot 的 events 中 `am_anr` / `am_crash` 计数均为 `0`，该观察仅适用于本轮运行。
- 支持反馈最终断言覆盖游客合成正文仅进入 JSON body、URL 无 query / Authorization，以及运行时关闭能力后不再提交。群组最终两张 PNG 已逐张查看：没有系统对话框遮挡，中文完整，首个只读候选与实时数据权利说明可见。文件为 `artifacts/group-device-2026-09-04/group-readonly-result.png` 和 `artifacts/group-device-2026-09-04/group-live-rights.png`；同一视口同时覆盖两块内容，所以文件内容及 SHA-256 相同，均为 `99501428B567C1309C79380C2181FFB318388867B31C65F77BE5F03AD28E3970`，不将它们计作两个不同页面的证据。
- 收尾再次确认本轮 boot 的 events 中 `am_anr` / `am_crash` 计数均为 `0`；已撤销本次 `tcp:3001` 映射，并按 AVD 名称核对后关闭测试模拟器，无 `W:` 映射残留。临时 AVD 与本地 artifacts 保留供后续验收。支持反馈测试修复已单独保留为本地提交 `c83441a`，不表示已推送或合并。

以上只证明该 API 36 / Pixel 6 模拟器合成环境的本轮严格断言与群组截图复验完成，不能替代 API 26–36 目标设备矩阵、真实供应商、无障碍、弱网、不同厂商后台恢复、长期稳定性、真机、生产或公开发布验收。

### 脚本、ECS bundle 与未执行项

- PowerShell 7 与 Windows PowerShell 5.1 下的九个相关脚本 AST / BOM 检查、四种群组开关场景和 ECS bundle 校验均通过；bundle 包含 27 个文件。这里是本地脚本与部署包门禁，不是 ECS 部署或生产动态验收。
- 当前进程缺少受控的 Alpha 微信与 QQ 公开 AppID，因此本轮未执行完整 `verify.ps1`，未把分项验证拼接宣称为完整发布门禁通过；没有读取签名私钥或要求将 Secret 放入命令。
- 本轮没有 push、创建 PR 或部署；尚无当前 HEAD 的 GitHub Actions、PR 合并或最终 `main` 全绿证据。
- 本轮群组与支持反馈的 API 36 单台模拟器合成夹具断言、群组无系统遮挡截图复验已通过，但 API 26–36 目标设备矩阵、长期稳定性、真机、无障碍、弱网、真实供应商链路及授权、Alpha 和公开发布门禁仍待补充。群组功能保持工程候选与默认关闭边界，不宣称已上线或已完成完整设备验收。

## 历史本轮结论（2026-08-22 至 2026-08-28）

- 2026-08-28 PHONE_ONLY 改造正在进行，尚未完成本分支完整 `verify.ps1`、ECS 部署或真实供应商/真机验收。0010→0011 的 `legacy_phone_drain` bridge、共享 `api.env` 原样保留、迁移前备份、0011/角色授权与最终候选回退也尚未在 ECS 动态演练。本报告下方旧计数和 APK 哈希只属于此前提交，不能作为当前改造已通过的证据。
- 2026-08-26 已将内部 Alpha 身份固定为包名 `com.chishenme.app.alpha`、证书 MD5 `7c64a4f134a3ebe121c1fb055c09a70c`、SHA-256 `31f21374f2f5d40697efb3c50e14d4e8d228991f6acbcde262e37c72ae4c0289`。私钥和密码位于仓库外；Gradle 缺失、部分、错误或过期签名材料时拒绝构建且不回退 Debug signer。该日期生成的 Alpha APK 为历史工件，本轮未执行设备安装验收。
- 2026-08-24 完整执行 `.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'` 全绿。普通 Debug 默认并经门禁确认只连接与 Alpha 相同的公网 HTTPS API；确定性 AndroidTest 改为独立 Fixture build type，固定回环地址并输出到独立路径。Node lint/typecheck/test/build、ECS bundle、buildSrc、Debug JVM/Lint、Debug/Fixture/FixtureTest/Alpha 构建、端点隔离、运行时类、Manifest、v2 signer、16 KiB zipalign 和服务端 Secret 扫描全部通过。
- 2026-08-23 决策专注版最终一次 `.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'` 全绿：Node 共享契约 66 / 66、API 78 个文件 667 / 667，类型检查、生产构建与代码规范检查全部通过；Android buildSrc 为 2 个测试套件、8 项测试，App JVM 为 72 个测试套件、327 项测试，失败 / 错误 / 跳过均为 0。
- Debug 与 Alpha 已统一使用当前云端 API，但客户端包名、可调试性、压缩和分发资格保持隔离；不存在第二套 Debug 服务端。门禁证明 `https://api.unfinished-era.com/` 同时进入 Debug/Alpha `BuildConfig` 与 DEX，且二者不含本机回环或服务端高德、SMTP、数据库、OAuth Secret。Fixture 单独证明只含 `http://127.0.0.1:3001/`，其 localhost 明文白名单不进入普通 Debug。DNS、TLS、HTTP 跳转、readiness、真实搜索/推荐和管理端点 404 仍由独立公网验收覆盖。
- Android 对 `/v1/config.serviceCapabilities` 中实际消费的推荐与地点搜索字段采用逐字段 fail-closed，并将地点搜索能力绑定可信配置 generation；旧 generation 的 `true` 不能借用新配置的远程访问 lease。Android 1.0 无条件忽略 `placeSearchEnabled`，不展示、不路由，也不调用直接餐厅关键词搜索；服务端 `/v1/place-search`、OpenAPI 与 provider 仍作为独立 API 能力保留。首页只显示当前 Android 功能的云端状态并提供手动重连。API 新增 `/health/ready`，以有界数据库探测和核心推荐 adapter 配置区分“进程存活”与“可提供推荐”。
- ECS 从 235 项、不含 Secret 的最小源码归档构建 Linux/amd64 镜像 `sha256:44041f99d06b1758088b58a22af83707e56db81783c8c4daadc7347e9da7c3a7`，并激活全国版 root-only release `20260823T071142Z-nationwide`。bundle、镜像 ID/用户、发布坐标、共享 Secret 形状、PostgreSQL TLS 与 Compose 通过严格预检；候选先在临时双网络容器通过 readiness、上海地点搜索、决策、附近搜索和高德三链 smoke，再由唯一激活脚本切换，PostgreSQL 容器未变化。切换前备份 `/opt/chi-shen-me/backups/postgres/20260823T072519Z` 的 SHA-256 与 `pg_restore --list` 复核通过，未执行生产库恢复。
- `api.unfinished-era.com` 已使用独立 A 记录、Let's Encrypt ECDSA 证书和 API-only 宝塔 vhost；证书 SAN 仅为该子域，有效期至 2026-11-21，私钥为 root-only `0600`。HTTP→HTTPS、SNI/信任链、`/health/ready`、`/v1/config`、上海真实地点搜索、真实餐厅推荐、附近搜索和 `/admin/v1=404` 均从工作站公网通过；公开配置为 `minimumSupportedVersion=0.1.1`、`coverageName=全国范围`。
- Android buildSrc/JVM 测试和 Lint 全部通过；Debug、Fixture、Fixture AndroidTest 与 Alpha 均成功构建。统一门禁直接检查四份 APK 的 manifest、DEX 关键类、instrumentation 唯一性、权限/备份/明文流量边界、FileProvider authority、v2 签名、唯一 signer/证书一致性和 16 KiB zipalign，并要求 Android 主源码不存在直接餐厅搜索页面、路由、client、`/v1/place-search` 调用或入口文案，`placeSearchEnabled` 只能作为 v1 DTO 兼容字段存在。Alpha 的 R8、资源压缩、独立包名和 `lintVital` 同样纳入门禁。
- 2026-08-22 既有 Android 16 模拟器验收中的 8 条核心 Activity instrumentation 用例和 2 条分享封藏负例全部通过：兼容态 3 条、配置不可用 1 条、同进程最低版本提高 1 条、启动即强制更新 1 条、账号设备内合成 API 闭环 1 条、高德合成 `LIVE_DISPLAY_ONLY` 展示边界 1 条，以及分享封藏负例 2 条。账号夹具验证手机号登录、邮箱绑定、退出、邮箱登录、再次退出的 15 个请求严格顺序；高德夹具验证实时来源标注、无自有评分、保持供应商顺序、动作关闭和 WGS84 请求。两项新增夹具均不代表真实供应商联调。
- 2026-08-22 的设备内夹具曾完成“启动强制更新 1 条 → 恢复兼容 3 条 → 运行中提高 1 条 → 配置不可用 1 条 → 账号夹具 1 条 → 高德展示夹具 1 条 → 分享封藏 2 条”。本轮源码最低兼容版本已升为 `0.1.1`，AndroidTest APK 已重新编译通过；全国版又以全新安装的 `0.1.1-alpha01-internal` 在模拟器手动搜索上海地点并完成真实决策闭环。
- 分享封藏前后使用完全相同的 DEMO 请求（北京大学东门坐标、午餐、1500 米、关闭 AI）比较，餐厅数量均为 3，名称和顺序均为“演示·校园面馆 → 演示·家常盖饭 → 演示·北方饺子铺”；封藏后每条结果的 `actions.share=false`，召回、过滤、评分与排序没有变化。
- 高德适配器的安全响应分类、脱敏诊断与离线 wrapper 回归通过；Android 合成展示夹具继续验证 UI 边界。ECS 又使用 root-only Key/数字签名与已确认的固定出口 IP 白名单完成真实官方网络调用：隔离容器、活动容器和公网三层地点搜索均返回 5 条 `AMAP/LIVE` 结果，餐厅推荐均返回 3 条 `AMAP/LIVE` 结果，`fitScore=null`、GCJ-02 和 `actions.share=false` 边界通过。报告不记录 Key、签名、餐厅名称、精确供应商 URL或坐标日志。
- 2026-08-28 起账号政策固定为 PHONE_ONLY：PHONE OTP 直接注册/登录，EMAIL/WECHAT/QQ 仅已绑定登录，登录后支持微信绑定。此前设备夹具属于旧矩阵，必须由新链路回归替代。
- 邮箱验证码已从阿里云 DirectMail 迁移到供应商无关的标准 SMTP；阿里云只保留短信用途。SMTP 启动连接校验、TLS/STARTTLS、固定纯文本验证码、收件人精确匹配、禁用附件和安全错误收敛均进入自动化回归；真实发件地址能否投递仍待所选邮箱服务商实测。
- 本地启动脚本已修复 Windows 同时发现多个 `pnpm.cmd` 路径时的数组拼接问题，并收紧为最小子进程环境：构建阶段不继承运行时 Secret，API 运行阶段只接收明确白名单配置，已通过 Windows PowerShell 5.1 参数、离线 wrapper 和 Secret 隔离验证。
- 统一门禁新增仓库与 APK Secret 扫描：私钥文件模式被 Git/Docker 忽略，Android 源码和四份 APK 的 DEX 均不得出现服务端 Key、SMTP 密码字段或高置信度私钥/AccessKey 模式；本轮检查通过，未发现真实凭据入库或进入 APK。
- 本轮全国版 Alpha 以全新安装方式覆盖旧 `0.1.0`：设备确认 `versionCode=2`、`versionName=0.1.1-alpha01-internal`，定位权限仍为拒绝；手动搜索 `Shanghai People Square` 获得上海 `AMAP/LIVE` 地点，选中“朋友AA酒店(上海人民广场店)”后完成决策，返回 3 条推荐，主推荐为“小栖村(黄浦店)”。稳定截图为 `artifacts/emulator/nationwide-result.png`，未出现地域限制、最低版本错误或分享入口。
- 直接餐厅搜索模块移除后，`0.1.2-alpha01-internal`（`versionCode=3`）已在 `emulator-5556` 全新安装。UI 语义确认搜索卡片/入口为 0，“手动选择”和“帮我决定”均存在；选择内置“北京电子科技学院”后公网 API 返回 3 条真实高德推荐且无错误。定位权限仍为拒绝。首页与结果证据分别为 `artifacts/emulator/android1-decision-only-home.png`、`artifacts/emulator/android1-decision-only-result.png`。

## 自动化验证

### Node 工作区

| 范围 | 当前结果 |
|---|---:|
| 共享契约 | 71 / 71 通过 |
| API | 82 个文件、708 / 708 通过 |
| API runtime smoke | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |

这些结果属于 2026-08-26 历史快照；当前 PHONE_ONLY 改造必须重新运行全部命令。即使重新通过，也不代表阿里云供应商、真实 PostgreSQL/OSS、ECS RAM/IMDSv2 或生产网络已联调成功。

### Android

以下 Android 表格和命令属于 2026-08-26 历史快照，本轮改造完成后必须重跑并更新：

```powershell
.\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
```

| 范围 | 当前结果 |
|---|---:|
| buildSrc 测试 | 2 个测试套件、8 项测试 |
| App JVM 测试 | 77 个测试套件、347 项测试 |
| JVM 失败 / 错误 / 跳过 | 0 / 0 / 0 |
| `lintDebug` | 通过 |
| `assembleDebug` | 通过 |
| `assembleFixture` | 通过 |
| `assembleFixtureAndroidTest` | 通过 |
| `assembleAlpha` | 通过 |
| Debug/Fixture/Alpha 端点隔离、签名、16 KiB 对齐与 Secret 扫描 | 通过 |
| Manifest、权限、ABI、R8、资源压缩、`lintVital`、包名与 DEX 门禁 | 历史通过；本轮待重跑 |

当前回归目标改为 PHONE OTP 直接注册/登录、EMAIL/WECHAT/QQ 仅已绑定登录、WECHAT 绑定，并验证隐私撤回先阻断持久化、使旧 attempt/session 失效，迟到回调不能写入 token。旧设备合成闭环只作历史参考；新自动化同样不能替代真实短信、邮箱、微信或 QQ 联调。

JVM 回归仍需覆盖进程级最低版本门禁、可信配置代际与在途请求撤销、结果会话失效，以及进程重建时只恢复非敏感挑战元数据。敏感手机号、验证码和 token 不进入 SavedState、磁盘或日志。Android 1.0 的直接餐厅关键词搜索产品模块仍保持移除。

高德回归覆盖 HTTP/业务状态分类、缺失或异常响应的安全降级、诊断信息脱敏、live-smoke 双门禁和离线 wrapper；普通 `start-api-local.ps1` 启动路径与 `AMAP_LIVE_SMOKE_ENABLED` 隔离。Android 合成展示夹具直接验证 AMAP/LIVE 展示、`fitScore=null`、供应商顺序、动作关闭与 WGS84 请求。ECS 真实网络 smoke 已另行证明 Key、数字签名、IP 白名单、`v5/place/text`/周边推荐技术链路和公网 API 可达，但不证明商业授权、配额容量、长期稳定性或全部真实餐厅字段已经完成验收。

## Android 16 模拟器验证

设备：Android 16，序列号 `emulator-5554`。

本轮 `0.1.2` 搜索模块移除后的 Alpha UI/真实决策 smoke 使用 `emulator-5556`：全新安装后直接读取 Compose/UIAutomator 语义树，搜索卡片在选址前后均不存在，手动选址与主决策入口存在；选择内置地点后得到 3 条 `AMAP/LIVE` 推荐。以下 `emulator-5554` 内容保留为此前完整 instrumentation 历史证据。

测试使用 Compose 语义查找与断言，不依赖固定屏幕坐标。2026-08-22 历史验收安装了当时统一构建的 Debug/Test APK；2026-08-24 起相同确定性用例由独立 Fixture/FixtureTest APK 承载，普通云端 Debug 不再访问本机接口。严格运行器动态提取唯一 instrumentation component、接受动态的非零用例数并拒绝 runner 失败标记，ADB 兜底没有绕过失败。配置不可用、运行中最低版本提高、账号与高德四项设备内夹具只接受测试类与唯一 `true` 参数的精确白名单；运行器在接触 `tcp:3001` 前取得按设备/端口命名的互斥锁，并在移除和恢复前复核实时映射。测试结束时停止 App 的失败不会跳过恢复；原映射缺失时恢复、已经恢复时保持不变，被外部进程改成其他目标时则拒绝覆盖并报告清理失败。

2026-08-22 核心七段历史验收使用以下测试筛选和 instrumentation 参数；`-Install` 只负责安装已经统一构建的干净 APK，可在首次运行或需要重装时添加，不改变用例语义。分享封藏的两条负例单独执行，不纳入 Android 1.0 分享能力或发布门禁：

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

# 3. 宿主 API minimumSupportedVersion=0.1.1：3 条兼容链路
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityDecisionFlowTest' `
    -ExpectedMinimumSupportedVersion '0.1.1' `
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

# 7. 主 API 恢复 minimumSupportedVersion=0.1.1 后重跑第 3 条命令。

# 分享封藏负例：固定关闭的 UI/出站/缓存边界
.\scripts\run-android-instrumentation.ps1 `
    -ClassName 'com.chishenme.app.MainActivityShareCardTest' `
    -ExpectedMinimumSupportedVersion '0.1.1' `
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
  → 选择地点后回到决策首页
  → 直接餐厅关键词搜索入口不存在，继续使用“帮我决定”
```

既有分享封藏负例结果为 2 / 2 通过：推荐详情没有分享入口，测试未观察到 `ACTION_SEND`、chooser 或新增 `share_cards` 文件；此前覆盖的直接餐厅关键词搜索详情现已随整个 Android 产品模块移除，不再构成 1.0 页面或验收路径。隔离夹具即使注入 `actions.share=true`，图片与文字分享调用也会在读取 `cacheDir`、解析 FileProvider authority 或启动 Intent 之前拒绝。验收结束后 `run-as com.chishenme.app.debug ls cache/share_cards` 明确返回目录不存在。Android 1.0 的 `SHARE_FEATURE_ENABLED` 固定为编译期 `false`，所有 provider 返回 `actions.share=false`，且没有远程重新启用路径。

账号设备内夹具结果为 1 / 1 通过：隐私同意前零请求，随后按严格 15 请求顺序完成手机号验证码登录、身份/会话读取、邮箱绑定、退出、邮箱验证码登录、再次读取身份/会话并退出；未配置微信/QQ AppID 时没有 OAuth 动作或请求，访问/刷新令牌没有出现在界面。该夹具不调用真实短信、邮件、微信或 QQ 供应商。

高德合成展示夹具结果为 1 / 1 通过：AMAP/LIVE 来源明确、`fitScore=null`、供应商顺序不变、所有出站动作关闭；请求明确使用 WGS84、预算 25 元、半径 1500 米、AI 关闭且无账号凭据。该夹具只注入合成 API v1 响应，没有使用 Key、访问官方端点或提供真实餐厅证据。

首次配置不可用的设备内夹具结果为 1 / 1 通过，覆盖：

```text
隐私同意前服务端请求数为 0
  → `/v1/config` 返回 503，门禁保持 UNKNOWN 并仅开放 guest 规则 lease
  → 规则推荐请求显式 `aiAssistanceEnabled=false` 且无登录凭据
  → 结果显示“仅展示，详情与操作暂不可用”和虚构数据提示
  → 不存在详情点击、任何出站动作入口或推荐事件
  → “为什么”披露规则模型与 LIVE_DISPLAY_ONLY 边界；仍可按相同条件重新请求，但不承诺结果变化
  → 重建 Activity 后展示态结果保持，服务端总计只有配置与推荐两个请求
```

同一进程运行中提高最低版本的设备内夹具结果为 1 / 1 通过，覆盖：

```text
取得最低版本 0.1.1 的可信兼容配置并挂起第一条推荐
  → 同一个 Activity / DecisionViewModel 经 ON_STOP / ON_START 返回前台
  → 刷新取得 99.0.0，立即进入强制更新并推进配置代际
  → 释放旧推荐响应，稳定观察窗口内始终不显示、不创建结果会话、不发送曝光
  → 复查返回 503，更新锁定保持粘滞且不得开放 guest 回退
  → 再复查取得可信 0.1.1，同一进程解锁但旧 token 在后续会话中仍为 EXPIRED
  → 旧更新 Snackbar 与表单错误均被清除，旧结果不自动恢复
  → 用户显式重新提交后只有新结果显示，且只有新 token 产生一次曝光事件
```

这条设备链路实际暴露过一个生产问题：门禁恢复为兼容态后，旧 `transientMessage` / `formError` 仍可能让强制更新 Snackbar 重新出现并遮挡底部“帮我决定”按钮。实现已改为在可信兼容配置到达时同时清除这两个旧错误；新增 JVM 回归与上述干净设备重跑均直接断言旧提示不存在，并成功完成显式新推荐。

随后仅把本机服务端 `minimumSupportedVersion` 提高为 `99.0.0`，强制停止 App 以重建进程级门禁，并单独执行启动强制更新用例，结果为 1 / 1 通过，覆盖：

```text
首次隐私同意
  → 显示“需要更新后继续”及当前/最低版本
  → 普通推荐、地点搜索、账号、收藏和反馈入口全部不可见
  → 重查同一高最低版本后仍保持锁定
  → 仅保留隐私撤回和数据权利区域；游客显示无可管理登录状态
  → 隐私撤回返回首次同意页
```

强制更新语义运行的视频证据位于 `artifacts/emulator/update-required-semantic-run.mp4`，稳定画面位于 `artifacts/emulator/gate-frame-3.png`。最终全量构建后的冷启动稳定画面位于 `artifacts/emulator/android1-final-20260822.png`；全部专项回归后再次执行 `am start -W` 得到 `LaunchState: COLD`、`TotalTime: 3338 ms`，清空后的 logcat 中 `com.chishenme.app.debug` 的 FATAL EXCEPTION / ANR 计数为 0。

模拟器测试证明单台模拟器、本机反向端口映射、设备内隔离夹具和虚构 DEMO/合成响应下的客户端核心闭环；ECS 与工作站公网 smoke 独立证明真实高德和 HTTPS 服务端链路。两类证据相加仍不能替代关闭 Wi-Fi 的真实手机、API 26–36、主流厂商、弱网/无网、权限、字体放大、深色模式、读屏、真实旋转、后台回收和性能矩阵，也未核验真实电话或外部路线 App。分享设备负例只证明 Android 1.0 固定封藏。

## 2026-08-22 历史设备夹具 API 与数据边界

该次历史设备验证使用以下模式：

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

下表是 2026-08-26 历史工件，PHONE_ONLY 改造后全部失效，不得分发或作为当前验收证据：

| 工件 | 路径 | 大小 | SHA-256 |
|---|---|---:|---|
| 云端 Debug APK | `apps/android/app/build/outputs/apk/debug/app-debug.apk` | 14,671,848 bytes | `8424B72852599273C0CB691BCDF2F3F30D7F7645685424469E1994D2EDE0C5A1` |
| 隔离 Fixture APK | `apps/android/app/build/outputs/apk/fixture/app-fixture.apk` | 13,882,953 bytes | `E1B699B6DF185FFB54268D9D748F2DF32C9F2A412B0A0DC8B5E8665B55C33157` |
| Fixture AndroidTest APK | `apps/android/app/build/outputs/apk/androidTest/fixture/app-fixture-androidTest.apk` | 1,118,046 bytes | `6F9F0D36BD605C4D6FFB328ABFB52F5EA00A43DD9D578BF0087315F2EE7EB522` |
| 内部 Alpha APK（历史） | `apps/android/app/build/outputs/apk/alpha/app-alpha.apk` | 2,501,571 bytes | `429F499B34FEBD7982787DBD694C794026D10548D3194DE124291E937B0BF795` |

普通 Debug 与内部 Alpha 均嵌入当前公网 HTTPS API 基址；Debug 可调试，Alpha 启用 R8/资源压缩且不可调试，并只接受固定长期 Alpha 证书。Fixture/FixtureTest 固定回环地址且只供自动化测试，禁止分发；安装 Fixture 会因 applicationId 相同而替换设备上的云端 Debug。Release 仍须使用 `com.chishenme.app` 对应的另一套独立签名，构建通过也不能替代公网、供应商和真机验收。

历史 Alpha 混淆阶段会输出固定微信 OpenSDK 6.8.40 外部字节码的 stack-map 警告；升级 SDK 或 Android Gradle Plugin 时必须重新审计，不能长期无条件忽略。

## ECS 基础运行时检查点

- 当前 `current` 指向 `/opt/chi-shen-me/releases/20260823T071142Z-nationwide`，镜像 ID 为 `sha256:44041f99d06b1758088b58a22af83707e56db81783c8c4daadc7347e9da7c3a7`；API 与 PostgreSQL healthy，`127.0.0.1:13001/health/ready` 返回 200，PostgreSQL 没有向宿主机发布 `5432`。
- 候选隔离容器通过真实高德后已删除；正式激活仅 force-recreate API，PostgreSQL 容器 ID 未变化。活动容器随后再次通过 runtime、地点搜索和推荐 smoke。
- 数据库切换前备份 `/opt/chi-shen-me/backups/postgres/20260823T072519Z` 已由 `verify-database-backup.sh` 重新计算 SHA-256 并对比实时 `pg_restore` 清单。该证据仍只是同机备份校验，不等于异机副本或恢复演练完成。
- 当前 `AMAP_ENABLED=true`；真实 Web Service Key、数字签名私钥和 ECS 出口 IP 白名单仅存在于服务器 root-only Secret，未进入镜像、bundle、APK或报告。
- `api.unfinished-era.com` 已启用独立证书和 vhost，API vhost SHA-256 为 `15a0ce4679ade503faac4481f19e6b647f1bc4218e545c18c3f2fe81d1e4adf6`；主站 vhost SHA-256 保持 `215a48d7e2c5e43493e89f6ed27f6fa304e7b6b9782a1c72cab3420476b0888e`。原 WordPress 文件、宝塔数据库、证书和恢复点均保留。
- 既有全国版 Alpha 的高德、公网 HTTPS 部署证据形成于 PHONE_ONLY 改造之前，只证明当时的推荐云链路。当前账号能力保持关闭；新服务端、数据库和 Android 工件未经完整验证与真实真机闭环，公开发布仍为 No-Go。

## 公开发布 No-Go

以下门禁仍未关闭；任一项未完成时，不得把当前 APK 作为 Android 1.0 公开发布版本：

1. **高德授权与规模化验收**：Web Service Key、匹配数字签名、固定出口 IP 白名单、`AMAP_ENABLED=true`、`ALLOW_DEMO_DATA=false` 和北京、上海真实搜索/推荐技术 smoke 已通过；仍需以实际运营主体确认技术服务/商业使用许可及逐项书面授权，并完成配额、长期错误降级、营业状态/电话/路线字段和规模化场景验收。
2. **完整云基础设施与数据权利链路**：ECS 自托管 PostgreSQL 17/PostGIS 3.5 的基础迁移、实际角色和 API 启动已通过，但 GitHub PostGIS 完整负例矩阵、ECS RAM 最小权限与 IMDSv2、RDS/OSS、导出 worker、密钥覆盖、完整性校验、永久 tombstone、保留期 execute、账号注销阻断及异机备份恢复仍未验收。基础健康检查不能替代这些真实联调。
3. **Release 签名与发布材料**：公网 HTTPS API 已完成；仍需配置独立 Release keystore 和离线备份，重新生成并校验正式 APK/AAB，并完成 App 备案、商标/名称核查、用户协议、隐私政策、第三方 SDK 清单、位置 PIA、算法/等保判断、应用商店素材与审核材料。
4. **真实账号与个人权利链路**：在号码认证短信、SMTP、微信、QQ 资质及真实数据库/对象存储上，严格按 PHONE OTP 直接注册/登录、EMAIL/WECHAT/QQ 仅已绑定登录、WECHAT 绑定验收；覆盖 ECS RAM/IMDSv2、当前签名模板、`ReturnVerifyCode=false`、错误/过期/限流/超时/并发/重放、ARM64 + 中国大陆 SIM 真机、迁移/权限/回滚，以及隐私撤回后的迟到回调拒绝、令牌撤销、导出、清除和注销。SMTP 的 DMARC 当前为 `false`，Alpha 可记录为非阻断缺口，但对外发布前必须关闭。
5. **发布质量门槛**：完成 API 26–36 与主流厂商真机矩阵、至少 200 个黄金场景、50–100 人 Beta、稳定性/ANR/性能/成本指标和发布负责人版本化 Go/No-Go 签署。

在以上门禁关闭前，准确状态是“封闭 Alpha 工件可用，真实高德服务端与公网 HTTPS 技术链路已通过”，而不是“外部真机矩阵已通过”“商业授权和备案已完成”或“Android 1.0 已获准公开发布”。
