# Android 启动附近餐厅收集

本地候选 `0.1.8-alpha`（versionCode 9），分支 `codex/nearby-restaurant-cache`。
基于已确认的首页分支 `codex/home-dice-layout` 的 `2c476b0` 继续开发，主干引用仍为 `757529b`。
用户于本任务明确确认餐厅数据存储权，并将最终要求限定为：每次最多两页、同一收集目录下按启动时间戳分别保存文件；每次还要保存本次用户位置及定位精度。

## 行为

- 首次打开先同意新版隐私政策，再请求大致/精确定位权限。返回用户已有同意且已有权限时直接定位；缺少权限时请求系统授权，永久拒绝时提醒前往应用设置。拒绝后仍可手动选址。
- 首次定位失败、超时或无法取得位置后，间隔一秒再试五次，最多六次尝试；六次都失败才弹窗。权限失效先返回权限请求，不持续重试没有权限的定位。定位服务关闭也遵循该次数，最后提供设备定位设置入口。
- 每次前台打开独立收集；旋转及 Compose 重建不会额外创建一次启动或增加分页。退到后台、退出或撤回隐私同意取消在途定位/收集。
- 自有 `POST /v1/restaurants/nearby` 固定餐饮类型 `050000`、半径 3500 米、高德 `/v5/place/around`，每页最多 25 条，页号仅 1 或 2。第一页不足 25 条提前结束，否则请求第二页。最多两次高德查询，不为餐厅 API 自动重试；定位重试不调用高德。过滤和同次去重后数量可能少于 50。
- 后端和 Android 分别按显式坐标系校验半径。大致定位仍可用，但 3.5 km 以系统提供的大致坐标为中心，不能证明距离实际人的精确位置。
- 服务端查询中心只在内存及请求体内使用；手机文件的 `userLocation` 保存本次查询使用的用户经纬度、显式坐标系与 `accuracyMeters`（米），与餐厅资料一并保留 90 天。系统提供的有效精度原值保留，包括大致定位可能大于 10 km 的误差；系统未提供或值无效时明确写入 JSON `null`，不伪造精度。推荐请求保留既有精度边界，收集接口只传三项坐标字段、不上传精度。没有单独的位置轨迹文件，也不保存账号、令牌或设备 ID。高德 Key/签名仍只在服务端。

## 本地文件与保留

应用私有目录结构为：

```text
files/nearby_restaurants/
  1791720000000.json
  1791720600000.json
```

每个文件包含启动/更新时间、本次用户位置与精度、半径、90 天保留期限、已收集页数、状态 `COLLECTING/COMPLETE/PARTIAL`、两页上限标志以及本次门店数组。同一供应商门店 ID 仅在本次文件中去重；不同启动中即便门店相同也分别保存，包括各次独立的定位数据。毫秒时间戳碰撞时只将文件名递增 1 ms，元数据保留实际启动时间，防止覆盖。AtomicFile 原子替换避免中断留下半个 JSON。第二页失败时第一页面数据留在本次文件，标记为 PARTIAL；达到两页上限算已完成本次两页收集，`limited=true` 表示上游可能还有更多数据。旧格式文件缺少 `userLocation` 时可读作空值，新收集始终保存取得的用户位置。

定位字段示例只使用合成测试坐标：

```json
"userLocation": { "latitude": 0.0, "longitude": 0.0, "accuracyMeters": 15.0, "crs": "WGS84" }
```

保留时间从启动时间计算，不因分页写入或读取延期。启动、创建文件和读取缓存都会物理删除过期文件；系统 JobScheduler 每日安排维护，并在重启后保留维护任务。后台维护只删除数据，不定位、联网或收集餐厅。Android 调度可能因关机、Doze、强行停止或设备策略延后，不能保证在第 90 天的毫秒边界立即物理删除；到期数据在下一次任何读取前即删除且不会返回。个人 → 设置可清除全部餐厅缓存及对应定位记录；撤回同意先关闭进程授权及取消收集，再清除文件，不允许晚到响应重建文件。隐私政策与 SDK 清单版本更新为 `2026-10-11.2`，既有同意不能跳过新增本机定位保存说明。

## 服务开关与本地边界

`NEARBY_RESTAURANT_COLLECTION_ENABLED` 默认 true，可显式关闭。还要求 AMAP 已配置启用，且推荐供应商优先级实际选择 AMAP；不会在上游出错后混入 DEMO。新 `/v1/config` 返回独立 `nearbyRestaurantCollectionEnabled`。旧服务缺少字段时 Android 保持关闭，避免请求不存在的接口。

