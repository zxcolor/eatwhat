# 单人用餐与代码质量审查（2026-09-12）

本轮以主线 `a2567e3d95e2ceb3b6e815cb03c7378725b7932d` 为基线，在 `codex/single-user-quality-review` 独立工作树审查并修复。依据是当前源码、调用关系、反例和实际验证，不以先前使用的模型判断代码质量。产品永久只服务一个人的用餐决策。

## 已修复问题

| 问题与具体触发 | 最终行为 | 主要代码与验证 |
|---|---|---|
| 普通推荐可选 1–30 人，并存在同机多人流程和可重开的开关 | 删除多人页面、领域、网络、API 路由、配置和专属测试；`partySize` 仅接受 1；旧路由即使残留环境开关也返回 404 | 共享契约、OpenAPI、API e2e、Android 请求与 HTTP 策略测试；APK 检查排除退役类 |
| 多个显式菜系被选择顺序、模型附加权重或不完整输出改变含义 | 将显式选择按固定顺序规范化为等权集合；评分与解释以请求和来源分类为依据；父类川湘菜只匹配登记的父子分类 | `explicit-cuisine-preference.ts`、查询计划、规则/Qwen 提供者、引擎回归；负例含“非素食”等 |
| 显式菜系已经决定查询、匹配和解释，仍等待一次不能改变结果的模型请求 | 直接规则执行，准确标注非 AI、非失败回退；无显式选择且模型确有当前用途时保持模型路径 | `intent-coordinator.ts`；显式路径零模型调用及实际模型/规则身份测试 |
| 半径边界先四舍五入，1500.4 米可进入 1500 米范围 | 来源和坐标计算保留原始距离，过滤后才为展示取整 | 高德与 DEMO 适配器、geo、引擎和端到端提供者回归 |
| 同名且坐标接近被当作同一餐厅；首个泛化标签被当作新菜系 | 仅按供应商及权威地点 ID 去重；探索使用已登记的具体分类集合，不把未知类别算作新类别 | 去重、标签顺序、泛化标签、未知分类和探索回归 |
| 同设备切换账号后复用另一账号的邮箱绑定验证码挑战 | 复用查询同时绑定 `target_user_id`，空目标的登录流程仍正确复用 | 仓储反例测试；实际 PostgreSQL 的 A/B 账号和空目标登录验证。原有最终绑定校验仍有效，未证实越权绑定 |
| 公共/管理端限流桶在新地址高并发时可突破容量，旧清理还会重置活跃限额 | 插入前落实 20,000/5,000 桶上限，保留活跃桶，容量不足返回受控 429 和有限 Retry-After；缓存回收时间并限制扫描频率 | 两个 guard 的容量、活跃限额、过期回收、混合窗口及扫描缓存反例 |
| Qwen 的 `max_tokens` 无法限制上游实际传输体积 | Qwen 128 KiB、高德 512 KiB 实际字节上限；严格 UTF-8、超时取消、受控错误，失败取消不等待失控流 | 复用 `bounded-json-response.ts`；缺失/虚假长度、分块、多字节、畸形内容、停滞和取消测试 |
| Android 前台刷新把晚餐等主动选择改回午餐 | 刷新撤销旧请求和访问授权，同时保留内存草稿；能力撤销后提示调整，并始终提供可退出旧选择的控件 | `DecisionViewModel`、首页选项策略、配置代次和晚到响应测试 |
| 隐私同意持久化失败没有可见反馈 | 显示保存中/失败并支持重试，阻止重复提交；撤回后忽略晚到完成，不提前开放持久化隐私门 | `ConsentAcceptanceController` 及回归；原有授权协调器继续负责实际隐私状态 |
| 升级后恢复的旧导航返回栈可能引用已删除的多人页面 | 为单人图使用新的稳定保存状态作用域；同版本重建继续使用同一作用域 | AndroidX 恢复逻辑源码核查；编译及现有设备回归。旧 APK 含多人栈的实际升级恢复单列为未验收 |
| 依赖审计与构建身份存在维护缺口 | 更新 Next、Nodemailer，固定已修复的 qs/multer/sharp 传递版本；可执行推荐规则版本由构建固定为 `recommendation-rules-v3` | 全工作区依赖审计；环境版本不能伪装规则身份的测试；生产构建 |
| Windows PowerShell 5.1 处理原生 `node --eval` 参数会丢失引号 | 内联生产认证夹具经 UTF-8 stdin 传入 Node，恢复进程原输出编码 | Windows PowerShell 5.1 和 PowerShell 7 均实际执行认证夹具；完整验证继续保留隔离与签名门禁 |

