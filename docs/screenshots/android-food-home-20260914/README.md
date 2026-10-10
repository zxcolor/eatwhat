# 食物主题首页设备截图

设计于 2026-09-14，设备验证于 2026-09-15。API 36 模拟器，1080×2400、420 dpi。图片直接从 Android 设备截取，没有重新生成或修图。

| 图片 | 场景 |
|---|---|
| [breakfast.png](breakfast.png) | 早餐面包按钮、白色原生文字 |
| [lunch.png](lunch.png) | 午餐蛋包饭按钮、深棕色原生文字 |
| [dinner.png](dinner.png) | 晚餐煎饺按钮、深棕色原生文字 |
| [conditions.png](conditions.png) | 条件面板及设置入口 |
| [location.png](location.png) | 位置面板；手动选址在展开后显示 |

以上五张来自本次 Debug APK 的真实 HomeScreen，读取正常公网配置，但没有发起定位、地点搜索、餐厅推荐或真实账号操作。“当前位置”为未选择地点时的按钮文字；展开面板明确显示“尚未选择地点”。食物图片为本次生成的 UI 素材，不是商家内容。

交互、推荐请求与异常流程使用同一源码构建的独立 Fixture APK，在隔离测试模拟器运行。详见[变更与验证记录](../../ANDROID_FOOD_HOME_20260914.md)。
