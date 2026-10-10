# 登录与注册原生界面证据

设备：独立 `ChiShenMe_Home_UI_Test` 模拟器，Android API 36，1080 × 2400，420 dpi。六张页面截图由 `AccountAuthLandingTest` 使用合成状态驱动；三张键盘截图来自 `MainActivityAuthLocalFixtureTest` 的真实输入流程，在填写合成值前采集。不包含真实账号、验证码或授权凭据。截图由 Android instrumentation 导出，未进行图像修饰。

| 文件 | 状态 |
| --- | --- |
| [auth-login-phone.png](auth-login-phone.png) | 手机号登录，隐私未勾选，表单未填写 |
| [auth-login-email.png](auth-login-email.png) | 邮箱登录，与手机号页相同的布局基线；右下角为电话图标 |
| [auth-register-phone.png](auth-register-phone.png) | 注册第一步，底部隐私勾选 |
| [auth-register-wechat.png](auth-register-wechat.png) | 注册第二步，固定纯绿色微信图标，无“已有账号？ 登录” |
| [auth-register-success.png](auth-register-success.png) | 合成的已确认微信绑定状态，三步完成 |
| [auth-dark-large-text.png](auth-dark-large-text.png) | 深色主题，在 Compose 中注入 1.6 倍字体缩放，验证滚动布局和系统栏对比度 |
| [account-phone-keyboard.png](account-phone-keyboard.png) | 手机登录的空输入框与真实数字键盘 |
| [account-email-keyboard.png](account-email-keyboard.png) | 退出后切换邮箱，真实邮箱键盘下输入框保持可见；取码和再次登录通过 |
| [account-email-bind-keyboard.png](account-email-bind-keyboard.png) | 原有账号安全页的邮箱绑定回归；仅包含合成的脱敏身份 |

截图中的主按钮及验证码操作按当前表单状态呈现禁用色；填写并满足隐私及服务能力条件后才可操作。无真实供应商调用，不能以这些截图替代短信、邮件或第三方客户端的真机验收。
