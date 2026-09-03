# 数据字典与保留策略

## 核心契约

| 对象 | 用途 | 关键字段 | 敏感性与限制 |
|---|---|---|---|
| `Coordinate` | 表示单次请求起点或餐厅位置 | latitude、longitude、可选精度、`crs`（WGS84/GCJ02） | Android 系统定位和手动点为 WGS84；只在高德出站边界转换一次，混合 CRS 不得计算距离 |
| `RecommendationContext` | 描述这一顿的限制 | 单次位置、餐段、预算、时间、半径、人数、交通、主动偏好、`preferenceVector` | 精确位置是敏感个人信息，不落库、不进日志、不发 AI |
| `RecommendationPreferenceVector` | 调节既有透明软评分 | `quality`、`time`、`budget`、`mealMatch`、`diversity`，均为 0–100 整数且默认 100 | Android 只在本机保存五个数值并随单次推荐请求发送；不含位置、餐厅或跨请求标识，不改变硬过滤。仅 `LICENSED_ENRICHMENT` 可用于软评分；`LIVE_DISPLAY_ONLY` 不据此重排且 `fitScore=null` |
| `IntentProfile` | 把场景转成餐饮方向 | 菜系权重、餐饮类型、速度、多样性 | 只含派生/主动输入；Schema 失败立即回退 |
| `RecommendationResult` | 展示主推荐和备选 | 数据源代码、请求作用域 `resultToken`、来源评分、可选适合度、时间/距离、原因、警告、置信度 | 事实只能来自合法数据源；缺失时明确未知；公开响应和客户端均不知道稳定地点 ID |
| `RecommendationEvent` | 计算推荐漏斗 | `requestId`、`resultToken`、事件类型、时间 | 严格对象；令牌仅在原推荐请求内使用并由服务端最多保留两小时，不接受来源、稳定地点 ID、坐标、手机号或任意扩展字段 |
| `FeatureConfig` | 客户端安全开关 | 数据权利模式、AI/账号/收藏开关、最低版本和算法版本 | 服务端为唯一可信来源 |
| `IdentityBinding` | 账号身份登记 | PHONE、WECHAT、QQ、EMAIL | Android 1.0 只允许 EMAIL/QQ 后续绑定；PHONE/WECHAT 是注册身份且无绑定入口；第三方授权材料仅后端验证，冲突不得静默合并 |

## 保留期限

| 数据 | 默认期限 | 删除/匿名化规则 |
|---|---:|---|
| 精确位置 | 单次请求 | 推荐完成后立即丢弃 |
| 游客随机 ID | 本地有效期 | 卸载或清除应用数据后失效 |
| 推荐偏好向量 | 本机设置有效期 | 用户可清除并恢复应用默认值；撤回隐私同意时移除，不包含位置、餐厅或稳定 POI ID |
| 推荐行为原始记录 | 90 天 | 到期删除；事件中不得包含精确位置 |
| 去标识汇总指标 | 12 个月 | 只保留无法回溯个人的统计 |
| 账号资料 | 账号存在期间 | 注销立即停用；按注销流程删除 |
| 验证码 | 短时有效 | 只保存加盐哈希和发送状态，不保存明文 |
| 安全/管理员审计 | 180 天 | 最终期限以法律审查为准 |
| 用户反馈 | 关闭后 180 天 | 删除或不可逆匿名化 |
| 数据导出文件 | 7 天 | 独立 worker 删除个人内容并以同 key 永久固定 tombstone 占位；该前缀禁止自动生命周期删除 tombstone |
| 数据库备份 | 滚动 30 天 | 注销数据在 30 天内退出可恢复备份 |

## 日志禁止字段

- 自有 URL 中的 `latitude`、`longitude`、完整地址和位置请求体。供应商若强制使用 HTTPS query，必须按架构文档执行审批、最小传输和全链路 URL 脱敏例外。
- 手机号、邮箱、微信/QQ/Apple 标识。
- Access Token、Refresh Token、验证码、Cookie、Authorization 头。
- 高德、千问、短信、社交登录 Secret。
- 未脱敏的用户自由文本。

网关、应用日志、APM、SLS 和管理员诊断必须分别做字段级脱敏；仅在应用代码中隐藏不算完成。
