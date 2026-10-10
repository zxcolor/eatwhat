# 吃什么微信小程序

根据当前 Android 单人用餐流程构建的原生 TypeScript / WXML / WXSS 客户端，共用现有 API 与手机号主账号。本目录是源码工程；构建后的 `dist/` 才是微信开发者工具加载的代码目录。

当前交付范围是**可导入工程和本地自动化验证**。没有真实小程序 AppID 的情况下，不宣称已完成微信开发者工具、真机、验证码供应商或生产环境验收。

## 无 AppID 导入

在仓库根目录执行（Node 24、pnpm 11；精确版本见根目录 `package.json`）：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @chi-shen-me/miniprogram build
```

1. 构建会生成 `dist/`，并在不存在本地配置时生成 `project.config.json`，使用 `touristappid`；已有本地 AppID 配置不会被覆盖。
2. 在微信开发者工具选择“导入项目”，目录选择本目录 `apps/miniprogram`，不要选择 `src/` 或单独选择 `dist/`。项目配置中的 `miniprogramRoot` 已指向 `dist/`。
3. 没有正式 AppID 时选择工具提供的游客/测试方式，先检查编译、页面和本地交互。此模式不能证明账号、定位等平台能力可用。
4. 修改 TypeScript、WXML 或 WXSS 后重新运行构建，再在开发者工具重新编译。构建产物只包含 CommonJS JavaScript 和页面资源，不需要在工具中构建 npm。

若使用本次交付的 ZIP，解压后直接导入包含 `project.config.json` 的文件夹即可，包内已包含 `dist/`，无需先安装 Node。继续开发请使用仓库中的源码工程。

## 与 Android 对齐的功能

| 范围 | 实现与边界 |
| --- | --- |
| 首页与推荐 | 极速/精细模式、主动场景、自动定位/手动地点、预算/时间/距离/菜系；固定单人、最多 3 个候选 |
| 专项能力 | 早餐/晚餐、奶茶/咖啡/甜品和主动体感依服务端能力声明开放；声明缺失或不完整时关闭相关能力 |
| 结果与详情 | 展示匹配、冲突及待确认事实；预计时间为软信号；导航、拨号、复制按逐项能力和结果寿命校验 |
| 账号 | 手机号注册/登录、已绑定邮箱登录与绑定；复用 Android 同一账号；查看身份、设备、撤销会话和退出 |
| 收藏与历史 | 根据服务端数据权利与账号能力开放；`LIVE_DISPLAY_ONLY` 不保存餐厅结果、不重排 |
| 数据权利 | 数据导出校验版本、长度和 SHA-256，用户再次确认后自行选择文件接收位置；注销需输入确认文字 |
| 设置与隐私 | 浅色/深色/跟随系统、许可范围内的偏好、隐私撤回、版本门禁与用户反馈 |

路由为 `consent`、`home`、`results`、`detail`、`login`、`account`、`saved`、`feedback`、`settings`、`update`。界面延续 Android 的蓝色动作、浅灰背景和深色主题。

没有多人用餐、直接餐厅关键词搜索、餐厅分享或后台定位入口。微信 OAuth 固定关闭，运行时不调用 `wx.login`；不提供 QQ 登录。账号导出文件的显式交接不开放餐厅分享。

## API、账号与隐私约束

- 客户端只接受固定公网 API `https://api.unfinished-era.com`，拒绝其他主机、私网、HTTP、路径、query、fragment 和用户信息。扩展配置不能任意换域名。
- 用户同意之前不发起配置或业务网络请求。主动定位还需微信隐私授权；撤回、切后台、旧请求回调都重新检查有效性。
- 推荐结果和精确定位只在内存保留。结果最多存活 2 小时，按服务端生成时间和本地接收时间取更早边界；定时器和回拨检测防止旧结果被延长使用。
- access token 只在内存；本地只保存轮换后的 refresh token 与到期时间。小程序存储不等同 Android Keystore，不宣称硬件加密。后台会暂停会话；若服务端已经轮换而客户端未收到结果，可能需要重新登录。
- 新客户端请求 `GET /v1/auth/sessions?includePlatforms=ALL` 查看 Android 和小程序会话；未携带该参数的旧 Android 仍只收到 `ANDROID` 会话，避免旧版响应校验失败。
- 安装标识和幂等键使用 `wx.getRandomValues`；安全随机不可用时明确失败，不降级到 `Math.random`。
- 数据导出使用 `DownloadTask.onHeadersReceived` 读取校验头，完整校验后才保存；临时文件不放入页面数据，交接结束、普通离开和撤回时清理。相关 API 签名参考[微信官方类型定义](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)。
- 本地 AppID 配置被 Git 忽略；AppSecret、QQ AppKey、高德 Key、验证码和令牌不得放入源码、构建包、日志或聊天。

## 后续真实微信环境验收

取得小程序 AppID 后，只修改已忽略的本地 `project.config.json`。在微信公众平台配置自有 API 的 request 和 downloadFile 合法域名，完成定位能力和隐私说明配置；保持 `urlCheck: true`。选择支持安全随机数、隐私授权及文件交接能力的基础库，缺失能力时本工程会提示或关闭对应操作。

逐项验收：同意前零网络、授权/拒绝定位与手动选址、推荐及失效、切后台再回来、主题、手机号/邮箱账号、跨端会话、收藏/历史能力、导出保存及取消、注销、隐私撤回、强制更新和网络失败恢复。真实验证码和账号操作由用户在设备完成，不在聊天传递。

本分支还包含必要的 API/共享契约/Android 会话兼容修改；本次没有部署服务端。导入包不等于现网已经更新，跨端链路需要后续在兼容后端联调。

## 本地检查

```powershell
pnpm --filter @chi-shen-me/miniprogram typecheck
pnpm --filter @chi-shen-me/miniprogram test
pnpm --filter @chi-shen-me/miniprogram build
```

构建检查会加载每个页面模块，核对 10 条路由的 JS/JSON/WXML/WXSS、事件处理函数、无外部运行时依赖、无测试源码入包、主包大小和同意前零网络。它不模拟微信原生运行时。

完整结果及未执行项见 [本次验证报告](../../docs/MINIPROGRAM_VERIFICATION_20260917.md)；实际视觉延伸和原生验收边界见 [小程序界面说明](../../docs/MINIPROGRAM_DESIGN.md)。
