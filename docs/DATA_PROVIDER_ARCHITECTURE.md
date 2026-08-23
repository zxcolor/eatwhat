# 多数据源架构与接入治理

> - 文档状态：目标架构与迁移基线
> - 核对日期：2026-08-20
> - 适用范围：地点搜索、附近餐厅候选、餐厅详情、路线与后续授权数据源
> - 相关文档：[`AMAP_API_INTEGRATION.md`](./AMAP_API_INTEGRATION.md)
>
> 说明：本文定义供应商无关的工程边界，不代表任何未来平台已经开放接口、同意合作或授权本项目使用其数据。

## 1. 结论与不可违反的原则

“吃什么”的核心是完成一次用餐决策，不是转售任何平台的数据。高德是首个受控接入的数据源，但领域模型、推荐规则、公共 API 和 Android UI 都不能以高德字段为中心设计。

必须长期遵守以下原则：

1. **领域模型先于供应商模型**：业务层只理解地点、餐厅候选、来源事实、派生事实和可执行动作；高德、美团、大众点评等专有请求和响应只能存在于各自 adapter 内。
2. **技术可调用不等于有权使用**：一个能力只有在“adapter 支持、书面授权允许、运行状态健康”同时成立时才可用。
3. **默认拒绝，逐项授权**：搜索、重排、缓存、持久化 ID、收藏、图片、分享、模型推理等是不同用途，不能由一个“已授权”开关全部放行。
4. **事实带来源，评分不混算**：名称、价格、营业时间、评分等外部事实必须能追溯到具体数据源；不同平台评分不得直接求平均或伪装为“综合评分”。
5. **公共契约不出现供应商专有字段**：可以返回通用的 `source.id` 和 `source.label`，但不得出现 `amapPoiId`、`dianpingScore`、`meituanCategory` 一类字段，也不得要求 Android 按供应商名称分支业务逻辑。
6. **最小化与短生命周期**：精确位置、地点搜索词、原始响应和稳定 POI 引用只在当前用途所需的最短时间内处理；没有明确权利时不得跨请求缓存或关联。
7. **不抓取、不绕过**：未来接入美团、大众点评或其他平台，只能使用该平台正式 API、商务合作数据、商户主动提供或用户明确贡献且可合法使用的数据。禁止网页抓取、模拟登录、复用 Cookie、逆向私有接口或规避访问控制。
8. **故障安全关闭**：授权不明、授权过期、配置错误或来源不可用时关闭该来源或对应能力，不使用未授权缓存兜底，也不把演示数据冒充真实结果。

Android 1.0 的分享能力是上述“默认拒绝”的固定实例：API v1 暂时保留 `share` 字段，但全部 provider 返回 `false`，客户端由唯一的 `BuildConfig.SHARE_FEATURE_ENABLED=false` 编译期常量移除入口，不允许 Gradle 属性或远程配置覆盖。本文后续伪代码中的 `SHARE` 只描述 2.0 候选权利模型；仓库里的底层实现仅封存，重新启用前必须重新评审。

### 1.1 三类约束及其变更方式

本文不会机械照搬某一家供应商的全部文档。设计、评审和上线时应先判断一条要求属于哪一层：

| 层级 | 内容 | 执行方式 | 如何变更 |
| --- | --- | --- | --- |
| A. 技术事实 | 官方 endpoint、参数格式、响应 schema、坐标系、业务成功码、配额语义、签名算法 | adapter 和契约测试必须与当前官方文档一致；不能凭经验猜测 | 官方版本变化后，在对应 adapter 内升级并回归，不扩散到领域层 |
| B. 合同/授权/法律硬门禁 | 商业使用权、字段用途、重排、缓存、图片、外传、模型、隐私同意、留存和删除义务 | 没有可追溯依据时默认拒绝；服务端远程门禁必须可立即撤权 | 只依据新合同、书面工单、政策或法律审查更新，并记录范围、期限和责任人 |
| C. 架构与交互建议 | registry 选择、超时预算、展示顺序、搜索节流、部分失败提示、UI 组件 | 采用成熟系统的可替换、可观测和渐进发布做法，并以当前产品指标验证 | 通过 ADR、测试、灰度和回滚方案调整，不需要把某供应商建议永久写死 |

