# Android 1.0：ECS 最小云端部署计划

> 当前检查点：2026-08-23，线上全国版 release 为 `20260823T071142Z-nationwide`；不可变 bundle、镜像、权限、Compose、数据库 readiness、真实高德与自动回退门禁均已通过。
> `AMAP_ENABLED=true`，独立的 `api.unfinished-era.com` DNS、Let's Encrypt 证书、vhost 和自动续期均已激活；ECS 与工作站公网 HTTPS 闭环通过，关闭 Wi-Fi 的外部真机仍待复验。
> 适用范围：北京地域 2 vCPU / 2 GiB / 40 GiB / 3 Mbps ECS，云端 Debug 与封闭邀请制 Alpha 共用单实例 API。

## 1. 结论与当前状态

现有 ECS 足以承载单实例、少量开发者 Debug 与受邀 Alpha，不需要把决策算法搬进 APK，也不需要为节省服务器资源删除 Android 1.0 的决策能力。普通 Debug 直接连接与 Alpha 相同的公网 API/PostgreSQL；本轮不复制第二个 API 容器、Compose project、宿主端口、域名、Secret、数据库或卷。直接餐厅关键词搜索从客户端移除是产品范围收口，不是服务器容量妥协；服务器的主要负担是 PostgreSQL、账号状态和容器运行时，不是规则排序本身。

共用意味着 Debug 流量计入 Alpha 的 IP 限流、高德配额、配置和未来账号数据。当前 2 GiB 主机不适合再并行启动一套相同 API/数据库；若后续需要隔离破坏性迁移、真实测试账号或不同微信/QQ AppID，应使用独立 staging 域名、Compose project、端口、Secret、数据库角色/卷和上游配额，并先升级到至少 2 vCPU / 4 GiB 或使用另一台服务器。不得让两个环境共享数据库完成实验性迁移。

当前部署严格分为三个检查点：

| 检查点 | 当前结果 | 是否可对外 |
| --- | --- | --- |
| 基础运行时 | `20260823T071142Z-nationwide` 已成为 `current`；API/PostgreSQL healthy，`/health/ready` 为 200，PostgreSQL 容器在切换中未变化 | 封闭 Alpha |
| 新候选发布 | Linux/amd64 镜像 `sha256:44041f99d06b1758088b58a22af83707e56db81783c8c4daadc7347e9da7c3a7`、root-only release、共享 Secret/TLS 与 Compose 已通过预检、上海隔离验收和动态激活 | 是 |
| 高德真实数据 | `AMAP_ENABLED=true`；Key、数字签名与固定出口 IP 白名单门禁通过，隔离容器、活动容器和公网均得到 `AMAP/LIVE` 结果 | 封闭 Alpha |
| 公网域名 | `https://api.unfinished-era.com` 已启用独立 DNS、证书、vhost 与自动续期；只公开健康探针和 `/v1`，`/admin/v1` 为 404 | 封闭 Alpha |
| WordPress | 原站点文件、宝塔数据库、证书和两份恢复点均保留；当前离线 | 不受本次 API 基础运行时影响 |
| 登录 | 账号、手机号、邮箱、微信、QQ 均保持关闭 | 否 |

当前真实地点搜索和餐厅推荐的技术链路、数据库 readiness、域名 HTTPS 与工作站公网访问均已通过；这仍不等于商业授权、登录供应商、关闭 Wi-Fi 真机矩阵、App 备案或 Android 1.0 公开发布门禁已经完成。

## 2. 当前实际拓扑

```text
Android Debug / Alpha（公网流量，共用 api.unfinished-era.com）
        |
        | HTTPS :443
        v
宝塔 Nginx（宿主机，API 子域使用独立 vhost 与证书）
        |
        | http://127.0.0.1:13001
        v
Docker 端口映射（仅绑定宿主机回环）
        |
        | edge 网络 172.30.10.0/29，容器端口 :3001
        v
NestJS 公共 API（单实例，172.30.10.3 / 172.30.20.3）
        |
        | database 内部网络 + TLS verify-full
        | postgres.internal:5432
        v
PostgreSQL 17 + PostGIS 3.5（172.30.20.2，无宿主机端口）

API 出站：
  - 高德 Web Service：阶段 A 已启用并完成基础真实 smoke
  - 阿里云短信、微信开放平台：阶段 B
```

