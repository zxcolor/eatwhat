# 高德开放平台 API 与“吃什么”项目接入说明

> 文档状态：项目接入评审稿  
> 官方资料核对日期：2026-08-22  
> 适用范围：全国范围、Android 客户端、NestJS 服务端、高德国内 Web 服务 API
> 说明：本文是产品与工程接入说明，不构成法律意见；配额、价格、协议和接口字段可能调整，上线前必须再次核对高德控制台与已签署合同。

本文中的内容分三类使用：endpoint、参数、响应格式、坐标系和业务成功码是 adapter 必须遵守的官方技术事实；商业使用、缓存、重排、外传、模型处理等以合同、书面授权和法律审查为硬门禁；接口组合、超时、排序、导航和 UI 方案是项目可评测、可替换的工程选择，不因高德文档中的示例或建议而永久锁死。供应商无关边界见[多数据源架构与接入治理](./DATA_PROVIDER_ARCHITECTURE.md)。

## 1. 结论先行

“吃什么”当前选择的主路径是合理的：Android 只把一次性位置、地点搜索词和用餐条件提交给自有 NestJS API，由服务端使用 **Web 服务类型 Key** 分别调用高德 `GET /v5/place/text` 和 `GET /v5/place/around`，再把经过校验、归一化的地点或推荐结果返回客户端。现阶段没有必要为了餐厅推荐而引入高德 Android 地图或定位 SDK。

但当前工程只能视为“已具备受控联调能力”，还不能据此公开启用高德真实数据：

1. 法人或非法人组织公开运营、上架、内部上线或以其他方式取得利益时，高德现行服务协议要求事先购买技术服务许可。Key 能创建、接口能返回成功，都不代表已经取得商业使用许可。
2. 协议默认限制存储、缓存、抓取、修改、二次包装和脱离服务使用高德内容。项目现有 `LIVE_DISPLAY_ONLY` / `LICENSED_ENRICHMENT` 双模式与此风险相匹配；在取得明确书面授权前，应继续保持 `LIVE_DISPLAY_ONLY`。但这个模式名称不是高德提供的法律“安全港”：其中现有的硬过滤、时间估算、置信度、推荐原因和 Top 3 截取也必须取得书面确认。
3. 未获得书面许可前，不应启用自有适合度、改变高德结果次序、持久化 POI ID、收藏/历史、图片缓存，也不应把 POI 名称、评分、价格、电话等内容发送给千问或其他模型。
4. 当前 `v5/place/around` 请求参数整体符合官方契约；地点搜索 adapter 也已使用 `v5/place/text`，不锁定城市、每次最多 5 条，并同时校验 `status="1"` 与 `infocode="10000"`。
5. 推荐与地点搜索的公共契约不再把来源锁成高德枚举；当前实际 adapter 仍只有 AMAP 和仅限 development/test 的 DEMO。不需要真实 Key 的签名、生产白名单硬门禁、安全错误分类、营业时间保守解析与坐标契约回归已完成；真实响应、配额和授权仍必须在获得 Key/书面许可后验证。

## 2. 项目中的高德数据流

当前实际链路如下：

```text
Android 系统前台定位（WGS84）
        |
        | POST /v1/recommendations
        | 精确坐标只在请求体中出现
        v
自有 NestJS API
        |
        | 1. 校验全国合法坐标、半径和用户约束
        | 2. 千问/规则只解析非敏感用餐意图，尚未接触 POI
        | 3. WGS84 在高德边界转换一次为 GCJ-02
        v
高德 Web 服务 API
GET https://restapi.amap.com/v5/place/around
        |
        | 临时返回 POI 基础信息和 business 字段
        v
服务端校验、半径/停业/预算/排除项过滤
        |
        | LIVE_DISPLAY_ONLY：保持供应商顺序，不生成 fitScore
        | LICENSED_ENRICHMENT：仅在授权有效时进行自有排序
        v
Android 展示 1 个主推荐 + 最多 2 个备选
```

手动地点搜索是独立链路：

```text
Android POST /v1/location-search（关键词在 JSON body）
        |
        v
自有 API 校验、独立限流和 provider 选择
        |
        | AMAP 启用时：GET https://restapi.amap.com/v5/place/text
        | development/test 默认：显著标记的 DEMO 地点
        v
最多 5 个通用地点结果（名称、地址、显式 CRS、来源说明；无稳定 POI ID）
```

对应代码位置：

| 责任 | 当前实现 |
| --- | --- |
| 高德请求与响应归一化 | `apps/api/src/recommendations/providers/amap-place.provider.ts` |
| 高德地点关键词搜索归一化 | `apps/api/src/location-search/providers/amap-location-search.provider.ts` |
| 高德附近餐厅关键词搜索归一化 | `apps/api/src/place-search/providers/amap-place-keyword-search.provider.ts` |
| 已授权保存项的实时 ID 批量重解析 | `apps/api/src/persistence/place-presentation.resolver.ts` |
| 高德数字签名与错误分类 | `apps/api/src/providers/amap-request-signature.ts`、`amap-response-status.ts` |
| 自有地点搜索端点与通用契约 | `apps/api/src/location-search/`、`packages/contracts/src/index.ts` |
| WGS84 → GCJ-02 与距离计算 | `apps/api/src/recommendations/domain/geo.ts` |
| 数据权利模式 | `apps/api/src/config/data-rights-policy.ts` |
| 硬过滤与授权后排序 | `apps/api/src/recommendations/domain/recommendation-engine.ts` |
| 服务端配置 | `apps/api/src/config/app-config.ts`、`.env.example` |
| Android 系统定位 | `apps/android/app/src/main/java/com/chishenme/app/location/AndroidForegroundLocationClient.kt` |
| Android 通用来源展示与动作门禁 | `apps/android/app/src/main/java/com/chishenme/app/feature/detail/` |

## 3. 当前核心接口：搜索 POI 2.0 周边搜索

官方文档：[搜索 POI 2.0](https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch)

### 3.1 服务地址

```http
GET https://restapi.amap.com/v5/place/around?parameters
```

项目中只有 API 服务可以构造该请求。Android 客户端不得持有 `AMAP_WEB_SERVICE_KEY`，也不得直接调用该地址。

### 3.2 项目请求参数对照