## 删除、兼容保留与尚未接线

- 多人用餐的生产实现和专属用例一并退役；新增反例验证旧配置无法重新开启。没有删除其他隐私、认证、数据权限或构建安全门禁。
- `groupRecommendationsEnabled` 仅在 v1 服务端兼容信号中固定为 `false`；Android 不再建模、消费或展示该字段。`FavoriteGroup` 是个人收藏分类，保留。
- Android 无消费者的 `IntentProfile`、`SpeedPreference`、`IntentProvider` DTO 已删除。
- 服务端意图契约中的 `speedPreference`、`diversityTarget`、`explanationSeed` 当前没有执行消费者。本轮保留共享兼容契约，不把这些字段描述为已生效算法；后续可在契约迁移中统一删减。`MealPeriodResolver` 仅有定义和测试，当前采用明确的午餐默认行为，未接入自动选餐段。
- `recentPlaceIds` 和持久反馈尚未接入学习链路。当前“换一批”或重试不构成已经实现的个性化学习，不能宣称“越用越懂你”的效果已经通过验证。
- 分享代码属于既有封存能力，商户领域接口属于有边界的候选接口；没有仅凭当前不调用就批量删除。

## 其他工作树的只读复核

| 候选 | 当前发现 | 本轮处理 |
|---|---|---|
| `explicit-preference-coverage` | 具有可复用的单人显式偏好修复，也包含已取消的多人扩展 | 只纳入与本轮单人目标一致的修复；原工作树保留 |
| `regional-model-governance` | 新增 0014 会被加载，但 CI/部署仍断言 schema 13；授权历史投影无界，读取契约却限制 purpose 128 / operation 160，累计后会返回 INVALID_RESPONSE；仍有 GROUP 枚举和无消费者目录 | 未合并。直接加载候选契约验证 128 条通过、129 条仅因总量超限失败；需先补发布链及有界授权投影，再做真实数据库验收 |
| `merchant-claim-core` | 领域函数和接口已有实现，未实现真实持久化、数据库 ACL、HTTP 和对象存储；没有证实新增状态机或跨账号越权漏洞 | 保留纯核心候选，不当成商户功能已交付；其基线早于当前主线 |
| 小程序、专项 Android、UI 及协作工作树 | 含其他任务的独立成果与未提交变更 | 保留原分支、提交及差异，本轮不覆盖或宣称这些候选已合并 |

区域候选的数量问题应通过限定当前请求依赖的投影或事务前明确配额解决，不能只增加数组上限。0014 集成需要区分历史 0013 切换检查与当前发布检查，不能删除安全断言来让流水线变绿。

## 验证记录

最终生产源码完成后执行完整 `scripts/verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'`，使用 Windows PowerShell 5.1 和受控 Alpha 公开 AppID。脚本通过后逐文件核对输入 SHA-256，确认验证期间没有源码变化；此后只补审查记录和截图。