当三层发生冲突时，B 层硬门禁优先于可用性优化；A 层事实决定 adapter 怎样正确调用；C 层在前两层允许的范围内追求速度、召回、成本和体验平衡。例如“当前不缓存图片”不是永久产品禁令：当某一 provider 的正式授权明确允许图片展示与限定 TTL 缓存后，只开放该 provider 对应 capability 和 TTL，其他来源仍保持原策略。

每项能力都应有远程状态：`disabled`、`staging_only`、`live_only`、`licensed`、`suspended`。状态只能缩小合同允许的范围，不能由运营后台把未授权能力强行放大。

## 2. 当前实现基线与差距

当前代码已经建立了一部分正确边界：

- `PlaceProvider` 把餐厅候选获取与推荐引擎分开，已有 `AmapPlaceProvider`、`DemoPlaceProvider` 和安全失败的 `UnavailablePlaceProvider`。
- `PlaceCandidate` 使用统一字段，推荐引擎不直接解析高德响应。
- 地点关键词搜索已使用独立请求/响应契约并由自有 `POST /v1/location-search` 代理，Android 不持有 Web 服务 Key；当前响应不包含稳定 POI ID。
- 推荐与地点搜索的 `provider` / `dataSource` 已改为受限但可扩展的代码，Android 不按代码值决定 CRS、演示语义或外部动作。
- `DataRightsPolicy` 已按供应商和 operation 查询数据库授权；授权缺失、撤销、过期、供应商不符或数据库不可用时会降级到 `LIVE_DISPLAY_ONLY`。
- 坐标值显式携带 CRS，降低 WGS84 与 GCJ-02 混用风险。

这些仍是“单真实供应商”基线，不是完整的多数据源架构：

| 当前限制 | 多数据源风险 | 目标状态 |
| --- | --- | --- |
| `PlaceProvider` 运行时只选择一个实例 | 无法按能力、地域、配额和健康状态组合来源 | 使用 provider registry 和 selector |
| 来源代码已可扩展，但运行时仍各自只选择一个 provider 实例 | 尚不能按地域、能力、授权、配额和健康状态组合多个正式来源 | 建立 provider registry/selector；客户端继续只消费通用来源说明和能力 |
| `DataRightsPolicy` 是全局双模式 | 不能表达“甲方可实时展示、乙方可保存 ID、图片均不可缓存”等组合 | 按供应商、操作、字段、用途和期限决策 |
| 候选只有整体 `sourceAttribution` | 合并来源后无法说明每个字段从哪里来 | 字段级 provenance，派生值记录输入来源和算法版本 |
| 去重只覆盖同源 ID和近似物理键 | 跨平台同店可能重复，错误合并也可能污染数据 | 带置信度的实体匹配；不确定时保留为独立结果 |
| 请求作用域 `resultToken` 已落地，但登记表仍是单进程内存实现 | 进程重启或多实例路由会让合法事件失效，不能支撑公开规模 | 在保持 token 不可跨请求关联的前提下迁移到有 TTL、可撤销的共享安全存储 |
| 全局 `DataRightsMode` 决定排序 | 混合来源时单一模式语义不清 | 每条事实/动作单独门禁；全局模式只作过渡兼容 |

本文描述的是目标状态和迁移路线。未完成相应代码与测试前，不能把目标能力写成“已经实现”。

## 3. 目标分层

```text
Android / iOS / 小程序
        |
        | 供应商无关的自有 API
        v
用例编排层
  地点搜索 / 附近餐厅 / 详情 / 推荐 / 外部动作
        |
        +--> ProviderSelector
        |      同时检查：技术能力 + 数据权利 + 健康/配额
        |
        +--> ProviderRegistry
               |
               +--> AMap adapter
               +--> Demo adapter（仅开发/测试）
               +--> Future adapter（仅在正式授权后加入）
        |
        v
归一化与治理层
  Schema 校验 -> 字段 provenance -> 实体匹配/去重
  -> 权利过滤 -> 硬规则 -> 授权后的排序与多样性
        |
        v
供应商无关响应 + 请求作用域 token + 来源说明
```

依赖方向必须单向：

- 领域层和用例层不得 import 任何供应商响应类型、SDK 或字段常量。
- adapter 可以依赖领域端口和供应商协议，但不能反向修改公共领域语义。
- 公共 contract 可以描述来源、事实、置信度和动作，不描述某一家平台的专有业务对象。
- Android 只渲染服务端返回的通用来源说明与动作能力，不保存服务端 Secret，也不自行拼接 Web 服务请求。

