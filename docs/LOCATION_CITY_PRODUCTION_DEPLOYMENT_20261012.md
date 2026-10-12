# 城市显示接口：生产部署记录

2026-10-12 用户明确批准将城市解析接口部署上线。新增 `POST /v1/location-city` 接受严格 JSON 请求体 `location: { latitude, longitude, crs }`，仅返回 `city: string | null`。详细地址、经纬度和供应商标识不进入响应，也不记录或持久化。高德 Key 和签名材料仍只保留在服务端。

## 发布范围

- 公网 API：`https://api.unfinished-era.com/`。
- 当前 release：`20261012T125114Z-city-schema12`。
- 镜像 ID：`sha256:fac07e5e8f09adb91c17172fd90c24abec711976ed2f357c502a46b1cb1e952a`。
- 兼容源码分支：`codex/city-api-production`，工作树 `C:/Users/color/.codex/worktrees/nearby-api-production/吃什么`。
- 源码提交：`bf395f45eb9fbef2982f71d031fa4845b64810d8`，基于此前现网 `1ca1c108d13c99b223be7281e34ff5ccfeb88088`。
- 保留的旧 release：`20261011T143500Z-nearby-schema12`。

仅回移城市接口、独立高德逆地理编码 provider、公开契约/OpenAPI、JSON 媒体类型门禁和测试。不包含本地功能主线尚未上线的 schema13 或其他变更。认证、群组、已有推荐、附近餐厅收集、迁移、锁文件与 ECS 脚本均保持原样。

高德请求使用正式 `v3/geocode/regeo`、`extensions=base`、`radius=0`，经纬度转换为 GCJ-02 后最多六位小数，并使用现有数字签名。仅取城市；四大直辖市的空 `city` 由对应 `province` 回退，其他未知结果返回 null。完整读取受现有供应商超时与 64 KiB 上限约束。上游禁用或失败返回安全 503，按客户端 IP 独立限流 30 次/60 秒。一次城市查询占用一次逆地理编码调用，与餐厅周边搜索的两页调用分开。

## 验证

| 项目 | 结果 |
| --- | --- |
| 兼容分支 `pnpm lint` | 264 文件通过 |
| `pnpm typecheck`、`pnpm build` | 全 workspace 通过 |
| contracts 测试 | 83 项通过 |
| API 测试 | 796 项通过，3 项既有 PostgreSQL 条件项跳过 |
| 编译产物 runtime smoke | 新城市端点未启用 AMap 时安全 503，既有核心端点通过 |
| provider 12 项与 HTTP 4 项 | 坐标转换、签名、直辖市、空城市、有界流读取、完整超时、严格输入、安全错误和限流通过 |
| `git diff --check`、保护范围检查、独立只读复审 | 通过，无阻断问题 |
| 外置 ECS bundle 构建及校验 | 通过 |
| 新备份及校验 | `/opt/chi-shen-me/backups/postgres/20261012T124954Z`，通过 |
| 新旧镜像迁移计划与备份 ledger | 12 条版本、名称、checksum 精确匹配；未运行迁移 |
| 权限加固、严格 preflight、原激活器 | 通过；保留自动回退机制 |
| 公网 smoke、最终 runtime | `PUBLIC_SMOKE=OK`、`RUNTIME_VERIFICATION=OK` |
| 公网城市查询 | 合成北京坐标返回 200、`city=北京市`、契约版本 1、`no-store` |
| 生产边界 | PostgreSQL 容器、共享 Secret/身份状态及 API/WordPress Nginx 文件哈希保持不变；公开配置字节完全相同 |

候选初次准备在保护哈希阶段引用了错误的 `api.env` 路径而停止，尚未构建镜像或切换生产。只读核对实际路径为 `/opt/chi-shen-me/shared/secrets/api.env` 后，以继续脚本完成同一候选；失败日志保留。未修改真实配置、Secret 或现有 release 内容。

未执行 GitHub push、PR、CI 或 main 合并；本次为授权的本地兼容发布。未执行真机 GPS 测量、未知城市的公网供应商实测或实际生产回退。Android 构建和设备验收由本轮 UI 验证记录单独描述，服务端成功不替代设备验收。

## 证据与回退

本任务忽略目录 `artifacts/city-deploy/` 中保存 `compatible-local-validation.log`、`baseline-backup.log`、`backup-verified-network.log`、`candidate-prepare.log`、`candidate-resume.log`、`activation-public.log` 和 `public-city.json`。服务器 release 保留源码 SHA、前后配置和保护哈希，文件均位于受控私有目录。

需要回退时，从保留旧 release 调用同一受控激活器；无数据库或共享身份变更，回退无需恢复数据库：

```bash
cd /opt/chi-shen-me/releases/20261011T143500Z-nearby-schema12/deploy
scripts/activate-candidate-release.sh
scripts/smoke-test.sh https://api.unfinished-era.com
```

回退后旧服务器缺少城市接口，Android 使用其既有城市解析回退逻辑。
