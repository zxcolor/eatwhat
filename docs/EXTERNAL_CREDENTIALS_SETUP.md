# Android 1.0 外部平台与密钥配置手册

更新日期：2026-08-23

## 1. 先看结论

Android 1.0 当前只需要准备五类外部能力：高德 Web Service、阿里云短信、标准
SMTP 邮件、微信开放平台、QQ 互联。邮件不再依赖阿里云 DirectMail。

真实密钥不得发到聊天、写进 Android、提交 Git 或放进截图。当前工作区没有
`.env.local`、真实平台密钥或已启用的微信/QQ AppID；因此本文只能完成配置契约
和本地安全验证，不能替代平台审核、真实投递或真机登录验收。

账号总开关不是拿到一个验证码就能开启。`ACCOUNTS_ENABLED=true` 时，PostgreSQL、
手机号短信、微信登录和两套内部密钥环必须同时就绪。邮箱和 QQ 是已有账号的
可选登录/绑定方式，不能单独创建账号。

## 2. 你最终要准备的清单

| 能力 | 平台给你的内容 | 只放服务端的 Secret | 可放 Android 的公开值 |
|---|---|---|---|
| 高德 | Web 服务 Key、数字签名私钥、固定出口 IP 白名单 | Key、签名私钥 | 无 |
| 阿里云短信 | 已审核签名、验证码模板 Code、RAM 角色/临时凭据 | 临时云凭据或本地测试 AK | 无 |
| SMTP 邮件 | 主机、端口、用户名、SMTP 专用密码/授权码、发件地址 | SMTP 密码/授权码 | 无 |
| 微信 | 每个 Android 变体的 AppID/AppSecret、包名和签名登记 | AppSecret | AppID |
| QQ | 每个 Android 变体的 AppID/AppKey、包名和签名登记 | AppKey 受控保存，当前服务端暂不消费 | AppID |
| 项目内部 | 无，由项目方生成 | HMAC key ring、OTP pepper ring | 无 |

## 3. 高德 Web Service

### 3.1 平台侧

1. 在实际运营主体名下创建应用。
2. 创建“Web 服务”类型 Key，不能拿 Android SDK Key 代替。
3. 为该 Key 开启数字签名并保存匹配的私钥。
4. 给生产服务准备固定出口 IP，在高德控制台配置精确白名单。
5. 开发、预发布、生产使用不同 Key。
6. 确认技术服务和商业使用范围；当前项目继续遵守 `LIVE_DISPLAY_ONLY`，不跨请求
   缓存高德 POI，也不把 POI 内容交给模型。

官方入口：