## 4. 核心领域模型

以下是建议的概念模型，名称可在实现时按项目规范调整，但语义不能丢失。

### 4.1 供应商身份与引用

```ts
type ProviderId = string; // 服务端注册且受控；不是客户端自由输入

interface ProviderPlaceRef {
  providerId: ProviderId;
  externalId: string;
}
```

- `ProviderId` 是配置和审计标识，不应成为 Android 业务分支枚举。
- `externalId` 只在服务端 adapter/治理层使用。能否持久化、发给客户端、用于收藏或跨请求关联，由该来源的权利策略决定。
- 公共 API 默认返回不可逆或带签名的短期 `resultToken`，其有效期和作用域由服务端控制；不得用“把 ID 哈希一下”规避合同中的存储或关联限制。

### 4.2 技术能力

```ts
type ProviderCapability =
  | "LOCATION_TEXT_SEARCH"
  | "PLACE_NEARBY_SEARCH"
  | "PLACE_DETAIL"
  | "ROUTE_ESTIMATE"
  | "EXTERNAL_NAVIGATION";

interface ProviderDescriptor {
  id: ProviderId;
  displayLabel: string;
  capabilities: ReadonlySet<ProviderCapability>;
  supportedRegions: readonly string[];
  coordinateSystems: readonly ("WGS84" | "GCJ02")[];
}
```

“接口能返回图片/评分”不是 `capabilities` 自动放行的理由。技术能力只说明 adapter 会做什么；数据能否展示、保存或派生必须另过权利门禁。

地点搜索与餐厅搜索必须是两个独立能力。一个来源可以支持餐厅候选但不支持通用地点搜索，反之亦然，selector 不得据供应商名称推断能力。

### 4.3 标准化候选与字段来源

```ts
interface ProvenancedValue<T> {
  value: T;
  providerId: ProviderId;
  sourceField: string;      // 仅服务端审计；不要求客户端理解
  fetchedAt: string;
  observedAt?: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
}

interface DerivedValue<T> {
  value: T;
  algorithmVersion: string;
  inputRefs: readonly string[];
  generatedAt: string;
}
```

标准化 `CanonicalPlaceCandidate` 至少包含：

- 内部临时实体 ID；
- 一个或多个 `ProviderPlaceRef`；
- 带 provenance 的名称、地址、坐标、分类、营业状态、价格、电话、图片、来源评分；
- 服务端派生的直线距离、预计路程、置信度、警告和适合度；
- 当前请求允许的动作；
- 数据权利决策结果和失效时间。

每个派生值必须区分“外部事实”和“项目计算”：例如 `sourceRating` 是来源事实，`fitScore` 是项目适合度；预计路程若只是本地估算，应标“约”，不能写成来源提供的实时路线。

### 4.4 公共响应建议

公共 API 和客户端只需要通用结构：

```ts
interface PublicSource {
  id: string;
  label: string;
  attribution: string;
}

interface PublicPlaceResult {
  resultToken: string;
  name: string;
  address?: string;
  location: { latitude: number; longitude: number; crs: "WGS84" | "GCJ02" };
  sources: readonly PublicSource[];
  sourceMetrics: readonly {
    sourceId: string;
    kind: "RATING" | "PRICE";
    value: number;
    scale?: number;
    label: string;
  }[];
  fitScore?: number;
  availableActions: readonly ("DETAIL" | "NAVIGATE" | "CALL" | "COPY" | "SHARE")[];
}
```

约束：

- `sources` 是数据，不是 schema 分支；Android 展示 `label/attribution`，不写 `if source == AMAP`。
- 不返回供应商 Secret、原始响应、内部授权状态、原始稳定 ID或专有字段。
- 供应商专用导航 URI 由受控动作层生成，必须校验 scheme/host/参数；客户端不能执行服务端返回的任意 URI。
- `availableActions` 已经过来源权利门禁。客户端不能因为拿到了电话或地址就自行开启复制、拨号或分享；Android 1.0 即使收到异常的 `share=true` 也必须由编译期门禁拒绝。
- 坐标 CRS 属于通用地理语义，不是供应商专有字段；任何转换都只在明确边界做一次。

## 5. Provider Adapter、Registry 与 Selector

### 5.1 Adapter 职责

每个 adapter 只负责：

