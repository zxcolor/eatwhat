# 「吃什么」账号与身份接入架构

状态：Android 1.0 实施基线。本文区分已经可以在本地完成的工程能力，以及必须等待平台资质、密钥和正式环境才能启用的外部能力。

## 1. 产品规则

- 游客无需登录即可完成核心推荐。
- 新账号只能由“已验证手机号 + 已完成微信授权”共同创建。
- 已有账号可以通过手机号或微信登录。
- 邮箱和 QQ 不能创建账号，只能在登录后的现有账号中验证绑定；绑定成功后才可用于登录。
- 同一个手机号、微信、QQ 或邮箱已经属于另一账号时，必须返回冲突并由用户人工处理，禁止静默合并。
- 登录不是开启定位、AI、埋点或第三方 SDK 的隐式同意。
- 所有第三方 SDK 只能在用户完成隐私同意并主动点击对应入口后初始化。
- AppSecret、AppKey、短信和邮件服务密钥只存在于服务端密钥管理系统，不进入 Android、日志、错误响应、远程配置或仓库。

## 2. 约束分层

### 2.1 不可绕过的安全与合规约束

- 服务端是账号归属的唯一裁决方；Android 回调不能直接声明“已经登录”或“已经绑定”。
- 验证码只保存带服务端 pepper 的密码学哈希、用途、有效期、尝试次数和发送状态，不保存明文。
- OAuth 临时 code、access token、refresh token、手机号、邮箱和第三方标识不得写入普通应用日志。
- 访问令牌短期有效；刷新令牌每次使用都轮换。旧令牌再次出现时撤销整个令牌家族，并要求重新登录。
- 数据库只保存 App 自有令牌的哈希，不保存可直接使用的 App 明文令牌。
- 微信和 QQ 身份使用“平台 + 应用作用域标识”的唯一键，不能假定不同 App 的 `openid` 相同。
- 用户在 App 内可以查看登录设备、退出其他设备、解绑非主身份、导出数据和注销账号。
- 注销立即撤销所有会话；滚动备份内可恢复的个人信息按既定 30 天窗口清除。

### 2.2 可以按评测调整的实现选择

- 短信与邮件供应商可以替换，账号领域不依赖阿里云字段或错误码。
- 微信、QQ Android SDK 只负责获得平台回调材料；页面、账号状态和后端接口保持供应商中立。
- 内测期可以使用数据库事务和进程内限流；多实例公开部署前必须把验证码发送、验证和会话风控迁移到共享原子存储或数据库原子语句。
- Android 本地令牌使用 Android Keystore 生成的 AES-GCM 密钥加密；密文可存入私有偏好存储，但密钥不可导出。

## 3. 官方资料核对与采用方式

### 3.1 微信移动应用登录

微信开放平台当前说明移动应用登录基于 OAuth 2.0 `authorization_code` 模式：移动端 SDK 拉起微信，用户授权后 App 获得临时 `code`，再由拥有 AppID 与 AppSecret 的服务端换取平台凭证。登录作用域为 `snsapi_userinfo`，`state` 应用于请求/回调关联和 CSRF 防护。

工程采用：

1. 自有服务端在用户主动点击后签发绑定 installation、provider、purpose 与有效期的一次性随机 `state`；Android 只在内存中短期保存。
2. 微信 SDK 回调必须同时满足成功状态、存在 code、state 常量时间比较通过。
3. Android 只把临时 code 和已验证 state 交给「吃什么」后端。
4. 后端通过独立 `WechatIdentityProvider` 适配器调用微信官方 HTTPS 接口，核对 HTTP 状态、微信错误码、AppID 作用域和返回字段。
5. 后端提取应用作用域 `openid`，在符合 UnionID 使用条件时可保存 `unionid` 作为受限辅助冲突信号；不能用客户端提交的第三方标识决定账号归属。
6. 平台 access token 只在完成本次身份核验所需的最短生命周期内使用，不返回 Android，不作为「吃什么」会话令牌。

官方资料：

