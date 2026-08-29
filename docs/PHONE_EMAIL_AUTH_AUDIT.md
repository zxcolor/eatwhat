# Android 1.0 手机号与邮箱登录专项审计

审计日期：2026-08-28

## 1. 当前结论

账号政策固定为 `PHONE_ONLY`：

| 身份 | 注册 | 登录 | 登录后绑定 | 恢复 |
|---|---:|---:|---:|---:|
| 手机号 | 允许 | 允许 | 不提供 | 不提供 |
| 微信 | 不允许 | 仅已绑定 | 允许 | 不提供 |
| QQ | 不允许 | 仅已绑定 | 允许 | 不提供 |
| 邮箱 | 不允许 | 仅已绑定 | 允许 | 不提供 |

手机号只使用阿里云号码认证服务的短信验证码 API：后端调用
`SendSmsVerifyCode` 发送供应商生成的验证码，并以 `CheckSmsVerifyCode`
验证用户输入。`ReturnVerifyCode=false`，验证码不能返回自有服务、Android、日志或响应。
Android 不集成号码认证 SDK，不申请 `READ_PHONE_STATE`，不提供一键登录、图形验证或上行短信。

邮箱继续使用自有后端生成的本地 OTP，并经标准 SMTP 发送；它不能创建账号。

## 2. 数据与 Secret 边界

- Android 只访问自有 HTTPS API；阿里云 AccessKey、短信签名/模板、SMTP 密码、
  微信/QQ 服务端材料均只存在于 root-only ECS Secret。
- 手机 challenge 保存手机号的版本化 HMAC、掩码、用途、设备/IP 限流信息和供应商请求标识，
  不保存供应商验证码。
- 邮箱 challenge 保存邮箱的版本化 HMAC、掩码和 Argon2id + pepper 的验证码哈希，
  不保存明文 OTP。
- `SMTP_APP_PASSWORD` 只允许出现在 root-only 认证候选输入中，Secret 更新器将它映射成
  `api.env` 和 API 运行时唯一接受的 `SMTP_PASSWORD`；候选同时提供两种名称会被拒绝；
  `SMTP_REPLY_TO` 与发件地址同为服务端配置。
- 微信/QQ/邮箱登录只解析现有绑定；未绑定身份不得隐式创建或合并账号。

## 3. 发送、验证与并发

- 发码先通过数据库事务中的目标、设备和 IP 限流，再调用供应商；成功响应只返回脱敏
  challenge 元数据。
- 手机验证码由供应商生成与验证，自有服务不做本地手机号 OTP 对比。
- 验证前通过 `otp_verification_leases` 取得短租约，阻止同一 challenge 的并发供应商校验；
  超时租约可恢复，成功后在数据库事务中一次性消费 challenge 并注册/登录。
- 供应商超时或未知结果不会自动重发短信，也不会把 challenge 当作验证成功；客户端可按
  `Retry-After` 或显式错误重新发起安全操作。
- 错码、过期、重放、设备/用途不匹配和供应商验证失败统一收敛为安全错误。
  只有一次性 state 与平台临时凭据都验证成功后，未绑定的微信/QQ 身份才返回稳定的
  `IDENTITY_NOT_BOUND`；该分支仍消费 state、不创建账号或会话，也不披露其他账号信息。
- 隐私撤回、设备不匹配、用途不匹配或 challenge 已消费时，迟到响应不得写入会话。

## 4. 部署门槛

启用 PHONE 时必须同时满足：

- `ALIYUN_PNVS_SIGN_NAME`
- `ALIYUN_PNVS_TEMPLATE_CODE`
- `ALIYUN_PNVS_TIMEOUT_MS`
- ECS RAM 仅授予 `dypns:SendSmsVerifyCode` 与 `dypns:CheckSmsVerifyCode`
- 生产角色使用 IMDSv2/临时凭据，不把固定 AccessKey 写入镜像、仓库或 APK

启用 EMAIL 时必须同时满足 `AUTH_OTP_PEPPER_ACTIVE_VERSION`、
`AUTH_OTP_PEPPER_KEYS_JSON`、SMTP host/port/TLS/用户名/应用专用密码、
`SMTP_FROM_ADDRESS`、`SMTP_REPLY_TO` 与 `SMTP_FROM_NAME`。ECS 的
`SMTP_TIMEOUT_MS` 由受审查的 Compose 固定为 5000 毫秒，不属于 root-only 认证候选
Secret；本机开发仍可通过受控运行时配置调整。当前 DMARC 检查为 `false`：封闭 Alpha
可作为明确记录的非阻断缺口，对外发布前必须修复并重新验收。

把 EMAIL 从 `true` 改为 `false` 时，更新器必须清退全部 SMTP 字段，同时逐值保留完整
`AUTH_OTP_PEPPER_*` pair，不得因账号与手机号/微信仍开启而删除 pepper 连续性。
候选激活失败时，现有激活器自动恢复的是旧 release、软链和 API 运行态，不会自动恢复
此前已经提交到共享 `api.env` 的认证 Secret。上线前必须保留 root-only、EMAIL=false 的
回滚输入，并预先准备固定上一已验证 API image ID 的独立恢复候选；失败后从该恢复候选
通过受控 Secret 更新器恢复手机号/微信配置、清退 SMTP，再走候选激活门禁重建并验证旧
API。失败候选不得复用；完成这些步骤前不得表述为“认证 Secret 已自动回滚”。

## 5. 尚未完成的真实验收

代码和离线自动化不能替代以下外部证据：

1. 阿里云资质、当前有效签名/模板、RAM 最小权限和生产网络上的小流量真实发送/验证。
2. 中国移动、联通、电信真机上的正确、错误、过期、限流、超时、重放和并发验证。
3. SMTP 真实投递、垃圾箱、退信与发信域 SPF/DKIM/DMARC 验收。
4. PostgreSQL 0011 迁移、运行时角色权限、并发 lease、回滚和账号清除链路的生产演练；
   必须覆盖停号 `legacy_phone_drain` bridge、迁移前备份、角色 ACL smoke、最终候选失败
   回 bridge，以及“回旧 Fusion 必须恢复迁移前数据库”的边界。

以上门槛关闭前，准确状态是“PHONE_ONLY 工程改造与离线门禁完成后可进入封闭 Alpha 验收”，
不是“真实短信、邮箱或公开发布已经通过”。