1. 把标准化请求转换为该供应商正式接口的参数；
2. 保护 Key/签名、限定 HTTPS 主机、超时、响应体大小和重定向策略；
3. 把上游响应当作不可信输入，验证业务状态和字段范围；
4. 归一化为领域候选并写入字段 provenance；
5. 将上游错误映射为低基数、无敏感信息的标准错误分类；
6. 遵守该来源的最小字段请求和单次请求生命周期。

adapter 不负责：

- 决定全局排序权重；
- 把不同平台评分换算成一个公共评分；
- 决定收藏、历史、分享或模型输入是否允许；
- 直接写业务数据库；
- 向 Android 暴露原始供应商对象。

### 5.2 Registry

`ProviderRegistry` 以服务端受控配置注册 provider descriptor、adapter、健康检查器和权利策略引用。注册必须满足：

- provider ID 唯一；
- capability 与实际 contract tests 一致；
- 开发、测试、预发布、生产配置隔离；
- 真实来源未配置 Secret 或授权记录时不可进入 active 状态；
- Demo 只允许开发/测试，生产环境强制拒绝；
- Kill switch 能按来源和能力立即关闭，不需要发布新客户端。

不要提前注册“美团”或“大众点评”的假 adapter、假 endpoint 或永远返回空数组的生产能力。只有正式接口/交付文件、商务授权和实现验收都存在后，才加入可用 registry。

### 5.3 Selector

`ProviderSelector` 的输入至少包括：

- 用例与必要 capability；
- 覆盖地域；
- 用户同意状态与本次用途；
- 环境与功能开关；
- 当前授权范围和有效期；
- provider 健康、配额和延迟预算；
- 请求的数据字段和后续动作。

候选来源必须同时通过：

```text
eligible
= adapter supports capability
&& authorization allows operation/purpose/fields
&& authorization is not expired
&& user consent covers outgoing data
&& provider is enabled and healthy
&& quota/cost guard permits the call
```

选择顺序是可版本化的服务端策略，不写进 Android。初期可以只选择一个真实来源；引入多个来源后也不应默认全量并发，应按用途设置调用预算。

### 5.4 能力矩阵与远程状态

能力矩阵同时记录“adapter 是否实现”和“运行时是否有权启用”，不能把两者合成一个布尔值。以下是本文核对时的保守基线；实际运行状态必须从受控配置和授权台账读取：

| Provider | 地点文本搜索 | 附近餐厅 | 详情/路线 | 生产远程状态 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `AMAP` | 接入中 | adapter 已实现 | 尚未作为通用能力完成 | 默认 `disabled`；取得实时展示许可后最多升至 `live_only`；专项授权后按项 `licensed` | 技术事实以高德官方文档和契约测试为准；权利以实际合同/工单为准 |
| `DEMO` | 可作为本地回退实现 | 已实现 | 非真实能力 | `staging_only`，生产强制关闭 | 必须显著标为虚构演示数据 |
| 未来正式合作来源 | 未注册 | 未注册 | 未注册 | `disabled` | 未知能力不写入 registry，不承诺美团、大众点评或其他平台已可接入 |

同一 provider 的每个 capability 还应有独立状态。例如，`AMAP.PLACE_NEARBY_SEARCH=live_only` 不代表 `AMAP.ROUTE_ESTIMATE`、图片、收藏或分享已经可用。推荐的运行时配置粒度为：

```text
providerId + capability + environment
  -> implementationStatus
  -> remoteState
  -> authorizationReference / expiresAt / allowedPurposes / allowedFields / maxTTL
  -> health / quotaBudget
```

在管理后台提升状态时，系统应计算“远程状态”和“授权范围”的交集：运营可以暂停或降级一项已授权能力，但不能把未授权能力提升为可用。这样既不会把当前审慎策略固化为永久禁用，也不会为了可用性越过合同边界。

## 6. 数据权利策略

### 6.1 从全局模式迁移到逐项决策

现有 `LIVE_DISPLAY_ONLY` / `LICENSED_ENRICHMENT` 可继续作为迁移期的保守总开关，但不能作为多数据源最终权利模型。目标 `DataRightsPolicy` 每次决策至少接收：