| 实际执行 | 结果 |
|---|---|
| `pnpm lint`、`pnpm typecheck` | 264 个受检源文件 lint 通过；三个工作区类型检查通过 |
| `pnpm test` | 管理端 52、共享契约 91、API 942 项通过；默认测试中的 3 项 PostgreSQL opt-in 用例在下述独立步骤实际执行 |
| `pnpm build` 与 compiled API smoke | Next 16.3.4 生产构建、API 编译，以及六条隔离 HTTP 路径通过 |
| `pnpm audit --json` | 包括开发依赖的整个工作区：critical/high/moderate/low/info 均为 0；这是本次审计时点的已知漏洞结果 |
| Android `buildSrc clean test` | 3 个 suite、11 项通过，无失败、错误或跳过 |
| Android `clean testDebugUnitTest lintDebug assembleDebug` | 84 个 suite、429 项通过，无失败、错误或跳过；lint 0 errors / 17 warnings |
| Release manifest、`assembleFixture assembleFixtureAndroidTest`、固定签名 `assembleAlpha` | 均成功；完整脚本验证 HTTPS/Fixture 分离、实际 APK/DEX 类、退役多人类缺席、Alpha 压缩与固定 signer；未签名发布的 Gradle 拒绝场景由 GitHub CI 另行执行 |
| PowerShell、Bash、密钥隔离、ECS 认证及部署包检查 | 完整脚本全部通过；生产认证内联夹具在 PowerShell 5.1 和 7 单独复核也通过 |
| 隔离 PostgreSQL 17.11 / PostGIS 3.5.3 | 真实执行 schema 1–13 并再次执行证明幂等；非超级用户迁移及角色授权；真实运行账号的 A/B 邮箱绑定挑战和空目标登录复用通过 |
| `pnpm --filter @chi-shen-me/api test:support-feedback-postgres` | 独立只用合成数据的实际数据库用例 3/3 通过，包含就绪、幂等冲突、配额、重启/关闭与清理 |
| API 36 专用模拟器，浅色正常字号 | `MainActivityDecisionFlowTest` 3 项及 SupportFeedback、ConfigUnavailable、RuntimeVersionRaise、AuthLocalFixture 各 1 项，共 7 项通过 |
| 同一模拟器，720×1600、320 dpi、深色、1.3 字体 | `MainActivityDecisionFlowTest` 3/3 通过；两个安装包均从设备拉回并与本轮构建 SHA-256 核对一致 |
| 实际界面复核 | 首页、单人条件和深色大字体截图已查看；切回前台后咖啡/晚餐仍被选中；仅使用合成/DEMO 内容，见[截图说明](screenshots/single-user-quality-20260912/README.md) |

第一次完整验证在启动器隔离夹具停止：退役群组开关后误用不在启动器允许列表的 `HISTORY_ENABLED`。已改成实际支持的 `FAVORITES_ENABLED`，保留“只进入运行进程、不进入构建进程”的同等断言，然后从头重跑通过。没有忽略该次失败。

17 条 lint 警告为 AGP 版本提示 1、屏幕尺寸 API 2、DiscouragedApi 1、依赖版本提示 9、UseKtx 4。Alpha R8 另报告既有微信 SDK 缺少 stack map 的第三方字节码警告；构建、DEX 和签名校验通过，但不能据此替代真实微信/QQ 客户端验收。本轮没有抑制这些警告或贸然更换认证 SDK。

附加的模拟器“能力关闭后切回前台”组合操作被自动审批以 `blocked by policy` 拒绝，没有给出更具体原因。该次手工检查未执行，不计入通过项；能力撤销时保留草稿、阻止失效请求和提供退出选项，已有 JVM 回归覆盖。旧 APK 含退役群组栈的实际升级恢复、真实供应商/真实账号验证、区域候选的数据库并发与 ACL 集成均未执行。

分支 push、PR 和最终 main 的确切提交与 Actions 结果记录在本次 PR 及交付说明中。只有对应当前提交的检查完成后才作为交付证据，历史绿色记录不替代本轮检查。

## 证据边界与回退

所有新增数据测试使用隔离本机数据库、合成账号及 DEMO/设备内夹具；未调用真实验证码、模型或高德服务，未读取真实账号或精确位置，未变更生产数据库和部署。构建中的 Alpha 微信/QQ 只使用受控公开 AppID，固定签名私有材料保持在原私有位置。

本轮不引入数据库迁移。代码可通过正常 revert 提交恢复；多人永久退役是用户确定的产品方向，回退时不能将多人体验重新作为默认产品能力。旧客户端普通单人请求继续兼容；多人请求返回明确错误，旧群组路由返回 404。

真实餐厅资料、实时营业/等位/座位、实际支出与行程没有因此变成确定事实。规则分值不是满意概率。未完成的区域模型、商户接入及真实效果评估继续明确标记为候选或待验证。
