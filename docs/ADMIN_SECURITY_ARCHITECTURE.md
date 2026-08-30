# 管理后台安全架构

## 1. 本轮边界

`0003_admin_security.sql` 提供管理后台的数据库安全底座；
`0004_admin_api_primitives.sql` 补齐管理员 API 所需的脱敏审计读取和当前管理员
passkey 自助管理原语；`0013_admin_config_control.sql` 在既有配置版本表上增加受控的
发布、历史和回滚原语。管理员 NestJS 由独立 `admin-main` 入口、`AdminAppModule`、
监听端口和容器运行，只在 `/admin/v1/*` 暴露登录、当前会话、自助凭据、脱敏审计和
受控配置端点。
公开 `AppModule` 不导入 `AdminModule`，公开 API 进程会拒绝 `ADMIN_API_ENABLED=true`
或任何管理员数据库/加密 Secret，因而普通推荐、账号服务的进程被攻陷时不会直接取得
管理员密钥或连接池。`ADMIN_API_ENABLED` 默认仍为 `false`。完成真实 PostgreSQL CI、
离线 bootstrap、独立 Secret/网络策略和部署演练前不得对外启用。系统没有公网管理员注册、
密码、TOTP 或“首个访问者成为管理员”的入口。

管理员只使用 WebAuthn/passkey。普通用户 API 的 `api_runtime`、保留任务的
`retention_worker` 与管理员服务的 `admin_api_runtime` 必须是四个互不继承、
互不相同的数据库角色（另一个角色是 `schema_migrator`）。

## 2. 数据最小化

- 登录名、challenge、会话 token、IP、设备标识、credential ID、RP ID 和
  origin 均不以明文保存。
- 可查询或比较的值使用带版本号、按用途分离密钥的 HMAC-SHA256。
- WebAuthn credential ID 只保留 HMAC 和 AES-256-GCM 认证密文；生产密钥必须由
  KMS 托管的 Secret 注入，不能进入数据库、仓库、镜像、日志或客户端。进程只复制
  最多三版 32 字节密钥并独占持有，启动传输 Buffer 和关闭时的内存密钥会显式清零；
  解密明文 Buffer 与临时 AAD 使用后也会清零。
- 自助管理页面只使用每枚凭据独立生成的 32 字节随机 base64url handle。该 handle
  不是凭据表 UUID、credential ID 或两者的哈希；每次列表和撤销仍按当前已认证
  管理员做 self-scope 校验，不能作为授权凭据。
- 数据库不保存 user-agent。公钥不是秘密，但仍只通过受控凭据查询函数返回。
- 所有时间判断使用数据库时钟。外部调用者不能向权限判断或会话撤销 primitive
  传入历史时间来复活过期角色。

密钥用途至少分为：管理员登录查询、challenge、credential 查询、credential
加密、会话 token、IP/设备绑定。轮换时服务端只允许显式配置的当前及最多两版过渡
密钥；登录 challenge 在数据库内以固定最多三组候选 HMAC 做枚举安全双读，找到后只
封存数据库已有的规范 hash/version，未知账号固定使用首组当前版本。credential 与
session 查询同样逐版本校验。旧版密钥只有在登录哈希受控重键、credential 密文重包裹
且活跃 session 过渡完成后才能退役，日志不得记录任何密钥或原始输入。

## 3. WebAuthn 验证器与数据库的分工

管理员 API 固定使用官方 `@simplewebauthn/server@13.3.2`，不自行解析 CBOR 或实现
签名算法。验证器必须在调用完成函数前完成全部密码学验证：

1. 只在内存中处理随机原始 challenge，并以 HMAC 查询数据库记录。
2. 校验 ceremony type、clientData challenge、精确 HTTPS origin、RP ID/hash、
   authenticatorData、签名和 credential 公钥。
3. 强制 `userVerification=required`，不把仅完成 user-presence 当成成功。
4. 登录只接受 discoverable/resident credential，options 的 `allowCredentials` 固定
   为空，使已知和未知登录名的响应形状及凭据数量不可区分；challenge 仍在数据库中
   绑定规范化登录 HMAC、IP HMAC 和设备 HMAC。不得把客户端提交的公钥、origin 或
   RP ID 当成可信事实。
