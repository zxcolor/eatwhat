# Android 界面精修与验证记录

> 产品范围（2026-09-12）：只服务一个人的用餐决策，永久取消多人用餐。历史群组方案与验收记录仅作追溯，不属于当前或未来待实施功能。

验证日期：2026-09-06 至 2026-09-07。基线：`333efc1fcd4313ec4e6da5513806ab713b7bf590`；分支：`codex/android-ui-refinement`。本文记录本地验证和截图；提交、PR 与合并后 CI 链接另记录在 PR 和交付说明中。

## 实现范围

本次精修首页、候选结果、餐厅详情、账号与安全、设置与透明度五个页面，统一蓝色明暗主题、文字层级、轻卡片与操作区。生产修改限于九个 Kotlin 文件：`HomeScreen`、`HomeVisualStyle`、`ResultsScreen`、`RestaurantDetailScreen`、`AccountScreen`、`SettingsScreen`、`AppVisualStyle`、`Theme`、`Type`。

- 首页保留一个“帮我决定”操作。常规竖屏固定在底部；窗口高度小于 `600dp` 时，将错误提示、显式距离修正和主操作一起放入滚动列表，避免短窗口被固定操作区占满。
- 结果与详情减少重复摘要和空图片占位。无图片或加载失败时折叠图片区域；来源、未知价格/营业状态说明、禁用原因和业务正文继续显示。
- 账号页面压缩重复介绍，列表避让系统 inset 和键盘。仅在后续游客与登录终态相互切换时清理焦点、收起键盘并回到状态概览；加载和资料刷新不会重置滚动位置。
- 设置页面统一层级与间距；原有偏好 Slider 的语义、数值和回调保留。共享返回图标继承按钮的禁用颜色，反馈提交期间不会显示为可用状态。

使用此前确认的 Zibll 前台视觉语言作为参考，以原生 Compose 实现；没有复制 WordPress 实现、付费主题资产、品牌素材或旧工作树中的账号代码。

## 行为与数据边界

没有修改 ViewModel、API、共享契约、数据库、构建配置或依赖。原有按钮回调、配置门禁、推荐条件、错误优先级、半径校正及隐私契约保留。

`LIVE_DISPLAY_ONLY` 继续按数据源顺序展示，不生成自有适合度。结果筛选、详情动作权限、来源说明与授权判断保持原有逻辑。分享用例验证既有关闭边界，不表示重新开放分享能力。普通 Debug 与 Alpha 仍访问 `https://api.unfinished-era.com/`；设备用例只使用独立 Fixture 构建和合成数据。

## 构建与完整验证

在当前进程注入受控的 `CHISHENME_ALPHA_WECHAT_APP_ID`、`CHISHENME_ALPHA_QQ_APP_ID` 公开 AppID 后运行：

```powershell
./scripts/verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
```

最终生产代码的完整验证通过，日志为 `verify-final-full.log`。没有使用或记录供应商 Secret。

| 检查 | 结果 |
|---|---|
| PowerShell、部署脚本、凭据边界、Android 产品边界 | 通过 |
| Node lint、typecheck、build、编译后 API smoke | 通过 |
| Contracts / Admin / API 测试 | 86 / 52 / 833 项通过 |
| 本地 PostgreSQL 条件测试 | 3 项条件性跳过；真实 PostgreSQL 门禁须由当前提交的 GitHub `postgres-integration` 验证 |
| Android Debug 单元测试 | 449 项通过，failure / error / skipped 均为 0 |
| `lintDebug`、`assembleDebug`、Release 配置与 manifest | 通过 |
| `assembleFixture`、`assembleFixtureAndroidTest` | 通过 |
| Alpha R8、`lintVitalAlpha`、`assembleAlpha`、端点与 APK 完整性 | 通过 |

完整验证后仅补充测试中的真实滚动和临时提示等待位置，重新运行以下定向编译，并用该测试包完成窄屏账号和短屏幕复验：

```powershell
.\apps\android\gradlew.bat -p .\apps\android :app:assembleFixtureAndroidTest
git diff --check
```