- [移动应用微信登录开发指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/WeChat_Login/Development_Guide.html)
- [微信 Android 接入指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/Android.html)
- [微信 Open SDK 开发者合规使用指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/Android.html#%E5%90%88%E8%A7%84%E6%8C%87%E5%8D%97)

文档示例中的动态依赖 `+` 不进入工程。Maven Central 元数据在 2026-08-20 核对到 `com.tencent.mm.opensdk:wechat-sdk-android:6.8.40`（元数据更新时间 2026-07-17）；接入时固定该版本并记录校验值，发布前仍要重新核对安全公告、依赖内容、依赖锁和 SBOM。

### 3.2 QQ 移动应用登录

QQ 互联官方 Android 页面要求先注册并审核移动应用，使用 AppID 初始化 SDK；登录回调包含 OpenID 与 AccessToken。官方页面同时要求在调用 SDK 前由宿主 App 确认隐私授权，并显式通知 SDK。

工程采用：

1. QQ 入口只在登录账号后用于绑定，或在账号已经绑定 QQ 时用于登录，绝不用于创建新账号。
2. QQ SDK 仅在隐私同意后、用户主动点击 QQ 登录/绑定时初始化。
3. Android 将本次 SDK 回调的短期凭证提交给后端；不将其保存到 DataStore、历史、崩溃日志或分析事件。
4. 后端 `QqIdentityProvider` 预留通过腾讯官方 `https://graph.qq.com/oauth2.0/me` 身份接口复核凭证的边界，要求响应 `client_id` 与本应用 AppID 完全一致，并以接口返回的 OpenID 为准；不能只相信 Android 回传的 JSON。正式开放前仍须以真实移动应用、真实签名和腾讯书面说明确认移动 SDK access token 的服务端校验语义，未确认时 `QQ_ENABLED=false`。
5. QQ 互联官方下载页在 2026-04-14 列出的 Android SDK 为 3.5.19，但该 SDK 以压缩包而非 Maven Central 坐标发布。正式二进制进入仓库前仍必须记录官方下载 URL、SHA-256、许可/隐私清单和 SBOM；上述核对或应用审核状态缺失时，QQ 适配器保持不可用，核心账号 API 和 UI 仍完成 fail-closed 流程。

官方资料：

- [QQ 互联移动应用接入流程](https://wiki.connect.qq.com/%E7%A7%BB%E5%8A%A8%E5%BA%94%E7%94%A8%E6%8E%A5%E5%85%A5%E6%B5%81%E7%A8%8B)
- [QQ 互联 SDK 官方下载](https://wiki.connect.qq.com/sdk%E4%B8%8B%E8%BD%BD)
- [QQ 互联 Android SDK 环境搭建与登录](https://wiki.connect.qq.com/qq%E7%99%BB%E5%BD%95)
- [QQ 互联获取用户 OpenID](https://wiki.connect.qq.com/%E8%8E%B7%E5%8F%96%E7%94%A8%E6%88%B7openid_oauth2-0)
- [QQ 互联 SDK 隐私保护声明](https://wiki.connect.qq.com/qq%E4%BA%92%E8%81%94sdk%E9%9A%90%E7%A7%81%E4%BF%9D%E6%8A%A4%E5%A3%B0%E6%98%8E)

### 3.3 手机验证码

账号领域使用 `OtpDeliveryProvider`；生产适配器使用阿里云官方
`@alicloud/dysmsapi20170525` 的 `SendSms`，领域层不依赖阿里云请求模型。
阿里云 `SendSms` 不提供幂等保证，因此「吃什么」必须先以自身 challenge
和幂等键完成原子去重，再调用计费接口；超时后不能盲目重发。

工程规则：

- 首期只接受规范化后的中国大陆 E.164 手机号。
- 发送前同时限制 IP、设备安装标识、手机号哈希和用途；目标地址执行 1 分钟复用、5 次/小时、10 次/滚动 24 小时上限，并按所有已触发窗口中最晚释放时间返回 `Retry-After`；返回统一响应，避免枚举已注册账号。
- 验证码使用密码学安全随机数生成，默认 6 位、5 分钟有效、最多 5 次尝试。
- 同一 challenge 只能成功消费一次；注册、登录和邮箱绑定的验证码不能跨用途使用。Android 1.0 不开放账号恢复 challenge。
- 发送调用使用服务端 RAM 最小权限身份；Android 没有短信 API Secret。
- `TemplateParam` 固定只序列化 `{ "code": "六位验证码" }`；不把用户资料、
  设备信息或场景标签交给短信接口。
- 只有 `SendSmsResponse.body.code === "OK"` 且存在格式受限的内部回执引用时
  才标记为供应商已接受；这不等同于运营商最终送达。
- SDK 自动重试关闭，连接和读取超时均由 `ALIYUN_SMS_TIMEOUT_MS` 控制。
- 开发和测试使用显式 `FakeOtpDeliveryProvider`，验证码只能被测试夹具读取，普通运行日志不输出。

官方资料：

- [阿里云 SendSms 接口](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)
- [阿里云短信 OpenAPI 使用说明](https://help.aliyun.com/zh/sms/developer-reference/using-openapi/)
- [阿里云短信发送规则](https://help.aliyun.com/zh/sms/user-guide/message-rules)
- [阿里云验证码防盗刷](https://help.aliyun.com/zh/sms/user-guide/verification-code-scams-and-message-flooding-1)

### 3.4 邮箱验证码

邮箱沿用同一 challenge 模型，投递适配器使用标准 SMTP 和固定版本
`nodemailer`，不与阿里云邮件产品绑定。部署方可更换 SMTP 服务商，但必须先
完成发信域名/地址验证，并按实际供应商更新隐私清单。

工程规则：

- 邮箱规范化只处理明确安全的大小写和首尾空白，不擅自改写地址本地部分。
- 邮箱验证码只用于绑定和已绑定账号登录，不能创建或恢复账号。
- 邮件只使用纯文本固定模板；不插入用户输入 HTML，不启用点击追踪。
- 当前验证码邮件只含产品名、验证码和有效分钟数；不开 HTML、附件、抄送、
  点击追踪或退订跟踪。
- 发件人显示名限制为 1–64 个单行字符，发件地址必须是单一邮箱地址；标题固定。
- 465 端口必须使用连接即 TLS；其他端口必须使用 STARTTLS。证书链校验和
  TLS 1.2 下限不能由环境变量关闭。
- SMTP 启动预检只验证 DNS、TCP、TLS 和认证；真实发件地址是否被接受仍需
  小流量发送验收。
- 投递失败不暴露供应商错误详情；手机号、邮箱、验证码、Message-ID、BizId
  和上游响应正文均不进入日志或客户端错误。供应商引用只在服务内部
  HMAC 后用于投递状态关联。
- 不启用连接池或应用层自动重试；连接、问候、DNS 和 socket 超时均由
  `SMTP_TIMEOUT_MS` 控制。文件/URL 内容读取在 transport 和 message 两层关闭。

官方资料：

- [Nodemailer SMTP transport](https://nodemailer.com/smtp)
- [Nodemailer message configuration](https://nodemailer.com/message)

## 4. 领域模型

### 4.1 用户与身份

- `User`：内部 UUID、状态、创建时间、注销时间；不以手机号或第三方 OpenID 作为主键。
- `IdentityBinding`：内部 UUID、用户 UUID、类型、平台作用域、标识的加密值/检索哈希、验证时间、是否为主身份、解绑时间。
- `OtpChallenge`：challenge UUID、目标类型、目标检索哈希、用途、验证码哈希、发送状态、到期时间、尝试次数、已消费时间。
- `OAuthState`：一次性 state 哈希、平台、用途、用户/注册流程引用、到期时间、已消费时间。
- `Session`：会话 UUID、访问令牌哈希、刷新令牌家族、当前刷新令牌哈希、设备安装标识哈希、创建/活动/到期/撤销时间。

身份类型为 `PHONE`、`WECHAT`、`EMAIL`、`QQ`；Apple 只在 iOS 路线启用，但数据库枚举和公共领域应允许未来迁移。

### 4.2 可见数据

客户端只接收：

- App 内部用户 UUID。
- 身份类型、脱敏显示值、绑定时间和是否可解绑。
- 会话 UUID、通用设备标签、当前设备标记、最近活动和到期时间。
- App 自有短期 access token 与一次性返回的 refresh token。

客户端不接收：

- 第三方 AppSecret/AppKey。
- 微信/QQ 平台 access token 或 refresh token。
- 其他账号的任何标识。
- 数据库检索哈希、pepper 版本或风控内部原因。

## 5. 核心流程

### 5.1 手机号 + 微信注册

1. 请求 `REGISTER` 手机 challenge。
2. 服务端限流、生成并发送验证码，返回 challengeId、脱敏目标、重发时间和到期时间。
3. Android 请求微信 OAuth state，并提交同一设备的 `installationId` 与第 1 步 `phoneChallengeId`。服务端读取手机号 challenge，核对设备后把该 challenge 的 `registration_flow_reference_hash` 原样写入 OAuth state；客户端不能自行生成或替换注册 flow。
4. Android 使用官方 SDK 拉起微信并获得临时 code。
5. Android 一次提交 challengeId、验证码、微信 code、state 和设备信息。
6. 服务端验证微信回调后，在消费 OAuth state 的同一原子操作中封存平台主体的 lookup/dedup HMAC 与 key version；注册事务只读取这份不可修改的 proof，再配对同 flow、同 device 的手机号 challenge，锁定两个身份唯一键。
7. 任一身份已有归属即整体失败，不创建半成品账号、不自动合并。
8. 两个身份均可用时创建 User、两个绑定和首个 Session，返回 App 自有令牌。

### 5.2 已有账号登录

- 手机/邮箱：先请求 `LOGIN` challenge，再提交 challengeId 和验证码。
- 微信：服务端签发 state，Android 获取 code，后端验证后查找已有绑定。
- QQ：Android 获得 SDK 临时材料，后端复核后查找已有绑定。
- 如果身份验证正确但不存在绑定，统一返回“该方式尚未绑定账号”，不能自动注册。

### 5.3 绑定与解绑

- 绑定要求有效登录会话，并对高风险设备要求重新验证主身份。
- 首次邮箱绑定只经已消费且绑定当前 user/device/operation 的 `BIND` challenge；QQ 绑定只经已消费且已封存平台主体 proof 的一次性 OAuth state。runtime 不拥有身份表直写权限。
- 唯一键冲突返回专用冲突码，但响应不披露另一账号信息。
- 至少保留手机号和微信两个创建必需身份；非主邮箱、QQ 可以解绑。
- 解绑撤销与该身份相关的未完成 challenge，并记录安全审计。

### 5.4 刷新与设备管理

- access token 短期有效，作为 Bearer token 使用；服务端只保存哈希。
- refresh token 只在 HTTPS 请求体传输，成功使用后立即轮换。
- refresh token 重放会撤销家族内所有会话材料。
- 退出其他设备按 session UUID 撤销，不接受客户端提交用户 UUID。
- Android 1.0 不提供账号恢复接口、入口或预留用途；后续版本如立项，必须重新完成防账号接管设计和真实环境验收，客服也不得仅凭截图或昵称改绑。

## 6. API 边界

公共契约使用供应商中立字段，计划端点包括：

- `POST /v1/auth/phone/request-code`
- `POST /v1/auth/email/request-code`
- `POST /v1/auth/oauth/state`
- `POST /v1/auth/register/phone-wechat`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/auth/identities`
- `POST /v1/auth/identities`
- `DELETE /v1/auth/identities/{bindingId}`
- `GET /v1/auth/sessions`
- `DELETE /v1/auth/sessions/{sessionId}`
- `POST /v1/account/export`
- `DELETE /v1/account`

所有 JSON 端点继续执行 100 KiB 请求上限、固定错误响应、安全响应头和 API 契约握手。验证码与登录端点使用比推荐端点更严格的分层限流；仅按 IP 的进程内限流不能作为公开多实例部署的最终防线。

## 7. Android 本地安全

- 用 Android Keystore 生成不可导出的 AES-GCM 密钥，加密 App 自有 refresh token 和必要的会话元数据。
- 每次加密使用新的随机 nonce；密文带 schema 版本和认证标签。
- 解密失败、密钥失效、备份恢复到另一设备时安全退出，不尝试绕过 Keystore。
- token 存储从 Android 自动备份和设备迁移中排除。
- access token 优先只保存在内存；进程重启时用加密 refresh token 换取。
- OkHttp 日志、崩溃报告、剪贴板、Compose state 和 saved state 禁止包含 token、验证码或 OAuth code。Android 1.0 没有分享入口；封存的分享实现即使在测试中运行，也不得接触这些认证材料，并且不能由远程配置启用。

Android 官方安全基线：

- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
- [Android 安全检查清单](https://developer.android.com/privacy-and-security/security-tips)

## 8. 功能开关与失败关闭

- `ACCOUNTS_ENABLED` 只有在数据库 schema 就绪、会话密钥就绪、至少手机号与微信适配器可用时才允许为 true。
- `PHONE_AUTH_ENABLED`、`EMAIL_AUTH_ENABLED`、`WECHAT_AUTH_ENABLED`、`QQ_AUTH_ENABLED` 分别控制真实通道；缺少所需配置时生产环境启动失败或该能力明确不可用。
- 功能配置返回 capability，不返回 AppSecret、模板 ID、签名、发信地址或供应商内部错误。
- Android 在能力关闭时展示“尚未开放”，不展示可以提交但必然失败的表单。
- 开发测试适配器只能在非生产环境通过显式开关启用，测试验证码和虚构第三方身份必须有醒目标识。

### 8.1 阿里云官方凭据与客户端启动门禁

- 阿里云只用于短信：服务端固定使用官方 TypeScript SDK 和短信 API
  `2017-05-25`；签名由 SDK 完成，不维护自研签名器。SMTP 使用独立凭据。
- 使用 `new Credential()` 的官方默认凭据链。生产 ECS 给实例绑定仅含
  `SendSms` 所需权限的 RAM 角色，通过
  `ALIBABA_CLOUD_ECS_METADATA` 指定角色名，并设置
  `ALIBABA_CLOUD_IMDSV1_DISABLED=true` 强制 IMDSv2。
- 生产必须用 `ALIYUN_CREDENTIAL_ALLOWED_PROVIDER` 把解析来源钉死为
  `default/ecs_ram_role` 或经评审的 `default/oidc_role_arn`；生产禁止
  `default/env` 长期 AccessKey，解析结果来源不一致时拒绝启动。
- 长期 AccessKey 不写入 `.env`、Compose、镜像、仓库或客户端。本地如确需
  使用，必须由部署 Secret 注入官方凭据链识别的环境变量，并使用独立的
  最小权限 RAM 用户；生产仍优先实例 RAM 角色的临时凭据。
- 手机投递通道启用时，Nest 启动阶段会在
  `ALIYUN_CREDENTIAL_TIMEOUT_MS` 内解析并验证一次凭据。凭据不存在、格式不完整
  或超时均以固定消息拒绝启动，不携带 SDK cause、凭据值、profile 路径或元数据
  正文；短信关闭时不初始化凭据链，也不会探测 ECS 元数据。
- API 客户端固定使用 HTTPS 官方端点 `dysmsapi.aliyuncs.com`。每次调用关闭
  SDK 自动重试与 keep-alive，并限制空闲连接，
  避免超时后出现不受控的二次计费请求或长期资源占用。

官方资料：

- [阿里云 TypeScript/Node.js 短信 SDK](https://help.aliyun.com/zh/sms/developer-reference/using-typescript-openapi-example)
- [阿里云 Node.js 默认凭据链](https://help.aliyun.com/zh/sdk/developer-reference/v2-manage-node-js-access-credentials)
- [ECS 实例 RAM 角色](https://help.aliyun.com/zh/ecs/user-guide/attach-an-instance-ram-role-to-an-ecs-instance)

## 9. 外部启用门禁

以下内容不能由本地代码替代，统一留到所有可实现工程完成后一次性向负责人收集：

- 微信开放平台已审核移动应用、AppID、AppSecret、Android 包名和正式签名配置。
- QQ 互联已审核移动应用、AppID/AppKey、正式 SDK 包及其校验值、包名和签名配置。
- 阿里云短信签名与模板审核、RAM 角色或最小权限凭据、发送配额和回执方案。
- 实际 SMTP 服务商、专用授权码、发信域名 DNS 验证、发信地址、退信治理和
  对应隐私披露。
- 生产数据库、token pepper/加密密钥、TLS CA、KMS/RAM 权限。
- 隐私政策、第三方 SDK 清单、个人信息保护影响评估和账号注销规则完成审核。

在这些门禁完成之前，自动化测试使用本地适配器，生产构建保持失败关闭；不得把测试验证码、虚构账号或占位密钥打进可公开 APK。