5. 只有上述验证全部成功后，才把经过验证的 origin/RP HMAC、UV 结果和新
   `signCount` 交给原子完成函数。

数据库以 `SELECT ... FOR UPDATE` 锁住一次性 challenge，并在同一事务内消费
challenge、更新 credential counter、创建会话和写审计。challenge 五分钟失效、
最多五次失败；登录按登录 HMAC、IP HMAC、设备 HMAC 串行计数，注册按管理员串行
计数。重复消费只能得到 `INVALID_PROOF`。

如果支持 counter 的凭据出现 `signCount` 不前进或回退，数据库原子地：消费
challenge、撤销凭据、锁定管理员、撤销其全部会话并写入审计。该状态不能由客户端
自行降级为普通登录失败；恢复必须经过离线安全流程。

## 4. 管理员会话

- 客户端只持有高熵 opaque token；数据库只保存带版本 HMAC。
- 登录 verify 只返回一次 32 字节 opaque token；Next BFF 必须立即放入
  `Secure; HttpOnly; SameSite=Strict` cookie，浏览器脚本不得持有 token。
- 空闲超时固定 15 分钟，绝对生命周期固定 8 小时。
- 每次鉴权都重新检查管理员状态、角色状态、角色开始时间与过期时间，并返回当前
  权限码；角色或账号变化会撤销已有会话。
- 会话绑定设备 HMAC，记录最后一次 IP HMAC用于风险判断，不记录原始 IP。
- 注销、过期、无有效角色、角色变化、凭据撤销、账号状态变化和 counter rollback
  都是单向撤销；不存在把 `revoked_at` 清空的运行时函数。

## 5. RBAC 与最小权限

固定角色及权限如下：

| 角色 | 主要权限 |
|---|---|
| `AUDITOR` | 审计只读、脱敏运营只读、自助管理 passkey |
| `OPERATOR` | 运营只读、反馈处理、门店纠错、自助管理 passkey |
| `ALGORITHM_ADMIN` | 算法配置读写、运营只读、自助管理 passkey |
| `SECURITY_ADMIN` | 审计读取、管理员安全读写、自助管理 passkey |

角色授权的过期时间在每次请求中实时生效。`SECURITY_ADMIN` 授权不得设置过期时间，
撤销角色或锁定账号时必须保留至少一名有效的安全管理员。运行角色没有任何管理员
基表 DML，只能执行白名单 `SECURITY DEFINER` 函数；这些函数全部固定
`search_path = pg_catalog, public`。通用审计写入、内部权限判断、批量会话撤销、
bootstrap 和保留清理不会授权给 `admin_api_runtime`。

管理员自助 passkey 列表只返回 opaque handle、创建时间和最后使用时间。注册选项
所需的 credential ID 密文与密钥版本只通过内部函数返回给服务端，且函数同时校验
当前会话、`ENROLL` challenge、发起 session、IP HMAC、设备 HMAC、绑定密钥版本、
五分钟有效期和一次性状态；没有至少一枚 active passkey 时不返回注册选项。撤销只
接受 opaque handle，取得管理员行锁以串行化并发撤销，拒绝撤销最后一枚 active
passkey；成功后撤销该管理员全部会话。旧的内部 UUID 撤销函数不再授权给
`admin_api_runtime`。

新增或撤销 passkey 还要求当前 session 本身是在数据库当前时间五分钟内由 passkey
登录签发；更旧的会话即使仍在 15 分钟 idle/8 小时 absolute 生命周期内，也必须先
重新登录。该近期再认证门禁把长期 bearer 泄漏升级为持久凭据接管的窗口压缩到五分钟；
但它**不等价于**由一枚既有 active passkey 完成的独立 step-up assertion：五分钟内被窃取
的 bearer 与设备绑定材料仍可能被用于注册攻击者凭据。生产开放自助新增/撤销前，必须
补齐与当前管理员、当前 session、IP/设备、一次性 challenge 和既有 credential 绑定的
WebAuthn step-up ceremony，并由数据库原子消费；当前近期登录检查只能作为临时缓解，
不得在验收报告中宣称完整 step-up 已完成。

注册完成函数仍使用服务端本次生成的内部 credential UUID 完成原子写入；紧接着服务端
可用同一已认证 session 调用精确查询函数，把该 UUID 映射为 active 凭据的 opaque
handle 和时间字段。UUID 只存在于 repository 调用参数中，精确查询不返回 UUID、
credential HMAC、密文或公钥；其他管理员的 UUID 和已撤销凭据都返回空结果。

