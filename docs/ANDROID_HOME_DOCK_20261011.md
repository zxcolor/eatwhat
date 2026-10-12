# Android 首页与三项 Dock 本地验证

日期：2026-10-11。分支：codex/home-dice-layout。基线：757529bc2f6c04332e5a0a024ea60b6deadece12。

## 实现

首页使用已确认草图的浅灰背景、白色圆角主卡片，标题“今天中午吃什么”，主操作“帮我选”，副标题“What to eat？”。移除三餐选项栏、旧食物按钮和首页条件入口；首页没有 AI 推荐列表。

Dock 只有首页、历史、个人，切换保存页面状态并避免重复叠加路由。个人页提供账号与安全、本次推荐条件、设置三个入口，游客无需先登录。原有条件面板和已选位置保留。历史复用既有账号记录页，优先打开服务器允许的历史分区；未开放时保留原有能力提示与可用分区回退，不新增记录权限或静默上传。

候选版本 0.1.7-alpha，versionCode=8，普通 Debug 的实际版本为 0.1.7-alpha-debug。其他工作树已分别使用 0.1.5 / 0.1.6 候选，本次使用独立版本标识，未合入这些分支。

没有修改 API、契约、数据库、认证实现或部署。首页沿用默认午餐，后端专项 profile 和供应商能力校验保留。普通 Debug 仍访问 https://api.unfinished-era.com/。

## 检查

先检查差异与相关工作树并运行 git fetch origin --prune。main、origin/main 和任务基线相同，无须快进更新；从 main 创建独立任务分支，没有覆盖其他工作树修改。

| 实际命令或检查 | 结果 |
|---|---|
| pnpm install --frozen-lockfile | 通过；锁文件未改变 |
| pnpm lint | 通过 |
| pnpm typecheck | 通过 |
| pnpm test | Contracts 95、Admin 52、Mini-program 174、API 957 项通过；3 项 PostgreSQL 条件测试跳过；编译后 API smoke 通过 |
| pnpm build | 通过 |
| gradlew.bat -p apps/android testDebugUnitTest lintDebug assembleDebug assembleFixtureAndroidTest --console=plain | 通过；446 项 JVM 测试，failure/error/skipped 均为 0 |
| gradlew.bat -p apps/android assembleFixture --console=plain | 通过 |
| Android Lint XML | 0 错误、19 警告；包含版本/API 提示和旧食物资源未引用提示，未降低门禁 |
| Debug APK DEX 检查 | 含预期公网 HTTPS 基址，不含 Fixture 的 http://127.0.0.1:3001/ |
| git diff --check、未跟踪文件与新增内容敏感模式检查 | 通过；APK、工具、日志、依赖保持忽略 |

Gradle 在命名构建锁内使用临时 W: ASCII 路径，退出时撤销映射并释放锁。本机 JDK/SDK 链接只在忽略目录，不改上游工具或用户级 Gradle 配置。

首次编译因骰子绘图使用不支持的 Offset 可变参数失败，修正后重新执行全部相关 Gradle 任务通过。失败及最终日志均保留在 artifacts/home-dice/android-build.log 和 android-build-final.log。

## 设备回归

使用独立、全新用户数据的 API 36 测试模拟器 emulator-5560，没有安装、退出或清理手机及现有模拟器上的应用。Fixture App/Test 只安装到该测试模拟器。

隔离组件测试实际命令：

    adb -s emulator-5560 shell am instrument -w -r -e class com.chishenme.app.HomeLandingTest com.chishenme.app.debug.test/androidx.test.runner.AndroidJUnitRunner

3 项通过：准确文案及移除入口、禁用主操作时导航仍可用、深色和 160% 字体下操作可达。该测试组合真实 UI 组件和合成地点文字，不调用推荐、定位或账号服务。

完整应用通过仓库严格 runner 执行：

    ./scripts/run-android-instrumentation.ps1 -Serial emulator-5560 -ClassName 'com.chishenme.app.MainActivityAmapLiveFixtureTest' -UseDeviceLocalApiFixture -InstrumentationArguments @{ amapLiveFixture='true' }
    ./scripts/run-android-instrumentation.ps1 -Serial emulator-5560 -ClassName 'com.chishenme.app.MainActivityAuthLocalFixtureTest' -UseDeviceLocalApiFixture -InstrumentationArguments @{ authLocalFixture='true' }
    ./scripts/run-android-instrumentation.ps1 -Serial emulator-5560 -ClassName 'com.chishenme.app.MainActivityConfigUnavailableTest' -UseDeviceLocalApiFixture -InstrumentationArguments @{ configUnavailable='true' }

分别通过 4 / 1 / 1 项，合计 9 个设备测试正常完成。新增测试验证首页进入历史及个人、个人进入设置、返回调整条件后已选地点仍存在。既有半径校正、授权展示、账号认证和配置 503 回退断言继续通过；未忽略退出码或降低断言。

严格 runner 首次前置检查因新设备缺少 tcp:3001 映射而停止。为独立测试设备建立唯一 Fixture 映射后，runner 按原规则暂移和恢复映射，重跑通过。失败及最终日志为 navigation-amap-tests.log 和 navigation-amap-tests-final.log。测试结束后移除本次映射并关闭本次专用模拟器。

## 视觉证据与 APK

原始模拟器 PNG 从应用缓存复制到本机时核对 SHA-256，没有修改像素。

- [完整应用首页](screenshots/home-dock-20261011/full-app-home.png)：完整导航和设备内合成 API，地点来自测试选择器。
- [隔离首页组件](screenshots/home-dock-20261011/decision-home-light.png)：空地点回退与首页布局。
- [个人页组件](screenshots/home-dock-20261011/decision-personal-light.png)：三个入口及三项 Dock。
- [深色大字体组件](screenshots/home-dock-20261011/decision-home-dark-large-text.png)：160% 字体、长地点名称和操作可达；此组件测试替换 Activity 内容，未同步生产根组件的系统栏明暗副作用，仅作为内容布局证据。

普通 Debug：artifacts/home-dice/app-home-dock-0.1.7-alpha-debug.apk。

SHA-256：D9F909D1AD53070D7D98AA5D6FBD56CF610FBECD149D7CEFB78D829763F05D55。

Fixture App SHA-256：0FBCE616FFF00D255BA8D657C1D0CB56617B0B19B925636C21C69678E8E35CFE。

Fixture AndroidTest SHA-256：429BC24B33E5C2A46F2113F0E2A74EC68E661FD8561AD9F2A3AAFD0F23EDDCC6。

## 未执行与交付边界

- 未运行完整 ./scripts/verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'：当前进程没有受控 Alpha 微信、QQ 公开 AppID，未用虚构 AppID 替代，也未构建 Alpha。
- 3 项 PostgreSQL 条件测试因缺少对应数据库条件跳过，没有记为通过。
- 未运行其余设备类、真实手机矩阵或第三方 OAuth 联调；设备回归只覆盖上述 9 项。
- 按既有本地开发要求，未 push、创建 PR、合并 main 或部署；本次没有 GitHub CI 链接或远端全绿结论，是已验证的本地候选。

回滚可在后续本地集成分支撤销本次任务提交并重建上一版 APK，无数据库或服务端迁移；不要重置其他并行工作树。
