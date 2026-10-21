# EatWhat 微信小程序

2026-10-17 在微信开发者工具中以 **JS 基础模板 / 不使用云服务** 新建的原生小程序。独立目录为 `apps/wechat`；未读取或复用历史 `apps/miniprogram` 实现。

当前本地候选为 `0.1.18-alpha`：首次打开先选择喜欢与避开的餐厅类型、预算、辣度及决定时的取舍；每次回答后更新就绪判定，只有偏好完整、能实际区分当前可行选择或由明确条件筛出唯一选择，并完成本机保存确认，才进入决策首页。资料不足、无法区分或没有可行选择时继续停留问题页，重新编辑也立即关闭决策入口，直到再次确认。

首页顶部导航标题按固定北京时间（UTC+8）显示：00:00–10:59「今天早上吃什么」、11:00–16:59「今天中午吃什么」、17:00–23:59「今天晚上吃什么」。进入页面时立即刷新，停留期间每分钟重算，隐藏或退出后停止计时。正文保留「帮你决定这一餐」，位置入口为「虚拟地图」，浅色页面背景为纯白。

首页决策按钮在原处打开推荐底部面板，保留首页上下文；结果、价格和虚拟距离优先展示，依据按需展开，主要未知项直接可见。确认成功后显示已选定状态；关闭、离开页面或偏好失效会停用旧卡片事件。偏好最终确认页集中展示摘要与真实就绪说明，勾选反馈只反映实际选择和就绪状态。

决定仍使用 R9A 复核后的 363 家虚拟餐厅、1092 份套餐，默认套餐模式；主流程不联网、不读取真实位置、不要求登录，账号服务保留。沿用纯白首页、紧接主标题且靠左的地点入口与线条箭头。这里的个性化是用户明确声明驱动的规则排序，不表示已训练个人模型或已认证真实满意度。研究接入、数学适配范围、数据来源与检查方法见 [虚拟决定说明](./DECISION_RESEARCH.md)。

## 打开工程

微信开发者工具打开本目录。当前工作区可通过 `C:\Users\color\.codex\worktrees\4477\eatwhat\apps\wechat` 访问。
`eatwhat` 是指向本工作区 `吃什么` 目录的 Windows junction：物理改名因目录被占用失败，主仓库和其他工作区没有移动。