## 6. 固定形状审计

管理员登录失败/成功、会话撤销、counter rollback、凭据注册/撤销、角色变化、
账号状态变化和首次 bootstrap 均进入现有 append-only 审计表。运行时函数只能调用
管理员专用审计包装器；包装器只接受白名单 action/target 组合，context 固定为空
对象，不能写入任意 JSON、登录名、IP、UA、坐标或 token。目标只使用版本化 HMAC。

审计日志沿用 180 天策略且禁止 UPDATE/TRUNCATE。challenge 保留 24 小时；管理员
会话在绝对过期后再保留 30 天。清理只能由 `retention_worker` 调用预览/执行函数，
先清理 challenge，再清理被其外键引用的 session。

`AUDIT_READ` 读取函数在同一次数据库调用中先执行实时 session/RBAC 鉴权，再按
`(created_at, event_id)` 倒序 keyset 分页，单页限制为 1–100 条。对外固定只返回
`event_id`、`action`、`target_type`、`created_at`；actor hash、target hash、
hash key version 和 `context_json` 永不进入结果集。运行角色仍无审计基表 SELECT。

## 7. 首名管理员离线 bootstrap

公开服务启动管理员路由前，由两名授权人员在受控维护窗口完成：

1. 确认数据库中没有 `admin_users`；`0003` 对任何旧管理员数据直接迁移失败，必须先
   人工审查并制定重新注册方案，不能静默迁移旧凭据。
2. 在隔离工作站和仅回环/SSH 隧道可达的临时 WebAuthn verifier 中生成随机
   challenge，使用生产 RP ID/origin 完成 `UV required` 的 passkey 注册。
3. verifier 在内存中验证 attestation/registration 响应，用 KMS 生成各用途 HMAC，
   对 credential ID 做认证加密；原始 challenge、登录名和 credential ID 随进程退出
   清除。
4. 以 `schema_migrator` 从受控终端调用
   `admin_bootstrap_first_security_admin(...)`。函数取得事务级 advisory lock，仅在
   管理员表为空时一次性写入首名 `SECURITY_ADMIN`、首枚 passkey 和审计。
5. 再次调用必须失败。成功后立即撤销维护网络入口，核对审计，并在首名管理员登录后
   注册第二枚独立硬件/passkey 作为恢复凭据。

仓库只能保存操作说明和参数格式，禁止保存登录名、raw credential、challenge、
私钥、KMS 数据密钥、生产 HMAC 或管理员数据库密码。不得提供公网 bootstrap 或
“首个访问者成为管理员”的逻辑。

## 8. 发布门禁

- 在空库真实 PostgreSQL/PostGIS 上依次执行固定的 0001–0013 完整迁移链，并重复运行
  迁移器验证 exact head、checksum/idempotency。
- 以真实五角色运行 `role-grants.sql`，验证角色互异、无 MEMBER/USAGE 继承、无高权
  属性、admin runtime 无基表权限、普通 runtime 无管理员函数权限。
- 覆盖 challenge 重放、五分钟过期、最大尝试次数、注册选项跨 session/IP/device
  拒绝、opaque handle 跨管理员拒绝、最后 passkey 不可撤销、脱敏审计 RBAC、过期
  角色、signCount rollback、会话 idle/absolute expiry、bootstrap 二次执行和保留清理。
- `admin_api_runtime` 使用独立 Secret/连接池和独立网络策略。API 镜像提供默认公开
  `runtime` 与显式 `admin-runtime` 两个 target；管理员 Compose profile 只把 `ADMIN_*`
  Secret 注入 `admin-api` 容器，普通 `api` 容器显式关闭管理员能力且不接收这些 Secret。
  `admin-api` 不加入普通 API 网络，只与同源 Next BFF 共享私有网络；浏览器和普通 API
  不能直连。公开环境要求 TLS 校验、KMS 可用、固定 RP ID/origin 和管理员路由默认关闭。
