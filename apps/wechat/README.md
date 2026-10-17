# EatWhat 微信小程序

2026-10-17 在微信开发者工具中以 **JS 基础模板 / 不使用云服务** 新建的原生小程序。独立目录为 `apps/wechat`；未读取或复用历史 `apps/miniprogram` 实现。

## 打开工程

微信开发者工具打开本目录。当前工作区可通过 `C:\Users\color\.codex\worktrees\4477\eatwhat\apps\wechat` 访问。
`eatwhat` 是指向本工作区 `吃什么` 目录的 Windows junction：物理改名因目录被占用失败，主仓库和其他工作区没有移动。

- 基础库固定 `3.17.4`，原生 JS / WXML / WXSS，无前端 npm 依赖。
- API 固定为自有阿里云服务 `https://api.eatwhat.pro`，保留合法域名校验。
- 微信后台须将该 HTTPS 域名配置为 request 合法域名；定位须完成平台相应接口与隐私声明配置。
- `project.private.config.json` 仅本地保存，不提交。
- 本轮未上传小程序或部署服务器；真实扫码、登录和定位另行验收。

## 开发与验证

```powershell
node apps/wechat/scripts/check.cjs
node --test apps/wechat/tests/*.test.cjs
pnpm exec biome lint apps/wechat/lib apps/wechat/pages apps/wechat/app.js apps/wechat/tests apps/wechat/scripts
```

`check` / `build` 脚本只检查 JS 语法、JSON、页面文件与配置；不能替代微信开发者工具编译或真机验收。首次实际编译的 WXML 表达式错误已修正。首页、个人、设置、本机最近决策、附近缓存未授权态与反馈关闭态已在模拟器实际查看，深色/跟随系统切换正常，调试器为 0 errors。基础库 preload、热重载与 `reportRealtimeAction` 提示仍保留，未屏蔽警告。

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

完整 `scripts/verify.ps1` 尚未运行：当前进程未提供受控 Alpha 微信/QQ 公开 AppID；没有执行 Android 构建、GitHub CI、生产迁移、真实微信登录或真机定位。本轮验证不能替代合并/上线门禁。

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

隐私说明版本为 v2：本机决策摘要与独立选择的附近缓存有明确保留期，旧版同意状态不能自动授权新行为。撤回先停止请求，再清除账号状态、本机摘要及附近缓存；存储失败明确提示，并可从设置重试。