| 最终设备验证产物 | SHA-256 |
|---|---|
| Fixture App | `2E5C26747D8935E5E7AA9EC83CDB79AFBFDA59030D87C22591455FE3BF389CBB` |
| Fixture AndroidTest | `A00788350639C12343E8894D94EAF3EB33912B5024C874A2A25CD1A6D5A7F071` |
| 普通 Debug | `3B92932A6E429DE88AC2B9B493D427A78FB6FC575BBA5A666E2F5B6DA10756D7` |
| 内部 Alpha | `D0C55AA5FBFE76CCBFB7929CDEB34FEB190383FA68D7090768FB74596BBB8FA9` |

APK、缓存、完整日志和本机工具未加入仓库。

## 设备回归

使用自有 Android API 36 模拟器。常规视口为 `1080×2400 px / density 420 / font_scale 1.0`；窄屏为 `1080×2400 px / density 480 / font_scale 1.5`，即 `360×800dp`；短窗口为 `1080×640 px / density 320 / font_scale 1.5`，即 `540×320dp`。深色模式在常规视口复验。

公共入口如下。设备内 API 用例增加 `-UseDeviceLocalApiFixture` 和表中参数；首次安装增加 `-Install`。

```powershell
.\scripts\run-android-instrumentation.ps1 -Serial emulator-5562 `
  -ClassName 'com.chishenme.app.<测试类>' <表中追加参数>