```ts
interface RightsRequest {
  providerId: ProviderId;
  operation: "FETCH" | "DISPLAY" | "FILTER" | "DERIVE" | "RERANK" |
    "PERSIST_REF" | "CACHE_CONTENT" | "SHARE" | "MODEL_INFERENCE";
  fields: readonly string[];
  purpose: "LOCATION_SELECTION" | "MEAL_RECOMMENDATION" | "DETAIL" |
    "FAVORITE" | "HISTORY" | "NAVIGATION" | "SUPPORT";
  environment: "development" | "test" | "staging" | "production";
  requestedRetentionSeconds: number;
}

interface RightsDecision {
  effect: "ALLOW" | "DENY" | "REDACT" | "LIVE_ONLY";
  allowedFields: readonly string[];
  maximumRetentionSeconds: number;
  authorizationReference: string;
  expiresAt: string;
  policyVersion: string;
}
```

规则：

- 无记录、字段未列出、用途未列出、环境不匹配或授权过期时一律 `DENY`。
- 授权记录按供应商、运营主体、应用、Key/账号、能力、字段、用途、地域、期限分别归档。
- “允许重排”不推导出“允许缓存图片”；“允许保存 POI ID”不推导出“允许把内容发给模型”。
- 授权在异步调用期间过期时，以输出前再次评估的结果为准，必要时丢弃候选并安全失败。
- 合同/工单才是权利依据；环境变量和后台开关只是工程门禁，不能替代授权。
- 多来源响应中，每个字段和动作按其实际来源分别判断，不采用“最宽松来源覆盖其他来源”的策略。

### 6.2 缓存与留存基线

下表是默认上限，不是授权承诺。若供应商协议、书面许可、隐私政策或法律要求更严格，执行更严格者。

| 数据 | 未获专项授权的默认处理 | 获得书面许可后 | 删除/失效触发 |
| --- | --- | --- | --- |
| 用户精确位置 | 单次请求内存，推荐结束即释放；不进 URL/日志 | 原则上仍不持久化，除非产品用途和单独同意都成立 | 请求完成、取消或超时 |
| 手动地点搜索词 | 当前请求内处理，不进分析日志，不跨用户缓存 | 仅可按明确用途和期限处理 | 响应完成或取消 |
| 上游原始响应 | 只在 adapter 内存中解析，不落盘、不写 APM | 只在明确允许的环境、字段和 TTL 内；优先保存脱敏契约夹具而非用户响应 | TTL、授权到期、供应商删除通知 |
| POI 字段 | `LIVE_ONLY`，响应结束后释放 | 每个字段独立 TTL；显示时保留来源和更新时间 | TTL、授权到期、纠错/下线 |
| 稳定供应商 POI ID | 不跨请求持久化；公共 API 使用短期 token | 仅用于授权列明的收藏/历史/去重目的 | 账号注销、授权到期、用途结束 |
| 请求作用域 `resultToken` | HMAC/签名、短 TTL、限定请求和动作 | 不因授权放宽而默认延长 | TTL 或一次性动作完成 |
| 图片及 URL | 默认不请求、不代理、不缓存、不生成分享卡 | 分别确认展示、热链、代理、缓存、版权和下线规则 | TTL、下线通知、授权到期 |
| 电话、地址外传 | 可展示不代表可复制、拨号、分享或交给其他 App | 每项动作单独门禁并记录用户主动触发 | 请求/动作完成 |
| 派生距离、解释、适合度 | 未允许派生时不计算或只做明确许可的安全过滤 | 记录算法版本与输入来源，不反向声称为供应商事实 | 授权到期或输入来源删除 |
| 推荐行为事件 | 不包含精确坐标；仅使用请求作用域 token，不能形成外部 POI 库 | 跨请求关联必须单独获准并满足项目留存政策 | 项目 90 天上限或更短授权期限 |
| 授权与管理员审计 | 只保存授权元数据、决策和操作者，不复制 POI 内容 | 按合规留存要求保存 | 法定/项目期限届满 |
| 模型输入 | 默认禁止发送任何第三方 POI 内容 | 仅限书面允许的字段、用途、地域和模型数据政策；训练另行授权 | 单次推理完成及约定日志期限 |

任何缓存 key、队列 payload、错误对象、trace、SLS/APM 和备份都属于“存储”，不能只检查业务数据库。

## 7. 字段 provenance、冲突处理与实体去重

### 7.1 Provenance 不变量

每个外部事实至少记录：来源、源字段、获取时间、授权决策引用和置信度。每个派生事实至少记录算法版本和输入引用。公共展示可以简化，但服务端必须能回答：

