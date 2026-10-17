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

预检会验证：release 和 Secret 的所有权/权限、环境变量精确集合、数据库角色 URL、CA 与证书、镜像 ID/平台/运行用户、API 入口和迁移文件，以及 Compose 渲染。除脚本为 `0700`、其余 release 文件为 `0600` 外，挂载给非 root PostgreSQL 进程读取的无密配置 `postgres/pg_hba.conf` 必须保持 root:root、`0644`；不得把这项例外扩展到 Secret。预检不打印密码、高德 Key 或签名私钥。

预检失败时不得启动、迁移或切换 release。`provision-database.sh` 会先取得 root-owned、
`0600` 的全局 `mutation.lock`，锁已被备份、Secret 更新、另一迁移或激活占用时立即拒绝；只有成功
取得锁后才执行同一预检及任何数据库动作，并持有到迁移/授权全部结束。

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

脚本使用独占锁和同目录临时文件，同时更新 `api.env` 与 `deployment.env`；更新后的严格预检失败时恢复原文件。首次 QQ 身份状态初始化或 UnionID 单调提升会更早写入共享权威文件，且故意不随这两个文件回滚。脚本不会显示 Secret，也不会自动重启 API。看到 `API_RECREATE_REQUIRED=true` 后，仍需在受控窗口重建 API 容器并完成真实 smoke；未重建前不能声称开关已生效。

这里的“受控窗口重建”固定由第 5 节的候选激活脚本完成，不得另行手工重建。若
`AMAP_ENABLED=false`，新版 readiness 必须失败，激活脚本会自动恢复旧 API；不得为通过
发布而绕过 readiness。

## 3.5 PHONE_ONLY 认证上线与 hash key 轮换

认证只在新建且尚非 `current` 的候选 release 中启用，不直接改活动 release 或容器。固定产品政策是：手机号验证码
通过即可建号和登录；微信、QQ、邮箱只登录已绑定身份；登录后可以主动绑定三者。
认证相关的 `deployment.env` 字段只保存非秘密开关、realm 和 ECS RAM 角色名，服务端材料只进入
root:root、`0600` 的共享 `api.env`。QQ realm 与单调 marker 的唯一权威是
`/opt/chi-shen-me/shared/auth-identity-state.env`；该非秘密文件也必须是 root:root、`0600`，并精确
包含 `AUTH_IDENTITY_STATE_FORMAT_VERSION=1`、`QQ_OPEN_PLATFORM_REALM_ID`、
`QQ_UNION_ID_NAMESPACE_INITIALIZED` 三键。不得把 marker 加入 `deployment.env`、认证候选或 API 环境。

在 root 私有目录准备完整候选；尖括号必须在服务器本地替换，不得发到聊天或提交：

```dotenv
ACCOUNTS_ENABLED=true
PHONE_AUTH_ENABLED=true
EMAIL_AUTH_ENABLED=false
WECHAT_AUTH_ENABLED=false
QQ_AUTH_ENABLED=false
QQ_UNION_ID_ENABLED=false
ALIBABA_CLOUD_ECS_METADATA=<ECS RAM 角色名>
AUTH_HASH_ACTIVE_VERSION=hash.v1
AUTH_HASH_KEYS_JSON={"hash.v1":"<32 到 128 字节随机值的规范 Base64>"}
AUTH_IDENTITY_DEDUP_KEY_VERSION=hash.v1
ALIYUN_PNVS_SIGN_NAME=<控制台当前可用签名原文>
ALIYUN_PNVS_TEMPLATE_CODE=<配套模板 Code>
```

仅当通道为 `true` 时再加入对应字段：

- 邮箱：`AUTH_OTP_PEPPER_ACTIVE_VERSION`、`AUTH_OTP_PEPPER_KEYS_JSON`、
  `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USERNAME`、
  `SMTP_APP_PASSWORD`、`SMTP_FROM_ADDRESS`、`SMTP_REPLY_TO`、`SMTP_FROM_NAME`；
  `SMTP_APP_PASSWORD` 只属于 root-only 候选输入，更新器将其映射成 `api.env` 唯一接受的
  `SMTP_PASSWORD`。ECS Compose 固定 `SMTP_TIMEOUT_MS=5000`，该字段不属于认证候选 Secret；
