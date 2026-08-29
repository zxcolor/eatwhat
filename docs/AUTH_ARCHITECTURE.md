# 「吃什么」账号与身份接入架构

## 1. 固定产品规则

当前账号策略固定为 `PHONE_ONLY`，不提供运行时策略开关：

- 手机号短信验证码验证成功后，可以创建账号并签发会话；
- 微信、QQ、邮箱不能单独创建账号，只能登录已绑定到现有账号的身份；
- 已登录用户可以主动绑定邮箱、微信和 QQ；绑定必须在有效手机主账号会话内完成；
- 不提供一键手机号登录、图形验证、上行短信或账号恢复；
- 账号能力关闭、数据库未就绪、供应商未配置或客户端能力不完整时统一失败关闭。

公开 capability 只描述部署中实际可用的通道，不能改变上述产品政策。

## 2. 信任边界

`Android → 自有 HTTPS API → PostgreSQL / 第三方服务`

- Android 只收集用户主动输入的手机号、验证码和 OAuth 回调材料；
- 阿里云 RAM 凭据、短信签名/模板、SMTP 密码、微信 AppSecret、QQ AppKey 只存在于服务端；
- Android APK 不包含号码认证供应商 SDK，不申请 `READ_PHONE_STATE`；
- PostgreSQL 不保存完整手机号、邮箱、明文验证码、OAuth code/token 或 App token；
- 日志不记录上述敏感值和第三方响应原文。

## 3. 手机短信认证

### 3.1 供应商

手机号通道使用阿里云号码认证服务 `Dypnsapi` 的纯服务端接口：

- `SendSmsVerifyCode`：发送验证码；
- `CheckSmsVerifyCode`：核验用户输入；
- ECS RAM 角色只授予 `dypns:SendSmsVerifyCode` 和
  `dypns:CheckSmsVerifyCode`；
- 生产凭据固定为 `default/ecs_ram_role` 并强制 IMDSv2；
- 签名与模板必须来自号码认证控制台的当前可用配套资源。

发送请求使用 `{"code":"##code##"}` 让供应商动态生成验证码，并固定
`ReturnVerifyCode=false`。API、日志、测试夹具和客户端都不能取得供应商生成的明文码。
SDK 运行时关闭自动重试，发送请求再显式设置 `AutoRetry=0`；不允许供应商自动切换签名、
模板或节点重发。每次受控发送只对应一次固定签名/模板调用，应用层重试仍受 challenge 与限流
约束，以保持计费和审计可预测。

### 3.2 Challenge

请求验证码时，服务端：

1. 规范化中国大陆手机号；
2. 对手机号、IP、installation 和 purpose 计算域分离 HMAC；
3. 在本地事务中创建 `otp_challenges`，保存掩码、不可逆指纹、过期时间和重发时间；
4. 调用供应商发送；
5. 只在供应商明确成功后把 challenge 标记为已投递；
6. 返回 challenge UUID、掩码、过期时间和可重发时间。

同号码/设备/IP 的本地限流先于供应商调用；供应商的频控和日限额错误再映射为稳定的公开错误。客户端不得根据错误差异枚举账号是否存在。

### 3.3 校验、并发与建号

PNVS 在校验时还需要手机号，因此登录请求同时携带 challenge、手机号、验证码和设备上下文。服务端重新计算手机号指纹，必须与 challenge 精确匹配后才调用供应商。

为避免同一 challenge 的并发双验，`otp_verification_leases` 提供短时数据库 lease：

1. `claim_otp_verification_lease` 原子抢占；
2. 只有抢占者调用 `CheckSmsVerifyCode`；
3. 网络/供应商失败时 `release_otp_verification_lease` 允许受控重试；
4. 明确验证码失败或成功时 `complete_otp_verification_lease` 原子记录结果；
5. 成功后 `register_phone_account_from_consumed_otp` 在数据库内创建或查找手机号主账号；
6. 会话创建与响应在事务成功后完成。

同一 challenge 只能消费一次。供应商超时不得被当作验证码错误，也不能提前消费 challenge；客户端可以按公开退避规则重试。未知或格式异常的供应商响应一律失败关闭。

## 4. 邮箱验证码

邮箱使用服务端本地生成 OTP 和 SMTP 投递：