- 这条价格/营业时间/评分来自哪里？
- 数据是什么时间获取的？
- 是来源事实还是项目推断？
- 当时依据哪条授权允许使用？
- 来源删除或授权终止时，需要删除哪些派生项？

不得用“字段被复制到 canonical 表”消除其来源属性。

### 7.2 同店识别

跨来源没有共享 POI ID。实体匹配只能使用在当前授权下允许比较的字段，例如规范化名称、地址、电话和同一 CRS 下的坐标距离，并输出匹配置信度。

建议分级：

- `EXACT`：同一来源且 external ID 相同；
- `HIGH`：多个强字段一致，且空间距离在经验证阈值内；
- `POSSIBLE`：只有名称近似或坐标接近；
- `DISTINCT`：强字段冲突。

只有 `EXACT/HIGH` 才可在单次请求内合并；`POSSIBLE` 应保留为独立候选或进入人工核验，不能为了“结果好看”强行合并。学校食堂档口、商场分店、同名连锁、店中店和搬迁门店是必须覆盖的反例。

实体匹配结果本身也是派生数据。是否允许跨请求保存跨平台映射，必须分别取得各来源授权；未允许时只能在当前请求内临时去重。

### 7.3 字段冲突

同一实体的字段冲突不得静默覆盖。选择展示值时按以下顺序：

1. 当前用途有权使用；
2. 来源明确且未过期；
3. 数据更新时间更近；
4. 字段完整、格式可验证；
5. 仍冲突时显示“信息可能有差异，请到店前确认”，或分别列出来源。

不得在核心代码中写死“高德优先”或“某点评平台优先”。字段选择策略必须版本化、可评测、可回滚，并保留最终展示值的 provenance。

### 7.4 评分绝不直接混算

不同平台的评分样本、量表、时间窗口、反作弊和用户群不同，因此：

- 保留为 `sourceMetrics`，显示“高德评分”等明确来源标签；未来其他来源同样独立显示。
- 不求平均、不相加、不取最高值后称为“综合评分”。
- 项目 `fitScore` 是“此刻对该用户的适合度”，必须与来源评分分栏、不同名称、不同说明。
- 若将来把多个质量信号用于排序，必须在书面授权允许后做离线校准，记录特征来源、缺失值策略、版本和公平性评测；用户可见解释不能伪装成某平台原始评分。
- 没有足够数据与授权时，宁可不显示/不使用，不用模型补全。

## 8. 多来源编排与故障隔离

每个 adapter 必须有独立的：

- 超时、并发上限、配额预算和熔断状态；
- 低基数错误分类与延迟指标；
- 功能开关和 kill switch；
- Secret、出口 IP、签名配置和轮换流程；
- 契约测试夹具与供应商状态告警。

编排规则：

1. 一次请求设置总延迟预算，再为每个来源分配子预算；不能让最慢来源拖过 API P95 目标。
2. 默认不对配额、参数、签名、Key 或授权错误自动重试；网络瞬态重试最多一次，并受幂等、退避和总预算约束。
3. 一个来源失败不能取消已完成且有权展示的其他来源；响应明确列出实际使用的来源和通用“部分来源暂不可用”提示。
4. 不把来源 A 的结果标成来源 B，也不在真实来源失败时自动返回演示餐厅。
5. 不使用超过 TTL、授权已过期或来源要求删除的数据作 stale fallback。
6. 先对每个来源做 schema/权利校验，再做跨来源去重和排序；任何非法候选只隔离本来源。
7. 多来源并发、候选上限和路线扇出由服务器策略控制，避免成本与配额失控。
8. 日志不记录 Secret、完整上游 URL、精确坐标、搜索词、稳定 POI ID 或原始响应；指标只用审核过的分类和数量区间。

当所有真实来源都不可用时，生产环境返回明确的可恢复错误或空结果说明；不得虚构事实，也不得让千问生成餐厅名称、营业时间或价格。

## 9. 公共 API 与 Android 边界

### 9.1 API