- 微信：`WECHAT_APP_ID`、`WECHAT_APP_SECRET`；
- QQ：`QQ_APP_ID`、root-only `QQ_APP_KEY`。AppKey 只用于官方 Server-Side code 换票，
  不得进入 `deployment.env`、Android 或部署 bundle；`QQ_UNION_ID_ENABLED=true` 必须同时启用
  QQ，并要求当前不可变 release 的 `QQ_OPEN_PLATFORM_REALM_ID` 合法且与后续 release 连续。
  共享状态缺失或需要从 `false` 提升为 `true` 时，还要求当前运行态 QQ 已关闭、聚合 QQ binding
  为零；首次直接启用 UnionID 会把共享 marker 直接持久化为 `true`。

执行：

```bash
cd /opt/chi-shen-me/releases/<候选 release>/deploy
scripts/update-auth-secrets.sh --apply --config-file /root/private/auth-candidate.env
```

更新器拒绝在 `current` 对应的 deploy 目录写配置。它在全局锁内只读活动 release 的运行态、
schema/ACL、微信/QQ realm、QQ 当前关闭状态和聚合 binding 计数；只写共享 `api.env`、非活动
候选的 `deployment.env`，以及首次初始化时只增不减的 QQ 共享 marker。候选与活动 release 的
微信 realm 必须一致；活动 release 已含 QQ realm 时也必须与候选一致，首次引入 QQ 前旧 release
可缺少该未来字段，但 QQ/Union 开关仍必须明确关闭。激活前活动 `deployment.env` 和容器保持不变。工作站上传的最小
QQ delta 不能直接交给更新器，必须在 ECS root-only 边界内与当前连续性字段及所有已开启通道
字段合成为精确完整候选；任何 Secret 值均不得输出。

脚本持有全局 mutation lock 和认证锁。普通 `--apply` / `--disable` 会把
`AUTH_SCHEMA_TRANSITION_MODE` 固定为 `none`，清退共享 `api.env` 中的旧认证字段，再用固定
API 镜像、无网络、只读容器运行生产配置预检；失败会恢复 `api.env` 与 `deployment.env`，但不会
回退已经原子持久化的 QQ 共享 realm/marker。成功只表示候选可发布，
看到 `API_RECREATE_REQUIRED=true` 后仍必须用第 5 节候选激活脚本重建 API 并完成 smoke。
`--apply` 和 `--disable` 都会在创建候选 Secret 前直接核验 `/opt/chi-shen-me/current`、活动
release 运行态、`0011_phone_only_auth`、角色 ACL 和 candidate/active realm 连续性；只要共享 `api.env` 仍有旧 Fusion/SMS
标记，当前 release 就必须正是所有账号通道均关闭的 `legacy_phone_drain` bridge。该检查与写入
共用同一全局锁，数据库恢复到 0010 后会自然失效；顺序错误不会修改共享 `api.env` 或候选
`deployment.env`。迁移前若只想停号并保留旧 Secret，必须使用 `--legacy-drain`，不得用
`--disable` 绕过 transition。

schema 已切到 0011 后，`--disable` 是可逆的紧急关闭：它只关闭所有账号/认证开关并删除
PNVS、SMTP、微信、QQ 等通道配置，不销毁身份/会话连续性。root-only `api.env` 必须继续
保留完整的 `AUTH_HASH_ACTIVE_VERSION`、`AUTH_HASH_KEYS_JSON`、
`AUTH_IDENTITY_DEDUP_KEY_VERSION`，以及原先存在的完整 OTP pepper pair；disabled preflight
仍用固定 API 镜像验证这些材料。再次 `--apply` 时三个身份/会话字段及保留的 OTP pair 必须
逐值一致，错误顺序或更换 key/version 会在任何共享文件写入前失败，`api.env` 与
`deployment.env` 摘要保持不变。密钥销毁/旧版本删除只能走独立审查的排空迁移，不能把
`--disable` 当作清库或重置账号身份的入口。

