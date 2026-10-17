# 数据库与本地容器拓扑

`docker-compose.yml` 只用于本地开发，顺序固定为：PostGIS 健康 → `api-migrate` 完成版本化迁移 → API 启动并校验 schema checksum/version → 可选数据导出 worker/管理台启动。API 不自动迁移，`service_completed_successfully` 不能替代生产权限配置。

```powershell
Copy-Item .env.example .env
docker compose -f infra/docker-compose.yml --env-file .env up --build
```

本地 Compose 让迁移和 API 共用一个本地角色，因此不能验证生产最小权限，也不能原样部署到阿里云。数据库和 HTTP 端口只绑定 `127.0.0.1`。当前开发机器没有 Docker、`psql` 或本地 PostgreSQL，本轮没有在本机执行 SQL；真实 PostGIS 验收已配置在 `.github/workflows/ci.yml`，只有 CI 实际成功后才能记为“真实数据库已验证”。

## 环境行为

| 环境 | 没有数据库时的行为 |
|---|---|
| development | `DATABASE_ENABLED` 默认 `false`；误留 URL/CA 也不创建 Pool，显式启用后才直连。 |
| test | 与 development 相同；纯单测无需数据库，PostGIS CI job 会显式启用。 |
| production | 数据库强制启用；缺 URL、目标、角色名或 `verify-full` TLS 时启动失败，不存在内存/SQLite/演示回退。 |

生产 URL 只允许 `postgresql://`，禁止 query、fragment 和 `sslmode=require`。TLS 使用 `rejectUnauthorized=true`，可选 CA 以 Base64 PEM 单独注入。错误和 CLI 只返回固定分类，不输出 URL、主机、用户名、密码、SQL 或驱动消息。

## 生产角色与 Secret 边界

- bootstrap extension owner：只在建库阶段安装/核验 `pgcrypto` 与 `postgis`，不作为长期凭据。
- migration owner：拥有应用对象，执行迁移与事务化 `role-grants.sql`；不是 superuser，不进入 API 容器。
- runtime role：只供 API；不能读权利/provider 基表或审计表，也不能直接改写一次性状态。
- maintenance role：只执行固定白名单的保留期、注销、反馈重加密与游客 IP HMAC 匿名化原语；不能读取 OTP、token、设备、身份、反馈正文或 provider 基表。
- admin runtime role：只供独立管理员 API；不进入普通 API 或导出 worker。
- export worker role：只读非敏感迁移元数据并执行导出快照、fencing、完成和删除白名单；没有任何个人数据基表权限。

五个应用角色必须两两不同、互不继承，且没有 `SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS`。五类进程分别只接收自己的 API、迁移、维护、管理员或导出 worker 数据库 URL；普通数据库进程共同使用非秘密 `DATABASE_EXPECTED_TARGET=host:port/database` 和声明角色名核对身份，但绝不相互接收密码。API 容器不得注入 migration/maintenance/export-worker URL。

### 导出 worker 环境净化

生产导出 worker 必须由空环境启动：Linux 入口使用 `env -i`，或使用能够保证相同语义的进程管理器，然后逐项注入源码许可集合中的专用数据库、导出/OSS、locator、反馈 AES 和基础 Node/OS 变量。禁止继承宿主 shell、整份 `.env`、整份 ConfigMap/Secret、`envFrom`、静态 AccessKey、profile/credential URI、代理或 `NODE_OPTIONS`。未在精确集合中的任何非空名称都会在 worker 访问数据库和 OSS 前让启动失败；这条规则不依赖变量名是否包含 `secret` 或 `token`。

Kubernetes Pod 必须设置 `spec.enableServiceLinks: false`，Secret/ConfigMap 只用固定名称的逐项 `env` 投影；入口仍需用 `env -i` 等价白名单重建环境，以清除集群保留注入的 `KUBERNETES_SERVICE_HOST` 等变量。Compose 的 `export-worker` 仅供本地联调，并已逐项映射当前 worker 读取的名称；不能把本地 Compose 环境当成生产 Secret 隔离证明。

PostGIS/pgcrypto 通常需要托管库特权，必须由一次性 bootstrap 身份预装。migration owner 只核验扩展并迁移应用对象；扩展对象归 bootstrap/托管角色。权限脚本只收敛 migration owner 拥有的对象，不触碰 PostGIS 对象。

## 生产发布精确顺序

