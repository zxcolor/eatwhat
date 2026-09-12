# 单人用餐代码审查：设备证据

2026-09-12，专用 API 36 模拟器，当前 Fixture APK 与测试 APK。图片为实际截图，没有生成、修图或合成真实餐厅数据。只连接本机隔离 DEMO API，未使用真实位置或账号。

| 图片 | 条件与证明范围 |
|---|---|
| [home-light.png](home-light.png) | 1080×2400、420 dpi、正常字体、浅色；首页入口及仅保留的三个个人场景 |
| [individual-draft.png](individual-draft.png) | 实际选择咖啡与晚餐、切到后台再回前台后仍保留；截图时又选了主动暖饮食体感。未验证该体感跨前后台，因为它是在返回后才选择 |
| [home-dark-narrow.png](home-dark-narrow.png) | 720×1600、320 dpi、1.3 字体、深色；位置按钮会换行，文字未重叠，相关流程实际通过 |

浅色 7 项和深色窄屏 3 项 instrumentation 均通过，未失败或跳过；完整记录见[代码审查报告](../../SINGLE_USER_QUALITY_REVIEW_20260912.md)。截图不证明真实推荐质量、生产配置或已发布功能。横向菜系/体感选项保持现有可滚动行为。

Fixture APK SHA-256：`A8E9F8D84910BB037689FBAB7495CB45F08758C2B798500C28E41E00AD51584C`。

FixtureTest APK SHA-256：`CA3BBAFACDBC39D81AC11325AF194BF1CE3D74675E10D94E5AAB815E320F7F79`。

两个 APK 均已从设备实际安装位置拉回，与上述本轮构建产物逐一匹配。APK 和本机测试工具不提交到仓库。