部署不再运行 Caddy。TLS 和公网反向代理由服务器既有的宝塔 Nginx 承担；Compose 只发布 `127.0.0.1:13001`，PostgreSQL 只在 `internal: true` 的 Docker 网络暴露 `5432`，宿主机和公网都没有数据库监听端口。

API 的 `TRUSTED_PROXY_CIDRS` 固定为 edge 网关 `172.30.10.1/32`。不能改成公网网段、`0.0.0.0/0` 或无条件信任转发头。

## 3. APK 与云端职责边界

| 能力 | APK | ECS | Android 1.0 状态 |
| --- | --- | --- | --- |
| 隐私同意、主题、偏好、内置快捷地点和结果 UI | 本地 | 不需要 | 保留 |
| 用户主动定位 | 权限与坐标采集 | 只接收请求坐标 | 保留 |
| 自动定位与手动选址 | 采集或选择本次推荐起点；地点关键词经 HTTPS JSON 请求 | 地点适配、校验和最多 5 条结果 | Android 1.0 保留，作为决策前置步骤 |
| 餐厅推荐与推荐详情 | 发 HTTPS JSON 请求并展示主推荐和备选 | 高德适配、校验、过滤和结果生成 | 推荐云端技术闭环通过；详情、真机与授权矩阵待验收 |
| 独立餐厅关键词搜索 | 不展示、不路由、不调用 | 保留 `/v1/place-search`、OpenAPI 与 provider | 仅服务端独立能力，不属于 Android 1.0 |
| 最低版本与能力发现 | 执行门禁 | `/v1/config` 提供配置 | 基础 API 已具备 |
| 推荐事件 | 失败不阻断推荐 | 单实例内存登记 | 保留 |
| 手机号/微信登录与会话 | 保存安全令牌 | 短信、微信、认证事务和数据库 | 待阶段 B |
| 收藏、跨端历史、私密反馈、导出 | 客户端已有部分消费端 | 需独立能力和权限 | 首轮关闭 |
| 分享推荐卡 | Android 1.0 固定关闭 | provider 返回 `share=false` | 封存到 2.0 |

高德 Key、数字签名私钥、微信 AppSecret、认证密钥和数据库密码永远不进入 APK、Git、部署 bundle、日志或验收文档。

`GET /v1/config` 只通过供应商无关的 `serviceCapabilities` 声明
`recommendationsEnabled`、`locationSearchEnabled` 和 `placeSearchEnabled`。对象缺失、
字段缺失或值不是明确的 `true` 时，共享契约和服务端按失败关闭处理。Android 1.0
只消费前两项并无条件忽略 `placeSearchEnabled`；即使它为 `true`，客户端也没有直接餐厅
关键词搜索入口、路由或请求。地点搜索能力判断与产生它的可信配置 generation 绑定：旧
generation 的 `true` 不能取得新 generation 的远程访问 lease，因此配置刷新或能力关闭后
不得用旧 UI 状态继续发网。
该对象只表示当前已选 adapter 的本地配置是否可用，不探测高德配额，也不向客户端
披露具体供应商身份。

## 4. 不可变 release 与共享状态

每个发布版本放在独立目录：

```text
/opt/chi-shen-me/releases/<release-id>/source
/opt/chi-shen-me/releases/<release-id>/deploy
```

跨 release 持久化的凭据固定放在：

```text
/opt/chi-shen-me/shared/secrets
```

`SHARED_STATE_DIRECTORY` 必须是 `/opt/chi-shen-me/shared`。`prepare-secrets.sh` 在同一文件系统的临时目录生成数据库 CA、服务端证书和随机密码，校验后原子移动到共享目录；已有共享 Secret 时脚本拒绝覆盖。任何 release 更新都不得重新生成仍在使用的数据库角色密码或删除共享目录。

PostgreSQL 数据使用固定名称 `chi-shen-me-alpha_postgres_data` 的 Compose 外部卷持久化，避免 `docker compose down -v` 随 release 误删。它和共享 Secret 都不属于不可变 release，切换 release、删除旧源码或重建 API 容器时不得删除。数据库卷仍在同一系统盘上，因此不能代替异机备份。

