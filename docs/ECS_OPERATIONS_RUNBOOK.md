# ECS 运维加固与恢复手册

适用环境：`/opt/chi-shen-me`、宝塔 Nginx、2 核 2 GiB ECS。本文只覆盖 API 云端运行，不会删除或覆盖原 WordPress 文件、MySQL 数据库、证书和恢复点。

当前活动检查点（2026-08-23）：`current` 指向全国版 `20260823T071142Z-nationwide`，镜像 ID 为 `sha256:44041f99d06b1758088b58a22af83707e56db81783c8c4daadc7347e9da7c3a7`，最低客户端版本为 `0.1.1`；`https://api.unfinished-era.com` 已启用独立 vhost 和 Let's Encrypt 证书，证书有效至 2026-11-21，acme.sh 自动续期与加固 reload hook 已动态执行成功。

## 1. 独立 API 域名边界

活动模板是 `infra/ecs/nginx/api.unfinished-era.com.conf`。它只声明 `api.unfinished-era.com`，只把 `/health`、`/health/ready`、`/v1` 和 `/v1/*` 代理到 `127.0.0.1:13001`，其他路径固定返回 404。`/health` 仅用于进程存活检查；发布、切流和公网 smoke 必须以 `/health/ready` 为准。

首次部署、证书重建或灾难恢复时不得直接覆盖活动 HTTPS 模板，必须按以下顺序完成外部条件：

1. 在候选 release 的 root-only Secret 中启用高德并完成严格预检；
2. 先完成 PostgreSQL 备份及校验，再用候选激活脚本通过回环 readiness 和自动回退门禁；
3. 候选激活成功后，先在回环地址通过真实高德 smoke 和登录关闭门禁；
4. 此后才允许把 `api.unfinished-era.com` 的 IPv4 DNS 指向 ECS；未配置并验收 IPv6 listener 时不得发布 AAAA 记录；
5. 将 `nginx/api.unfinished-era.com.well-known.conf` 安装为 root 所有、不可被组或其他用户写入的 `/www/server/panel/vhost/nginx/well-known/api.unfinished-era.com.conf`，并准备 root 所有的 `/opt/chi-shen-me/acme-webroot`；
6. 先备份任何同名 API vhost，再用 `nginx/api.unfinished-era.com.acme.conf` 建立只开放 HTTP-01 challenge、其他路径 404、绝不代理应用的临时 vhost；`nginx -t` 通过后才能 reload；
7. 取得包含 `api.unfinished-era.com` SAN 的有效证书，确认私钥匹配、至少七天有效期和自动续期；
8. 从已经成为 `current` 的 release 执行专属激活器：

```bash
cd /opt/chi-shen-me/current/deploy
scripts/activate-api-subdomain-nginx.sh
```

该脚本固定使用 `127.0.0.1:13001`，先运行 release 预检和现有 Nginx 基线检查，再保存 API vhost 现场、隔离检查候选配置、原子安装、执行完整 `nginx -t` 和 reload。它还通过 `nginx -T` 确认 `api.unfinished-era.com` 只由目标文件声明、主站两个 hostname 的配置归属未变化；随后以本机 `--resolve` 验证 HTTP 跳转、HTTPS SNI/证书、实际在 443 提供的叶证书指纹、`/health/ready`、`/v1/config`，并证明 `/admin/v1` 固定为 404。开始前和全部 smoke 后都会比较 `/www/server/panel/vhost/nginx/www.unfinished-era.com.conf` 的 SHA-256。

任何失败都会只恢复操作前的 API 子域 vhost（或恢复为不存在）并重新检查/reload Nginx；看到 `NGINX_API_SUBDOMAIN_ROLLBACK=FAILED` 或 `RECOVERY_REQUIRED=true` 必须停止公网发布并从脚本输出的 `/www/backup/manual/chi-shen-me-api-vhost-*` 目录人工恢复。成功必须同时看到：

```text
NGINX_API_SUBDOMAIN_ACTIVATION=OK
WORDPRESS_VHOST_UNCHANGED=true
ADMIN_ENDPOINT_PUBLIC=false
```

证书自动续期的成功 hook 只能以 root 调用当前 release 的 `scripts/reload-nginx-after-certificate-renewal.sh`。它与激活器共用 `/run/lock/chi-shen-me/public-nginx.lock`，重新核验证书 SAN、有效期和私钥匹配后执行 `nginx -t`、reload，轮询 443 直到实际服务叶证书指纹与磁盘证书一致，再执行本机 HTTPS smoke，并再次证明 API/WordPress 两个 vhost 文件的 SHA 均未变化；它不会复制、删除或改写任何 vhost。