- 管理员进程生产启动必须显式配置私有 `ADMIN_BIND_HOST` 和非通配
  `ADMIN_TRUSTED_PROXY_CIDRS`，且列表只能包含同源 Next BFF 的源地址。BFF 必须忽略
  浏览器 `X-Forwarded-For`，只接收由受信 ingress 覆盖的专用客户端 IP 头，在共享 edge
  限流生效后再向管理员 API 写入单一规范 `X-Forwarded-For`。缺少这些条件必须 503，
  不能退化为所有用户共享 BFF socket IP 的进程内全局桶。
- 所有管理员端点使用独立限流；内存桶仅保存用途分离的 IP HMAC，不保存原始 IP。
  JSON 请求体上限为 100 KiB，响应禁止缓存并携带 CSP、frame、referrer、CORP 与
  permissions-policy 安全头；API 不启用 CORS，生产只允许同源 Next BFF 服务端访问。
- 本地没有 PostgreSQL 服务时，只能报告静态/Node 测试结果；真实 PostgreSQL CI
  与部署前 RDS 演练仍是强制发布门禁。
- 自助凭据新增/撤销的完整既有 passkey step-up assertion 是生产发布门禁；当前五分钟
  近期登录检查不是替代品。

## 9. 受控配置中心

配置中心只管理下列五个已建模、非 Secret 的键。键、JSON schema 和分类必须逐项
匹配，不能由请求自报 schema/classification，也不能借“自定义配置”扩展为任意 JSON：

| `configKey` | 固定 schema | 分类 | 用途 |
|---|---|---|---|
| `features.ai-assistance` | `FEATURE_FLAGS_V1` | `PUBLIC` | 仅含全局 AI 辅助功能 `enabled` 开关 |
| `recommendations.rules` | `RECOMMENDATION_RULES_V1` | `INTERNAL` | 固定六项推荐权重与运营调整上限；仅 `LICENSED_ENRICHMENT` 应用 |
| `recommendations.prompt` | `PROMPT_SETTINGS_V1` | `INTERNAL` | 只能选择当前服务端构建注册的提示词/模型版本，另含超时和启用状态，不含模型 Key |
| `coverage.default` | `COVERAGE_SETTINGS_V1` | `PUBLIC` | 客户端建议半径、服务端最大半径和固定 `NATIONWIDE`，不含用户坐标 |
| `clients.minimum-version` | `MINIMUM_APP_VERSION_V1` | `PUBLIC` | Android、iOS、小程序最低兼容版本 |

高德、千问、短信、SMTP、微信、QQ、数据库、管理员加密材料、HMAC/pepper、token、
证书和任何其他 Secret 永远不进入 `app_config_versions`、HTTP 请求/响应、历史记录或
审计 context；它们仍由 ECS/KMS 的独立 Secret 注入和启动门禁管理。

- `GET /admin/v1/configuration` 和
  `GET /admin/v1/configuration/{configKey}/history` 同时要求 HTTP guard 与数据库函数
  当次重新认证后的 `ALGORITHM_CONFIG_READ`。响应只包含固定键、schema、分类、版本、
  已校验 JSON、变更原因和创建/激活时间，不返回管理员 UUID、基表 ID 或 Secret。
- `PUT /admin/v1/configuration/{configKey}` 和
  `POST /admin/v1/configuration/{configKey}/rollback` 同时要求
  `ALGORITHM_CONFIG_WRITE`。发布原因只接受 `ROUTINE_TUNING`、
  `INCIDENT_RESPONSE` 或 `RELEASE_COMPATIBILITY`；回滚原因固定为 `ROLLBACK`。
- 所有写入都携带 `expectedActiveVersion`；PUT 首次发布必须为 `null`，已有活动版本时
  必须精确匹配该版本，rollback 则始终要求正整数活动版本。数据库在锁住该键后重新
  比较当前活动版本；不匹配必须返回 HTTP 409，客户端只能刷新后重新判断，不能覆盖
  后来者。发布只追加新版本并
  retire 原活动版本。回滚读取同一键的目标历史版本，复制固定 schema、分类和值，发布
  `max(version)+1` 的新活动版本；绝不把旧行重新激活或改写历史值。
- 普通 API 只可执行 `runtime_list_active_app_config()`，管理员进程只可执行四个受控
  管理函数。两者都没有 `app_config_versions` 基表权限；函数全部为
  `SECURITY DEFINER`、固定 `search_path = pg_catalog, public` 并向 `PUBLIC` 撤权。