若共享文件中 `QQ_UNION_ID_NAMESPACE_INITIALIZED=true`，`--disable` 只把 QQ/UnionID 当前开关
关掉并逐字节保留共享文件。再次 `--apply` 可在已有 QQ binding 的情况下恢复 QQ+UnionID，且
不得重新执行零计数；但不得提交 `QQ_AUTH_ENABLED=true`、`QQ_UNION_ID_ENABLED=false` 的降级
组合。旧 release 的 `deployment.env` 即使没有 marker，也不得解释成 `false`：恢复候选始终以
共享文件为准。该文件位于 releases 之外，不得随 release 清理；灾备时应与账号数据库作为同一
身份连续性状态保存和恢复，禁止手工降级 marker 或更换 realm。

若只把 EMAIL 从 `true` 改为 `false`，应使用普通 `--apply` 提交完整的手机号/微信现状和
EMAIL=false，而不是用 `--disable` 关闭全部账号。更新器必须清退全部 SMTP 字段，同时无视
当前账号开关状态，逐值保留已经存在的完整 `AUTH_OTP_PEPPER_*` pair；回滚输入不得包含
`SMTP_APP_PASSWORD`、`SMTP_PASSWORD` 或旧 `EMAIL_OTP_PEPPER_*` 名称。

从 schema 0010 的旧 Fusion 认证迁移到 0011 PHONE_ONLY 时，固定使用两个候选 release，
顺序不可交换：

1. 在第一个新候选目录执行 `scripts/update-auth-secrets.sh --legacy-drain`。脚本设置
   `AUTH_SCHEMA_TRANSITION_MODE=legacy_phone_drain`，强制账号和所有认证通道关闭，同时对
   共享 `api.env` 做前后摘要核对并原样保留旧 hash/OTP、旧短信、Fusion 和微信材料；
2. 用第 5 节脚本激活这个停号 bridge。此时 API 只接受“schema 已完整”或“仅缺精确的
   最后一项 `0011_phone_only_auth.sql`”。激活失败会自动重建旧 API，因为数据库尚未迁移，
   且共享 `api.env` 仍逐字节保持旧值；
3. bridge healthy 且账号确认关闭后，等待旧方案最长 challenge/proof TTL、已消费但尚可领取的
   15 分钟窗口与在途请求全部排空；可先按第 4 节另做运维备份，但这不能替代下一步脚本在
   同一 mutation lock 内生成并验证的迁移备份；
4. 在活动 bridge 对应的 release 中串行运行下面的固定入口；它先再次 preflight，再执行
   `0011_phone_only_auth.sql` 并事务化重新应用 `role-grants.sql`：

   ```bash
   cd /opt/chi-shen-me/releases/<bridge release>/deploy
   scripts/provision-database.sh --phone-only-cutover
   ```

   该显式参数只接受精确 schema 0010。脚本会在任何迁移写入前核对活动软链、实际运行 API
   容器镜像及 bridge 环境，二次确认所有可兑换证明为 0，在同一 mutation lock 内自动生成并
   验证带完整 migration ledger 和 schema 匹配 ACL 的备份，然后再次排空确认后才迁移。不得
   另起并行备份、`--apply` 或候选激活；全局锁冲突必须让其中一个入口在 preflight 和数据库
   写入前失败。随后完成严格 schema verify、0011 新函数正例、runtime/admin/export
   对旧 Fusion 表和认证函数无授权负例、maintenance 仅能执行两项 24 小时历史清理函数的 ACL
   smoke，以及 API 账号关闭 smoke；任一项失败都保持 bridge，不进入下一步；
5. 在第二个启用候选目录执行本节上面的 `--apply`。它把 transition 恢复为 `none`、写入
   PNVS/可选通道服务端配置并清退所有旧认证字段；然后才用第 5 节脚本激活启用候选；
6. 最终候选激活失败时，只能自动退回“账号关闭、schema 已为 0011”的 bridge。不得把旧
   Fusion API 直接指向 0011 数据库；若业务决定恢复旧 Fusion，必须走第 7 节恢复迁移前
   数据库备份，并在独立审计窗口恢复旧 root-only 配置和旧角色权限。

`legacy_phone_drain` 是一次性、停号且 fail-closed 的迁移桥，不是长期兼容开关；不得与
`ACCOUNTS_ENABLED=true` 或任何认证通道同时使用，也不得为缩短窗口而复用旧验证码、旧
证明或旧供应商权限。

### schema 0011→0012：现在记录微信 UnionID alias（当前 head 0013）