- OTP 只保存带独立 pepper 的 Argon2id；
- SMTP 连接在启用时先 `verify()`；
- 465 使用隐式 TLS，587/25 强制 STARTTLS；
- 邮件为固定纯文本，无附件、外链或用户可控模板；
- 邮箱验证码只用于已绑定登录或有效会话内绑定，不能创建账号。

SMTP 运行时变量为
`SMTP_HOST/PORT/SECURE/USERNAME/PASSWORD/FROM_ADDRESS/REPLY_TO/FROM_NAME/TIMEOUT_MS`。
root-only 认证候选只接受 `SMTP_APP_PASSWORD`；Secret 更新器在服务器边界内把它映射为
`api.env` 的 `SMTP_PASSWORD`，候选不得使用运行时名称或同时提供两种名称。ECS Compose
固定 `SMTP_TIMEOUT_MS=5000`，因此该字段不进入认证候选 Secret；本机受控运行时仍可配置。
当前 DMARC 检查为 `false`，仅作为 Alpha 非阻断缺口；对外发布前必须完成
SPF/DKIM/DMARC 与真实投递验收。

## 5. 微信与 QQ

OAuth state 绑定 provider、purpose、installation、过期时间和一次性消费状态：

- LOGIN 只查找已绑定身份，不创建账号。只有 state 与平台临时凭据均验证成功后，
  未绑定身份才返回稳定的 `IDENTITY_NOT_BOUND`；错码、过期、重放、设备或用途不匹配、
  平台失败仍统一返回脱敏认证错误；
- BIND 必须有有效 App 会话；
- 微信授权 code 只由服务端用 AppSecret 兑换；
- 微信 OpenID 与 AppID 组成当前移动 App 的稳定身份和去重键；它不会被 UnionID 替换；
- 服务端把微信返回的 UnionID 以 `开放平台 realm + HMAC-SHA256` 单独保存为跨应用 alias，
  不保存或记录原始 OpenID/UnionID。realm 是稳定的内部身份命名空间，同一微信开放平台账号
  下的移动 App 与未来小程序必须复用同一值；
- UnionID 缺失时，已经由 AppID+OpenID 识别的当前 App 登录仍可继续，但不能跨应用匹配；
  AppID+OpenID 与 realm+UnionID 若指向不同业务账号则整次操作返回身份冲突，绝不自动合并、
  转移或覆盖；
- Android 调用 QQ 官方 `loginServerSide`，把 SDK 回调 `access_token` 字段承载的一次性
  authorization code 交给自有后端；客户端不提交或采信 OpenID/UnionID；
- 服务端使用与 Android 相同的公开 AppID、仅保存在服务端的 AppKey 和固定
  `auth://tauth.qq.com/` redirect URI 向腾讯官方
  token 端点换取短时 access token，再调用官方 `/oauth2.0/me` 核对返回的 `client_id` 并获取
  OpenID/可选 UnionID。code、access/refresh token 和供应商原始响应只在本次调用内存中存在；
- QQ lookup 始终是 `AppID + OpenID` 的 HMAC。启用 UnionID 时，dedup 使用稳定
  `QQ_OPEN_PLATFORM_REALM_ID + UnionID` 的域分离 HMAC；不保存明文，也不把 UnionID 当成
  全平台全局标识；
- QQ realm 与 UnionID namespace marker 的唯一权威是 releases 之外的
  `/opt/chi-shen-me/shared/auth-identity-state.env`。它是 root:root、`0600` 的非秘密完整性状态，
  且只允许 `AUTH_IDENTITY_STATE_FORMAT_VERSION=1`、`QQ_OPEN_PLATFORM_REALM_ID`、
  `QQ_UNION_ID_NAMESPACE_INITIALIZED` 三键；marker 不进入认证候选、Android、API 环境或
  `deployment.env`；
- 共享文件不存在时首次开启 QQ，或把其中 marker 从 `false` 提升为 `true`，都必须从活动 QQ
  通道关闭态开始，在全局部署锁内只输出聚合计数并证明旧 QQ binding 为零。首次直接启用
  UnionID 时共享文件直接写为 `true`，不产生可被普通 release 回退的中间 `false`；