- 精确坐标与地点搜索词只放在 HTTPS 请求体，不放 URL、埋点、错误日志或 trace 标签。
- 地点搜索、附近餐厅和详情返回同一种通用 `source` 描述，不分别定义 `AmapLocation`、`MeituanPlace` 等公开 schema。
- 接口响应不暴露供应商 Key、签名、原始 URL、原始 JSON、内部 external ID 或授权记录。
- 每条结果通过请求作用域 `resultToken` 关联详情和事件；只有权利允许时才在服务端把 token 解析到稳定引用。
- 对外动作由 `availableActions` 明确列出。服务端在动作执行前再次检查 token、用户触发、授权和有效期。
- 若迁移期仍返回 `provider` / `dataSource` 枚举，新增来源不得驱动客户端业务分支；后续升级为通用 source descriptor。旧 API 版本保持兼容，不能静默改变字段语义。
- 混合来源下单一 `dataRightsMode` 只能表示最保守的兼容状态；真正的动作和字段门禁始终在服务端逐项执行。客户端不能根据该模式自行推导“允许收藏/分享”。

### 9.2 Android

- UI 只显示服务端返回的来源名称、说明、更新时间、置信度、警告和可用动作。
- 不按 `AMAP/MEITUAN/DIANPING` 编写推荐、详情、收藏或分享分支；供应商差异由通用 capability/action 表达。
- 不引入某供应商 SDK，除非产品功能确有必要，且完成单独隐私评估、SDK 清单、用户同意、授权和商店合规。
- 不保存原始地点搜索结果或稳定外部 ID；用户选中地点后只把当前决策需要的通用名称与显式 CRS 坐标保存在内存状态。
- 输入变化应取消旧搜索，丢弃晚到响应；空结果、部分失败和总失败使用通用状态。
- 来源标识不能被截断到不可识别；无障碍读屏必须能读出“数据来源”和“项目适合度”区别。
- 导航、电话和复制只展示服务端允许的动作。分享字段为 API v1 兼容而保留，但 Android 1.0 不展示入口、没有远程开关；供应商专用 scheme 必须来自受控实现与白名单，不执行任意字符串 URI。

## 10. 接入新数据源的验收清单

任何新来源（包括未来可能的美团、大众点评或其他平台）必须逐项完成，不能因为市场上能看到数据就跳过：

### 10.1 商务、权利与合规

- [ ] 存在由实际运营主体签署或书面确认的正式 API/数据交付与商业使用权；未虚构开放平台能力。
- [ ] 授权明确列出应用、账号/Key、环境、地域、能力、字段、展示、重排、派生、缓存、ID、图片、分享、模型、留存、删除和到期处理。
- [ ] 来源文案、Logo、链接、版权、审图号（如适用）和用户外传规则有书面结论。
- [ ] 隐私政策、第三方清单、PIA、用户同意和境内处理链路已更新。
- [ ] 终止/到期后的主库、缓存、队列、日志、备份和派生数据删除流程已演练。
- [ ] 明确禁止抓取、模拟登录、Cookie 复用、逆向私有接口及其他绕过方式。

### 10.2 工程实现

- [ ] adapter 是独立模块，只依赖通用领域端口；公共 contract 和 Android 无供应商专有字段。
- [ ] Key/签名仅在服务端密钥系统，分环境、可轮换，主机白名单和出口策略已配置。
- [ ] 请求字段最小化，HTTPS、超时、响应大小、重定向、编码和业务状态全部校验。
- [ ] 成功、零结果、缺字段、类型漂移、超时、限流、配额、Key、签名和超大响应均有契约测试。
- [ ] 每个标准化字段都有 provenance；不存在模型补全外部事实。
- [ ] capability 声明与真实测试一致，registry 未把未实现能力标为可用。
- [ ] 权利策略覆盖每个 operation/field/purpose，缺省拒绝，授权到期可热降级。
- [ ] 跨来源去重覆盖同名连锁、商场分店、档口、店中店、搬迁和坐标偏差反例。
- [ ] 评分保持来源独立；适合度与来源评分在 schema、UI 和无障碍文案中可区分。

### 10.3 运行与发布

- [ ] 独立限流、配额、熔断、告警、成本预算和 kill switch 可用。
- [ ] 日志/APM/网关实测不含 Secret、完整 URL、搜索词、精确坐标、稳定 POI ID和原始响应。
- [ ] 预发布使用独立凭据和授权测试样本，完成真实响应与坐标系校验。
- [ ] 部分来源失败、全部失败、授权运行中到期和供应商删除通知均通过演练。
- [ ] 黄金场景回归证明预算、距离、营业和多样性指标不倒退；没有付费来源暗改自然适合度。
- [ ] 上线采用小流量功能开关，可立即退回上一个健康、合规的数据源组合。