| 参数 | 官方约束 | 项目当前值 | 评审结论 |
| --- | --- | --- | --- |
| `key` | 必填，必须是 Web 服务类型 Key | `AMAP_WEB_SERVICE_KEY` | 正确；只从服务端环境变量注入 |
| `location` | 必填；`经度,纬度`；小数不超过 6 位 | WGS84 转 GCJ-02 后各保留 6 位 | 正确；必须避免二次偏移 |
| `radius` | 0–50,000 米；超范围会按默认值处理 | 客户端契约限制 200–10,000 米 | 正确；项目范围更严格 |
| `types` | POI 分类码，可用 `|` 分隔 | `050000` | 正确；限定餐饮服务大类 |
| `keywords` | 可选；仅支持 1 个关键字；最长 80 字符 | 按意图顺序取首个白名单餐类，无安全词时省略 | 正确；不得用 `|` 拼接多个词，仍以类型过滤为主 |
| `sortrule` | `distance` 或 `weight` | `distance` | 适合附近就餐；未获重排许可时保留高德次序 |
| `region` | 可选的行政区名、citycode 或 adcode | 省略 | 正确；周边搜索以请求坐标为中心，全国使用时不得锁定北京市 |
| `city_limit` | `true` 时严格限制 `region` | 省略 | 正确；未指定 `region` 时不施加单城门禁 |
| `show_fields` | 可请求 `business`、`navi`、`photos` 等扩展类 | `business` | 正确；只取当前必要字段，不取图片 |
| `page_size` | 1–25，默认 10 | `25` | 合法；每次最多取一页 25 条 |
| `page_num` | 1–100，默认 1 | `1` | 正确；当前不翻页，单次推荐只消耗一次搜索调用 |
| `output` | 搜索 2.0 当前仅支持 JSON | `json` | 正确 |
| `sig` | 可选；Key 开启数字签名后必须传 | 有签名私钥时对所有 Web Service 请求统一生成 | 生产环境已硬性要求签名；私钥不进入 URL 或客户端 |

项目当前请求的等价示意如下。禁止把真实 Key、完整 URL 或精确坐标粘贴到工单、日志和截图中。

```text
https://restapi.amap.com/v5/place/around
  ?key=<server-side-key>
  &location=<gcj02-longitude>,<gcj02-latitude>
  &radius=1500
  &types=050000
  &sortrule=distance
  &page_size=25
  &page_num=1
  &show_fields=business
  &output=json
```

### 3.3 响应字段与项目模型映射

高德多数数值字段以字符串返回，字段缺失时还可能出现与正常类型不同的空值形式。所有上游内容都必须继续按不可信输入处理。

| 高德字段 | 项目字段 | 当前处理 | 注意点 |
| --- | --- | --- | --- |
| `status` | 上游成功状态 | 必须为字符串 `"1"` | HTTP 200 不代表业务成功 |
| `infocode` | 上游状态码 | 必须为字符串 `"10000"` | 失败时应只记录安全分类，不记录 URL/Key/坐标 |
| `pois[]` | 候选集合 | 必须是数组，最多读取 25 条 | 非数组直接视为无效响应 |
| `pois[].id` | 服务端内部 `providerPlaceId` | 必须是非空字符串 | 公开响应会替换为请求作用域 `resultToken`；默认不得跨请求持久化 |
| `pois[].name` | `name` | 必须是非空字符串 | 展示时保留来源，不冒充自有数据 |
| `pois[].address` | `address` | 缺失时为空串 | 不能假定每条都存在 |
| `pois[].location` | `location` | 解析为 GCJ-02 | `经度,纬度`，不是 `纬度,经度` |
| `pois[].type` | `tags` 的一部分 | 按 `;` / `|` 拆分并去重 | 分类描述可能变化，不应用作永久枚举 |
| `pois[].business.rating` | `sourceRating` | 解析为 0–5 数值 | 仅是数据源评分，不是项目适合度 |
| `pois[].business.cost` | `averageCostYuan` | 解析为非负数值 | 缺失或陈旧时必须允许 `null` |
| `pois[].business.tel` | `phone` | 字符串或 `null` | 电话属于第三方内容，事件和日志不得复制 |
| `pois[].business.tag` | `tags` 的一部分 | 拆分、去重、截断 | 官方说明主要在美食 POI 下返回 |
| `pois[].business.opentime_today` | `openStatus` | 解释为 `OPEN/CLOSED/UNKNOWN` | 详见下方营业时间风险 |
| `pois[].distance` | `distanceMeters` 的可选参考 | 与本地球面距离取较大值 | 搜索 2.0 当前公开响应表未把它列为稳定字段，不能依赖 |

项目不请求 `photos` 是正确的。官方接口虽然能返回图片 URL，但在未确认图片展示、热链、缓存、域名和下线机制前，不应在 App 中启用。

### 3.4 营业时间的兼容风险

官方文档中的 `opentime_today` 示例既有单一时段，也出现以空格连续表达多个时段的形式。当前 `interpretAmapOpenStatus()` 已支持空格、中英文逗号/分号分隔的多时段、跨夜时段、`24:00` 边界和显式全天/休息文案；无法完整理解的输入保守返回 `UNKNOWN`。

真实 Key 可用后仍应增加北京、上海等多城市响应夹具，并持续遵守以下安全规则：

- 能明确识别“全天/24 小时”才判定 `OPEN`。
- 能明确识别“休息/歇业/关闭”才判定 `CLOSED`。
- 能完整解析当天所有时段时，才根据北京时间判断营业状态。
- 任一格式含义不明时返回 `UNKNOWN`，不能误判 `CLOSED` 或 `OPEN`。
- 离线回归已覆盖空格多时段、中文标点、跨午夜、`24:00` 边界、空/非字符串与非法时间；真实夹具还应覆盖节假日描述与上游新形态。

### 3.5 距离语义

搜索 2.0 的当前公开响应字段表没有承诺返回 `distance`，因此项目本地计算 GCJ-02 起点到 GCJ-02 POI 的球面直线距离，是必要的兼容兜底。

需要区分三种距离：

1. 当前本地 `distanceMeters`：直线近似距离，用于硬半径和粗略说明。
2. 高德搜索可能返回的距离字段：只能作为可选上游值，不能绕过本地半径。
3. 路径规划距离和时间：基于真实道路网络，适合后续替换“每分钟 80/240 米”等估算。

结果卡若仍使用本地估算，应明确写“约”，不能暗示为实时路线耗时。

## 4. 坐标系边界