- 共享状态在 API/`deployment.env` 候选之前原子持久化，后续预检失败只回滚这两个候选文件，
  不回滚 realm 或单调 marker。旧 release 即使没有 marker，恢复候选也必须以共享文件为准；
  紧急关闭只把 QQ/UnionID 当前开关设为 `false` 并保留共享状态。marker 为 `true` 后重新开启
  QQ 必须同时开启 UnionID，因此已有 binding 不会被误判为首次切换，也不会新增 OpenID-only 绑定。

schema 0012 的受限数据库函数把可选 UnionID 证明封存在已经消费的微信 OAuth state 中，
随后在同一事务边界内核对 state 的 AppID+OpenID 哈希与目标微信绑定，再写入 alias。
`bind_oauth_identity_with_wechat_union_from_consumed_state` 在 alias 冲突时回滚新绑定；登录路径在
alias 成功或明确无 UnionID 后才创建会话。普通运行角色不能直接读取或改写 alias 表。
`revoke_non_primary_identity_binding` 只允许解绑非主身份；微信解绑保留 alias 防止被另一个业务
账号接管，最终账号删除则通过外键级联删除 alias。

## 6. 密钥与数据模型

### 6.1 数据表

- `users`：账号主体；
- `identity_bindings`：PHONE/EMAIL/WECHAT/QQ 的不可逆 lookup、掩码和主身份标记；
- `otp_challenges`：短信或邮件 challenge、投递/验证状态、次数和过期时间；
- `otp_verification_leases`：同 challenge 并发供应商核验租约；
- `oauth_states`：OAuth state、purpose、installation 和消费状态；
- `wechat_union_aliases`：微信开放平台 realm、UnionID HMAC、对应微信 binding 与验证时间；
  每个 realm 内 UnionID 与业务账号均唯一，不向 API runtime 开放直接表权限；
- `auth_session_families` / refresh/access 表：会话轮换与重放检测。

历史迁移中的 0010 Fusion 表只为履行最长 24 小时的数据删除而暂留：maintenance role
只能执行两项专用 preview/execute 清理函数，不能直接读取表；API、管理员和导出角色均显式
拒绝这两项函数。这是历史数据最小化，不是 Fusion 运行时能力。schema 0011 后不能仅靠切回
旧镜像恢复 Fusion；必须恢复迁移前数据库。schema 0012 在 0011 上增加微信 UnionID alias，
不重键已有 AppID+OpenID binding。普通 0012→0011 回退只允许 alias 表仍为空的过渡窗口；
一旦记录过 alias，只能保留 0012 数据库并向前修复。当前认证运行时只授权 PHONE_ONLY、
OAuth/邮件和三项 UnionID state-bound 原语所需的最小表及函数。

### 6.2 密钥环

- `AUTH_HASH_KEYS_JSON`：身份、目的地、设备/IP、token 的域分离 HMAC；
- `AUTH_OTP_PEPPER_KEYS_JSON`：仅邮件 OTP Argon2id pepper；
- 两个密钥环不能复用材料；
- `AUTH_IDENTITY_DEDUP_KEY_VERSION` 不能由普通 Secret 更新脚本改变；
- 普通轮换不能移除任何仍在使用的版本，删除需单独审查的迁移/排空流程。

`update-auth-secrets.sh --disable` 是可逆的紧急停号，不是密钥销毁。它关闭六个账号/认证
开关并清退供应商通道配置，但必须在 root-only `api.env` 原样保留
`AUTH_HASH_ACTIVE_VERSION`、`AUTH_HASH_KEYS_JSON`、`AUTH_IDENTITY_DEDUP_KEY_VERSION`，以及
已有的完整邮件 OTP pepper pair。主 HMAC ring 同时承载身份去重、设备/IP 和 access/refresh/
session/OAuth token 的连续性；丢失或替换会让既有绑定/会话不可解析，并可能把同一手机号建成
新账号。停号后 `--apply` 必须提交相同连续性字段；任一值不一致都在写 `api.env` 或
`deployment.env` 前失败。

仅关闭 EMAIL 而保持账号、手机号和微信开启时也遵循相同连续性规则：更新器删除全部 SMTP
字段，但无条件逐值保留已经存在的完整 `AUTH_OTP_PEPPER_*` pair。重新开启邮箱时可以增加
新版本并切换 active，但不能删除仍在使用的旧版本。

## 7. 运行时配置

账号启用时必须满足：

`ACCOUNTS_ENABLED=true` 且 `PHONE_AUTH_ENABLED=true`。