UnionID alias 迁移不替换现有 AppID+OpenID binding，但仍必须使用两个不可变候选 release，
避免 plan11 镜像遇到未知 schema12，也避免 schema11 上提前运行当前 plan13 final API：

1. 第一个候选使用 `AUTH_SCHEMA_TRANSITION_MODE=wechat_union_aliases_pending`，强制
   `WECHAT_AUTH_ENABLED=false`；账号和手机号可继续开放。`WECHAT_OPEN_PLATFORM_REALM_ID`
   必须是稳定的小写内部标识，并与以后绑定到同一微信开放平台账号的小程序复用；
2. 激活 bridge 后确认 API/PostgreSQL healthy，公开配置中的微信仍关闭，再从活动 release
   执行：

   ```bash
   cd /opt/chi-shen-me/releases/<UnionID bridge release>/deploy
   scripts/provision-database.sh --wechat-union-aliases-cutover
   ```

   脚本只接受 exact schema11，并在同一 mutation lock 内创建、验证 exact-schema11 备份，
   连续执行 0012 与 0013、重新应用角色授权，再核对 exact schema13、0012 UnionID ledger、
   空 alias 表、三项 state-bound SECURITY DEFINER 函数和最小 ACL。微信在整个 cutover 中保持关闭；
3. 第二个候选必须使用 `AUTH_SCHEMA_TRANSITION_MODE=none` 且仍保持
   `WECHAT_AUTH_ENABLED=false`。先激活并证明 plan13 final API healthy；不得让认证更新器直接把
   pending bridge 变成 final；
4. 最后另建一个非 `current` 的认证候选并从其中使用 `update-auth-secrets.sh --apply` 恢复微信
   通道；更新器只读活动 final 的 exact schema13、0012 UnionID ledger、realm 和别名 ACL 证明，
   再由候选激活流程
   重建 API；
5. 已有微信用户下一次成功登录或绑定时，服务端会把微信返回的 UnionID 作为
   `realm + HMAC-SHA256` alias 懒写入；不输出原值。当前存量用户需要主动完成一次微信授权，
   才能证明 alias 已补齐。

保留的专用 0012→0011 回滚只适用于数据库仍精确停在 schema12 的旧过渡部署。在 alias 表仍为空时，显式
`rollback-database.sh --wechat-union-aliases <schema11备份> --execute <确认值>` 可从活动 pending
bridge 回退数据库；当前已到 schema13 的部署不得借该入口跨越 0013 降级。只要写入过一条
alias，普通降级必须失败；此时关闭微信、保留当前数据库及安全备份并向前修复，不能用数据丢失
回滚删除跨端身份。

首次开启前必须：

1. 先提供 PHONE_ONLY 兼容的 Android `0.1.3`（`versionCode=4`），并把活动
   `MINIMUM_SUPPORTED_VERSION` 提升到 `0.1.3`；确认旧 `0.1.2` Fusion APK 已进入
   更新锁定后才可开放账号，禁止让旧客户端继续调用已退休的 v1 认证结构；
2. ECS 强制 IMDSv2；RAM 角色只授予 `dypns:SendSmsVerifyCode` 和
   `dypns:CheckSmsVerifyCode`；
3. 在号码认证控制台核对当前可用且配套的系统签名/模板；服务端发送时必须使用供应商
   动态验证码并设置 `ReturnVerifyCode=false`，SDK 自动重试关闭且请求显式 `AutoRetry=0`；
   禁止供应商自动切换签名/模板/节点重发，逐次核对固定资源、调用次数与计费审计；
4. 严格按上述 bridge → 备份 → 0011 迁移与角色授权 → 启用候选顺序执行；
5. 证明手机号成功、错误码、过期、限流、超时、重放和并发校验；成功后直接创建账号；
6. 对每个额外通道证明“未绑定拒绝、登录后主动绑定、已绑定登录”，QQ 首次启用 realm-scoped
   UnionID 前还必须用仅聚合查询确认旧 QQ binding 为零；
7. 切换候选后完成真实 Android 真机闭环，日志和 APK 均不得泄露材料。

普通 key 轮换只能增加新版本并切换 active，不能删除或改变任何仍在使用的版本；脚本
也拒绝改变 `AUTH_IDENTITY_DEDUP_KEY_VERSION`。删除旧版本必须走单独审查的排空与
冲突审计流程，不能手工编辑活动 env 绕过。

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