未完成任何一项 P0 权利或安全门禁时，保持 provider disabled；不得用“先灰度看看”替代授权。

## 11. 迁移路线

### 阶段 0：维持当前安全基线

- 高德按 [`AMAP_API_INTEGRATION.md`](./AMAP_API_INTEGRATION.md) 的许可、Key、日志和 `LIVE_DISPLAY_ONLY` 要求联调。
- 生产禁止 Demo；没有合法真实来源时安全失败。
- 不因本架构文档存在而宣称多平台数据已接入。

### 阶段 1：公共契约去供应商专有化（主体已完成）

- 已新增受限可扩展来源代码、请求作用域 `resultToken`、逐项 `actions` 和显式 CRS；结构化 `PublicSource` 仍是后续可选增强。
- 当前仍是未公开 Alpha，可在 API v1 冻结前直接移除稳定 ID；Android 新代码只使用通用来源描述和动作，不按 provider 名称分支。
- Location Search 与 Recommendation 共用 source 表达，不把高德响应字段扩散到客户端。

验收：静态检查确认供应商名称只存在于 adapter、注册配置、来源展示数据和供应商契约测试；领域/Android 业务层不存在供应商专有字段类型。

### 阶段 2：Registry 与能力选择

- 把当前单例 `PLACE_PROVIDER` 迁移为 registry + selector。
- 分离地点搜索、附近餐厅、详情、路线等 capability。
- 建立每来源独立超时、配额、熔断与 kill switch。

验收：同一用例可在不修改领域层/Android 的情况下切换合规测试 adapter；无健康来源时生产安全失败。

### 阶段 3：逐供应商权利策略

- 将全局 `DataRightsMode` 降为总门禁/兼容字段，新增 provider-operation-field-purpose 决策。
- 授权引用、范围、到期时间和删除义务进入可审计配置。
- 字段、动作、缓存、事件和模型输入全部调用权利策略。

验收：混合授权矩阵、运行中到期、缺失记录和紧急撤权测试均默认拒绝；无客户端更新即可关闭单项能力。

### 阶段 4：字段 provenance 与跨来源治理

- 候选字段改为 `ProvenancedValue`，派生值记录输入和算法版本。
- 引入请求内实体匹配、冲突提示和来源独立评分。
- 未取得持久化映射权时，不保存跨平台实体关联。

验收：任一用户可见外部事实都能追溯来源；同店错误合并率和重复率进入黄金测试集；评分不混算。

### 阶段 5：第一个新增真实来源

- 仅在正式 API/商务授权和第 10 节清单完成后开发 adapter。
- 先在预发布和小流量下验证，再按地域/用例逐步启用。
- 初期可只做单来源选择；多来源融合必须在 provenance、去重、权利和成本验证后单独开关。

验收：移除/关闭新增 adapter 后，核心推荐、Android 和公共 API 无需改写；授权到期时能自动、可观测地退出。

## 12. 架构验收不变量

CI、契约测试和上线门禁最终应固定以下不变量：

1. 供应商原始类型、endpoint 和字段名不会越过 adapter 边界。
2. Android 包和公共 API 不含服务端 Secret，不要求客户端理解供应商专有字段。
3. 每次真实调用都能追溯 provider、capability、权利决策和策略版本，但日志不含精确位置或原始 POI 内容。
4. 权利缺失、过期或撤销时默认拒绝，且不会用缓存、事件库或模型输出绕过。
5. 每个外部事实有 provenance；每个派生事实能说明算法版本和输入来源。
6. 不同来源评分始终独立，`fitScore` 始终明确为“吃什么”的此刻适合度。
7. 一个来源故障不会污染其他来源、触发重试风暴或使 Demo 混入生产。
8. 跨来源实体匹配不确定时保留独立结果，不静默错误合并。
9. 精确位置不落库，搜索词不进分析日志，稳定 external ID 的留存必须有专项授权。
10. 新来源只通过正式、授权的渠道接入；没有授权时不承诺美团、大众点评或任何其他平台能力。

这组不变量比“支持了几个平台”更重要。只有供应商可以被替换、禁用和逐项撤权，而核心决策流程仍保持一致，系统才真正具备可更新性、合规性和长期扩展能力。