该能力依据用户本次确认的本机存储权，与现有 `LIVE_DISPLAY_ONLY/LICENSED_ENRICHMENT` 推荐排序和账号持久化门禁分别表达，不改变既有收藏、推荐历史、反馈、模型处理或外部动作的权限。服务器仍不建立餐厅缓存数据库。

## 验证记录

最终源码已完成以下本地验证：

| 实际执行 | 结果 |
| --- | --- |
| `pnpm lint` | 350 个文件，无错误 |
| `pnpm typecheck` | contracts、API、admin、miniprogram 全部通过 |
| `pnpm test` | contracts 95、API 960、admin 52、miniprogram 174 项通过；API 编译产物 smoke 通过。3 项需要独立 PostgreSQL 验证环境的条件测试按原门禁跳过 |
| `pnpm build` | 全部通过 |
| `.codex-tmp/build-home.ps1 -Tasks @('testDebugUnitTest','lintDebug','assembleDebug','assembleFixture','assembleFixtureAndroidTest','--max-workers=2','-Dorg.gradle.jvmargs=-Xmx5g -Dfile.encoding=UTF-8')` | 最终 `android-location-build.log` 为 BUILD SUCCESSFUL；458 项 JVM 单测，0 失败/错误/跳过；lint 0 错误、19 项既有依赖/资源/API 建议；Debug、Fixture、测试 APK 构建通过 |
| `.codex-tmp/verify-nearby-device.ps1` | 独立 emulator-5560 的 `NearbyRestaurantCollectionTest` 4 项通过，4 次 start 与 4 次成功终态；验证两页、文件隔离、毫秒碰撞、不同用户位置与精度、显式 null、实际过期删除、六次定位失败提醒、撤回后不重建文件 |
| `.codex-tmp/verify-nearby-regression.ps1` | 同一独立模拟器：HomeLanding 3、PrivacyWithdrawalMarkerStore 1、MainActivityAmapLiveFixture 4 项通过；最后一组通过仓库正式严格 runner 和 `-UseDeviceLocalApiFixture -InstrumentationArguments @{amapLiveFixture='true'}` 执行 |
| `git diff --check`、改动/未跟踪文件与敏感材料边界检查 | 通过；没有 APK、构建输出、凭据或真实定位样本进入源码变更 |

临时 PowerShell 构建入口只为中文路径映射本任务的 `W:`，调用现有 `scripts/android-env.ps1` 和 Gradle；完成后释放映射与本机构建锁，不修改用户级 Gradle 配置。临时脚本、原始日志和 APK 保留在本任务忽略目录，未纳入 Git。设备用合成门店、注入定位结果及设备内隔离 API，没有调用真实高德、操作真实手机或主服务端。

迭代过程中真实失败已保留：主程序初稿颜色属性不存在、既有隐私说明子串断言因标点变化失败、收集配置刷新用例曾读取修改前编译结果，均在最终源码验证中通过；新设备用例曾漏传主题参数，并缺少 Fixture 的 Compose 宿主 Activity，补齐了测试配置后四项通过。首页截图检查一度被模拟器的 “System UI isn't responding” 对话框遮挡，确认系统提示并选择等待后重跑通过；未删除断言或放宽成功门禁。

全量 `./scripts/verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'` 未运行：当前进程没有受控公开 `CHISHENME_ALPHA_WECHAT_APP_ID` 和 `CHISHENME_ALPHA_QQ_APP_ID`，不能用 Secret 或虚构值替代。真实手机定位、真实高德取数、长期关机后的物理清理、生产发布及 GitHub CI 均未执行，不能用本地合成验证替代这些结果。

本次按此前用户的本地开发约定保留在 `codex/nearby-restaurant-cache`，不上传 GitHub、创建 PR、合并 main 或部署服务器。新服务端代码尚未由本任务上线；连接缺少新能力字段的旧服务时，Debug 会保持启动收集关闭。其他工作树原有改动保持不变，本地 main 与 origin/main 引用仍一致。

普通公网 Debug 交付文件：`artifacts/nearby-cache/app-nearby-0.1.8-alpha-debug.apk`，versionCode 9，versionName `0.1.8-alpha-debug`。DEX 检查包含 `https://api.unfinished-era.com/`，不包含 Fixture 的 `http://127.0.0.1:3001/` 或 `http://localhost:3001/`。SHA-256：`E81688E93D66A7D5B6E45BB79087D90E6F863E889A47C7F738312914CA376940`。

接口参数依据 [高德搜索 POI 2.0 官方文档](https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch)，权限处理依据 [Android 官方文档](https://developer.android.com/training/permissions/requesting)，检查日期 2026-10-11。