- 基础库固定 `3.17.4`，原生 JS / WXML / WXSS；精确分数使用原样纳入、固定哈希的 JSBI 4.3.2，无运行时 npm 安装步骤。
- 现有在线账号等功能的 API 固定为自有阿里云服务 `https://api.eatwhat.pro`，保留合法域名校验。虚拟推荐不调用该 API。
- 微信后台须将该 HTTPS 域名配置为 request 合法域名；定位须完成平台相应接口与隐私声明配置。
- `project.private.config.json` 仅本地保存，不提交。
- `0.1.12-alpha` 已上传并设为体验版，用户已在真机打开；发现服务器域名漏配后已补充 request 合法域名。当前候选的上传状态和真实登录验证见[连接排查记录](./DECISION_RESEARCH.md#2026-10-19-体验版账号连接排查)。后端发布进度与验证证据见 [PR #23](https://github.com/zxcolor/eatwhat/pull/23)。

## 开发与验证

```powershell
node apps/wechat/scripts/check.cjs
node --test apps/wechat/tests/*.test.cjs
pnpm exec biome lint apps/wechat/lib apps/wechat/pages apps/wechat/app.js apps/wechat/tests apps/wechat/scripts
```

`check` / `build` 检查 JS 语法、JSON、页面及本地组件文件与配置、虚拟目录生成物和第三方数值库完整性；不能替代微信开发者工具编译或真机验收。`0.1.16-alpha` 最终小程序 390 项测试通过；微信开发者工具隔离副本已验证首启、逐题检查、五条直达路径拦截、确认进入首页、实际个性化结果、再次进入与编辑门禁及深色显示。`0.1.16-alpha` 和 `0.1.17-alpha` 均已通过官方 CLI 上传，设为体验版与真机验收尚未确认；当前 `0.1.18-alpha` 尚未上传。完整命令、源码一致性与历史失败见 [本次验证记录](./DECISION_RESEARCH.md#2026-10-20-首启偏好验证)。

2026-10-19 历史验证：当时修改的 `pnpm.cmd lint`、`typecheck`、`test`、`build` 均通过；全仓 1648 项测试通过（其中微信 304 项），13 项专用 PostgreSQL 测试默认跳过。新增 23 项真实模块生命周期集成测试，覆盖附近与反馈页的入口、后台和晚到回调。官方 CLI 预览包为 1,390,867 字节；预览成功不等于开发版本已上传或已上线。命令、依赖门禁与未完成项见 [本地验证记录](./DECISION_RESEARCH.md#2026-10-19-本地验证记录)。

2026-10-17 本地验证记录：

| 命令或检查 | 结果 |
| --- | --- |
| `node apps/wechat/scripts/check.cjs` | 12 页语法与配置通过 |
| `node --test apps/wechat/tests/*.test.cjs` | 181 项通过，合成数据 |
| `pnpm --filter @chi-shen-me/contracts test` | 106 项通过，含 OpenAPI 路由与 schema 对照 |
| `pnpm --filter @chi-shen-me/contracts typecheck` | 通过 |
| `pnpm --filter @chi-shen-me/api test` | 1012 项通过；13 项需专用 PostgreSQL 环境的测试默认跳过；编译与本机临时端口冒烟通过 |
| 小程序专用 PostgreSQL 验证 | 新建临时本机数据库中迁移 1–14，10 项账号、重放、撤销和 ACL 测试通过；与上一行默认跳过项分开计数 |
| `pnpm lint`、`git diff --check` | 通过 |
| `scripts/start-api-local.ps1 -EnvFile .env.local.example -ValidateOnly` | 通过；另实跑 `verify.ps1` 中子进程密钥隔离检查块 |

完整 `scripts/verify.ps1 -AlphaApiBaseUrl 'https://api.eatwhat.pro/'` 已在当前进程注入受控 Alpha 微信/QQ 公开 AppID 后通过，涵盖 Node 检查、部署包门禁、Android Debug / Fixture / Alpha 构建与 APK 完整性检查。分支与 PR 的 GitHub CI 也已通过；每次新提交仍须重新检查当前 HEAD，具体提交和运行链接记录在 PR 中。数据库部署演练、真实微信登录与真机定位分别验收，不能由这些本地测试替代。

## 微信登录与多端账号

微信登录采用用户点击后的 `wx.login`，临时 code 以 JSON POST 传给 `/v1/auth/wechat-miniprogram/login`。
服务器以固定小程序 AppID / AppSecret 调用 `code2Session`，按既有开放平台 realm 的 UnionID HMAC 找到同一个吃什么账号，再签发 `MINIPROGRAM` 会话。

新通道由独立 `authCapabilities.wechatMiniProgramEnabled` 控制；旧服务缺少该字段时关闭入口。
Android 原生 OAuth 接口保留原语义，不能接收小程序 code；小程序没有 QQ 登录入口。
小程序与安卓必须绑定到同一微信开放平台账号。UnionID 缺失、未关联、原绑定撤销或账号非活动时不建立会话，也不自动创建第二个账号。

服务端专属配置：`WECHAT_MINIPROGRAM_AUTH_ENABLED`、`WECHAT_MINIPROGRAM_APP_ID`、`WECHAT_MINIPROGRAM_APP_SECRET`、`WECHAT_MINIPROGRAM_AUTH_TIMEOUT_MS`；复用 `WECHAT_OPEN_PLATFORM_REALM_ID`。启用前需 schema 0014 与最小权限验收。密钥不得进入小程序目录或聊天记录。

已有数据库升级和通道启用顺序见 [schema 0014 上线门禁](../../docs/wechat-miniprogram-cutover.md)。

## 当前范围

参见 [安卓功能对照](./PARITY.md)。主要页面和账号/记录流程已移植；尚不宣称完成安卓全部功能或生产验收。小程序首次微信绑定、导出到本地文件及平台实际权限/身份/动作验收仍未完成。账号令牌只驻留内存，退出小程序后需要重新登录。

隐私说明版本为 v2：虚拟决定与交互事件只驻留内存。用户主动开始偏好选择后，明确声明保存在本机；已确认偏好自确认起保留 90 天，未完成草稿自最后修改起保留 7 天，过期后重新选择。偏好不上传账号、不写入训练目录，不包含身份、真实坐标或配料推断；设置中可以修改或清除。旧版本机决策摘要与独立选择的附近缓存仍有各自保留期。撤回先停止请求，再清除虚拟决定、偏好、账号状态、本机摘要及附近缓存；存储失败明确提示，并可从设置重试。