`public-nginx.lock` 只能串行本项目脚本，宝塔面板和宝塔自带证书任务不会自动遵守该锁。运行激活器或续期 hook 时不得同时在宝塔修改站点、证书、rewrite、redirect 或 include；操作窗口内看到任何面板侧并发写入必须停止，不能把本脚本的 reload 当成对并发改动的授权。

不得把新模板写到 `/www/server/panel/vhost/nginx/www.unfinished-era.com.conf`。旧 `activate-baota-nginx.sh` 已固定无条件退出，旧主站 API 模板不再进入部署 bundle；不得复制旧 release 中的同名危险工件来代替子域部署。

## 2. Release 权限、部署预检与启动边界

真实 `deployment.env` 需要同时保存可读镜像标签和本机精确镜像 ID：

```dotenv
API_IMAGE=chi-shen-me-api:<release-id>
API_IMAGE_ID=sha256:<64位小写十六进制>
POSTGIS_IMAGE=postgis/postgis:17-3.5-alpine
POSTGIS_IMAGE_ID=sha256:<64位小写十六进制>
```

上传并校验 bundle 后，以 root 在目标 release 中依次运行：

```bash
cd /opt/chi-shen-me/releases/<release-id>/deploy
bash scripts/harden-release-permissions.sh
scripts/preflight-deployment.sh
```

预检会验证：release 和 Secret 的所有权/权限、环境变量精确集合、数据库角色 URL、CA 与证书、镜像 ID/平台/运行用户、API 入口和迁移文件，以及 Compose 渲染。它不打印密码、高德 Key 或签名私钥。

预检失败时不得启动、迁移或切换 release。`provision-database.sh` 也会先执行同一预检。

预检通过不代表候选已经运行。不得手工执行 `docker compose up`、修改 `current`，也不得
把数据库迁移夹带进 API release 切换。候选只允许在第 5 节完成高德 Secret、数据库
备份和校验后，由 `activate-candidate-release.sh` 启动。

## 3. 高德凭据原子更新

Key 和数字签名私钥分别放入两个 root:root、`0600`、单行文件。不得把真实值放在命令参数、Shell 历史、Git、APK 或部署 bundle 中。

启用配置：

```bash
scripts/update-amap-secrets.sh \
  --enable \
  --key-file /root/private/amap-web-service-key \
  --signature-file /root/private/amap-signature-private-key \
  --ip-whitelist-confirmed
```

紧急关闭配置：

```bash
scripts/update-amap-secrets.sh --disable
```

脚本使用独占锁和同目录临时文件，同时更新 `api.env` 与 `deployment.env`；更新后的严格预检失败时恢复原文件。脚本不会显示 Secret，也不会自动重启 API。看到 `API_RECREATE_REQUIRED=true` 后，仍需在受控窗口重建 API 容器并完成真实 smoke；未重建前不能声称开关已生效。

这里的“受控窗口重建”固定由第 5 节的候选激活脚本完成，不得另行手工重建。若
`AMAP_ENABLED=false`，新版 readiness 必须失败，激活脚本会自动恢复旧 API；不得为通过
发布而绕过 readiness。

## 3.5 融合认证上线与 hash key 轮换

融合认证只在新候选 release 中启用，不直接改活动容器。`deployment.env` 的
`ACCOUNTS_ENABLED`、`PHONE_AUTH_ENABLED`、`FUSION_AUTH_ENABLED`、
`WECHAT_AUTH_ENABLED` 和 `ALIBABA_CLOUD_ECS_METADATA` 是非 Secret 发布坐标；
认证 hash ring、微信 AppSecret、短信材料和融合方案标识只进入 root:root、`0600`
的共享 `api.env`。不要手填或拼接这两个活动文件。只在 root 私有目录准备一份完整
候选输入，再由脚本把发布坐标和 Secret 原子拆分到各自文件：

```bash
install -d -m 700 /root/private
install -m 600 /dev/null /root/private/auth-candidate.env
```

Fusion-only 候选文件的字段集合固定如下；尖括号只表示需要在服务器本地填写，不能
原样保留，也不能把文件发到聊天或提交 Git：

```dotenv
ACCOUNTS_ENABLED=true
PHONE_AUTH_ENABLED=false
FUSION_AUTH_ENABLED=true
WECHAT_AUTH_ENABLED=true
ALIBABA_CLOUD_ECS_METADATA=<ECS RAM 角色名>
AUTH_HASH_ACTIVE_VERSION=hash.v1
AUTH_HASH_KEYS_JSON={"hash.v1":"<32 到 128 字节随机值的标准 Base64>"}
AUTH_IDENTITY_DEDUP_KEY_VERSION=hash.v1
WECHAT_APP_ID=<wx 加 16 位十六进制 AppID>
WECHAT_APP_SECRET=<微信 AppSecret>
ALIYUN_FUSION_SCHEME_CODE=<融合认证方案 Code>
ALIYUN_FUSION_PACKAGE_NAME=com.chishenme.app.alpha
ALIYUN_FUSION_PACKAGE_SIGN=<固定 Alpha signer 的 32 位 MD5>
```

