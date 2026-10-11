# 启动附近餐厅收集：生产上线记录

2026-10-11 已完成生产发布，并用普通公网 Debug APK 在本任务独立模拟器实际验证高德取数及手机文件保存。用户本轮明确授权上线；没有上传 GitHub、创建 PR 或合并 main。

## 发布范围与版本

- 公网 API：`https://api.unfinished-era.com/`，新增 `POST /v1/restaurants/nearby`；`GET /v1/config` 已返回 `nearbyRestaurantCollectionEnabled=true`。
- 线上旧版本为 `578ba4bfee38105f767ce9e4adf89bc074956cce`、数据库 schema12。本地功能主线包含尚未上线的 schema13 配置中心，因此没有整体发布该主线。
- 独立兼容工作树：`C:/Users/color/.codex/worktrees/nearby-api-production/吃什么`，分支 `codex/nearby-api-production`，生产源码提交 `1ca1c108d13c99b223be7281e34ff5ccfeb88088`，以现网版本为兼容基线，只加入附近收集接口、独立高德适配器、契约和可选能力字段。
- 当前 release：`20261011T143500Z-nearby-schema12`；镜像 ID：`sha256:87af15f9118ac99d0e7a5d2826e6bb0e8428641b7f7650cce82ebfd2547700ee`。
- 旧 release `20260905T134500Z-main-578ba4b` 与旧镜像仍保留。部署包 SHA-256：`08ec975e20403ad6d9a6e6dab99038212efef62fca0e08f191f1e545c549aa25`。
- Android 沿用此前验证的 `0.1.8-alpha-debug`、versionCode 9，APK SHA-256：`E81688E93D66A7D5B6E45BB79087D90E6F863E889A47C7F738312914CA376940`。本轮没有改变 Android 源码或构建配置；本地功能主线另补接口 JSON 媒体类型门禁，提交 `da40001dc22173a7d2c9395a4a0c886546917b40`。

原有认证、群组、推荐、数据库代码、12 条迁移、锁文件和 ECS 脚本在兼容发布分支上均无差异。生产配置只替换 API 镜像标签与精确 ID；已有认证开关、共享 Secret、身份状态和 Nginx 文件保持不变，PostgreSQL 容器 ID 保持不变。服务器继续 `LIVE_DISPLAY_ONLY`，不新增餐厅或位置数据库；餐厅与本次位置、精度保存在应用私有目录，保留 90 天。

严格 ECS 环境文件尚不接受新开关键，因此本次没有向 `deployment.env` 或 `api.env` 添加 `NEARBY_RESTAURANT_COLLECTION_ENABLED`；应用配置默认 true，既有高德与 AMAP 供应商选择满足启用条件。紧急关闭可回退到保留的旧 release。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| 兼容分支 `pnpm lint` | 257 文件通过 |
| 兼容分支 `pnpm typecheck`、`pnpm build` | 全 workspace 通过 |
| contracts `pnpm --filter @chi-shen-me/contracts test` | 81 项通过 |
| API `pnpm --filter @chi-shen-me/api test` | 780 项通过，3 项既有 PostgreSQL 条件测试跳过；编译 API runtime smoke 通过 |
| 新增边界测试 | provider 6 项、service 2 项、HTTP 4 项；覆盖 3500.01 米排除、3499.99 米保留、WGS84/GCJ02、签名、有界读取、超时取消、畸形数据、关闭时零调用、两页与 JSON 415 |
| `git diff --check` 与保护范围无差异检查 | 通过；独立只读复审未发现阻断问题 |
| `build-ecs-deployment-bundle.ps1`、`verify-ecs-deployment-bundle.ps1` | 通过；按脚本要求生成在仓库外目录 |
| 活动 release `backup-database.sh`、`verify-database-backup.sh` | 通过，备份 `/opt/chi-shen-me/backups/postgres/20261011T143033Z` |
| 新旧不可变镜像 `loadMigrationPlan()` 对备份 ledger 精确比较 | 两者 12 项名称、版本、checksum 均一致；没有执行迁移 |
| 候选权限加固、严格 preflight | `RELEASE_PERMISSIONS=OK`、`DEPLOYMENT_PREFLIGHT=OK` |
| `activate-candidate-release.sh` | `CANDIDATE_RELEASE_ACTIVATION=OK`、`POSTGRES_CONTAINER_UNCHANGED=true`；脚本具备失败自动回退 |
| 公网 `smoke-test.sh`、最终 `verify-runtime.sh` | `PUBLIC_SMOKE=OK`、`RUNTIME_VERIFICATION=OK`，API/PostgreSQL healthy |
| 公网新能力与既有配置逐项比较 | 新能力 true；原所有公开字段保持一致 |
| 公网无效媒体类型、非法第 3 页、`/admin/v1` | 分别 415、400、404；响应 `Cache-Control: no-store` |
| 普通公网 APK 第一次独立启动 | COMPLETE，2 页、50 条 AMAP/LIVE，1 个时间戳 JSON；3500 米、90 天、位置经纬度/坐标系/有效正数精度均保存 |
| 普通公网 APK 第二次独立启动 | COMPLETE，2 页、50 条；新增独立文件，总计 2 文件；第一份文件 SHA 不变，没有混合或覆盖 |