部署 bundle 不含 Secret。工作站生成后必须先用
`scripts/verify-ecs-deployment-bundle.ps1` 验证固定清单和 `SHA256SUMS`；上传到新的
`/opt/chi-shen-me/releases/<release-id>/deploy` 后，还必须在 ECS 运行
`scripts/preflight-deployment.sh`，校验 release 路径、权限、所有者、共享状态、镜像
坐标、数据库证书和 Compose 配置，再允许迁移或启动。预检不会写入真实 Secret，
也不能把任意目录提升为 release。API 镜像仍须在启动前核对镜像 ID、平台和入口文件。

候选和旧 release 固定使用同一个 `chi-shen-me-alpha` Compose project，因此 release
激活是对同一 `api` service 的原地替换，不是两套 API 并行的蓝绿部署。只有候选
readiness 完整通过后，`activate-candidate-release.sh` 才会原子切换 `current`；任何失败
都必须重建旧 API 并验证旧容器 healthy、`/health` 为 HTTP 200。该脚本只重建 API，
绝不迁移或重建 PostgreSQL，也不触碰 Nginx。

## 5. 数据库安全边界

生产数据库目标固定为：

```text
postgres.internal:5432/chi_shen_me
```

连接使用 `verify-full`，数据库证书 SAN 包含 `DNS:postgres.internal`。PostgreSQL 使用 TLS、SCRAM 和受限 `pg_hba.conf`，不向宿主机发布 `5432`。

实际角色名如下，不能再使用旧文档中的 `csm_*` 前缀：

| 角色 | 用途 | 是否进入普通 API |
| --- | --- | --- |
| `postgres_bootstrap` | 首次创建角色、扩展和数据库 owner 调整 | 否 |
| `api_runtime` | 普通 API 最小权限访问 | 是 |
| `schema_migrator` | schema owner 与版本迁移 | 否 |
| `retention_worker` | 保留期清理 | 否 |
| `admin_api_runtime` | 隔离的管理员运行时 | 当前不部署 |
| `data_export_worker` | 隔离的数据导出 worker | 当前不部署 |

五个应用角色均为 `LOGIN`，且必须保持 `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`。迁移、maintenance 和 bootstrap 凭据不得注入 API 容器。

## 6. 当前生产基线

发布坐标写入 `deployment.env`，其中不放 Key 或密码：

```dotenv
COMPOSE_PROJECT_NAME=chi-shen-me-alpha
SHARED_STATE_DIRECTORY=/opt/chi-shen-me/shared
API_LOOPBACK_PORT=13001
API_IMAGE=chi-shen-me-api:20260823T071142Z-nationwide
API_IMAGE_ID=sha256:44041f99d06b1758088b58a22af83707e56db81783c8c4daadc7347e9da7c3a7
POSTGRES_DB=chi_shen_me
POSTGRES_BOOTSTRAP_USER=postgres_bootstrap
POSTGRES_VOLUME_NAME=chi-shen-me-alpha_postgres_data
POSTGIS_IMAGE_ID=sha256:<已校验的 PostGIS 镜像 ID>
MINIMUM_SUPPORTED_VERSION=0.1.1
AMAP_ENABLED=true
RETENTION_MODE=--dry-run
```

普通 API 使用下列不可变身份声明：

```dotenv
NODE_ENV=production
PORT=3001
TRUSTED_PROXY_CIDRS=172.30.10.1/32
DATABASE_ENABLED=true
DATABASE_SSL_MODE=verify-full
DATABASE_EXPECTED_TARGET=postgres.internal:5432/chi_shen_me
DATABASE_RUNTIME_ROLE_NAME=api_runtime
DATABASE_MIGRATION_ROLE_NAME=schema_migrator
DATABASE_MAINTENANCE_ROLE_NAME=retention_worker
DATABASE_EXPORT_WORKER_ROLE_NAME=data_export_worker
DATA_RIGHTS_MODE=LIVE_DISPLAY_ONLY
ALLOW_DEMO_DATA=false
QWEN_ENABLED=false
ACCOUNTS_ENABLED=false
```

`api.env`、`migration.env` 和 `maintenance.env` 分别只保存对应进程需要的 URL、CA 和服务端 Secret。真实值只在 ECS 的 root 管理目录录入，不在本文示例中展开。

## 7. 高德阶段 A 门禁

当前服务器已在以下三项全部完成后受控启用 `AMAP_ENABLED=true`：

1. 取得高德 **Web Service Key**，不是 Android SDK Key；
2. 取得与该 Key 匹配的服务端数字签名私钥；
3. 在高德控制台把 ECS 固定公网出口 IPv4 加入该 Key 的 IP 白名单，并确认已生效。