Fusion-only 不写 `AUTH_OTP_PEPPER_*` 或 `ALIYUN_SMS_*`；只有
`PHONE_AUTH_ENABLED=true` 才把这四项加入候选文件。编辑完成后从待发布的候选
release 执行：

```bash
cd /opt/chi-shen-me/releases/<候选 release>/deploy
scripts/update-auth-secrets.sh --apply --config-file /root/private/auth-candidate.env
```

脚本要求 root:root、`0600` 的输入文件，复用全局 deployment mutation lock，在同一
目录生成候选和回滚文件；它先验证当前 release，再原子替换共享 `api.env` 与候选
`deployment.env`，最后通过固定 API 镜像里的生产
`loadAuthRuntimeConfig` 重新预检。JSON、1 到 3 个 current/retiring key、版本格式、
标准 Base64、32 到 128 字节长度、active/dedup 归属、微信 AppID 或任何精确字段集合
不合格时都会恢复原文件。成功只表示配置可发布；看到
`API_RECREATE_REQUIRED=true` 后仍必须用第 5 节候选激活脚本重建 API 和完成 smoke。

首次开启前必须依次完成：

1. 把最小权限 RAM 角色绑定到 ECS，并强制 IMDSv2；融合主链只授予
   `dypns:GetFusionAuthToken`、`dypns:VerifyWithFusionAuthToken`，短信开启时才增加
   `SendSms` 权限；
2. 在控制台核对方案 Code、场景 `100001`、`com.chishenme.app.alpha` 与固定证书
   MD5，确认全局降级路径不依赖宿主自动回填手机号；
3. 备份并复核数据库，运行包含 `0010_fusion_phone_auth.sql` 的迁移；
4. 在候选环境运行配置、失败关闭和重放 smoke，不把真实 token/手机号写入日志；
5. 通过唯一候选激活脚本切换，再用 ARM64 + 中国大陆 SIM 真机完成闭环。

融合防重放会对 `AUTH_HASH_KEYS_JSON` 中 current 与 retiring 的全部版本计算 HMAC。
供应商 token/本地 flow 的最大窗口为 12 小时，因此旧 hash key 必须至少保留到该
窗口排空。常规轮换先在候选输入中加入新 key、保留旧 key，再切 active；脚本会拒绝
改变 `AUTH_IDENTITY_DEDUP_KEY_VERSION`，该值只能走单独的全量回填和冲突审计迁移。

移除 retiring key 必须走显式排空：先用仍包含旧 key 的候选关闭 Fusion。当前只有
Fusion 手机主链时执行 `scripts/update-auth-secrets.sh --disable`；如短信主链已就绪，
也可用 `--apply` 提交 `FUSION_AUTH_ENABLED=false` 且保留旧 ring 的完整候选。脚本会把
旧 ring 保存到 root-only `auth-key-drain.env` 并记录服务端 UTC epoch。激活关闭候选后
等待至少 12 小时。随后再次更新或执行：

```bash
scripts/update-auth-secrets.sh --finalize-drain
```

该命令只有在当前 Fusion 开关仍为 false、排空时间不少于 43200 秒，并且真实
PostgreSQL 的 `fusion_auth_flows` 中没有未消费且未过期 flow 时才报告
`AUTH_KEY_DRAIN_READY=true`；表或数据库不可达一律失败关闭。root-only 排空快照会
保留到下一次成功的 `--apply`，用于证明和比较即将移除的旧 key；候选预检成功后脚本
才原子清除或推进它，避免短信主链仍开启时出现“先删排空证据、后续反而永远不能删
旧 key”的死路。12 小时内如重新开放，候选必须仍包含快照里的每个旧 key 及相同
材料。只有排空完成后才可提交不含旧 key 的候选并重新开放。所有开关变化都必须经
候选激活和真实 smoke，不能手工重建容器或删除排空文件绕过门禁。

## 4. PostgreSQL 备份与验证

迁移、release 切换或真实高德/登录开放前先运行：

```bash
scripts/backup-database.sh
```

每份备份原子发布到：

```text
/opt/chi-shen-me/backups/postgres/YYYYMMDDTHHMMSSZ
```