高德/认证 Secret 更新、PostgreSQL 备份、隔离恢复/生产回滚、`provision-database.sh`
迁移/授权和候选激活
共同使用 root-only 的 `/run/lock/chi-shen-me/mutation.lock` 非阻塞独占锁，脚本会拒绝
任何两者并发；仍必须按上述顺序逐项等待成功，不得通过复制脚本或换锁文件绕过。

脚本必须由 root 从真实的 `/opt/chi-shen-me/releases/<release-id>/deploy` 运行，并持有全局
`flock`。它先再次执行严格预检，要求 `current` 直接指向另一个完整 release，然后只用
候选 Compose 对 `api` 执行 `--no-deps --force-recreate`。它不会运行迁移、重建或停止
PostgreSQL，也不会读取、修改或 reload 任何 Nginx 配置。

候选只有在 API/PostgreSQL 容器均 healthy、`/health/ready` 返回 `ready`、`/v1/config`
公开的账号/注册/手机号/微信/邮箱/QQ 能力与候选 `deployment.env` 完全一致、回环监听和镜像
ID 均正确且 PostgreSQL 容器 ID 未变化后，才会使用 `/opt/chi-shen-me` 同目录临时软链和
原子 rename 切换 `current`，随后再做一次完整运行时校验。成功标志是：

```text
CANDIDATE_RELEASE_ACTIVATION=OK
POSTGRES_CONTAINER_UNCHANGED=true
```

候选重建前必须校验回退 release 的不可变镜像迁移计划与数据库当前完整 ledger 一致。
默认回退目标为旧 release，也可通过 `--rollback-release /opt/chi-shen-me/releases/<id>`
指定已验证的兼容恢复 release；不兼容时保留活动 API，拒绝启动切换。
候选启动、readiness 或切链后复核任一失败时，脚本会从该回退 release 强制重建 API，要求
回退容器恢复为 healthy 且 `/health` 精确返回 HTTP 200，并保证 `current` 指向该回退 release。
`ACTIVATION_ROLLBACK=OK` 表示自动回退完成；`ACTIVATION_ROLLBACK=FAILED` 必须立即停止后续
操作并人工检查，绝不能继续配置 DNS、证书或 vhost。`AMAP_ENABLED=false` 导致候选
readiness 失败属于预期的失败关闭，也会走同一自动回退，不存在特殊绕过。

`ACTIVATION_ROLLBACK=OK` 只证明 release、软链和 API 运行态已经回到已验证回退版本。认证更新器若在
激活前已经成功提交共享 `api.env`，激活器不会自动恢复该文件；QQ 开关仍为 `false` 的旧运行态
会忽略暂存的 QQ 字段并保持 fail-closed，但旧 release 的严格 preflight 会因多余字段失败，不能
称为规范态完整回滚。认证上线前必须准备 root:root、`0600` 的完整关闭目标通道回滚输入，并
准备一个固定、已通过当前 bundle 严格 preflight 的兼容 API image ID 的独立恢复候选；若上一
镜像不具备新配置结构，恢复候选必须使用已验证的新镜像并保持目标通道关闭，不能放宽 preflight。
二者都保留到观察窗口结束。激活失败
后，从恢复候选运行受控 `update-auth-secrets.sh --apply` 恢复其余已开启通道、清退失败通道的
Secret 并保留连续性材料，再走恢复候选的激活门禁；QQ 共享 marker 若已为 `true` 绝不回退。
不得手工编辑共享 Secret、不得直接执行 `docker compose up`，也不得复用失败候选。只有共享
Secret 与旧 API 容器环境都恢复后，才能记录完整回滚。

只有候选激活成功并完成回环真实高德 smoke 后，才进入第 1 节的独立 API 子域 DNS、TLS
和 vhost 配置。成功激活 release 本身不会触碰宝塔或主站。

## 6. 非破坏恢复演练

### 配置中心 schema 12 → 13 切换

当前配置中心升级从完整 schema 12 开始；不要借用历史 PHONE_ONLY 或微信 bridge 入口。
先准备不同于候选的不可变恢复 release，要求其镜像带完整 schema13 迁移计划，并在隔离
恢复库实际验证启动、readiness、既有账号通道与普通推荐。迁移计划校验只证明 ledger
兼容，不替代这一业务演练。恢复 release 必须保持同一数据库卷、公开端口、身份 realm
和部署最低版本安全下限；不得把 schema12 旧镜像声明为 schema13 可用的回退。