- 配置发布/回滚审计 context 只写入固定 `configKey`、`newVersion`、
  `sourceVersion` 和枚举 `changeReason`；不写入 value、Secret 或自由文本。
  `AUDIT_READ` 的 v2 脱敏投影只对 `APP_CONFIG` 事件返回这四项，其他事件
  仍只返回原固定四字段。

配置接口中的“活动”“已发布”只描述数据库版本状态，不执行高德、千问、SMTP、OAuth
或客户端在线探测，不证明 Secret 有效、上游健康、运行进程已刷新、移动端已采用该版本，
也不等于 `/health/ready` 或生产发布验收。真实生产 RP ID/origin、首名管理员离线
bootstrap、独立 `admin_api_runtime` Secret/网络、完整 step-up、真实 PostgreSQL ACL、
备份恢复和部署演练仍未验收，因此路由和页面存在不能被表述为生产管理员启动门禁已通过。

公开 `/v1/config` 只投影运行时已经采用的脱敏值：`recommendationDefaults` 包含固定
`NATIONWIDE`、客户端建议半径与服务端最大半径。建议半径不是服务端自动默认：
每个推荐请求仍必须显式提交 `radiusMeters`。`minimumSupportedVersions` 包含 Android 及可选 iOS/
小程序最低版本。两个对象为旧响应兼容而可缺省，但当前服务必须返回；旧
`minimumSupportedVersion` 继续等于 Android 值。该投影不含版本历史、管理员、坐标、
供应商身份或 Secret，也仍不是上游健康与生产 readiness 证明。

## 10. API 接线边界

管理员服务只能从独立 `admin_api_runtime` 连接池调用以下新增原语：

- `admin_get_self_enroll_credential_options(...)`：仅供服务端解密并生成
  `excludeCredentials`，密文和密钥版本不得下发或记录。
- `admin_list_self_credentials(...)`：只形成当前管理员可见的自助列表。
- `admin_get_self_credential_record(...)`：注册成功后把本次内部 UUID 精确映射为
  active self credential 的外部记录；UUID 不得进入 controller、日志或错误。
- `admin_revoke_self_credential(...)`：只接受列表返回的 opaque handle。
- `admin_list_sanitized_audit_events_v2(...)`：普通事件只形成固定四字段审计响应，配置
  事件额外形成四项受控配置投影。
- `admin_list_active_app_config(...)`：只返回五个白名单键当前活动的固定形状记录。
- `admin_list_app_config_history(...)`：只读取一个白名单键的有界版本历史。
- `admin_publish_app_config(...)`：验证键/schema/classification/value、权限、原因和
  `expectedActiveVersion` 后原子发布新版本。
- `admin_rollback_app_config(...)`：验证写权限、目标历史版本和乐观锁后复制发布回滚版本。

每个原语内部都先调用 `admin_authenticate_session(...)`，API guard 仍必须使用该次
返回的实时权限，不能缓存角色。接线不得复制普通用户 bearer 认证、改用
`api_runtime`、直接查询管理员基表，或把内部 UUID/HMAC/密文映射进 HTTP 合同。
任何新增管理能力必须先新增固定权限码、受控函数、固定形状审计和越权反例，再开放
前端入口。

## 11. 参考实现与洁净室边界

本轮只对用户提供的 WordPress 7.1 与 Zibll V9.0 本地压缩包做离线、只读研究，压缩包
不是产品依赖，也没有被安装、执行或提交。WordPress 参考仅用于理解“固定功能注册表、
按能力显示菜单、分组表单、显式发布动作”的管理体验；本项目用 TypeScript 固定合同、
双层 RBAC、同源 BFF、乐观锁和追加式版本历史重新实现，没有引入 PHP、插件运行时或
WordPress 的配置存储方式。

Zibll 只作为视觉气质参考。实现采用暖色浅背景、克制边框与阴影、紧凑信息层级、语义
状态色和尊重 `prefers-reduced-motion` 的短动效；未复制主题的 PHP、JavaScript、CSS、
图标、图片、字体或品牌元素。压缩包中出现的混淆/动态执行代码和旧版第三方组件也未被
带入或运行。最终管理后台仍是现有 Next.js 网页、NestJS API 与 PostgreSQL 受控函数，
所有设计和安全边界都由本仓库合同与测试独立定义。