1. bootstrap 身份预装并核验 PostgreSQL 17、PostGIS 3.5、pgcrypto，随后移除凭据。
2. migration job 仅注入 migration URL，运行 `node dist/database/migrate-cli.js`。
3. runner 使用固定 `migrations/`、SHA-256、连续版本和 advisory lock；每个迁移独立事务。
4. migration owner 执行 `psql -X -v migration_owner=... -v runtime_role=... -v maintenance_role=... -v admin_runtime_role=... -v export_worker_role=... -f infra/postgres/role-grants.sql`。
5. 权限脚本以 `ON_ERROR_STOP`、服务端 `RAISE EXCEPTION` 和单事务 fail closed；前置校验错误会让非交互 psql 返回非零，授权阶段先撤历史表/列/序列/函数 ACL，再白名单授权，中途失败完整回滚。
6. 用 runtime role 做 schema verify、权限正反例和 API 启动 smoke，失败不启动新实例。
7. 启动 API；仅在私有 OSS、独立 RAM 角色、locator/反馈解密密钥和 export worker 均就绪后开放数据导出能力。导出专用 RAM 角色只需读取桶版本与生命周期配置，不得修改它们；专用桶必须从未启用版本控制，且 `GetBucketLifecycle` 必须精确返回 `404 NoSuchLifecycle`，任何已配置规则都会拒绝 worker 就绪。maintenance job 独立运行，默认 `--dry-run`；只有明确 `--execute` 才删除到期数据，并在同一受控事务中不可逆销毁已超过 24 小时配额窗口的游客反馈 IP HMAC。

以下 schema 0010→0013 认证 bridge 操作仅适用于已批准的历史 schema 0013 发布包。
当前完整迁移 head 为 **0014**；新发布包要求旧库先完成 0013，再按
[微信小程序登录切换说明](../docs/wechat-miniprogram-cutover.md) 备份并执行独立的 0013→0014
cutover，且准备兼容 schema 0014 的回滚发布。不得用 0014 镜像执行历史 bridge 或跳过其门禁。

账号 schema 0010→0011 是上述历史流程的受控特例：先激活 `ACCOUNTS_ENABLED=false` 的
`legacy_phone_drain` bridge，再从活动 bridge 运行
`scripts/provision-database.sh --phone-only-cutover`。该入口在同一 mutation lock 内核对实际
运行容器、排空所有未过期及 15 分钟内已消费未领取的证明，自动生成并验证带完整 ledger 和
匹配 ACL 的 schema 0010 备份，二次排空后才执行 0011 和第 4–6 步；最后才对启用候选执行
`--apply` 并激活。bridge 只允许 schema 完整或仅缺精确最后 0011；迁移后不能把旧 Fusion
镜像直接指回当前数据库，必须恢复迁移前数据库。完整命令见运维手册。
`provision-database.sh`、备份、Secret 更新和候选激活共用 root-owned 非阻塞全局 mutation
lock；锁冲突必须在 preflight 和任何数据库动作之前失败。
隔离恢复与生产回滚也使用同一把锁并覆盖恢复、停 API、数据库 rename、重启及失败清理的完整
关键区间；回滚内部的安全备份/隔离恢复只验证并继承父进程 FD8，不会二次抢锁。认证 `--apply`
或 `--disable` 若发现旧 Fusion/SMS 配置，会在修改共享 `api.env` 前直接验证活动停号 bridge、
0011 migration 和角色 ACL；因此恢复旧数据库后不能复用先前的迁移证明。
schema 0011 常态下的 `--disable` 仅做可逆紧急关停：清除供应商字段但保留 root-only
身份/会话 HMAC、dedup version 与已有 OTP pepper pair；后续 `--apply` 必须沿用相同连续性
材料，错误值会在共享 env 写入前拒绝。

微信 UnionID 的历史 schema 0011→0012 受控过渡使用 approved plan head 0013。先激活
`AUTH_SCHEMA_TRANSITION_MODE=wechat_union_aliases_pending` 且
`WECHAT_AUTH_ENABLED=false`、允许 0012 及其后迁移保持 pending 的 bridge，再从活动 bridge 执行
`scripts/provision-database.sh --wechat-union-aliases-cutover`。脚本在同一 mutation lock 内创建并
验证 exact-schema11 备份，连续执行 0012 和 0013 至 exact-schema13，重新应用兼容
schema11/12/13 的角色授权，并验证 0012 ledger、alias 表无直接 runtime 权限、只有 API runtime
可执行三项 state-bound 函数且表仍为空。
随后必须先激活 `transition=none`、微信仍关闭的 final release，最后才由认证配置更新器启用微信。
`WECHAT_OPEN_PLATFORM_REALM_ID` 是稳定身份命名空间；常规 release 不允许相对活动 release
更改。保留的专用 schema12→11 回滚只适用于仍精确停在 0012 的旧过渡部署，并要求 alias 表为空；
已到 0013 或 0014 的部署不得借该入口跨越 0013 降级。写入任一真实 alias 后只允许向前修复。

