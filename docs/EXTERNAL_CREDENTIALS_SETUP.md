# 外部认证材料一次性清单

本文只记录需要由项目负责人在第三方控制台取得、并在服务器本地录入的材料。不要把真实密钥、手机号、验证码、正式方案参数或服务器候选配置发到聊天、Issue、PR、截图或 Git 仓库。

## 1. 固定产品政策

当前政策固定为 `PHONE_ONLY`，不是运行时开关：

- 手机短信验证码验证成功后可直接创建账号并签发会话；
- 微信、QQ、邮箱只允许登录已经绑定到现有账号的身份，不能单独建号；
- App 提供登录后绑定微信；
- 不提供一键手机号登录、图形验证或上行短信；
- 客户端只调用自有 HTTPS API，不持有阿里云、SMTP 或 OAuth 服务端密钥。

因此最小可用账号链路必须先完成阿里云短信认证。微信、QQ、邮箱可以分别保持关闭，直到对应材料、服务端部署和真实验收完成。

## 2. 一次性向项目负责人收集的材料

### 阿里云号码认证短信

请提供非敏感配置值：

- 当前控制台“短信认证参数配置”中可用的系统签名原文；
- 与该签名配套的系统模板 Code，例如控制台当前显示的登录/注册模板；
- ECS 实例绑定的 RAM 角色名；
- 已确认套餐/余额、国内手机号发送能力和签名模板配套状态。