```

| 基础用例 | 数量 | 追加参数 / 条件 | 通过日志与耗时 |
|---|---:|---|---|
| `MainActivityAmapLiveFixtureTest` | 3 | 设备内 API；`-InstrumentationArguments @{ amapLiveFixture='true' }` | `light-final-attempt2.log`，65.783s |
| `MainActivityAuthLocalFixtureTest` | 1 | 设备内 API；`-InstrumentationArguments @{ authLocalFixture='true' }` | `light-auth-final-attempt3.log`，30.275s |
| `MainActivityConfigUnavailableTest` | 1 | 设备内 API；`-InstrumentationArguments @{ configUnavailable='true' }` | `light-final-attempt2.log`，28.175s |
| `MainActivityRuntimeVersionRaiseTest` | 1 | 设备内 API；`-InstrumentationArguments @{ runtimeVersionRaise='true' }` | `light-regression-attempt1.log`，10.104s |
| `MainActivityGroupDecisionLocalFixtureTest` | 4 | 设备内 API；`-InstrumentationArguments @{ groupDecisionLocalFixture='true' }` | 同上，25.447s |
| `MainActivitySupportFeedbackLocalFixtureTest` | 1 | 设备内 API；`-InstrumentationArguments @{ supportFeedbackLocalFixture='true' }` | 同上，9.795s |
| `MainActivityDecisionFlowTest` | 3 | 独立 DEMO API；`-ExpectedMinimumSupportedVersion '0.1.1'` | `light-decision-final-attempt5.log`，27.348s |
| `MainActivityShareCardTest` | 2 | 独立 DEMO API；`-ExpectedMinimumSupportedVersion '0.1.1'` | `light-share-privacy-attempt2.log`，11.708s |
| `PrivacyWithdrawalMarkerStoreTest` | 1 | `-ExpectedMinimumSupportedVersion '0.1.1'` | 同上，0.135s |
| `MainActivityMinimumVersionGateTest` | 1 | 独立 API 最低版本 `99.0.0`；`-ExpectedMinimumSupportedVersion '99.0.0' -InstrumentationArguments @{ minimumVersionGate='true' }` | `light-minimum-final-attempt1.log`，6.091s |

共 18 个不同测试方法。额外显示模式执行如下，均通过；不把重跑次数当成新增用例覆盖。

| 模式 | 数量 | 通过日志与耗时 |
|---|---:|---|
| 深色 | 5 | Amap 3：`dark-final-attempt1.log`，71.686s；Auth 1：`dark-auth-final-attempt6.log`，25.801s；Config 1：`dark-config-final-attempt1.log`，28.517s |
| 窄屏、150% 字体 | 5 | Amap 3：`narrow-amap-final-attempt2.log`，55.533s；Auth 1：`narrow-auth-config-final-attempt2.log`，86.564s；Config 1：`narrow-config-final-attempt2.log`，22.417s |
| 短窗口、150% 字体 | 3 | Amap 3：`short-amap-final-attempt2.log`，101.459s |

合计覆盖 18 个不同方法及 13 次额外显示模式执行。Auth 的最终测试保持真实键盘打开，在邮箱键盘与数字键盘切换后等待 UI 空闲，再滚动并单次点击操作；原有请求数量、权限、身份与凭据不可见断言保留。

测试适配中发现的失败日志全部保留：旧结果标题、未组合的 LazyColumn 条目、临时提示覆盖点击，以及同一进程删除 DataStore 文件造成的异步隐私状态重置。决策测试现在通过现有隐私撤回契约重置，每个正式用例仍须真实显示并点击同意按钮。配置不可用用例另出现一次 10 秒提示条等待超时，未修改代码或超时门槛，同一代码复跑通过。没有删除业务断言、忽略失败退出码或放宽安全门禁。

## 视觉证据

以下均为原始模拟器 PNG，复制前后核对 SHA-256，没有修图或重新排版。账号、地点和餐厅均为自有合成夹具。查看截图时应区分容器内截断与滚动视口边缘的正常裁切；键盘图验证所示输入框的位置，操作可达性由完整设备交互验证。

| 截图 | 核对内容 | 原始批次 |
|---|---|---|
| [浅色首页](screenshots/android-ui-refinement-20260906/light-home.png) | 主题、层级、唯一主操作 | `light-final-attempt2` |
| [浅色候选](screenshots/android-ui-refinement-20260906/light-results.png) | LIVE 来源、顺序、禁用说明 | 同上 |
| [浅色账号](screenshots/android-ui-refinement-20260906/light-account.png) | 登录后的状态概览 | 同上 |
| [深色首页](screenshots/android-ui-refinement-20260906/dark-home.png) | 暗色层级与辅助文字 | `dark-final-partial-attempt1` 中已通过的 Amap 用例 |
| [深色候选](screenshots/android-ui-refinement-20260906/dark-results.png) | 暗色卡片、来源与正文 | 同上 |
| [窄屏首页](screenshots/android-ui-refinement-20260906/narrow-home.png) | 150% 字体、条件与主操作 | `narrow-amap-final-attempt2` |
| [窄屏账号键盘](screenshots/android-ui-refinement-20260906/narrow-account-keyboard.png) | 空邮箱输入框位于真实键盘上方 | `narrow-auth-final-attempt2`，Auth 已通过后导出 |
| [短窗口距离校正](screenshots/android-ui-refinement-20260906/short-radius.png) | 超限提示、修正和主操作可滚动到达 | `short-amap-final-attempt2` |

关键文字对比度按源码颜色计算，先做透明颜色叠加，再计算 sRGB 相对亮度；渐变使用最亮端点叠加最大光晕的保守下界。这不是截图像素实测或完整无障碍认证。

| 文字 / 背景 | 浅色 | 深色 |
|---|---:|---:|
| 正文 / 卡片 | 15.1406:1 | 14.3805:1 |
| 辅助文字 / 卡片 | 5.5296:1 | 8.4624:1 |
| 辅助文字 / 页底 | 5.1556:1 | 9.7145:1 |
| 辅助文字 / cardMuted | 4.9218:1 | 7.2702:1 |
| 辅助文字 / surfaceContainerHighest | 4.6557:1 | 6.3740:1 |
| 主按钮文字 / 按钮 | 6.0182:1 | 7.5497:1 |
| WARNING 文字 / 提示底色 | 4.6688:1 | 7.7038:1 |
| 首页错误正文 / 错误底色 | 11.7075:1 | 9.4406:1 |
| Home Hero 白字与光晕 | ≥4.5685:1 | ≥5.6031:1 |
| App Hero 白字与光晕 | ≥4.6939:1 | ≥5.7977:1 |
| App Hero 眉标 | ≥4.5346:1 | ≥5.5097:1 |

上述关键组合均达到普通文字 4.5:1。未执行真实手机矩阵、第三方 OAuth 平台联调或生产发布。回滚对应 PR 合并提交并重建此前稳定 APK 即可，无数据库迁移或服务端数据回滚。