本轮已先在隔离容器和活动容器完成服务器侧真实 smoke，再切换域名；实际覆盖范围为：

- `/health/ready` 和 `/v1/config` 正常，三项服务能力均为 `true`；
- “北京大学”地点关键词搜索返回 5 条 `AMAP/LIVE`、GCJ-02 结果；
- 北京大学东门附近午餐推荐返回 3 条 `AMAP/LIVE` 结果，不出现 DEMO 来源；
- `LIVE_DISPLAY_ONLY` 下 `fitScore=null`、`actions.share=false`；
- Key、签名、坐标和完整供应商请求 URL 不进入日志；
- 离线自动化覆盖超时、业务错误和供应商异常的 fail-closed；真实配额耗尽动态演练仍待完成。

`/health` 只证明进程存活；`/health/ready` 才检查启用数据库的 `SELECT 1` 和核心推荐适配器配置。Compose、运行时验证和公网 smoke 均使用 readiness，因此生产 `ALLOW_DEMO_DATA=false` 且 `AMAP_ENABLED=false` 时返回受控 503、容器保持 unhealthy 是预期的失败关闭状态。

Key 能返回数据不等于数据使用和商业授权已经完整解决；自有加权排序仍受书面授权和 `LICENSED_ENRICHMENT` 门禁约束。

## 8. 独立 API 子域与 WordPress 共存

宝塔 Nginx 继续拥有 `80/443`，API 的 Compose 不触碰这两个端口。公网 API 改用 `api.unfinished-era.com` 的独立 vhost、ACME well-known 文件和证书；`www.unfinished-era.com` 与根域的主站 vhost 不再作为 API 激活目标。

仓库中的 `nginx/api.unfinished-era.com.conf` 是当前已激活的 HTTPS 模板，只代理 `/health`、`/health/ready`、`/v1` 和 `/v1/*`，其余路径返回 404。`nginx/api.unfinished-era.com.acme.conf` 仅用于首次申请证书时的 HTTP-only 阶段；当前 DNS、证书与最终 vhost 已完成，后续不得用临时模板覆盖活动配置。

上述门禁已满足并从当前 release 成功执行 `scripts/activate-api-subdomain-nginx.sh`。它固定代理 `127.0.0.1:13001`，备份并只替换 API 子域 vhost，在 reload 前后比较主站 vhost SHA、核对 `nginx -T` hostname 唯一归属，并用本机 SNI/HTTP/HTTPS smoke 验证实际服务证书、readiness、配置接口和 `/admin/v1` 的 404；本轮全部通过。续期成功 hook 使用 `reload-nginx-after-certificate-renewal.sh`，与激活器共用 public-Nginx 锁且已动态重载成功。宝塔面板不遵守项目锁，因此后续激活/续期窗口仍禁止并发修改站点或证书。旧 `activate-baota-nginx.sh` 固定 fail closed，旧主站 API 模板不再进入 bundle。原 WordPress 文件目录、宝塔 MySQL 数据库、主站证书和手工备份必须继续保留。完整恢复步骤见 [WORDPRESS_OFFLINE_RECOVERY.md](./WORDPRESS_OFFLINE_RECOVERY.md)，API 运维、备份和数据库回滚见 [ECS_OPERATIONS_RUNBOOK.md](./ECS_OPERATIONS_RUNBOOK.md)。

## 9. 2 核 2G 资源预算

当前 Compose 的常驻上限是：

| 组件 | 限制/配置 | 说明 |
| --- | ---: | --- |
| NestJS API | `640 MiB`；Node heap `384 MiB`；DB pool 4 | 单实例 |
| PostgreSQL/PostGIS | `768 MiB`；`shared_buffers=128MB`；`work_mem=2MB`；`max_connections=30` | 仅内部网络 |
| 宝塔 Nginx | 宿主机既有进程，不另起容器 | 与现有面板环境共存 |
| migrate / retention | 各 `256 MiB`，一次性运行 | 与构建、备份串行 |

服务器实测可用内存约 1.8 GiB，并已有 1 GiB swap。swap 只作为 OOM 紧急缓冲，不能把持续换页当作正常容量。API 与数据库的容器上限之和不等于稳定常驻用量，但在 2 GiB 主机上不得同时进行镜像构建、迁移、备份和压力测试。

