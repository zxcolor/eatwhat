# 配置中心 Android 半径回归证据

2026-09-06 使用本轮新建的 API 36 / Pixel 6 模拟器 `emulator-5562`、独立 Fixture App/Test APK 和设备内合成 API 验证；不访问真实高德、账号或生产服务。

- `MainActivityAmapLiveFixtureTest`：最终严格 `OK (2 tests)`，29.816 秒。覆盖既有 LIVE 权利边界，以及 750 米默认、1250 米上限、场景保留的 1500 米输入、超限零请求与主动修正。
- `MainActivityGroupDecisionLocalFixtureTest`：最终严格 `OK (4 tests)`，42.242 秒。覆盖既有群组只读、重建及后台清空边界，并验证 1250 米精确复核、超限零请求及 `[1250,1500]` 的成员距离交集。

两类均通过 `scripts/run-android-instrumentation.ps1` 的 `-UseDeviceLocalApiFixture` 白名单运行；分别使用 `amapLiveFixture=true` 和 `groupDecisionLocalFixture=true`，开启 `-Install`。严格运行器检查逐项状态并恢复端口映射。

本次模拟器启动的事件计数为：`am_anr=1`（其中 Fixture App 为 0），`am_crash=0`。测试完成后本轮临时 reverse 映射恢复为空，并关闭本轮模拟器以释放资源。

| 截图 | 核对内容 |
| --- | --- |
| [单人超限](single-radius-over-limit.png) | 工作日午餐已选中，完整显示 1250 米上限、1500 米输入与主动改为 750 米的操作。 |
| [单人主动修正](single-radius-explicit-correction.png) | 750 m 已选中，同时显示 1.25 km 选项及 1250 米上限。 |
| [群组精确复核](group-radius-1250-review.png) | 共同距离为 1250 米，不四舍五入为 1.3 公里。 |
| [群组超限](group-radius-over-limit.png) | 保留 1.5 公里成员选择，并提示共同距离超出 1250 米上限。 |

截图均来自合成数据，逐张检查后原样复制并校验 SHA-256。单人早期失败为测试定位假设：上限过滤后的选项不存在、LazyColumn 内容尚未组合、初始 Snackbar 遮挡触点；最终用例等待精确提示消失，并保留选中状态、距离与零请求断言。初始提示截图及失败日志在本轮本地验证目录保留。

这些证据只覆盖单台合成环境，不替代真实管理员登录、真实 provider、生产部署、无障碍或完整设备矩阵验收。
