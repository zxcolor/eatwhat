# 城市显示与固定 Dock（2026-10-12）

## 改动

- 本地分支 `codex/stable-dock-city` 从已安装整合版本 `668c00f` 延续；原首页、方位图删除和启动收集改动保留。
- 首页位置只显示所在城市，字号由 titleLarge（20sp）调整为 titleMedium（16sp）。优先通过自有 `POST /v1/location-city` 解析显式 CRS 坐标，系统 Geocoder 作回退；未知城市显示“城市暂未获取”，不把街道、区名或坐标冒充城市。
- 城市查询只在已同意隐私且可信配置就绪的 Home 中运行；返回值与坐标只保留在 Activity 内存，相同坐标/CRS 复用结果，撤回隐私清理且拒绝迟到结果。查询请求不包含精度，原收集文件的经纬度和精度保存逻辑保持不变。
- 三个主页使用一个持续存在的 AppTabShell/Dock。NavHost 页面切换无淡入或滑动；仅灰色选中背景通过 graphicsLayer 平移，使用已有 180ms 选择时长及 ease-in-out 曲线，可从中间值重新定位。遵循 Android/Compose 系统动画缩放设置；标签保留 Tab 语义和固定触控区域。
- 版本 `0.1.10-alpha-internal`，versionCode 11。Alpha 已覆盖安装到用户原模拟器，数据保留。
- 城市接口已按用户批准部署至现网兼容版本，详见 [部署记录](./LOCATION_CITY_PRODUCTION_DEPLOYMENT_20261012.md)。每次新的城市查询增加一次高德逆地理编码调用，不改变两页周边搜索。

## 验证

- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过：Node 1,300 项通过，3 项既有 PostgreSQL 条件项跳过；编译 API smoke 通过。
- `assembleAlpha` 通过；`testDebugUnitTest lintDebug` 通过：461 项 JVM 测试全部成功，Lint 0 错误、19 条警告。新增城市字段选择、坐标请求、同坐标复用/并发和隐私撤回迟到响应等测试。
- 在原模拟器实际点击三个 Dock 按钮，所有按钮的设备坐标逐页一致；截图确认灰色选中背景位于对应项。线上接口返回城市后，首页实际显示“北京市”，没有坐标文本。测试使用之前指定的公共地标模拟 GPS，不代表真实用户 GPS 测量。
- 最新启动记录 COMPLETE、2 页、50 家餐厅，位置和精度存在。原始文件与页面截图只在忽略目录保存。
- `assembleFixture assembleFixtureAndroidTest` 通过；只读独立模拟器中的 HomeLandingTest 4 项全部通过，覆盖固定 Dock、背景途中滑动及重新定位、禁用态导航、浅色和深色大字号截图。首次两项截图因 System UI ANR 弹窗失败，原始日志已保留；恢复隔离模拟器系统界面后完整重跑通过，没有改动断言或应用数据。测试模拟器已关闭，原模拟器保持运行。

## 边界与回滚

- 未运行完整 `verify.ps1` 或真机测试；本次采用定向验证与模拟器验收，不替代公开发布门禁。按本地开发约定未推送、创建 PR、运行 GitHub CI 或合并 main。
- APK SHA-256：`8AA7D740263BBF36F875E111511778809ABAF608721B01721AD64A2791F72DA3`。
- 验证日志及截图：`artifacts/stable-dock-city/`。服务端证据：`artifacts/city-deploy/`。
- 客户端回滚只撤销本轮文件，不覆盖其他工作树；服务端保留旧 release 的受控激活器。接口回退时客户端保留系统城市解析及未知状态，不恢复坐标显示。