官方资料说明，高德国内坐标属于 GCJ-02；非高德 GPS/WGS84 坐标应先转换为高德坐标。参考：[坐标转换 API](https://lbs.amap.com/api/webservice/guide/api/convert) 和 [高德坐标系说明](https://lbs.amap.com/api/javascript-api-v2/guide/transform/convertfrom)。

项目当前坐标约定：

| 环节 | 坐标系 | 结论 |
| --- | --- | --- |
| Android `LocationManager` 输出 | WGS84 | 客户端契约显式标记为 `WGS84` |
| API 入站请求 | WGS84 或显式 GCJ-02 | 旧客户端缺省按 WGS84 解析 |
| 高德周边搜索请求 | GCJ-02 | 只在供应商边界转换一次 |
| 高德 POI 响应 | GCJ-02 | 领域模型保留 `crs: "GCJ02"` |
| POI 距离计算 | 两端必须同一坐标系 | 混用时直接抛错 |

当前本地转换避免了每次推荐额外调用一次坐标转换 API，也减少了延迟和配额消耗。但在真实上线前，必须用高德官方转换 API 建立北京、上海及其他区域的控制点对照集，量化本地算法与官方结果的误差；对不同经纬度、半径边界附近点和校园出入口尤其要测。

不要把官方坐标转换 API 直接加入热路径，除非本地转换误差不满足产品要求或高德书面要求必须使用官方服务。若加入，则一次推荐会从 1 次高德调用增加到至少 2 次，并新增一条精确坐标出站链路。

## 5. 与项目相关的其他高德能力

### 5.1 能力选择矩阵

| 能力 | 官方接口/方式 | 项目用途 | 建议优先级 | 结论 |
| --- | --- | --- | --- | --- |
| 周边餐厅 | `v5/place/around` | 当前推荐候选 | 必需 | 保留现有服务端实现 |
| 输入提示 | `v3/assistant/inputtips` | 可选的逐字联想增强 | 暂不采用 | 当前明确提交式搜索已满足首测；只有用户研究证明需要联想时才经自有 API 增加，不能与文本搜索无控制叠加 |
| POI 关键字搜索 | `v5/place/text` | 用户明确提交地点关键词 | 已实现 | 经自有 `POST /v1/location-search` 代理；全国可用、不锁定城市、每次最多 5 条，结果仅在当前选择流程使用 |
| POI ID 搜索 | `v5/place/detail` | 选中项临时补全、导航 | 按需 | 最多可批量查询 10 个 ID；持久化 ID 需书面授权 |
| 逆地理编码 | `v3/geocode/regeo` | 把定位点显示为可读位置标签 | 可选 | 使用 `extensions=base`，避免顺带拉取不需要的周边 POI |
| 坐标转换 | `v3/assistant/coordinate/convert` | 校验或替代本地 WGS84 → GCJ-02 | 校验用 | 不默认进入推荐热路径 |
| 路径规划 2.0 | `v5/direction/*` | 更准确的步行/骑行/公交时间 | 授权后 | 先只对最终 3 条结果查询，避免对 25 个候选逐一算路 |
| 高德地图 App URI | `amapuri://route/plan` | 点击“去这里”后调起高德 | 近期 | 无需集成地图 SDK；可传 POI ID、GCJ-02 坐标和出行方式 |
| Android 定位 SDK | SDK | 定位与地址 | 暂不采用 | 系统前台定位已满足首测；SDK 会扩大第三方数据与合规清单 |
| Android 地图 SDK | SDK | App 内地图选点/地图页 | 暂缓 | 只有产品确定需要地图交互时再引入 |
| 图片字段 | `show_fields=photos` | 餐厅卡图片 | 暂不采用 | 先获得图片使用、热链、缓存与下线处理的书面边界 |
| 静态地图 | `v3/staticmap` | 详情图或 2.0 候选分享卡 | 暂缓 | 涉及地图审图号、版权标识和图片存储，不是 Android 1.0 能力；分享卡必须在 2.0 重新评审 |

输入提示官方文档：[输入提示](https://lbs.amap.com/api/webservice/guide/api-advanced/inputtips)  
逆地理编码官方文档：[地理/逆地理编码](https://lbs.amap.com/api/webservice/guide/api/georegeo/)  
路径规划 2.0 官方文档：[路径规划 2.0](https://lbs.amap.com/api/webservice/guide/api/newroute)  
Android 调起高德官方文档：[高德地图 App 路径规划](https://lbs.amap.com/api/amap-mobile/guide/android/route)

### 5.2 当前手动地点搜索实现

项目已实现供应商无关的自有端点：

```http
POST /v1/location-search
Content-Type: application/json

{"query":"中关村"}
```

这样搜索词不会进入自有 URL、访问日志或埋点。服务端限制长度，拒绝控制字符、管道符、明显坐标、手机号和邮箱；地点搜索使用独立 IP 限流。高德 adapter 调用 `v5/place/text`，当前参数为：

- `keywords=<query>`：只在单次上游请求中使用，不写分析日志、不跨用户缓存。
- 不发送 `region` 和 `city_limit`：地点搜索不锁定城市；用户应在易歧义关键词中写明城市，adapter 保留名称、地址和坐标合法的全国结果。
- `page_size=5`、`page_num=1`：只返回当前地点选择所需的少量结果。
- `output=json`：同时验证 HTTP 状态、`status="1"`、`infocode="10000"` 和 `pois` 数组。

响应只包含通用来源代码、`LIVE/DEMO`、来源说明及最多 5 个地点的名称、可选地址和显式 CRS 坐标，不返回高德 POI ID。Android 在用户明确提交后请求；输入变化、关闭选择器或页面进入后台会取消旧请求，并用代次校验丢弃晚到响应。内置快捷地点始终可用，因此拒绝定位、无网或上游失败不会堵塞核心流程。

当前没有逐字联想，也没有调用 `v3/assistant/inputtips`。是否增加联想是后续产品决策，不是高德接入的强制要求；若用户研究证明有价值，再按最小字符、节流、取消和短生命周期原则另行设计。

### 5.3 路线与导航建议

当前 v1 推荐结果通过供应商无关的四项 `actions` 布尔值控制导航、拨号、复制地址和分享。为保持 API v1 兼容暂时保留 `share`，但 AMAP/DEMO provider 统一返回 `false`；Android 1.0 又以唯一的 `BuildConfig.SHARE_FEATURE_ENABLED=false` 编译期常量移除入口，不存在 Gradle 属性或远程开关。其余动作仍同时接受服务端能力和本地必要字段门禁，不因 provider 名称、坐标或电话存在而自行开放。

如果后续高德书面许可允许导航，可以在受控动作层增加高德官方 App URI：

```text
amapuri://route/plan/
  ?sourceApplication=吃什么
  &did=<server-resolved-providerPlaceId>
  &dlat=<gcj02-latitude>
  &dlon=<gcj02-longitude>
  &dname=<poi-name>
  &dev=0
  &t=<travel-mode>
```

其中 `dev=0` 表示传入坐标已经是高德坐标；`t=2` 为步行、`t=3` 为骑行、`t=1` 为公交。名称、ID 和其他参数必须分别进行 URI 编码。`resultToken` 不能直接填入 `did`；只有服务端在许可有效时解析出的内部引用才能进入供应商动作 adapter。供应商专有 URI 的构造与白名单校验应封装在动作 adapter 中，公共契约和 Android 推荐流程只消费通用能力；未安装时的回退也必须经过真机验证和数据外传授权，不能把任意服务端字符串当 URI 执行。

复制地址、把电话交给系统拨号器以及通过 `ACTION_SEND` 分享都会让第三方内容离开当前实时展示界面，不能仅凭“用户主动点击”就推定已获许可。当前 AMAP 四项动作全关是安全基线；导航、拨号和复制以后仍须按书面授权逐项开放。分享不属于 Android 1.0，即使远程配置变化也不能启用，最早在 2.0 完成新的产品、数据权利、隐私和安全评审后再决定。

如果未来需要把路线耗时加入推荐排序，应先完成授权确认，再采用“两阶段”策略：一次周边搜索得到候选，完成硬过滤后只为少量候选调用路线接口，不能对每个请求的全部 25 条结果无限制扇出。

## 6. Key、签名与网络安全

官方创建流程：[创建应用和 Key](https://lbs.amap.com/api/webservice/create-project-and-key)。

### 6.1 必须执行

1. 以实际运营主体创建高德应用，为该应用创建“Web 服务”类型 Key。
2. 开发、预发布、生产使用独立应用或至少独立 Key；高德协议原则上要求每个应用单独申请 Key，一个 Key 只用于一个应用。
3. 生产 Key 只存于服务端密钥管理系统，通过 `AMAP_WEB_SERVICE_KEY` 注入；不进入 APK、仓库、镜像层、CI 输出或管理台响应。
4. 在高德控制台为生产 Key 设置服务器出口 **IP 白名单**。官方 FAQ 明确建议线上使用时配置；否则 Key 泄露后他人可消耗配额，并可能触发封禁。
5. 只允许 HTTPS；限制出站域名为 `restapi.amap.com`，不跟随重定向。
6. 网关、反向代理、DNS 代理、APM、SLS、异常追踪和 HTTP 调试器全部禁止采集完整高德 URL。因为 Key 和精确坐标都位于 query 中，单靠应用代码“不打印日志”并不够。
7. Key 泄露时立即轮换并复核异常调用量、出口 IP 和日志留存。

IP 白名单说明：[为什么要设置 IP 白名单](https://lbs.amap.com/faq/webservice/webservice-api/basic-configuration/43238)。

高德把 IP 白名单定义为可选但强烈建议的控制；本项目选择更严的生产基线：`NODE_ENV=production` 且启用 AMAP 时，`AMAP_IP_WHITELIST_CONFIGURED` 必须精确为 `true`，否则配置启动失败。该变量只是部署确认，不会替代高德控制台的真实白名单。

### 6.2 数字签名

高德 Web 服务 `sig` 是可选能力；一旦在控制台为 Key 开启，所有请求就必须按官方算法携带正确签名，否则返回 `10007 INVALID_USER_SIGNATURE`。

当前项目已实现官方算法：请求参数（包含 `key`，不含 `sig`）按参数名升序连接，末尾直接追加私钥，按 UTF-8 取 MD5，再将结果作为 `sig` 查询参数。`apps/api/src/providers/amap-request-signature.ts` 仅允许精确的 `https://restapi.amap.com` 且拒绝重复参数名。`AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY` 只保留在服务端运行时，不进入 URL、APK、构建输出或诊断文本。

当 `NODE_ENV=production` 且启用 AMAP 时，签名私钥缺失会使应用在发起任何供应商请求前启动失败。开发/测试环境未配置私钥时保持未签名，便于纯离线夹具和 DEMO；不得将此例外用于生产。

官方算法说明：[如何添加数字签名](https://lbs.amap.com/faq/quota-key/key/41181/)。

签名是请求完整性与持有私钥的证明，不替代 HTTPS、IP 白名单、密钥轮换和调用量告警。

## 7. 错误处理与可观测性

官方错误码：[Web 服务 API 状态码说明](https://lbs.amap.com/api/web-service/tools/info)。

### 7.1 两层成功判断

一次调用必须同时满足：

1. HTTP 层：状态码为 2xx，响应体不超过项目设置的 512 KiB，UTF-8 和 JSON 解析成功。
2. 高德业务层：`status == "1"` 且 `infocode == "10000"`，`pois` 为数组。

项目当前已实现这两层校验、2.2 秒默认超时、不跟随重定向和响应体大小上限，这是正确的安全基线。

### 7.2 已实现的安全分类边界

三个高德 adapter 现在共用 `apps/api/src/providers/amap-response-status.ts`。分类器只接收 `status` 与 `infocode`，接口刻意不接收 `info` 或响应体；安全诊断以不可枚举 Symbol 附着在内部错误上，不进入 JSON 序列化和公共 503 响应。

分类固定为：

- `CONFIGURATION_OR_PERMISSION`
- `QUOTA_OR_RATE_LIMIT`
- `REQUEST_REJECTED`
- `UPSTREAM_TRANSIENT`
- `UNKNOWN_REJECTION`
- `MALFORMED_RESPONSE`

只有官方逐项列出的错误码可以作为 `safeInfocode`；官方统称的 `300**` 只输出 `3XXXX`，其他未知值只输出 `UNKNOWN`。应用日志不能记录完整 URL、Key、请求坐标、搜索词、POI ID、`info` 或上游响应体。将来如接入指标系统，只允许记录低基数、无个人信息的聚合值：

- `amap.request.outcome`: `success / timeout / http_error / rejected / invalid_response / too_large / network_error`
- `amap.infocode.class`: 仅允许上述固定分类
- `amap.latency.bucket`
- `amap.result_count.bucket`: `0 / 1-3 / 4-10 / 11-25`
- `amap.quota.usage_ratio`: 从控制台或运维配置取得，不从用户请求推导

不要把 `info` 原文直接写日志；未知文本可能包含不可预期内容。

### 7.3 重点告警错误码

| `infocode` | 含义 | 项目动作 |
| --- | --- | --- |
| `10001` | Key 无效或过期 | 立即告警，检查轮换和环境注入 |
| `10003` / `10044` | Key 或账号调用量超限 | 停止重试风暴，降级并联系运营 |
| `10004` / `10029` | 频率或 QPS 超限 | 限流、退避，不做即时重复重试 |
| `10005` | 出口 IP 不在白名单 | 核对 NAT/SLB 出口与控制台配置 |
| `10007` | 数字签名失败 | 核对签名开关、参数顺序、编码和私钥 |
| `10009` | Key 平台类型不匹配 | 确认使用 Web 服务 Key，而非 JS/Android Key |
| `10026` | 账号被封禁 | 保持服务关闭，走高德工单申诉 |
| `20000` / `20001` | 参数非法或缺失 | 视为代码/配置问题，不能让客户端无限重试 |

### 7.4 真实 Key 的双重 opt-in smoke

真实网络验证不属于 `pnpm test`、`pnpm build` 或 `scripts/verify.ps1`，只能从仓库根目录显式运行：

```powershell
.\scripts\run-amap-live-smoke.ps1 -EnvFile .\.env.local -ConfirmLiveRequest
```

私有 `.env.local` 至少需要：

```dotenv
AMAP_LIVE_SMOKE_ENABLED=true
AMAP_ENABLED=true
AMAP_WEB_SERVICE_KEY=<仅保存在本机私有文件中的 Web 服务 Key>
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=<与该 Key 匹配的签名私钥>
AMAP_IP_WHITELIST_CONFIGURED=true
AMAP_TIMEOUT_MS=2200
```

只有环境开关和命令确认同时存在才会联网。脚本不修改调用 PowerShell 的环境：contracts/API 构建在只含必要系统变量的最小子进程中运行，最终 smoke Node 也只接收同一最小系统环境和私有文件中选出的六个高德变量。私钥缺失或未明确确认 IP 白名单时，在构建和任何高德请求之前就拒绝。普通 `start-api-local.ps1` 会忽略 `AMAP_LIVE_SMOKE_ENABLED`，不能借此启动 smoke。smoke 使用固定的非用户多城市测试输入，串行且每条只请求一次：

1. 地点文字搜索：`v5/place/text`；
2. 餐厅关键词搜索：`v5/place/around`；
3. 推荐召回：`v5/place/around`。

任一链路失败即停止。成功输出只包含链路名和结果数量；失败只包含固定分类及已审核的安全 infocode。Key、完整 URL、搜索词、精确坐标、`info`、响应体、POI ID、名称、地址、电话、评分、价格、标签和异常堆栈一律不得输出或写入工件。

默认 `scripts/verify.ps1` 只运行 `run-amap-live-smoke.test.ps1` 的假 `pnpm`/假 `node` 离线门禁回归，覆盖构建阶段无任何父终端 Secret、运行阶段仅六变量、缺少签名或白名单确认拒绝、恶意/重复行拒绝、参数转发、输出脱敏和父环境不变；不会执行真实构建命令或高德网络请求。真实三链路仍只能通过上面的显式命令启动。

## 8. 数据权利、商业许可与隐私

官方依据：

- [高德地图开放平台服务协议](https://lbs.amap.com/pages/terms/)
- [高德地图开放平台隐私权政策](https://lbs.amap.com/pages/privacy/)
- [基础服务价格](https://lbs.amap.com/pages/base_service_price)
- [商用授权与技术服务许可](https://lbs.amap.com/commercial)

### 8.1 对项目最重要的协议边界

按 2025-12-03 更新的现行服务协议：

- 法人或非法人组织为了公开用户、内部运营、投标、收费、广告或其他直接/间接利益使用服务，需事先购买技术服务许可。
- 未经专门书面许可，不得把高德内容用于模型或算法训练、数据集构建。
- 默认不得直接存储、缓存、抓取、下载、复制、修改、二次包装或脱离服务使用 POI、图片等相关内容。
- 每个应用应单独申请 Key，并妥善保护。
- 展示高德地图页面时必须在适当位置说明来源于“高德地图”，不得删除审图号、许可证号或版权标识，也不得暗示高德赞助或认可本项目。
- 最终用户的位置等必要数据应在充分告知并取得有效同意后再交由高德服务处理。

因此，项目不能把“高德接口允许返回某字段”解释为“项目可以永久保存、重新排序、训练模型或转售该字段”。接口能力和数据使用权是两件事。

### 8.2 当前双模式的使用规则

#### `LIVE_DISPLAY_ONLY`

取得允许实时展示的必要许可后，仍只在单次请求内：

- 调用官方接口并展示结果。
- 做安全与产品必需的硬过滤；过滤的具体范围仍应在工单中得到确认。
- 保持高德返回次序，不显示自有 `fitScore`。
- 不跨请求缓存或持久化 POI 字段、图片、稳定 POI 摘要。
- 不把 POI 候选发送给千问或其他第三方模型。
- 行为事件只使用项目现有的请求作用域短期 HMAC 校验，不形成可跨请求关联的 POI 库。
- 系统分享、复制到剪贴板、把电话或地址交给其他 App、生成分享卡等动作，在高德明确允许前保持关闭；其中分享在 Android 1.0 还受不可远程覆盖的编译期关闭门禁。

当前代码即使处于该模式，仍会根据高德字段计算直线距离、预计交通时间、预计用餐时间、置信度、警告和推荐原因，并执行停业、半径、预算、排除菜系和去重过滤。它们是产品上合理的安全能力，但仍属于对服务结果的选择、解释或派生；必须列入高德书面确认范围，不能只确认“不缓存”就直接上线。

#### `LICENSED_ENRICHMENT`

只有书面许可明确覆盖相应行为时，才可按授权范围逐项开放：

- 自有重排与适合度。
- 稳定 POI ID 的收藏、历史或跨设备引用。
- 经许可的派生字段和留存期限。
- POI 内容参与第三方模型的单次推理；模型训练、日志留存和数据集构建仍需单独确认。
- 图片展示、代理或缓存。

项目的 `DATA_RIGHTS_AUTHORIZATION_ID` 和到期时间只是工程门禁，不能替代合同、许可证书或高德工单回复。

### 8.3 来源展示

当前结果卡和详情页显示 `sourceAttribution`，高德候选写为“高德地图实时数据”，来源标注方向正确。Android 1.0 不生成分享文本或分享卡；封存实现不代表该行为已经获准。若 2.0 重新立项，应先让高德书面确认：

- 纯文本搜索结果是否要求固定文案、Logo 或链接。
- “高德地图实时数据”是否满足来源标识要求。
- 2.0 候选分享卡、截图和无地图列表页如何展示来源。
- 不得使用会暗示“高德官方推荐”“高德认证”的文案。

### 8.4 隐私告知

启用高德前，App 隐私政策、隐私同意页和第三方服务清单至少应说明：

- 服务与接收方：高德软件有限公司/高德开放平台 **Web 服务 API**，不是 Android SDK，客户端不初始化高德 SDK，Key 和签名私钥只在自有服务端。上线文本要以真实合同主体和当时政策为准。
- 处理时机：用户完成隐私同意并主动发起自动/手动地点搜索或餐厅推荐时，才可由自有 API 发起对应高德请求；不得在 App 启动、后台或用户未操作时调用。
- 最小出站数据：单次 GCJ-02 中心点（Android 系统 WGS84 位置只在服务端转换）、搜索词或餐饮类型、半径与必要的分页/字段控制；不额外发送固定城市限制。手动快捷地点同样会把该点作为查询中心，不能笼统宣称“拒绝系统定位就不处理位置”。
- 用途与边界：只用于返回当次附近地点/餐厅并实时展示。默认不跨请求缓存或持久化高德 POI，不转发给模型，不开放未获书面许可的外部动作。
- 拒绝与关闭：拒绝系统定位后仍可手动选择固定测试地点；AMAP 关闭时不向高德传输。若手动地点最终也用于实时高德查询，应明确告知这一点。
- 政策链接：完整隐私政策/第三方清单直接链接高德隐私政策和开放平台服务协议，并在外部测试前补齐实际运营主体与联系方式。

精确位置属于高敏感度数据。项目应在启用前完成个人信息保护影响评估，并验证代理/APM/日志全链路不留存 query。当前 Android 内部 Alpha 的同意页和设置页已复用同一份第三方服务清单，明确列出高德 Web Service 接收方、主动触发时机、坐标转换、最小出站字段、实时展示边界、无客户端 SDK/Key 及 AMAP 关闭态；完整隐私政策、真实运营主体/联系方式、直接政策链接和位置 PIA 仍是外部测试及发布硬门禁。

## 9. 配额与成本估算

以下是高德定价页在 2026-08-22 展示的公开信息，实际权益以账号控制台、订单和合同为准。

### 9.1 基础搜索服务月配额

关键字搜索、周边搜索、多边形搜索、ID 搜索和输入提示共享“基础搜索服务”配额：

| 账号/许可状态 | 公开页面月配额 |
| --- | ---: |
| 个人认证开发者，非商业目的 | 5,000 次 |
| 经高德评估符合非商业目的的企业认证开发者，页面所述一年期权益 | 50,000 次 |
| 企业认证开发者，已购买技术服务许可 | 500,000 次 |

公开页面显示基础搜索服务流量包为 **30 元/万次**；企业技术服务许可基础版/高级版页面价格分别为 **50,000 元/年** 和 **100,000 元/年**。价格和权益会调整，预算审批前必须重新确认。

QPS 不应写死在代码或本文中。官方流量说明要求在 **控制台 → 流量分析 → 配额管理** 查看当前账号的精确 QPS；账号下所有 Key 还可能共享服务级配额。

### 9.2 当前推荐链路的调用量

当前实现每次推荐只请求周边搜索第 1 页，且不自动重试，因此理论上：

```text
月周边搜索调用量
= 月活跃天数 × 日活跃用户 × 每人每天推荐次数
```

示例只用于容量估算：

| 场景 | 假设 | 周边搜索调用/月 |
| --- | --- | ---: |
| 封闭 Alpha | 20 人 × 2 次/天 × 30 天 | 1,200 |
| Beta | 100 人 × 3 次/天 × 30 天 | 9,000 |
| 小规模公开 | 1,000 人 × 3 次/天 × 30 天 | 90,000 |

加入地点输入提示后，调用量可能快速超过周边搜索本身。例如每个推荐会话有 30% 使用手动搜索、每次平均触发 4 次联想，则总基础搜索调用约为：

```text
推荐会话数 × (1 次周边搜索 + 30% × 4 次输入提示)
= 推荐会话数 × 2.2
```

所以输入提示必须节流，且运维应按共享配额监控，而不是只统计 `/v5/place/around`。

## 10. 当前实现评审

### 10.1 已做对的部分

- Web 服务 Key 只在服务端配置，Android 不包含高德依赖或 Secret。
- 高德默认关闭；必须同时存在 Key 和 `AMAP_ENABLED=true` 才启用。
- 生产启用还必须配置独立签名私钥并明确确认出口 IP 白名单；否则在发起任何供应商请求前启动失败。
- 生产环境禁止 DEMO 餐厅，未配置合法供应商时安全失败。
- WGS84 → GCJ-02 只在高德边界执行，并用 CRS 类型防止重复转换和混合距离。
- 坐标发送前限制为 6 位小数，符合官方接口约束。
- 周边搜索全国可用，限定餐饮、10 公里以内，分页最大 25 条且只取第一页；请求不附加固定城市门禁。
- 地点关键词搜索经自有 `POST /v1/location-search` 代理，使用 `v5/place/text` 全国搜索且每次最多 5 条；Android 不持有 Key，搜索词不进入自有 URL。
- 不请求图片；响应体限制 512 KiB；设置超时、禁止重定向和缓存。
- 同时验证 HTTP 状态、`status`、`infocode` 和 `pois` 类型。
- 周边、文本、附近关键词和已授权 ID 详情四条调用链共用签名与安全错误分类；ID 详情按官方上限每批最多 10 个。
- 营业时间已按能确定才判定的原则支持多时段、跨夜与异常输入；含义不明仍回退 `UNKNOWN`。
- 坐标转换已有多城市控制点、同 CRS 与不支持逆向转换的服务端/Android 回归；真实 Key 到位后仍需与官方转换服务量化误差。
- `LIVE_DISPLAY_ONLY` 不计算适合度，不跨请求缓存 POI，不把候选传给千问。
- 推荐结果的 provider 已是受约束的通用代码，并显式携带 `LIVE/DEMO` 与四项动作能力；AMAP 的导航、拨号、复制和分享当前全部默认关闭，DEMO 的分享也固定为 `false`。Android 1.0 额外以编译期常量封闭分享入口。
- UI 已显示数据来源；只有服务端明确允许的动作才会出现在详情并通过动作工厂执行。

### 10.2 上线前待办

| 优先级 | 待办 | 验收标准 |
| --- | --- | --- |
| P0 | 购买/确认适用技术服务许可 | 运营主体、应用、Key、期限和服务范围可追溯 |
| P0 | 获取数据使用书面结论 | 重排、硬过滤、派生解释、适合度、POI ID、事件、模型、图片、分享/外传、来源文案逐项有答复 |
| P0 | 完成位置 PIA 与隐私文本 | 用户主动触发、出站字段、接收方、拒绝替代和删除规则均落地 |
| P1 | 在高德控制台配置生产 Key 的固定出口 IP 白名单和数字签名 | 工程端生产配置硬门禁已完成；待真实 Key/出口可用后验证非白名单为 `10005`、错签名为 `10007`、正式出口成功 |
| P1 | 做真实响应契约测试 | 使用授权测试 Key 覆盖成功、零结果、缺字段、字符串/空数组差异和 25 条上限 |
| P1 | 用授权真实响应补强营业时间夹具 | 离线保守解析已完成；待 Key 到位后覆盖多城市实际字段形态 |
| P1 | 用官方坐标转换 API 量化本地转换误差 | 本地多城市控制点和混合 CRS 拒绝回归已完成；待 Key 到位后归档官方对照误差与阈值 |
| P1 | 在获得导航许可后实现受控高德动作 adapter | `amapuri://route/plan` 的 POI ID、GCJ-02、`dev=0` 和未安装回退完成真机验证；公共推荐流程不按供应商名称分支 |
| P1 | 把当前 AMAP 全关闭基线升级为逐项授权策略 | 复制、拨号和地图跳转只有在对应书面许可有效时才返回 `true`，授权到期可立即回到全关闭；分享保持 `false`，不进入 Android 1.0 |
| P1 | 建立配额/QPS/失败率告警 | 达到 50/75/90% 分级预警，超限不发生重试风暴 |
| P2 | 连接配额/失败率指标后端 | 代码已能区分配置、配额、请求、临时和畸形响应；指标后端仍不得接收 URL/坐标/POI |
| P2 | 持续同步项目文档 | 本轮高德专项文档已同步；最终验证报告仍必须记录真实 Key/授权后的外部验收 |
| P2 | 为 2.0 候选分享能力确认来源文案和规则 | 只有重新立项后，才请求高德书面确认列表页、详情、分享和外部导航的展示方式 |

## 11. 推荐实施顺序

### 阶段 A：保持关闭，完成授权和控制台准备

```dotenv
AMAP_ENABLED=false
AMAP_WEB_SERVICE_KEY=
AMAP_WEB_SERVICE_SIGNATURE_PRIVATE_KEY=
AMAP_IP_WHITELIST_CONFIGURED=false
AMAP_TIMEOUT_MS=2200
DATA_RIGHTS_MODE=LIVE_DISPLAY_ONLY
```

完成运营主体认证、技术服务许可、书面工单、Key 分环境、出口 IP 白名单、隐私评估和日志验证。不能为了“先看看效果”把生产 Key 放进 APK。

### 阶段 B：封闭预发布联调

- 使用独立预发布 Key 和固定出口 IP。
- 只通过 7.4 节的双重 opt-in 命令运行三链路真实 Key smoke；默认验证不联网。
- 只对授权测试人员开放，调用仍保持 `LIVE_DISPLAY_ONLY`。
- 用北京、上海及其他城市的校园、商圈、零结果点和粗略定位建立真实夹具。
- 验证高德响应字段、营业时间、坐标偏移、电话/价格缺失、错误码和超时。
- 检查 API、网关、APM、容器、云日志中不存在 Key、完整 URL、精确坐标和 POI 响应体。

### 阶段 C：受控实时展示

- 只有书面许可明确允许实时展示和当前硬过滤后，才设置 `AMAP_ENABLED=true`。
- 保持 `DATA_RIGHTS_MODE=LIVE_DISPLAY_ONLY`。
- 不持久化、不跨请求缓存、不显示自有适合度、不改变供应商次序、不把 POI 交给模型。
- 建立按日/周复核的配额、失败率、空结果率和来源展示检查。

### 阶段 D：按授权逐项开放增强

获得覆盖具体行为且未过期的书面许可后，才配置：

```dotenv
DATA_RIGHTS_MODE=LICENSED_ENRICHMENT
DATA_RIGHTS_AUTHORIZATION_ID=<database-authorization-uuid>
DATA_RIGHTS_AUTHORIZATION_EXPIRES_AT=<future-iso-8601-time>
```

每一项增强单独验收；不能因为授权允许“重排”就推定同时允许“永久保存 POI”“把图片缓存到 OSS”或“将 POI 发送给模型”。

## 12. 建议提交给高德的工单问题

下面内容可作为工单主体，提交时补充真实运营主体、应用包名、预计用户量、部署地域和 Key 所属应用，但不要附真实 Key 或精确用户坐标。

> 我们正在开发 Android 应用“吃什么”，由自有境内 NestJS 服务端调用高德 Web 服务 API `v5/place/around`，面向全国用户提供附近餐厅决策。用户主动发起推荐后，我们传输单次中心点、半径和餐饮分类，计划展示 1 个主选择和 2 个备选。Android 客户端不持有 Web 服务 Key。目前默认不缓存高德 POI，不把 POI 交给大模型。
>
> 请以书面形式逐项确认以下使用边界，并注明适用的技术服务许可、Key、应用、期限、字段和留存期限：
>
> 1. 是否允许在单次请求内依据营业状态、用户半径、明确排除菜系和预算上限移除不符合项，并从最多 25 条中只展示前 3 条，同时保持剩余结果的高德原始顺序？
> 2. 是否允许基于 POI 坐标、分类、营业时间、评分和人均消费计算直线距离、预计交通时间、预计用餐时间、置信度、警告和推荐原因？是否允许进一步重新排序并生成自有适合度？如允许，来源和派生内容应如何标识？
> 3. 是否允许保存 POI ID 用于收藏、历史、重复推荐控制和跨设备同步？分别允许保存多久？
> 4. 是否允许保存只含事件类型、请求 ID 和经不可逆处理的 POI 引用的点击/导航聚合？是否允许跨请求关联同一 POI？
> 5. 是否允许把有限 POI 字段发送给境内阿里云百炼模型做单次推理？模型不用于训练，但服务可能有安全日志时需要满足什么条件？
> 6. 是否允许展示 `business.rating`、`cost`、`tel`、`tag`、`opentime_today`？各字段的推荐展示文案和刷新要求是什么？
> 7. 是否允许展示 `photos` URL？是否允许客户端直连、服务端代理、短期缓存，或在 2.0 候选功能中生成分享卡？下线和版权要求是什么？
> 8. 是否允许用户把高德 POI 地址复制到系统剪贴板、把电话交给系统拨号器；若 2.0 重新立项，是否允许通过系统分享把名称/地址发送给其他 App，或把结果交给非高德地图 App？各动作有什么限制？
> 9. 纯列表页、详情页、2.0 候选分享文本和调起地图页分别应使用何种“高德地图”来源文案、Logo、链接或其他标识？
> 10. 是否允许使用 POI ID 和 GCJ-02 坐标通过 `amapuri://route/plan` 调起高德地图 App？
> 11. 服务端本地把 Android WGS84 坐标转换为 GCJ-02 是否符合接入要求，还是必须调用高德坐标转换 API 或使用高德定位 SDK？
> 12. 本应用所需技术服务许可的准确类型、价格、基础搜索月配额、QPS、超限计费和测试环境政策是什么？
> 13. 终止服务或授权到期后，项目应如何删除 POI 引用、衍生字段、事件和备份中的相关内容？

工单回复应归档到项目的授权记录中，并把工单号、回复日期、适用 Key/应用、到期时间和负责人写入 `DATA_RIGHTS_AUTHORIZATION_ID` 所指向的真实记录。

## 13. 联调与回归清单

### 请求契约

- [ ] 只使用 Web 服务类型 Key。
- [ ] 自有地点搜索使用 JSON `POST /v1/location-search`；搜索词不进入自有 URL、埋点、错误日志或 trace 标签。
- [ ] 高德地点搜索使用 `v5/place/text`、`page_size=5`、`page_num=1`，不发送 `region`/`city_limit`，不自动翻页。
- [ ] 坐标顺序是经度、纬度，最多 6 位小数。
- [ ] WGS84 只转换一次，GCJ-02 不重复转换。
- [ ] 半径始终在 200–10,000 米项目范围内。
- [ ] `keywords` 最多一个、来自服务端白名单、长度不超过 80 字符且不含 `|`。
- [ ] 周边请求使用 `types=050000`，不发送固定 `region`/`city_limit`。
- [ ] `page_size=25`、`page_num=1`，无隐式分页或自动重试。
- [x] 有签名私钥时，文本、周边、附近关键词和 ID 详情每个请求都携带按官方算法生成的 `sig`。
- [x] 生产启用 AMAP 时，缺少签名私钥或未明确确认 IP 白名单会在任何高德请求前拒绝启动。

### 响应契约

- [ ] HTTP 失败、业务失败和 JSON 失败分别覆盖。
- [ ] `status="1"` 且 `infocode="10000"` 才进入 POI 解析。
- [x] 四个高德调用链共用表驱动的安全 infocode 分类；未知值不回显。
- [x] ID 详情重解析每批不超过官方规定的 10 个 ID。
- [ ] 在取得测试 Key 后运行双重 opt-in smoke，三条链路各成功一次且没有敏感输出。
- [ ] `pois=[]` 被视为正常零结果，不被误报成上游故障。
- [ ] 地点搜索保留全国合法结果、最多 5 条，响应不含高德 POI ID；名称、地址和 GCJ-02 坐标缺失时按保守规则处理。
- [ ] `id/name/location` 缺失的单条 POI 被丢弃，不拖垮整个响应。
- [ ] `rating/cost/tel/tag/opentime_today` 缺失或类型异常时安全降级。
- [ ] 响应大于 512 KiB、慢响应和中途断流均安全失败。
- [ ] 任何错误路径都不输出 Key、完整 URL、精确坐标或响应体。

### 产品与数据权利

- [ ] `LIVE_DISPLAY_ONLY` 下 `fitScore` 始终为 `null`。
- [ ] AMAP 推荐的四项 `actions` 在未取得对应书面许可时全部为 `false`，Android 界面与动作工厂都不能绕过。
- [ ] 未授权时不跨请求缓存/保存 POI、图片或稳定摘要。
- [ ] POI 不进入千问请求、提示词、模型日志或评测集。
- [ ] 未经确认时，AMAP 结果不进入系统分享、剪贴板、拨号器或任意第三方地图 App；Android 1.0 的分享无论配置如何都保持关闭。
- [ ] 来源在卡片、详情中可见且文案已获确认；分享来源要求留待 2.0 重新立项时评审。
- [ ] 授权到期会在运行中降级，并完成演练。
- [ ] App 隐私政策与实际出站字段、初始化时机一致。

### 容量与运维

- [ ] 控制台 QPS、月配额和计费方式已截图归档并记录核对日期。
- [ ] 50%、75%、90% 配额告警可触发。
- [ ] `10003/10004/10029/10044` 不触发无界重试。
- [ ] 出口 IP 变化有变更流程，不会突然触发 `10005`。
- [ ] Key 轮换、供应商关闭和无供应商安全失败均已演练。

## 14. 官方资料索引

| 主题 | 官方链接 |
| --- | --- |
| Web 服务 API 概述 | [概述](https://lbs.amap.com/api/webservice/summary/) |
| 创建 Web 服务 Key | [创建应用和 Key](https://lbs.amap.com/api/webservice/create-project-and-key) |
| 搜索 POI 2.0 | [关键字、周边、多边形、ID 搜索](https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch) |
| 输入提示 | [输入提示 API](https://lbs.amap.com/api/webservice/guide/api-advanced/inputtips) |
| 地理/逆地理编码 | [地理/逆地理编码 API](https://lbs.amap.com/api/webservice/guide/api/georegeo/) |
| 坐标转换 | [坐标转换 API](https://lbs.amap.com/api/webservice/guide/api/convert) |
| 路径规划 2.0 | [路线规划 2.0](https://lbs.amap.com/api/webservice/guide/api/newroute) |
| 调起高德地图 App | [Android 路径规划 URI](https://lbs.amap.com/api/amap-mobile/guide/android/route) |
| Web 服务错误码 | [错误码说明](https://lbs.amap.com/api/web-service/tools/info) |
| 流量限制 | [流量限制说明](https://lbs.amap.com/api/webservice/guide/tools/flowlevel) |
| IP 白名单 | [IP 白名单 FAQ](https://lbs.amap.com/faq/webservice/webservice-api/basic-configuration/43238) |
| 数字签名 | [添加数字签名 FAQ](https://lbs.amap.com/faq/quota-key/key/41181/) |
| 配额与价格 | [基础服务价格](https://lbs.amap.com/pages/base_service_price) |
| 技术服务许可 | [商用授权与技术服务许可](https://lbs.amap.com/commercial) |
| 服务协议 | [高德地图开放平台服务协议](https://lbs.amap.com/pages/terms/) |
| 隐私政策 | [高德地图开放平台隐私权政策](https://lbs.amap.com/pages/privacy/) |
| POI 与城市编码下载 | [相关下载](https://lbs.amap.com/api/webservice/download) |

官方提醒 POI 分类码和城市编码会更新，下载表仅供查询，不应被当作长期不变的生产数据库。项目可以把当前使用的 `050000` 作为带版本和复核日期的供应商配置，但不能由此推定所有细分类长期稳定。