可选通道：

- `EMAIL_AUTH_ENABLED`；
- `WECHAT_AUTH_ENABLED`；
- `QQ_AUTH_ENABLED`；
- `QQ_UNION_ID_ENABLED`，要求 QQ 同时启用。

PNVS 使用：

- `ALIYUN_PNVS_SIGN_NAME`；
- `ALIYUN_PNVS_TEMPLATE_CODE`；
- `ALIYUN_PNVS_TIMEOUT_MS`。

`AUTH_SCHEMA_TRANSITION_MODE` 常态只允许 `none`。一次性 0010→0011 迁移可暂设
`legacy_phone_drain`，但仅在 `ACCOUNTS_ENABLED=false` 且全部认证通道关闭时有效；该 API
只接受完整 schema 或仅缺精确最后一项 `0011_phone_only_auth.sql`。bridge preflight 允许的
旧 `api.env` 字段是固定白名单，未知字段仍拒绝；普通 `none` 模式继续要求严格精确字段。

`update-auth-secrets.sh --legacy-drain` 只更新非秘密部署配置，并用摘要证明共享 `api.env`
逐字节未变，以便首次 bridge 激活失败时重建旧 API。普通 `--apply` / `--disable` 会把 mode
恢复为 `none` 并清退旧字段；其中 `--disable` 仍保留上述连续性材料。任何模式都用无网络、
只读候选容器执行生产配置解析，失败
自动回滚；成功仍需按 bridge → 备份 → 0011/角色授权/ACL smoke → enabled apply → 激活的
顺序重建 API、检查 readiness 并完成真实 smoke。

认证更新器只允许写尚非 `current` 的候选 release；活动 release 仅用于锁内只读证明运行态、
schema/ACL、realm、当前开关和必要的聚合计数。共享 Secret 与候选配置通过后，仍由候选激活器
完成受控容器重建和原子切链。

这里的“失败自动回滚”只指 Secret 更新器自身预检失败。更新器预检成功后，候选激活器若
失败，只会自动恢复旧 release、软链和 API 运行态，不会恢复已经提交的共享 `api.env`。
认证通道上线前必须另备 root-only、关闭目标通道的回滚输入和固定、已通过当前严格 preflight
的兼容 API image ID 的独立恢复候选；上一镜像若不具备新配置结构，应使用已验证的新镜像并
保持目标通道关闭，而不是放宽 preflight。激活失败后从恢复候选运行受控 Secret 更新器，清退目标通道 Secret 并保留连续性材料，
再走其激活门禁重建并验证旧 API。失败候选不得复用；激活器不解析或重组认证 Secret，
不得把 release/runtime 回退表述成完整 Secret 自动回滚。

## 8. Android 安全状态管理

验证码页面状态由 Activity 级内存 ViewModel 管理：

- Activity 配置重建时只在内存中保留当前步骤、challenge、倒计时和输入；
- 显式退出、隐私撤回、账号配置代际变化或 challenge 过期时清除；
- 进程死亡后只按安全的非敏感信息恢复，不把完整手机号/验证码/token 写入 SavedState 或磁盘；
- 迟到网络响应必须匹配当前 attempt/generation 才能更新 UI 或保存会话。

## 9. 必过验证

- 配置：PHONE_ONLY 组合、每个可选通道的精确字段、关闭路径和 Secret 隔离；
- PNVS：发送成功/失败、`ReturnVerifyCode=false`、SDK 自动重试关闭、`AutoRetry=0`、固定
  签名/模板、错误/过期码、限流、超时、异常响应和可预测计费审计；
- 数据库：lease 并发唯一、失败释放、成功消费、原子建号、重放拒绝、最小角色权限；
- OAuth/邮箱：未绑定拒绝、已绑定登录、微信绑定、重复/抢占冲突；
- Android：短信切换返回、Activity 重建、进程恢复、弱网、重复点击；
- 工件：源码、依赖、Manifest、DEX 均不含旧号码认证 SDK、`READ_PHONE_STATE`、
  一键手机号登录或图形验证文案；
- 真实环境：ECS RAM/IMDSv2、控制台当前签名模板、ARM64 + 中国大陆 SIM 真机、
  SMTP DNS/投递、微信/QQ 平台资质。

工程测试通过不能替代第三方控制台状态、真实供应商调用或真机闭环。