40 GiB 系统盘应始终保留至少 10–12 GiB 空闲；当前基础部署后仍有约 23 GiB 空闲。容器日志限制为 `10 MiB × 3`，服务器只保留当前和上一个已验收镜像。清理镜像、容器或 release 必须使用精确目标，不得删除数据库卷、共享 Secret、WordPress 文件、宝塔数据库或备份。

出现以下任一信号时优先升级到 2C4G：一次 OOM kill、`MemAvailable` 连续 5 分钟低于 300 MiB、非运维窗口持续使用 swap、CPU 连续 10 分钟高于 70%、磁盘超过 70% 且无明确可回收项，或需要第二 API 实例、Redis、管理员进程、导出 worker。

3 Mbps 足够传输 JSON API，不适合由 ECS 同时分发 APK；APK 继续使用现有文件传输渠道。

## 10. 当前检查点与后续顺序

已完成：

1. 盘点 ECS、宝塔、现有站点和数据库；
2. 保留 WordPress 文件、数据库、证书和恢复点，并切到停止页；
3. 安装并验证 Docker Engine、Compose、Buildx，建立 swap；
4. 上传并验证 PostGIS/Node 基础镜像、release 和部署 bundle；
5. 在 `/opt/chi-shen-me/shared` 准备共享 Secret 和数据库 TLS；
6. 启动 PostgreSQL/PostGIS，创建 `postgres_bootstrap` 与五个应用角色，完成迁移与权限授予；
7. 为全国版 release `20260823T071142Z-nationwide` 复用 root-only 高德 Secret 与 IP 白名单，生成并复核数据库备份 `20260823T072519Z`；
8. 先在隔离容器完成上海地点搜索 5 条、决策 3 条、附近搜索 3 条及高德三链 smoke，再激活 release；PostgreSQL 容器未变化；
9. 激活独立 API DNS、Let's Encrypt 证书、最终 HTTPS vhost 和自动续期 hook；ECS 与工作站公网 smoke 通过，WordPress vhost 哈希未变化；
10. 用最终 HTTPS API 地址执行完整门禁并重建 Alpha APK：

   ```powershell
   .\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
   ```

   2026-08-24 完整门禁重新构建的当前 `0.1.2-alpha01-internal` Alpha SHA-256 为 `DD7257BCE3098DD658D30A8E7D6EAFECB980D627CCCB9C3B516BF7B32DCCEC07`。该版本已移除 Android 直接餐厅搜索模块；独立公网 smoke 与此前模拟器真实决策闭环补齐构建门禁不覆盖的运行证据，本次新哈希尚未重复设备安装验收。

下一步只能按以下顺序继续：

1. 在关闭 Wi-Fi 的外部真机完成手动选址、决策、版本门禁和恢复流程，并确认没有直接餐厅关键词搜索入口；
2. 完成高德商业授权、配额/弱网/真实错误和详情/动作矩阵；
3. 准备短信、SMTP、微信和 QQ 的正式资质与凭据，进入登录真实联调；
4. 完成 App 备案、正式 Release 签名、设备矩阵和公开发布审批。

不得因为基础 `/health` 已通过就跳过高德真实 smoke、直接切域名或对外发测试 APK。

## 11. 阶段 A 验收清单

- API 与 PostgreSQL 容器均为 `running/healthy`；
- 主机只监听 `127.0.0.1:13001`，没有宿主机 `5432` 监听；
- 宝塔 Nginx 配置检查和 reload 成功，HTTPS 证书有效；
- 公网只暴露预期的 80/443，SSH 按管理策略限制来源；
- `/health`、`/health/ready` 与 `/v1/config` 正常，最低版本门禁符合 Alpha；
- `AMAP_ENABLED=true` 时真实地点搜索与推荐已通过；详情和“换一批”仍待专项验收；
- `ALLOW_DEMO_DATA=false`，生产响应不出现 DEMO 来源；
- `LIVE_DISPLAY_ONLY` 不产生自有评分或重排；
- 高德凭据、坐标和完整供应商请求 URL 不进入日志；
- Android 1.0 无分享入口和分享执行；
- 重启 ECS 后数据库和 API 自动恢复，迁移 checksum 仍通过；
- WordPress 文件、数据库、证书和恢复点仍完整；
- 真实手机关闭 Wi-Fi 后能通过公网 HTTPS 完成核心闭环。

## 12. 登录阶段 B

