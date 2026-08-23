# Android 1.0 手机号与邮箱登录专项审计

审计日期：2026-08-22

## 1. 范围与结论

本轮只审计手机号、邮箱验证码的共享契约、NestJS 账号服务、阿里云短信与标准 SMTP 投递适配器、PostgreSQL 状态机和 Android 消费端；没有修改微信、QQ、高德、分享或其他产品功能，也没有发送真实短信或邮件。

所有不依赖真实资质或凭据的 P0/P1/P2 工程项已经落实。公开矩阵保持为：

| 身份 | 注册 | 登录 | 绑定 | 恢复 |
|---|---:|---:|---:|---:|
| 手机号 | 允许 | 允许 | 拒绝 | 拒绝 |
| 邮箱 | 拒绝 | 允许（必须已绑定） | 允许（必须已登录） | 拒绝 |

## 2. 官方事实基线

- 阿里云 `SendSms` 明确说明接口不提供幂等能力，调用方必须自行防止重试造成重复发送；成功响应必须是 `Code=OK`，`BizId` 才是投递回执查询标识。[SendSms 官方接口](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)
- 中国内地验证码默认同签名、同号码最多 1 条/分钟、5 条/小时、10 条/天；另有跨发送方的单号码 40 条/天上限。[短信发送规则](https://help.aliyun.com/zh/sms/user-guide/message-rules)、[发送频率配置](https://help.aliyun.com/zh/sms/user-guide/configure-delivery-frequency-and-whitelist/)
- 官方防盗刷说明要求限制最小获取间隔、验证码有效期、请求 IP 和接收手机号频率。[验证码防盗刷](https://help.aliyun.com/zh/sms/user-guide/verification-code-scams-and-message-flooding-1)
- SMTP 是通用邮件传输协议；465 使用连接即 TLS，587/25 使用 STARTTLS。Nodemailer 可通过 `verify()` 检查 DNS、TCP、TLS 与认证，但是否接受具体发件地址仍需真实发送确认。[Nodemailer SMTP transport](https://nodemailer.com/smtp)
- 阿里云计算有限公司的现行隐私政策入口由阿里云官网维护。[阿里云隐私政策（最新）](https://help.aliyun.com/zh/document_detail/2705226.html)

## 3. 需求—证据矩阵

| 优先级 | 要求 | 当前权威证据 | 结果 |
|---|---|---|---|
| P0 | 用途不可混用 | `PhoneRequestCodeSchema` 只接受 REGISTER/LOGIN；`EmailRequestCodeSchema` 只接受 LOGIN/BIND；Android repository 在发网前执行同一矩阵 | 完成 |
| P0 | 验证码有效期有界 | 服务端默认 5 分钟且配置只允许 2–10 分钟；数据库仅查未过期 challenge；Android 新增最多 10 分钟加 30 秒时钟偏差的响应门禁 | 完成 |
| P0 | 一次性消费与重放拒绝 | `record_otp_verification_attempt` 在事务内只允许未消费、未过期、同用途、同目标用户/操作/设备的 proof 成功消费一次 | 完成 |
| P0 | 猜码次数有界 | 0007 迁移把受限状态迁移函数从 10 次收紧为 5 次；runtime proof 查询同步使用 `attempts < 5` | 完成 |
| P0 | 隐私撤回立即失效 | Android 发码请求现在也获取认证 attempt lease；撤回后迟到的 PHONE/EMAIL challenge 响应被拒绝，不能重新进入 UI 流程 | 完成 |
| P0 | Secret 不进 Android | Android 只有自有 API 契约；阿里云短信凭据、SMTP 密码、模板和发信地址全部在服务端 | 完成 |
| P1 | 发送限流与防盗刷 | 数据库事务内按目标、设备和 IP advisory lock 串行；目标 1 分钟复用、5 次/小时、10 次/24 小时，设备 10 次/小时、IP 30 次/小时 | 完成 |
| P1 | 准确重试时间 | durable limit 现在按所有已触发窗口中最晚释放时间返回 `Retry-After`，不再一律错误返回 60 秒 | 完成 |
| P1 | 防重复计费发送 | challenge 先持久化、并发 PENDING 被阻断、SDK 自动重试关闭；SendSms 的 `OutId` 只做关联，不伪称供应商幂等 | 完成 |
| P1 | 枚举防护 | 发码响应不查询或泄露账号是否存在；未绑定、验证码错误、过期、重放均统一映射为 `INVALID_CREDENTIALS`；供应商错误统一收敛 | 完成 |
| P1 | 标准化与最小披露 | 手机只接受 `+86` E.164 中国大陆格式；邮箱 trim 并以固定 Locale 规范化；数据库只保存版本化 HMAC、掩码和 Argon2id+pepper 验证码哈希 | 完成 |
| P1 | 邮箱登录/绑定 | 邮箱 LOGIN 只解析已有未撤销绑定；BIND 必须有效 bearer、同设备和一次性操作 proof，冲突不静默合并 | 完成 |
| P1 | 手机注册/登录 | 手机 REGISTER proof 只能进入既有的手机号+微信双验证注册事务；PHONE LOGIN 只解析已有主手机号绑定 | 完成 |
| P2 | 用户侧第三方服务披露 | 首次同意页与设置页共用同一文案，准确说明 SMS/SMTP 是自有后端调用而非 Android SDK，以及处理手机号/邮箱和验证码的目的；启用邮件前还必须补充实际 SMTP 服务商 | 完成（邮件外部信息待定） |
| P2 | 投递数据最小化 | SMS 只提交手机号、固定模板 code 变量和随机关联 ID；邮件只提交邮箱、固定标题/纯文本验证码；不开点击追踪、HTML、附件、抄送 | 完成 |

## 4. 自动化证据

- 完整 `scripts/verify.ps1` 已通过：共享契约 62 项、API 75 个文件 653 项测试全部通过，根工作区 lint、typecheck、生产构建与编译产物运行时 smoke 均通过。
- SMTP 专项覆盖启动 `verify()`、465 隐式 TLS、587/25 强制 STARTTLS、收件人精确匹配、禁用附件/URL/file 内容、供应商错误收敛，以及能力关闭时不保留或注入凭据。
- Android buildSrc、JVM、Lint、Debug/AndroidTest/Alpha 构建和 APK 完整性门禁均通过；隐私撤回后的 PHONE/EMAIL 迟到 challenge、10 分钟 TTL 上限、服务端 SMS/SMTP 处理披露和清单版本变化均有回归。
- 仓库与三份 APK 的 Secret 门禁通过：服务端 Key、SMTP 密码、私钥模式没有进入 Android 源码或 DEX；本地启动器的构建子进程不继承运行时 Secret，API 子进程只接收明确白名单字段。
- 未配置真实凭据，因此没有声称真实 SMTP 投递、阿里云短信投递或外部账号平台联调成功。

## 5. 仅剩外部资质/密钥门槛

以下事项不能由本地代码伪造，本轮不要求用户填写，也未尝试真实发送：

1. 阿里云企业实名认证、短信资质、签名与验证码模板审核、运营商实名报备。
2. 仅含 `SendSms` 所需权限的 RAM 角色或临时凭据，以及生产 IP/网络边界。
3. SMTP 专用密码/授权码、发信域名 DNS 验证、发信地址、回信策略、退信/无效地址治理，以及实际服务商隐私披露。
4. 在真实 RDS/PostgreSQL 上执行迁移 0007、角色脚本和并发/回滚测试。
5. 使用测试号码与测试邮箱的小流量真实投递、三大运营商覆盖、邮件到达/垃圾箱/4xx 重试/5xx 永久退信验收。
6. 完整隐私政策、第三方服务清单、个人信息保护影响评估和供应商合同由正式运营主体审核发布。
