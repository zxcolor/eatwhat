# Android 登录与注册界面

将已确认的登录、邮箱登录、手机号验证和微信绑定效果图实现为原生 Compose 界面。使用暖白背景、深棕主按钮、柔和白色输入框和圆形图标；没有食物图片、宣传说明或“暂不登录”入口。系统状态栏与导航栏由 Android 提供，效果图中的时间和底部横条没有绘入页面。

## 页面与交互

- 手机号和邮箱登录使用同一表单布局，底部提供微信、QQ、邮箱或电话三个图标入口，不显示渠道名称；读屏仍能取得完整操作名称及不可用状态。
- 注册页面包含“验证手机号 → 绑定微信 → 注册成功”三步。微信绑定按钮为“绑定微信”，绑定页不显示“已有账号？ 登录”。注册隐私复选框位于底部安全区域上方；登录页的复选框位于底部渠道图标上方。
- 勾选隐私协议后才能获取、重发、提交验证码及主动拉起登录/绑定授权；隐私链接复用当前 Alpha 的隐私摘要，不新增虚构的政策内容。
- 验证码沿用既有倒计时、过期、脱敏目标、重发和更换账号逻辑。选择另一渠道会明确清除旧挑战。原始手机号、邮箱和验证码只保留在进程内存中。
- 正常字号下手机/邮箱页面的标题、输入框、主按钮、复选框和图标位置一致。页面支持滚动、IME 安全距离、大字体与深色主题；所有操作区域至少 48 dp。
- 短暂提示在表单之后占据真实布局空间，随页面滚动；键盘显示时也不浮动覆盖验证码、隐私勾选或渠道按钮。提示消失后不保留空白占位。

## 真实账号边界

本次是客户端界面与绑定引导改造，没有改变服务端 `PHONE_ONLY` 契约。手机号验证成功时服务端仍会创建或登录真实账号；微信步骤是该会话内的绑定引导，返回不会撤销账号或清除会话。没有新增强制“双重验证后才建号”的后端策略。

只有可信的身份列表确认已绑定微信，或本次 `bindWithWechat` 被服务端确认成功，向导才进入“注册成功”。该页表示完成当前验证与绑定流程，不断言服务端新建了账号。普通登录不会进入注册向导；进程重建也不会复活未完成的注册页面。加载失败、配置关闭、取消、超时或绑定冲突不会伪造完成状态。现有微信/QQ 配置、隐私、会话代际和迟到回调保护继续生效。

已登录的账号与安全、身份解绑、设备会话、邮箱绑定、导出、退出和注销页面继续使用原实现。

## 图标来源

微信与 QQ 外轮廓采用腾讯 TDesign Icons 的公开 MIT 矢量路径，完整来源与许可位于 `AuthProviderIcons.kt`。QQ 的白肚、眼睛、围巾、嘴和脚是为本界面补绘的细节。微信使用单一 `SolidColor(0xFF07C160)`，不含渐变、纹理或网络图片，符合本次要求的纯色展示。

## 验证记录

本轮自动化设备证据使用独立测试模拟器与合成账号数据；不据此声称真实短信、邮件、微信或 QQ 供应商已重新验收。

- 完整执行 `./scripts/verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'`，在当前进程注入受控的 Alpha 公开 AppID，退出码 0。仓库静态检查、Node lint/typecheck/构建、Android lint、Debug/Fixture/FixtureTest/Alpha 构建和 APK 完整性/密钥边界检查通过。
- Android JVM 测试 442 项通过，无失败或跳过。其中新增注册流程测试 13 项，与既有远程配置生命周期测试 15 项均通过。
- 最终提示布局调整后再次执行 `gradlew --offline testDebugUnitTest lintDebug assembleAlpha`，退出码 0，9 分 33 秒完成；前置的 `gradlew --offline assembleFixture` 同样通过。最终 Android 单元测试和 lint 均重新执行，没有借用调整前的结果。
- Node 测试：管理端 52 项、契约 91 项、API 942 项通过。本轮未启用独立 PostgreSQL 反馈集成测试开关，API 中对应的既有 3 项测试跳过；没有修改其开关或断言。
- 在 API 36 的独立模拟器运行 `AccountAuthLandingTest` 与 `HomeLandingTest`：最终 8 项通过，46.694 秒。验证手机/邮箱布局对齐、隐私勾选、注册各步骤、深色主题和 1.6 倍字体，并回归首页。初轮运行曾被冷启动后的 Android System UI 无响应弹窗遮挡；选择系统的“等待”并确认弹窗消失后，原测试未经修改重跑通过。
- 最终 `MainActivityAuthLocalFixtureTest` 通过，31.1 秒。通过设备内合成账号完成手机号登录、邮箱绑定、退出、邮箱登录及再次退出，保留 15 次请求的顺序与契约头检查、真实键盘可见性/输入框边界检查及访问/刷新凭据不得进入 UI 的断言；微信/QQ 在测试包没有 AppID 时仍拒绝发出 OAuth 请求。
- 账号夹具暴露了浮动提示覆盖底部图标，以及键盘显示后覆盖取码按钮的问题。最终采用布局内消息后，同一真实触摸流程通过；没有通过提前关闭退出提示或绕开实际点击来取得通过结果。测试另行明确等待退出完成和邮箱输入可编辑，并对每条不可用供应商提示核验精确文本、可见性及关闭操作。
- 原生截图保存在 [screenshots/android-auth-20260916](screenshots/android-auth-20260916/README.md)，均来自真实 Compose 渲染，非生成效果图。注册成功截图使用合成的已绑定状态，不代表真实微信授权记录。

设备回归命令：

```powershell
adb -s emulator-5556 reverse tcp:3001 tcp:3001
try {
  ./scripts/run-android-instrumentation.ps1 -Serial emulator-5556 `
    -ClassName com.chishenme.app.MainActivityAuthLocalFixtureTest `
    -UseDeviceLocalApiFixture -InstrumentationArguments @{ authLocalFixture = 'true' }
} finally {
  adb -s emulator-5556 reverse --remove tcp:3001
}
adb -s emulator-5556 shell am instrument -w -r `
  -e class com.chishenme.app.AccountAuthLandingTest,com.chishenme.app.HomeLandingTest `
  com.chishenme.app.debug.test/androidx.test.runner.AndroidJUnitRunner
```

该模拟器安装的是隔离 Fixture 与 Fixture AndroidTest 包；设备内账号夹具按验证脚本要求临时移除并恢复测试反向映射，不读取或重配生产 API。最终 9 项设备用例无失败、无跳过。

最终 Alpha 为 `0.1.3-alpha01-internal`（versionCode 4），继续使用既有内部签名及公网 HTTPS API。APK SHA-256：`448834ACC616A83CCAC6278C259383CD6BC32564F9F44DCD3275F13B80702303`，大小 7,125,415 字节。此次属于同版本号的界面迭代，不能仅以版本名区分新旧包。

最终 APK 已通过 `apksigner verify --print-certs` 与 `zipalign -c -P 16 4`，签名指纹匹配既有 Alpha。使用 `adb install -r` 更新日常 `ChiShenMe_API_36` 模拟器，未卸载、清数据或退出账号；从设备回读 `base.apk` 后 SHA-256 与上述最终包一致，冷启动返回 `Status: ok`。没有替换用户手机上的安装包。

上游微信 SDK 在 Alpha 压缩阶段仍有 R8 stack-map 警告；构建与现有 APK 门禁通过，本次没有修改 SDK 或压低验证门禁。