迁移锁键为 `(1129310029, 1296645202)`，`pg_try_advisory_lock` 最多 20 次、间隔 250 ms；保留期锁键为 `(1129310029, 1382374734)`，占用时立即失败。成功和失败路径都尝试释放。`schema_migrations` 固定为 `version integer`、`name varchar(120)`、`checksum varchar(64)`、`applied_at timestamptz`；未知版本、缺号、名称或 checksum 漂移会拒绝迁移/启动。

## 数据与保留边界

- 除 `coverage_areas.boundary` 的泛化服务区域 MultiPolygon，业务表没有用户坐标、轨迹或原始请求体。
- provider ID 只存在 `external_place_references`，且只由当前有效 `LICENSED_ENRICHMENT` + `PERSIST_PLACE_REFERENCE` 经受限函数写入；runtime 只读 active view。授权撤销/到期会解绑依赖并清除引用，过期行不能 upsert 复活。
- 邮件 OTP 使用带 pepper 的 Argon2id；手机验证码由号码认证服务生成并通过供应商 API 核验，服务端只保存 challenge、状态和不可逆目的地指纹。身份、目的地、OAuth state、设备/IP 和 opaque token 使用带域分离与 key version 的 HMAC-SHA256。不保存明文 OTP、手机号、邮箱、refresh/access token、第三方 token 或授权 code。
- 0010 Fusion 表仅为清除最长 24 小时的历史记录而暂留；只有 maintenance role 可调用两项专用 preview/execute 清理函数，runtime/admin/export 均显式拒绝。这是历史数据最小化，不构成 Fusion 登录能力。
- 支持反馈正文以独立 AES-256-GCM 密钥环加密，内容幂等指纹与游客配额使用另一个独立 HMAC-SHA256 密钥环。轮换期间 API 对每个保留版本计算最多 3 个候选，数据库原子比较；启动门禁会拒绝缺少任何在用版本的实例。游客 IP HMAC 不做伪重算，超过数据库时钟 24 小时窗口后由 maintenance job 置空并记录 `guest_ip_destroyed_at`，随后才能移除对应旧 HMAC 密钥。
- identity `lookup_hash` 可轮换；跨账号唯一的 `dedup_hash` 必须使用独立稳定 key。该 key 不允许在线直接轮换；若必须轮换，先完成双读、全量事务重键和冲突审计，旧版本清退前禁止新版本写入。
- 微信 OpenID/UnionID 原值均不落库；AppID+OpenID 的 HMAC 继续作为当前 App binding，
  `realm + UnionID` 的 HMAC 只作为跨应用 alias。微信解绑保留 alias 防接管，账号最终删除通过
  外键级联删除；历史备份中的副本按同一 30 天备份保留流程清除。
- 推荐历史 90 天；关闭反馈/管理员审计 180 天；导出个人内容/元数据 7 天；完成注销任务和过期会话最多 30 天；OTP/OAuth/access token 更短。OSS 个人工件必须先由 worker 删除并以同 key 的固定、无 PII 永久 tombstone 占位，HEAD 验证后才能写 `artifact_deleted_at` 并清理导出元数据；生命周期规则不得覆盖该 tombstone 前缀。
- audit context 只接受内置 action 对应的非负计数；未知 action 只能空对象，runtime 不获泛化 append 权限。

数据库备份滚动 30 天、OSS 删除、RDS PITR 和注销后备份清除属于运维流程，不由 SQL cleanup 冒充。公开前仍要在真实阿里云 RDS 上完成迁移、角色、备份恢复和 RPO/RTO 演练。

本地演示默认关闭高德和千问并标记 `DEMO`。生产禁止 `ALLOW_DEMO_DATA=true`，还必须配置 HTTPS、可信代理 CIDR、共享限流、密钥管理和日志脱敏。管理台完成登录、MFA、RBAC 前只能监听回环地址。API 镜像通过 `pnpm deploy --prod --legacy` 生成生产依赖，并复制只读 migrations；升级 pnpm 后要重新验证镜像。