- [创建应用和 Key](https://lbs.amap.com/api/webservice/create-project-and-key)
- [数字签名](https://lbs.amap.com/faq/webservice/webservice-api/basic-configuration/43238)
- [Key/IP 安全设置](https://lbs.amap.com/faq/quota-key/key/41181/)

### 3.2 服务端字段

```dotenv
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=<Web 服务 Key>
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=<与该 Key 匹配的数字签名私钥>
AMAP_IP_WHITELIST_CONFIGURED=true
AMAP_TIMEOUT_MS=2200
DATA_RIGHTS_MODE=LIVE_DISPLAY_ONLY
```

`AMAP_IP_WHITELIST_CONFIGURED=true` 只是部署确认，不能代替控制台真正配置白名单。
Key 和签名私钥都不能进入 APK。

### 3.3 真实小流量检查

```powershell
.\scripts\run-amap-live-smoke.ps1 `
  -EnvFile .\.env.local `
  -ConfirmLiveRequest
```

该脚本有文件开关和命令行确认两道门禁。通过后仍需检查生产出口 IP、配额、
APM/代理 query 脱敏和授权范围。

## 4. 阿里云短信

### 4.1 平台侧

1. 完成企业实名认证和短信资质。
2. 创建并审核短信签名，复制签名原文。
3. 创建并审核验证码模板，模板变量只保留 `code`，复制 `SMS_...` Code。
4. 给 API 运行身份授予实际 `SendSms` 最小权限并确认配额。
5. 生产优先使用 ECS RAM 实例角色或经评审的 OIDC 临时角色，不使用长期 AK。

官方入口：

- [TypeScript 短信 SDK 示例](https://help.aliyun.com/zh/sms/developer-reference/using-typescript-openapi-example)
- [短信身份与权限管理](https://help.aliyun.com/zh/sms/identity-management)
- [SendSms 接口](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)
- [Node.js 凭据链](https://help.aliyun.com/zh/sdk/developer-reference/v2-manage-node-js-access-credentials)

### 4.2 服务端字段

生产 ECS：

```dotenv
PHONE_AUTH_ENABLED=true
ALIYUN_SMS_SIGN_NAME=<已审核签名原文>
ALIYUN_SMS_TEMPLATE_CODE=<已审核的 SMS_... Code>
ALIYUN_SMS_TIMEOUT_MS=1500
ALIYUN_CREDENTIAL_TIMEOUT_MS=2000
ALIYUN_CREDENTIAL_ALLOWED_PROVIDER=default/ecs_ram_role
ALIBABA_CLOUD_ECS_METADATA=<RAM 实例角色名>
ALIBABA_CLOUD_IMDSV1_DISABLED=true
ALIBABA_CLOUD_ECS_IMDSV2_ENABLE=true
ALIBABA_CLOUD_ECS_METADATA_DISABLED=false
```

本机确需使用独立最小权限测试 RAM 用户时，`.env.local` 设置：

```dotenv
ALIYUN_CREDENTIAL_ALLOWED_PROVIDER=default/env
ALIBABA_CLOUD_ECS_METADATA_DISABLED=true
```

AccessKey 只由受控进程环境注入官方字段
`ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`，不要写入仓库、
命令行参数或 Android。生产配置会拒绝 `default/env`。

## 5. 标准 SMTP 邮件

### 5.1 邮箱服务商侧

1. 选择支持 SMTP 的邮箱或事务邮件服务。
2. 开启 SMTP，取得主机、端口、用户名和“SMTP 专用密码/授权码”。不要填写邮箱
   网页登录密码。
3. 验证发信域名和发件地址，并按服务商要求配置 SPF、DKIM、DMARC。
4. 明确退信、无效地址和投诉处理方式。
5. 正式启用前，把实际服务商主体和隐私政策补进 App 第三方服务清单。

Nodemailer 官方说明：SMTP 可通过替换配置切换服务商；465 使用连接即 TLS，
587/25 使用 STARTTLS；`verify()` 只检查连接、TLS 和认证，不证明指定发件地址会被
接受。[SMTP transport](https://nodemailer.com/smtp)

### 5.2 服务端字段

465 示例：

```dotenv
EMAIL_AUTH_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USERNAME=no-reply@example.com
SMTP_PASSWORD=<SMTP 专用密码或授权码>
SMTP_FROM_ADDRESS=no-reply@example.com
SMTP_FROM_NAME=吃什么
SMTP_TIMEOUT_MS=5000
```

587 或 25 必须设置 `SMTP_SECURE=false`，服务端会强制 STARTTLS；如果服务器不支持
STARTTLS，发送会失败。工程不提供关闭证书校验、降低 TLS 版本或明文发送的开关。

API 启动时会执行 SMTP `verify()`。首次真实投递仍需用受控测试邮箱检查收件箱、
垃圾箱、4xx/5xx、退信和发件人接受策略。

## 6. 微信开放平台

### 6.1 平台侧

为每个实际测试/发布变体创建或登记独立移动应用，并登记精确包名和最终 APK
签名：

| 变体 | 包名 | Android Gradle property | 服务端 |
|---|---|---|---|
| Release | `com.chishenme.app` | `CHISHENME_WECHAT_APP_ID` | `WECHAT_APP_ID` / `WECHAT_APP_SECRET` |
| Debug | `com.chishenme.app.debug` | `CHISHENME_DEBUG_WECHAT_APP_ID` | 联调时填写对应 AppID/Secret |
| Alpha | `com.chishenme.app.alpha` | `CHISHENME_ALPHA_WECHAT_APP_ID` | 联调时填写对应 AppID/Secret |

AppID 格式必须是 `wx` 加 16 位十六进制字符。服务端和当前 Android 变体必须使用
同一个平台应用。AppSecret 只放服务端 Secret/KMS。

官方入口：

- [移动应用微信登录开发指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/WeChat_Login/Development_Guide.html)
- [Android 接入与合规指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/Android.html)

### 6.2 服务端字段

```dotenv
WECHAT_AUTH_ENABLED=true
WECHAT_APP_ID=<当前变体 AppID>
WECHAT_APP_SECRET=<当前变体 AppSecret>
WECHAT_AUTH_TIMEOUT_MS=2000
```

## 7. QQ 互联

### 7.1 平台侧

同样为三个包名分别登记移动应用、实际 signer 和 AppID/AppKey：

| 变体 | Android Gradle property | 服务端 |
|---|---|---|
| Release | `CHISHENME_QQ_APP_ID` | `QQ_APP_ID` |
| Debug | `CHISHENME_DEBUG_QQ_APP_ID` | 联调时填对应 `QQ_APP_ID` |
| Alpha | `CHISHENME_ALPHA_QQ_APP_ID` | 联调时填对应 `QQ_APP_ID` |

QQ AppID 必须是 5–16 位、不以 0 开头的数字。平台发放的 AppKey 先保存在受控密钥
清单；当前代码不消费 AppKey，不能把它放进 APK，也不要自行发明环境变量。

QQ 当前还有两个发布门禁：必须由腾讯确认移动 SDK access token 通过
`/oauth2.0/me` 复核的语义，并完成真机恶意 scheme、迟到回调、进程重启、取消、
换号和 token 注入测试。在此之前保持 `QQ_AUTH_ENABLED=false`。

官方入口：

- [QQ 移动应用接入流程](https://wiki.connect.qq.com/%E7%A7%BB%E5%8A%A8%E5%BA%94%E7%94%A8%E6%8E%A5%E5%85%A5%E6%B5%81%E7%A8%8B)
- [QQ 登录](https://wiki.connect.qq.com/qq%E7%99%BB%E5%BD%95)

## 8. Android 公开 AppID 和正式签名

微信/QQ AppID 不是 Secret，可写入用户级 Gradle 属性
`%USERPROFILE%\.gradle\gradle.properties`：

```properties
CHISHENME_WECHAT_APP_ID=
CHISHENME_DEBUG_WECHAT_APP_ID=
CHISHENME_ALPHA_WECHAT_APP_ID=
CHISHENME_QQ_APP_ID=
CHISHENME_DEBUG_QQ_APP_ID=
CHISHENME_ALPHA_QQ_APP_ID=
```

Release 签名材料通过以下进程环境变量提供，keystore 和密码都不能提交仓库：

```text
CHISHENME_RELEASE_STORE_FILE
CHISHENME_RELEASE_STORE_PASSWORD
CHISHENME_RELEASE_KEY_ALIAS
CHISHENME_RELEASE_KEY_PASSWORD
```

登记平台签名前，从最终 APK 提取真实 signer，不能使用上传证书、Debug 证书或另一个
变体证书：

```powershell
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" `
  verify --verbose --print-certs <最终 APK 绝对路径>
```

## 9. 生成项目内部密钥环

这两套密钥不是任何平台发放的，必须独立随机生成；工程现在会拒绝两套 ring 复用
同一密钥材料。

```powershell
node .\scripts\generate-auth-keyrings.mjs v1
```

命令会在当前终端输出五行配置。立即复制到受控 Secret 存储或本机私有
`.env.local`，清理终端滚屏，不要发到聊天。`AUTH_IDENTITY_DEDUP_KEY_VERSION`
用于稳定身份去重，普通轮换时不能直接删除或替换；变更前必须做全量回填和冲突
审计。

## 10. 本机填写与验证顺序

1. 创建私有文件：

   ```powershell
   Copy-Item .\.env.local.example .\.env.local
   ```

2. 填写非 Secret 和本机测试 Secret。该文件已被 Git 忽略，但仍是明文，只能用于
   受控开发机；生产使用 Secret/KMS/RAM 角色。
3. 先保持所有通道开关为 `false`，逐项取得平台材料。
4. 开账号前同时准备 PostgreSQL、短信、微信和内部密钥环，再设置：

   ```dotenv
   DATABASE_ENABLED=true
   ACCOUNTS_ENABLED=true
   PHONE_AUTH_ENABLED=true
   WECHAT_AUTH_ENABLED=true
   ```

5. 邮箱和 QQ 分别通过真实验收后再单独启用。
6. 只做结构检查：

   ```powershell
   .\scripts\start-api-local.ps1 -EnvFile .\.env.local -ValidateOnly
   ```

7. 启动 API：

   ```powershell
   .\scripts\start-api-local.ps1 -EnvFile .\.env.local
   ```

   启动器先在无运行时 Secret 的最小环境中构建，再只把白名单配置注入运行进程；
   未批准的父 PowerShell 环境变量不会传给构建或 API。
8. 完整本地回归：

   ```powershell
   .\scripts\verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'
   ```

   该参数是要写入内部 Alpha 的公开 API 根地址。完整门禁会复核它是允许的公网
   HTTPS URL，并检查生成的 `BuildConfig` 与 APK DEX 确实包含同一地址；这一步
   不会替代网络访问，也不能证明 DNS 已解析、证书链有效、Nginx 已切流或公网
   `/health/ready` 可用。上述公网条件必须按下一节另行验收。

## 11. 仍然必须由真实环境完成的验收

- 高德：Key 类型、签名、错误签名、非白名单拒绝、四条调用链、配额和日志脱敏。
- 短信：RAM 权限、签名/模板归属、真实号码送达、频率限制和回执。
- SMTP：TLS/认证、发件人接受、真实送达、垃圾箱、退信和投诉处理。
- 微信/QQ：平台审核、包名、最终 signer、真机回调和攻击用例。
- API 子域：`api.unfinished-era.com` 的独立 DNS、证书、自动续期和宝塔 Nginx
  vhost；从公网分别确认 `/health` 存活、`/health/ready` 就绪和 `/v1/config`
  能力声明，再用关闭 Wi-Fi 的真实手机完成核心闭环。
- 部署恢复：无 Secret 的不可变 bundle 先校验 `SHA256SUMS` 并通过部署预检；
  数据库备份必须校验清单和 SHA-256，并在隔离数据库完成恢复演练。服务器本地
  备份不能替代 ECS 快照或异机副本，也不得直接覆盖正在运行的数据库。
- 运维：Secret/KMS 权限、崩溃转储、APM、代理与出口日志不记录 query、token 或
  邮箱/手机号。

任何真实凭据如果误入源码、聊天、截图、终端历史或 APK，必须立即在对应平台
吊销并轮换；只从文件里删除不算修复。