阶段 A 全部通过后，才准备并启用账号。当前代码要求手机号与微信注册链路同时就绪，不能通过只开一个开关伪装完成。邮箱将来只需要标准 SMTP；阿里云在此处只负责手机号短信验证码。

登录阶段还需要：短信签名与模板、ECS RAM 实例角色与 IMDSv2、微信移动应用的 Alpha 包名/签名登记、微信 AppID/AppSecret、认证哈希与 OTP pepper 密钥环，以及 retention worker 的先 dry-run 后 execute 验收。这些凭据均不属于当前基础部署，不得提前写入 APK 或仓库。

## 13. 回滚与恢复

- 每次数据库迁移前创建快照，并把 `pg_dump` 保存到异机位置；
- 仓库的 `backup-database.sh` 只在固定备份根目录创建 root-only、不可覆盖的时间戳
  目录，并同时生成 restore list、非敏感元数据和 `SHA256SUMS`；
- `verify-database-backup.sh` 必须在恢复前重新校验目录边界、权限、精确文件集合、
  SHA-256 与 `pg_restore --list`；
- `restore-database.sh` 只允许恢复到全新的
  `chi_shen_me_restore_YYYYMMDDtHHMMSSz` 隔离数据库，目标已存在时拒绝执行；恢复
  演练通过不等于已替换生产库，显式回滚仍按运维手册执行；
- 服务器保留当前与上一已验收 API 镜像和 release；
- 未发生 schema 变化时，`activate-candidate-release.sh` 会在候选 readiness、镜像核对或原子切链复核失败时重建旧 API，并要求其容器 healthy 且 `/health` 返回 HTTP 200；只有看到 `ACTIVATION_ROLLBACK=OK` 才能认为自动代码回退完成；
- `ACTIVATION_ROLLBACK=FAILED` 或 `RECOVERY_REQUIRED=true` 时必须停止 DNS、TLS、vhost 和 APK 发布，保留旧 release、镜像、数据库备份及现场日志进行人工恢复；
- 已发生新迁移时旧镜像可能因 schema 版本过高拒绝启动，必须向前修复或恢复迁移前数据库备份，不能只替换镜像；
- API 子域激活必须保存操作前现场文件并支持精确恢复；专属脚本只回滚 `/www/server/panel/vhost/nginx/api.unfinished-era.com.conf`，主站 vhost 只做前后 SHA 比较，绝不作为 API 激活或回滚载体；
- 数据库备份、隔离恢复演练和保留旧库的显式回滚按 [ECS_OPERATIONS_RUNBOOK.md](./ECS_OPERATIONS_RUNBOOK.md) 执行；
- WordPress 恢复只按恢复文档操作，不覆盖未验证的现场副本；
- 高德或登录供应商故障时保持 fail closed，不启用生产 DEMO 数据伪装成功。

## 14. 明确不做

- 不部署 Caddy，不让 Compose 占用宿主机 80/443；
- 不把本地开发 `infra/docker-compose.yml` 原样部署；
- 不公开 API 容器的 3001、回环 13001、PostgreSQL 5432、Docker daemon 或宝塔面板端口；
- 不把高德、微信、短信或数据库 Secret 放进 APK、Git、镜像或 bundle；
- 不在真实高德门禁未齐时把 `AMAP_ENABLED` 改为 `true`；
- 不在账号依赖未齐时强开 `ACCOUNTS_ENABLED`；
- 不启动 Qwen、管理后台、导出 worker、QQ、收藏、跨端历史或反馈能力；
- 不删除 WordPress 文件、宝塔数据库、证书或恢复点；
- 不通过删除 Android 决策能力掩盖服务器容量问题；直接餐厅关键词搜索的客户端下线只依据产品边界，服务端独立接口继续维护。

## 15. 官方运维参考

- [Alibaba Cloud Linux 3 安装 Docker](https://help.aliyun.com/zh/ecs/user-guide/install-and-use-docker)
- [ECS 安全组最小权限配置](https://help.aliyun.com/zh/ecs/user-guide/start-using-security-groups)
- [ECS 快照概述](https://help.aliyun.com/zh/ecs/user-guide/snapshot-overview)
- [ECS 实例 RAM 角色](https://help.aliyun.com/zh/ecs/user-guide/attach-an-instance-ram-role-to-an-ecs-instance)
- [RDS PostgreSQL 支持的插件版本](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/extensions-supported-by-apsaradb-rds-for-postgresql)