从候选 bundle 执行以下命令，由脚本持全局锁、校验恢复镜像与目标迁移计划、生成并校验
备份，然后迁移和执行只读 schema13/ACL 核验：

```bash
scripts/provision-database.sh --admin-config-cutover /opt/chi-shen-me/releases/<recovery-id>
scripts/activate-candidate-release.sh --rollback-release /opt/chi-shen-me/releases/<recovery-id>
```

两条命令必须顺序执行，第一条失败后停止，不得自行删除迁移或回滚数据库以迎合旧镜像。
备份验证、回退 artifact 和真实管理员 RP/origin/bootstrap/step-up 验收需在受控环境记录；
仓库测试或页面存在不表示这些生产条件已经完成。

恢复脚本只允许写入新的隔离数据库名，不会覆盖生产数据库：

```bash
scripts/restore-database.sh \
  /opt/chi-shen-me/backups/postgres/<backup-id> \
  chi_shen_me_restore_YYYYMMDDtHHMMSSz
```

它在任何预检或数据库动作前取得全局 mutation lock，并在校验备份、创建新数据库、预置扩展、
单事务恢复、重新授予最小权限和核对 `schema_migrations` 的整个区间持续持有。锁冲突立即失败且
不会创建恢复库。成功后保留恢复库作为证据；删除恢复库属于另一次明确且可审计的操作，不由该脚本代办。

创建前还会核对备份 `postgis_image_id` 与实际运行容器的镜像 ID，并严格校验 TOC。
允许的扩展为 `pgcrypto`、`postgis` 及备份确实包含的 `fuzzystrmatch`、
`postgis_tiger_geocoder`、`postgis_topology`；普通数据库 provision 不会因此启用可选扩展。
恢复专用 SQL 检查扩展版本、schema、owner，以及精确配置对象的 extension membership 和
`extconfig` 注册。仅跳过已预建扩展及 `tiger`/`topology` schema 的创建项，所有配置数据和序列
状态均保留，与业务数据一起以 `schema_migrator` 完成一次单事务恢复。临时权限仅包括精确
配置表 INSERT、`topology.topology_id_seq` UPDATE 和所需 schema USAGE；恢复后撤回并核对
ACL/owner 基线。恢复阶段失败会清理本次新建的失败库，原备份和活动库不变；恢复完成后若仅临时
清单清理失败，脚本返回非零并保留已完成的恢复库供排查。序列 `setval` 本身不随事务回滚，
所以失败库不可留作成功恢复使用。未知扩展或扩展 schema 中的额外对象须
先独立审查，不能通过删除 TOC 数据项、扩大迁移角色权限或截断配置表来绕过。

## 7. 明确的数据库回滚

生产回滚必须显式提供与备份编号绑定的确认文本：

```bash
scripts/rollback-database.sh \
  /opt/chi-shen-me/backups/postgres/<backup-id> \
  --execute \
  ROLLBACK_chi_shen_me_FROM_<backup-id>
```

执行顺序是：先取得全局 mutation lock，再为当前数据库做安全备份、把目标备份恢复到隔离库、
停止 API、保留并重命名原数据库、原子切换恢复库、重启并运行运行时验证。内部备份和恢复只接受
由父回滚进程继承并复核的同一 FD8 锁，不会二次抢锁，也没有无锁旁路；锁一直覆盖失败清理和旧库
恢复。若新库不能启动 API，脚本尝试自动切回原库；无论成功或失败，都不主动删除原库、失败库或历史备份。

0010 的 Fusion 表只为完成既有记录的 24 小时历史数据删除而暂留。`retention_worker` 仅能执行
`preview_fusion_auth_retention_cleanup()` 和 `execute_fusion_auth_retention_cleanup()`；API、管理员
和导出角色均显式拒绝。这是数据最小化义务，不是保留 Fusion 登录能力。

2 GiB ECS 上，镜像构建、备份、恢复、迁移和压力测试必须串行。回滚前还应确认磁盘至少有“当前数据库大小的两倍 + dump 大小 + 2 GiB”可用空间。