不要提供 AccessKey。生产环境使用 ECS RAM 角色和 IMDSv2。角色只授予：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dypns:SendSmsVerifyCode",
        "dypns:CheckSmsVerifyCode"
      ],
      "Resource": "*"
    }
  ]
}
```

阿里云在 2026-07-07 上线了新的短信认证签名，并公告历史赠送签名将在 2026-08-31 后停止支持。上线前必须回到控制台确认当前可用签名，不能沿用旧截图或旧部署值。参考：[短信认证服务](https://help.aliyun.com/zh/pnvs/user-guide/sms-authentication-service)、[RAM 授权信息](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-ram)、[签名变更通知](https://help.aliyun.com/zh/pnvs/product-overview/sms-authentication-signature-change-notification)。

### 微信开放平台

请一次性提供或确认：

- Android 应用 AppID；
- AppSecret，仅进入服务端 Secret；
- 已审核的 Android 包名与应用签名摘要；
- Universal Link/开放平台回调配置（若当前 SDK 版本要求）；
- 稳定的内部 `WECHAT_OPEN_PLATFORM_REALM_ID`；未来小程序只有绑定到同一微信开放平台账号并
  复用该 realm，才能用 UnionID 与现有移动 App 账号匹配；
- 可用于“已绑定登录”和“登录后绑定”的真实测试账号。

AppSecret 不能进入 Android 代码、APK、Gradle 属性或日志。AppID 可作为客户端公开标识，但
必须与服务端允许值和开放平台配置一致。服务端只保存带密钥的 OpenID/UnionID HMAC，不保存
原值；realm 不是 Secret，但一旦产生 alias 就属于身份连续性配置，不能在普通发布中更换。

### QQ 互联

请一次性提供或确认：

- QQ 互联 AppID；
- QQ 互联 AppKey，只进入服务端 root-only Secret；
- 已审核的 Android 包名与签名；
- 是否已具备并启用 UnionID 能力；
- 稳定内部 `QQ_OPEN_PLATFORM_REALM_ID`；同一 QQ 互联开放平台打通应用集合必须永久复用；
- 可用于“登录后绑定”和“已绑定登录”的真实测试账号。

Android 使用官方 `loginServerSide` 取得一次性 code。服务端用 AppID/AppKey 通过腾讯官方 token
端点换票，再调用官方身份接口核对 AppID 并取得 OpenID/可选 UnionID；AppKey 不得进入 Android、
Gradle、APK、日志、聊天或 Git。启用 QQ 时 root-only `api.env` 必须同时含 `QQ_APP_ID` 与
`QQ_APP_KEY`。只有 UnionID 能力真实开通、稳定 realm 已锁定、上线前确认旧 QQ binding 聚合数
为零且服务端/数据库/真实账号全部验收后，才设置 `QQ_UNION_ID_ENABLED=true`。

实现和验收只以腾讯 QQ 互联官方一手资料为准：

- [Server-Side 登录模式](https://wiki.connect.qq.com/server-side%E7%99%BB%E5%BD%95%E6%A8%A1%E5%BC%8F)；
- [使用 authorization_code 获取 access_token](https://wiki.connect.qq.com/%E4%BD%BF%E7%94%A8authorization_code%E8%8E%B7%E5%8F%96access_token)；
- [获取用户 OpenID](https://wiki.connect.qq.com/%E8%8E%B7%E5%8F%96%E7%94%A8%E6%88%B7openid_oauth2-0)；
- [UnionID 介绍](https://wiki.connect.qq.com/unionid%E4%BB%8B%E7%BB%8D)。

### SMTP 邮箱验证码

请一次性提供或确认：

- SMTP 完整 DNS 主机名；
- 端口及 TLS 模式；
- SMTP 登录名；
- 应用专用密码或 SMTP 授权码；
- 发件地址与显示名；
- Reply-To 回复地址；
- SPF、DKIM、DMARC 的 DNS 检查结果；
- 可用于“已绑定登录”的真实收件邮箱。

root-only 认证候选必须把应用专用密码命名为 `SMTP_APP_PASSWORD`。Secret 更新器只在服务器
内存和 root-only 文件边界内把它映射为 `SMTP_PASSWORD`；`api.env` 与 API 运行时只接受
`SMTP_PASSWORD`，候选同时提供两种名称会被拒绝。当前 DMARC 实测状态为 `false`：Alpha
阶段把它记录为非阻断缺口，不得写成“已完成”；对外发布前必须完成域名策略和真实投递复核。

## 3. 服务器变量

### 固定开关和公共运行参数

```dotenv
ACCOUNTS_ENABLED=true
PHONE_AUTH_ENABLED=true
EMAIL_AUTH_ENABLED=false
WECHAT_AUTH_ENABLED=false
QQ_AUTH_ENABLED=false
QQ_UNION_ID_ENABLED=false
ALIBABA_CLOUD_ECS_METADATA=<ECS RAM 角色名>
```

### 手机短信认证

```dotenv
ALIYUN_CREDENTIAL_ALLOWED_PROVIDER=default/ecs_ram_role
ALIYUN_PNVS_SIGN_NAME=<控制台当前可用签名原文>
ALIYUN_PNVS_TEMPLATE_CODE=<与签名配套的模板 Code>
ALIYUN_PNVS_TIMEOUT_MS=1500
```

服务端调用 `SendSmsVerifyCode` 时使用供应商动态生成验证码，并强制 `ReturnVerifyCode=false`；客户端和 API 响应都不得得到明文验证码。SDK 运行时自动重试必须关闭，请求再显式设置 `AutoRetry=0`，不允许供应商自动切换签名、模板或节点重发；一次受控发送对应一次固定签名/模板调用，便于计费和审计。校验必须调用 `CheckSmsVerifyCode` 并只接受明确的成功结果。短信认证是纯服务端 API，不需要 Android 供应商认证 SDK。

### 微信（启用时才需要）

```dotenv
WECHAT_AUTH_ENABLED=true
WECHAT_APP_ID=<wx 开头的 18 位 AppID>
WECHAT_APP_SECRET=<仅服务器持有>
WECHAT_AUTH_TIMEOUT_MS=2000
```

### QQ（启用时才需要）

```dotenv
QQ_AUTH_ENABLED=true
QQ_UNION_ID_ENABLED=false
QQ_APP_ID=<5 至 16 位数字 AppID>
QQ_APP_KEY=<仅 root-only 候选输入和服务端 api.env 持有>
QQ_AUTH_TIMEOUT_MS=2000
```

`deployment.env` 只携带候选 `QQ_OPEN_PLATFORM_REALM_ID`，绝不携带 marker。realm 与非秘密
marker 的唯一权威是 root:root、`0600` 的
`/opt/chi-shen-me/shared/auth-identity-state.env`，其中只能有 format version 1、realm、marker 三键；
它不属于上面的 root-only 认证候选，也不进入 API 环境。共享文件缺失或 marker 需要提升时，只能
由活动 release 的更新器在 QQ 当前关闭且聚合 QQ binding 为零时原子写入。首次直接启用 UnionID
会直接写成 `true`；紧急关闭、release 回滚和后续恢复均以该共享值为准，不得回退或重算。

### 邮箱（启用时才需要）

```dotenv
EMAIL_AUTH_ENABLED=true
AUTH_OTP_PEPPER_ACTIVE_VERSION=otp.v1
AUTH_OTP_PEPPER_KEYS_JSON={"otp.v1":"<32 字节随机值的规范 Base64>"}
SMTP_HOST=<完整 DNS 主机名>
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USERNAME=<SMTP 登录名>
SMTP_APP_PASSWORD=<应用专用密码或授权码，仅 root-only 候选输入>
SMTP_FROM_ADDRESS=<发件地址>
SMTP_REPLY_TO=<回复地址>
SMTP_FROM_NAME=吃什么
```

邮件 OTP pepper 与身份哈希密钥不能复用。手机号验证码由阿里云生成和核验，不使用本地
OTP pepper。ECS API 运行时由受审查的 Compose 固定
`SMTP_TIMEOUT_MS=5000`；它不是认证候选 Secret，不能加入上面的精确字段文件。本机开发
仍可在受控运行时配置中使用 `SMTP_TIMEOUT_MS`。

## 4. 安全录入与激活

1. 在服务器 root-only 目录创建候选配置，权限必须为 `0600`；不要使用仓库内 `.env`。
2. 候选必须包含开关所要求的精确字段：关闭的通道不得夹带对应 Secret。
3. 在新建且尚非 `current` 的候选 release 的 `deploy` 目录运行（不要调用或修改仍在活动的旧版
   deploy）。工作站的最小 QQ delta 必须先在 ECS root-only 边界内与当前连续性字段及所有已开启
   通道字段合成为精确完整候选，不能直接交给更新器：

   ```bash
   sudo /opt/chi-shen-me/releases/<候选 release>/deploy/scripts/update-auth-secrets.sh \
     --apply --config-file /root/auth-candidate.env
   ```

4. 更新器在锁内只读 `/opt/chi-shen-me/current` 的运行态、schema/ACL、realm 和需要的聚合
   数据证明；活动 release 与容器在激活前保持不变。普通 `--apply` 会把 transition 设为 `none`，把候选中的
   `SMTP_APP_PASSWORD` 映射成 `api.env` 的 `SMTP_PASSWORD`，清退旧字段并原子替换
   `api.env` 与候选 `deployment.env`，再执行无网络的生产配置预检；该更新器进程内的
   预检失败会自动回滚。
5. 重新创建 API 容器后，先验证 `/health`、公开 capabilities 和失败关闭，再做真实手机号/微信/QQ/邮箱测试。
6. 候选文件完成后安全删除；不要把文件内容复制到终端记录、工单或聊天。

第 6 步只能在候选激活稳定、回滚窗口关闭后执行。激活器失败时会自动恢复旧 release、
软链和 API 运行态，但不会恢复已经由更新器提交的共享 `api.env`。启用认证通道前还必须准备
一份 root-only、关闭目标通道的完整回滚输入，以及固定且通过当前严格 preflight 的兼容 API
image ID 的独立恢复候选。上一镜像若不具备新配置结构，恢复候选应使用已验证的新镜像并保持
目标通道关闭，不得放宽字段或运行态门禁。候选与输入保留到观察窗口结束；若激活失败，从恢复候选运行受控
`update-auth-secrets.sh --apply` 恢复原有通道配置并清退失败通道 Secret，再通过该候选的激活门禁
重建和验证旧 API。失败候选不得复用；只有 release/runtime 与共享 Secret 都恢复后，才能
称为完整回滚。QQ UnionID marker 一旦持久化为 `true`，恢复流程也不得把它降回 `false`。

若共享 `api.env` 仍来自 schema 0010 的旧认证方案，必须按运维手册使用 bridge：第一个
新候选执行 `--legacy-drain`，以 `AUTH_SCHEMA_TRANSITION_MODE=legacy_phone_drain` 且所有账号
通道关闭的状态激活；它只允许数据库完整或仅缺精确的 `0011_phone_only_auth.sql`，并逐字节
保留旧认证 Secret 供首次候选失败时重建旧 API。bridge healthy、旧请求排空后，依次完成
迁移前备份、0011 迁移、角色授权和 ACL/runtime smoke；最后才在第二个候选执行 `--apply`
并激活 PHONE_ONLY。最终候选失败时只能回到停号 bridge；恢复旧 Fusion 必须恢复迁移前
数据库，并另行审计恢复旧配置/权限。这些阶段不能合并。

紧急关闭所有账号能力：

```bash
sudo /opt/chi-shen-me/releases/<候选 release>/deploy/scripts/update-auth-secrets.sh --disable
```

这是可逆的紧急关闭，不是 Secret 销毁：脚本关闭所有认证开关并清退供应商通道字段，但在
root-only `api.env` 保留身份/会话 HMAC ring、稳定 dedup version 和已有的邮件 OTP pepper
pair。恢复账号时 `--apply` 必须沿用这些连续性字段；任何 key/version 变化都会在写共享
`api.env` / `deployment.env` 前拒绝，避免同一手机号因新 dedup 生成第二个账号。若确需删除
旧 key，必须走单独审查的排空和数据迁移流程。

## 5. 上线验收

- 手机：发送、错误验证码、过期、重复发送、供应商限流、超时、同一 challenge 并发校验、成功后直接建号/会话；
- 微信：未绑定身份必须失败，已绑定登录成功，登录后绑定成功，重复绑定/抢占失败；
- QQ：未绑定身份必须失败，登录后主动绑定成功，已绑定登录回原账号；Server-Side code 只能
  消费一次，AppID/AppKey 换票和 UnionID realm 行为与开关一致；
- 邮箱：未绑定身份必须失败，已绑定登录成功，错误/过期/重放验证码失败；
- 隐私：APK 不包含服务器 Secret、供应商认证 SDK、`READ_PHONE_STATE` 或旧认证入口；
- 日志：不记录完整手机号、验证码、OAuth token、SMTP 密码或密钥材料；
- 外部条件：RAM/IMDSv2、短信签名模板、SMTP DNS、微信/QQ 控制台状态均以当天真实结果为准。

工程测试通过不等于第三方真实验收完成。每个通道在真实成功、失败、超时和回滚证据齐全前保持关闭。