两次设备验收使用本任务 `emulator-5560`、合成 GPS 与真实 HTTPS API/高德数据，ADB reverse 为零。没有操作真实手机。原始门店和定位只留在应用私有文件；宿主仅记录字段有效性与数量，日志、源码及本记录不含精确位置、门店内容或密钥。时间戳文件名与各自启动时间匹配，每份文件内部无重复 ID，每日清理 Job 已注册。

追加只读定位核验最初使用逐位相等比较，因模拟器浮点舍入报告 false，原记录保留。随后按定位数据的物理意义复核：两份保存位置距合成注入点不足 1 米，且处于系统报告精度内；两份启动时间各自计算的 90 天保留期限正确。没有修改产品源码或自动化测试断言，该追加核验没有重新启动或调用餐厅接口。最终聚合证据为 `public-location-retention-final-aggregate.json`。本任务模拟器已正常停止，缓存保留，未关闭共享 ADB 或其他设备。

前两次镜像构建在 Corepack 下载 pnpm 时出现 `ETIMEDOUT/ENETUNREACH`，均在切换前停止。随后使用构建专用 `--network host --add-host registry.npmjs.org:<本次核验可达 IPv4>` 完成标准 Dockerfile 构建，仍使用 `pnpm install --frozen-lockfile`，没有改变锁文件、生产容器网络或 TLS 校验。相关失败日志与成功日志均保留在本任务忽略目录。

## 保留证据与回退

宿主忽略目录 `artifacts/nearby-deploy/` 保存备份、构建、激活、公网验证及最终运行日志；`artifacts/nearby-cache/public-opening-1-aggregate.json` 和 `public-opening-2-aggregate.json` 保存两次设备聚合验收。服务器 release 中保存 `SOURCE_COMMIT.txt` 和 root-only 边界校验记录。

需要回退时，从保留的旧 release 执行原有受控激活器：

```bash
cd /opt/chi-shen-me/releases/20260905T134500Z-main-578ba4b/deploy
scripts/activate-candidate-release.sh
scripts/smoke-test.sh https://api.unfinished-era.com
```

本次没有改变数据库或共享身份材料，回退无需恢复数据库。回退后旧服务缺少新能力字段，Android 会停止启动收集。没有为验证而执行实际回退或额外重建生产容器。

未执行项：本轮未重跑完整 Android/Alpha `verify.ps1`，因为此次发布是兼容 API 变更，Android 使用前一轮已完成 JVM、lint、构建与设备回归的相同 APK，再做公网实际验证；未执行真实手机 GPS/定位精度验证、实际等待 90 天后的清理，以及 GitHub CI/PR/合并。既有过期逻辑已在合成时钟测试中验证。本地 main 与 origin/main 仍同为 `757529bc2f6c04332e5a0a024ea60b6deadece12`，没有修改其他工作树。