其中包括自定义格式 dump、`pg_restore --list` 结果、非敏感元数据和 `SHA256SUMS`。脚本只清理自己尚未发布的 staging 目录，不覆盖或自动删除历史备份。

再次验证指定备份：

```bash
scripts/verify-database-backup.sh \
  /opt/chi-shen-me/backups/postgres/<backup-id>
```

服务器本地备份不能替代 ECS 快照和异机副本。获得对象存储或另一台受控主机后，应把整个备份目录原样复制到异机并在那里再次校验 SHA-256。

## 5. 候选 release 激活与自动回退

以下顺序不可交换：

1. 在候选 release 中用 `update-amap-secrets.sh` 从 root:root、`0600` 的输入文件原子写入高德 Key 和签名私钥，并确认 ECS IP 白名单；
2. 确认脚本自动执行的严格预检成功，且没有输出任何 Secret；
3. 从同一候选 release 运行 `backup-database.sh`，再用 `verify-database-backup.sh` 校验刚生成的备份；
4. 仍在候选 release 中运行唯一允许的 API 激活脚本：

   ```bash
   cd /opt/chi-shen-me/releases/<release-id>/deploy
   scripts/activate-candidate-release.sh
   ```

高德 Secret 更新、PostgreSQL 备份和候选激活共同使用 root-only 的
`/run/lock/chi-shen-me/mutation.lock` 非阻塞独占锁，脚本会拒绝三者并发；仍必须按上述
顺序逐项等待成功，不得通过复制脚本或换锁文件绕过。

脚本必须由 root 从真实的 `/opt/chi-shen-me/releases/<release-id>/deploy` 运行，并持有全局
`flock`。它先再次执行严格预检，要求 `current` 直接指向另一个完整 release，然后只用
候选 Compose 对 `api` 执行 `--no-deps --force-recreate`。它不会运行迁移、重建或停止
PostgreSQL，也不会读取、修改或 reload 任何 Nginx 配置。

候选只有在 API/PostgreSQL 容器均 healthy、`/health/ready` 返回 `ready`、回环监听和镜像
ID 均正确且 PostgreSQL 容器 ID 未变化后，才会使用 `/opt/chi-shen-me` 同目录临时软链和
原子 rename 切换 `current`，随后再做一次完整运行时校验。成功标志是：

```text
CANDIDATE_RELEASE_ACTIVATION=OK
POSTGRES_CONTAINER_UNCHANGED=true
```

候选启动、readiness 或切链后复核任一失败时，脚本会从旧 release 强制重建旧 API，要求
旧容器恢复为 healthy 且 `/health` 精确返回 HTTP 200，并保证 `current` 仍指向旧 release。
`ACTIVATION_ROLLBACK=OK` 表示自动回退完成；`ACTIVATION_ROLLBACK=FAILED` 必须立即停止后续
操作并人工检查，绝不能继续配置 DNS、证书或 vhost。`AMAP_ENABLED=false` 导致候选
readiness 失败属于预期的失败关闭，也会走同一自动回退，不存在特殊绕过。

只有候选激活成功并完成回环真实高德 smoke 后，才进入第 1 节的独立 API 子域 DNS、TLS
和 vhost 配置。成功激活 release 本身不会触碰宝塔或主站。

## 6. 非破坏恢复演练

恢复脚本只允许写入新的隔离数据库名，不会覆盖生产数据库：

```bash
scripts/restore-database.sh \
  /opt/chi-shen-me/backups/postgres/<backup-id> \
  chi_shen_me_restore_YYYYMMDDtHHMMSSz
```

它先校验备份，再创建新数据库、预置扩展、单事务恢复、重新授予最小权限并核对 `schema_migrations`。成功后保留恢复库作为证据；删除恢复库属于另一次明确且可审计的操作，不由该脚本代办。

## 7. 明确的数据库回滚

生产回滚必须显式提供与备份编号绑定的确认文本：

```bash
scripts/rollback-database.sh \
  /opt/chi-shen-me/backups/postgres/<backup-id> \
  --execute \
  ROLLBACK_chi_shen_me_FROM_<backup-id>
```

执行顺序是：为当前数据库再做一份安全备份、把目标备份恢复到隔离库、停止 API、保留并重命名原数据库、原子切换恢复库、重启并运行运行时验证。若新库不能启动 API，脚本尝试自动切回原库；无论成功或失败，都不主动删除原库、失败库或历史备份。

2 GiB ECS 上，镜像构建、备份、恢复、迁移和压力测试必须串行。回滚前还应确认磁盘至少有“当前数据库大小的两倍 + dump 大小 + 2 GiB”可用空间。
