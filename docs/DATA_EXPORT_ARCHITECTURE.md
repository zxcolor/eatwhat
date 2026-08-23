# 数据导出交付架构

## 目标与边界

Android 1.0 的账号数据导出采用“API 排队、独立 worker 生成、私有对象存储、同一 Bearer 请求代理下载”的边界。客户端不会收到 OSS object key、签名 URL、下载 token、加密 locator、数据库密钥版本或 worker lease 标识。

能力使用两个独立部署开关：`DATA_EXPORT_ENABLED` 表示 API/OSS/密钥配置完整，`DATA_EXPORT_WORKER_READY` 表示独立 worker、最小权限数据库角色、RAM 策略和告警已通过部署探针。后者不是自动健康检查；只有运维确认 worker 实际就绪后才可置为 `true`。任一为 false 时公开配置不宣传能力，导出端点统一 fail-closed。

导出任务从请求时间起保留 7 天。对象必须存放在 App 自有私有桶中并启用服务端加密；API 只在任务属于当前 Bearer 用户、状态为 `READY`、尚未过期且对象未被删除时，才可以通过内部 artifact reader 代理内容。响应文件名由 API 固定为安全 ASCII 名称，不采信数据库或对象元数据中的任意文件名。

## 数据库角色

| 角色 | 基表权限 | 允许的导出能力 |
|---|---|---|
| `api_runtime` | 对 `data_export_jobs` 为 0 | 排队、读取公开状态、在同一 Bearer 请求内打开已授权 artifact |
| `data_export_worker` | 只读非敏感 `schema_migrations` 以执行启动版本门禁；对用户、身份、收藏、历史、反馈、导出任务基表均为 0 | 查询最小化的 locator/反馈加密 key-version 覆盖集；领取/续租 lease、生成受控快照、完成或失败、删除过期 artifact |
| `retention_worker` | 对导出任务基表为 0 | 固定保留期清理、完成满足门禁的账号注销 |
| `admin_api_runtime` | 对导出任务和个人数据基表为 0 | 无导出能力 |
| `schema_migrator` | 迁移所有者 | 仅受控迁移和授权部署 |

所有导出函数均为 `SECURITY DEFINER`，并固定 `search_path = pg_catalog, public`。`role-grants.sql` 在同一事务内先收回所有历史表、列、序列和函数权限，再应用函数白名单。

## API 函数

### 排队

```sql
public.app_queue_data_export(
  p_user_id uuid,
  p_export_id uuid,
  p_include_behavior_history boolean
)
RETURNS TABLE(
  outcome text,
  export_id uuid,
  export_status text,
  include_behavior_history boolean,
  requested_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  failure_code text,
  artifact_size_bytes bigint,
  artifact_sha256 varchar
)
```

`outcome` 只有 `CREATED`、`REPLAY`、`CONFLICT` 和用户状态竞态下的 `INVALID_USER`。函数用每用户 advisory transaction lock 串行化并发请求；同一尚未开始处理的请求可安全重放。数据库内部 `PENDING` 对外映射为 `QUEUED`。

### 状态

```sql
public.app_get_data_export_status(p_user_id uuid, p_export_id uuid)
public.app_get_latest_data_export_status(p_user_id uuid)
```

两者只返回公开状态列与 `include_behavior_history`，不返回 locator 或密钥版本。指定任务不存在或不属于用户时返回 0 行，API 统一按 404 处理，避免所有权探测。即使保留期任务尚未运行，时间已经到期的记录也会逻辑映射为 `EXPIRED`。

### Bearer 代理读取

```sql
public.app_open_data_export_artifact(p_user_id uuid, p_export_id uuid)
RETURNS TABLE(
  artifact_locator_ciphertext bytea,
  artifact_encryption_key_version varchar,
  artifact_size_bytes bigint,
  artifact_sha256 varchar,
  artifact_content_type varchar,
  artifact_filename text
)
```

这是 API 唯一能获得加密 locator 的函数。它只在 owner、`ACTIVE`、`READY`、未过期、未删除全部满足时返回一行。返回值只能传给服务器内部 artifact reader；controller 禁止序列化这些字段。reader 必须校验实际字节数和 SHA-256，再以 `no-store`、固定文件名、固定 `application/json` 代理响应。数据库返回的 `artifact_filename` 仅用于诊断，API 不采信它。

每个 API 进程固定最多持有 4 个已验证下载槽。槽从 reader `open` 开始占用，覆盖 OSS 读取、最多 10 MiB 的完整缓冲校验以及实际 HTTP 传输；第 5 个并发请求在接触 OSS 前立即按 503 fail-closed，不排无限等待队列。因此工件正文的进程级常驻上限约为 40 MiB。reader 只把同一个已验证 Buffer 交给响应流，不再复制第二份完整正文；Nest/Express 将流 pipe 到真实 `ServerResponse` 后，只有目标响应 `finish`、`close` 或 `error` 才会清零 Buffer 并释放槽，不能因 source stream 提前 `end` 而让慢客户端绕过上限或读到被提前清零的字节。pipe 在注册监听前和注册后都会拒绝已经 `destroyed`、`closed`、`writableEnded`、`writableFinished`、`writableAborted` 或 `errored` 的目标并立即清理，覆盖客户端在 OSS 预取期间已经断开的竞态，且绝不向旧响应写入正文。未进入 HTTP pipe 的内部消费者则在 body 被消费、关闭或销毁时完成相同清理。所有校验、OSS 和传输失败路径都只能释放一次。

Controller 在解析 Bearer 和进入数据库/OSS 预取之前即启动两层 HTTP 期限。`DATA_EXPORT_DOWNLOAD_TOTAL_TIMEOUT_MS` 是独立绝对计时器，默认 120 秒、允许 30–300 秒，不能只依赖 socket 空闲语义；`DATA_EXPORT_DOWNLOAD_IDLE_TIMEOUT_MS` 使用 `ServerResponse.setTimeout` 限制无传输进展的连接，默认 15 秒、允许 5–60 秒且必须小于绝对期限。任一期限触发都会先幂等清除绝对 timer、socket timeout 与全部生命周期 listener，再 destroy 响应；若完整校验的 body 随后才从预取返回，Controller 会立即 destroy body 释放 reader 槽而不设置响应头。正常 `finish`、客户端 `close` 或传输 `error` 同样清除所有 timer，绝对 timer 使用 `unref`，不会形成永久事件循环句柄。这两个变量只属于公开 API 进程；Docker 的 worker service 不转发它们，worker 的严格环境白名单也不接受它们。

API 在调用 reader 后无论成功或失败，都在 `finally` 中清零数据库返回的 locator ciphertext。Android 只使用固定 32 KiB 复制缓冲区写入 Storage Access Framework，独立校验长度和 SHA-256，并在成功、校验失败、I/O 异常或协程取消的 `finally` 路径中清零该复制缓冲区。

本方案不创建预签名 URL、Bearer 等价下载 token 或可复制的长期下载地址。

## Worker 函数与 fencing

```sql
public.export_claim_next_job(varchar, varchar, integer)
public.export_renew_job_lease(uuid, varchar, varchar, bigint, integer)
public.export_artifact_required_locator_key_versions()
public.support_feedback_required_key_versions()
public.export_stage_job_artifact(
  uuid, varchar, varchar, bigint, bytea, varchar, varchar, bigint, varchar
)
public.export_build_safe_snapshot(uuid, varchar, varchar)
public.export_complete_job(uuid, varchar, varchar, bigint)
public.export_fail_job(uuid, varchar, varchar, bigint, varchar, boolean)
public.export_claim_next_artifact_deletion(varchar, varchar, integer)
public.export_mark_artifact_deleted(uuid, varchar, varchar, bigint)
```

worker 标识在进入数据库前做 HMAC-SHA256；数据库只保存 64 位小写十六进制 HMAC、算法和密钥版本。lease 为 30–900 秒，领取任务会增加 `attempt_count` 和单调 `state_version`。续租、完成、失败和删除标记都必须同时匹配：

- 任务 UUID；
- lease owner HMAC 与 key version；
- 当前 lease purpose（`BUILD` 或 `DELETE`）；
- 尚未过期的 lease；
- 调用方持有的 `state_version` fencing token。

任何不匹配均返回 0 行。对象 key 由 export UUID 确定性派生，且在上传前已由 stage 写入数据库；完成结果为 0 行或响应不确定时，worker 不得直接删除这个可能已被另一事务标记 READY 的对象，而应保留可追踪的 staged locator，交给后续 fenced 重试或删除 lease 收敛。

更重要的是，worker 必须先构建严格快照并算出正文，再在向 OSS 上传任何字节前调用 `export_stage_job_artifact`，把确定性 object key 的加密 locator、正文 SHA-256、size 和固定 content type 原子写入数据库。stage 同样受有效 BUILD lease 和 `state_version` 约束，并对“提交成功但响应丢失”提供整组期望值完全相同的幂等重放。stage 后 locator 与全部完整性元数据永久不可换；`export_complete_job` 只能把已冻结且已验证的任务转为 `READY`，不能补写或更换工件元数据。这样即使上传成功后 lease 丢失且即时 OSS 删除失败，账号注销和删除 worker 仍能看见并阻断这份对象，不会产生数据库之外不可追踪的个人数据。

重领一个已 stage 的任务时，worker 先以冻结的 size/SHA-256/content type 打开相同 object key 并完整校验。对象完全匹配时直接完成数据库状态，不再生成或 PUT；对象不可确认或尚不存在时，只允许重新生成字节完全相同的正文后执行禁止覆盖 PUT。若当前数据生成的正文与冻结值不同，任务以固定 `ARTIFACT_VERIFY_FAILED` 收敛，绝不能用新正文覆盖旧 key。`generatedAt` 固定取任务创建时间，避免单纯重试时间变化破坏可复现性。

可重试失败会保留 staged locator 并回到 `PENDING`，下一次 claim 会返回同一加密 locator，worker 必须复用同一对象 key。带 staged locator 的 fatal 失败进入 `EXPIRED`；账号不再 ACTIVE、尝试耗尽或任务到期且 lease 已失效时，删除 worker 也可将其转为 `EXPIRED` 并领取 DELETE lease。账号进入注销流程后，已经 `READY` 且不再允许下载的 artifact 也会立即进入删除候选，而不必继续等待 7 天窗口结束。

如果账号在 stage 之前进入非 ACTIVE 状态，删除 worker 的领取函数会先把无 locator 的 `PENDING`/`PROCESSING` 行原子取消为 `FAILED`，写入系统专用 `ACCOUNT_DELETION_REQUESTED` 失败码、清空 lease 并提升 `state_version`。这会 fence 掉仍持有旧版本的 builder；因为协议禁止 stage 前上传，所以此分支没有对象需要删除。只要 locator 已存在，该快速取消分支就绝不适用，账号注销仍必须等待对象存储删除和 `artifact_deleted_at` marker。

任务最多尝试 5 次。失败码被数据库限制为固定 allowlist；可重试失败回到 `PENDING`。没有 staged locator 的最终失败进入 `FAILED`；已经 stage 的任务必须进入 `EXPIRED` 并完成对象删除，不能用失败状态绕过 artifact 清理。到期任务同样进入 `EXPIRED`。

## Worker-only 快照

`export_build_safe_snapshot` 只在有效 `BUILD` lease 下返回 JSONB。它不授予 worker 任何相关基表 SELECT。中间快照顶层固定为：

```text
schemaVersion
generatedAt
account
identities
favorites
recommendationHistory
privateFeedback
preferences
supportFeedbackEncrypted
```

公开字段只包含：

- App 自有账号 UUID、账号状态和创建时间；
- identity 类型、已脱敏展示 hint、主身份标记和验证/创建/撤销时间；
- 收藏 UUID、分组、创建时间和引用是否仍可用；
- 用户允许时的推荐行为类型、餐段和时间；
- 用户允许时的私有反馈类型和时间；
- 当前服务端偏好对象。

Android 1.0 的偏好仍为本地数据，服务端尚无偏好表，因此数据库固定返回空对象 `{}`，而不是暗示已导出不存在的数据。`include_behavior_history=false` 时 `recommendationHistory` 和 `privateFeedback` 固定为空数组；收藏仍属于用户主动保存的数据并正常导出。

数据库在任何 `jsonb_agg` 前先用用户维度索引和 `LIMIT max+1` 做硬数量预算：身份 32、收藏 1000、推荐历史 5000、私有反馈 2000、support feedback 100；worker 的 Zod 边界使用相同 `.max` 再校验一次。任一预算超限统一映射为不可重试的 `SNAPSHOT_TOO_LARGE`，且发生在 stage/PUT 之前。推荐历史只导出 `retain_until > now()` 的逻辑有效记录；support feedback 只导出 `retain_until IS NULL OR retain_until > now()` 的记录，不能因物理清理尚未运行而泄露逻辑过期数据。

快照禁止 provider code、provider place ID、餐厅名称/地址、坐标、provider subject、lookup/dedup/correlation HMAC、Token、OTP、管理员审计和内部请求元数据。

用户提交的 support feedback 正文是个人数据。数据库只向 export worker 返回有账号归属的加密记录：feedback UUID、类别、状态、时间、受长度约束的 Base64 ciphertext 和加密 key version。worker 必须使用现有 `SupportFeedbackKeyRing` 解密，然后严格重建最终的：

```json
{
  "supportFeedback": [
    {
      "feedbackId": "uuid",
      "category": "PRIVACY",
      "status": "OPEN",
      "createdAt": "ISO-8601",
      "message": "用户原文"
    }
  ]
}
```

`supportFeedbackEncrypted`、ciphertext、Base64 和 key version 绝不能写入最终 artifact。解密失败必须让任务按固定错误码失败，不能上传部分或混合格式文档。

## Artifact 完整性与删除

可下载 artifact 必须同时具有：

- 16–4096 字节的加密 app-owned locator；
- locator 加密 key version；
- 64 位小写十六进制 SHA-256；
- 1–10 MiB 的字节数；
- 固定 `application/json`；
- 同一数据库时间写入的 `ready_at` 与 `completed_at`。

这些元数据在首次完成后不可变。过期 artifact 由独立 `DELETE` lease 领取，但 OSS 返回“对象已删除/不存在”不再代表清理完成：只有同一个 object key 已被永久、固定、无 PII 的 tombstone 占据，并经 HEAD 复核服务端 MD5、长度、固定 tombstone content type、`no-store` 和 `AES256` 后，worker 才能调用 `export_mark_artifact_deleted`。数据库保留 marker，后续 retention cleanup 才可删除任务元数据；tombstone 永久保留，生命周期规则不得清除，也不会被后续幂等删除任务再次删除。

上传使用禁止覆盖、私有 object ACL、`Content-MD5` 传输校验、自定义 SHA-256 元数据、固定 `application/json`、`no-store` 和 OSS `AES256` 服务端加密。API 与 worker 的 RAM 策略都必须具有最小范围的 `GetBucketVersioning` 和 `GetBucketLifecycle` 权限；启动时先确认 OSS 返回“从未启用版本控制”的状态：SDK/解析器中的 `Status` 只能是 absent、`null` 或空字符串，不能把字面字符串 `Disabled` 当作安全状态；`Enabled`、`Suspended`、其他未知值、权限不足、超时或解析异常一律 fail-closed。随后查询生命周期配置，只有精确的 HTTP 404 + `NoSuchLifecycle` 才表示专用桶从未配置 lifecycle 并允许就绪；任何 HTTP 200（包括空数组、`null` 或禁用规则）、403、未知结构、超时或解析异常都拒绝启动。OSS 一旦启用版本控制只能切换到 `Suspended`，因此误启用后不能复用原桶；专用桶也不得配置任何会改变对象的 lifecycle，必须创建并验收干净私有桶。worker/部署角色不得拥有 `PutBucketVersioning` 或 `PutBucketLifecycle`，并应持续监控桶配置漂移，避免启动检查后的外部变更绕过永久墓碑门禁。PUT 成功后 worker 必须再执行 HEAD，复核对象长度、内容类型、缓存策略、下载文件名、服务端 Content-MD5/ETag、SHA-256 元数据和服务端加密标记；任一不符都不能进入 READY。遇到禁止覆盖冲突时不能只相信可由上传者设置的 SHA-256 元数据：必须匹配 OSS 的 Content-MD5/单段 ETag；若服务端未返回可比较的 MD5，则最多下载 10 MiB 并重新计算 MD5、SHA-256 和实际长度，完全一致后才可视作幂等重试。下载 API 同样先在服务端完整缓冲最多 10 MiB，严格验证实际长度和 SHA-256 后才创建响应流；失败时 `open` 直接拒绝，不向客户端下发任何对象字节，Android 再独立计算 SHA-256，形成三层完整性校验。

独立导出 worker 的环境边界采用两个“精确名称集合”，不是敏感词、正则或前缀黑名单。业务集合只含：导出专用数据库 URL/TLS 与生产目标/角色声明、`DATA_EXPORT_*` 中 worker 实际读取的参数、locator 密钥环、反馈 AES 解密密钥环，以及具名 OSS ECS RAM 角色的三个 IMDS 安全开关。运行时集合只含固定列举的 Node/基础镜像和本地 Windows 启动变量；`LC_ALL`、`LC_CTYPE`、`LC_MESSAGES` 等 locale 名称也是逐项列举，不接受任意 `LC_*`。任何其他非空环境变量一律在连接数据库、访问 OSS 或领取任务前拒绝，即使它叫普通的 `FEATURE_FLAG`，因此 `SENTRY_DSN`、`STRIPE_KEY`、`MY_SENSITIVE_MATERIAL`、`KUBERNETES_SERVICE_HOST` 同样不能静默进入进程。

静态 AccessKey、默认 profile、凭据文件/URI、代理、`NODE_OPTIONS`、API/auth/OAuth/admin/反馈 HMAC/高德/千问配置均不在许可集合中。OSS 凭据固定构造为具名 `ecs_ram_role`，强制 IMDSv2 并关闭 IMDSv1，不使用默认凭据链中的环境 AccessKey 或本地 profile。生产启动器必须从空环境（Linux 使用 `env -i` 或具备同等语义的进程管理器）重建精确环境，不能把宿主环境、整份 ConfigMap/Secret 或 shell 会话直接继承给 worker。Kubernetes Pod 必须同时设置 `enableServiceLinks: false`，并通过固定名称的逐项 `env` 投影；由于集群仍可能注入自身变量，镜像入口仍需以 `env -i` 等价方式只转交许可名称。应用内的严格检查是第二道 fail-closed 门禁，不能替代部署侧净化。

worker 在打印“已就绪”或领取任务前必须通过两个数据库 key-coverage 门禁：`export_artifact_required_locator_key_versions()` 只返回尚未写入删除 marker 的 locator 所需 distinct key version；现有 `support_feedback_required_key_versions()` 只取 `key_purpose='ENCRYPTION'`。两者只授权给独立 export worker（反馈函数保留 API 自身既有启动用途），不授予 maintenance/admin；任一返回版本未被对应的 locator ring 或仅含 AES encryption 的 feedback ring 覆盖时，worker 启动 fail-closed。

密钥轮换 SOP：先把新版本加入密钥环并部署所有 reader/worker，确认 coverage 门禁全绿；再切换 active version 生成新密文；保留旧版本直到数据库门禁不再返回它（locator 必须已经 tombstone 并写 marker，反馈必须已按现有 rewrap/retention 流程消除引用）；最后才从配置移除旧 key。不得先删旧 key、不得用 HMAC ring 代替反馈 encryption ring，也不得通过跳过启动门禁强行发布。

删除与迟到上传之间必须收敛到 tombstone：worker 先删除旧对象，再以 `x-oss-forbid-overwrite=true` PUT 固定 tombstone。若迟到的旧 BUILD lease 先写回个人数据，tombstone PUT 会得到精确的 `FileAlreadyExists`；清理流程 HEAD 发现现有对象不是经验证的 tombstone 后，重新执行 DELETE→PUT。每个导出任务最多存在 5 个旧 BUILD attempt，因此单次清理最多做 5 轮替换；仍未占据 key 时 fail-closed，不写 deleted marker，留给后续 lease 重试。若 tombstone 先赢，所有迟到个人 PUT 都因禁止覆盖而失败，`putArtifact` 在 HEAD 看到 tombstone 时必须返回完整性失败。其他 409、未知对象状态或反复竞态均不能报告删除成功。

账号注销采用 fail-closed：尚未由清理 worker fence 的 `PENDING`/`PROCESSING` 任务，或任何 locator 尚无 `artifact_deleted_at` marker 时，`complete_account_deletion` 返回 false。stage 前的无 locator 任务可按上节规则安全取消；stage 后永远不能跳过对象删除。数据库不会用 `ON DELETE CASCADE` 隐藏一个仍可能存在的对象。

## 迁移与运维

0006 之前的 `READY` 行没有独立验证过的 checksum 和 size。迁移不会伪造这些元数据，而是将其变为不可下载的 `EXPIRED`，由 artifact deletion worker 删除。旧 `PROCESSING` 行没有 fencing lease，会安全回到 `PENDING`。

`execute_retention_cleanup` 会先提高 `state_version` 并终止到期的 in-flight lease，再删除没有 artifact 或已经确认删除 artifact 的 7 天元数据。带未删除 locator 的记录始终保留供删除 worker 处理。

CI 必须在真实 PostgreSQL/PostGIS 上验证：

- 五个数据库角色彼此独立、无超级权限或角色继承；
- API、worker、maintenance 和 admin 对导出任务基表及敏感列权限均为 0；
- worker 不能直接读取用户、身份和反馈基表；
- API 和其他角色不能调用 worker snapshot；
- stale fencing token 无法完成任务；
- `include_behavior_history=false` 在存在有效行为记录时数组仍为空，`true` 时只导出未逻辑过期记录；
- 五类快照数量预算及 worker 端 Zod 上限一致，超限为不可重试 `SNAPSHOT_TOO_LARGE` 且不触发上传；
- support ciphertext 只出现在 worker-only 中间快照；
- worker 启动密钥环覆盖 locator 与 support encryption 的全部 retained key version，缺旧 key 时拒绝就绪；
- 非 owner 或过期任务无法打开 artifact；
- PUT 成功但 complete 未确认可由新 worker 校验同一对象并直接完成；不同重建正文不得覆盖；
- 墓碑先赢时暂停的旧 PUT 无法恢复个人对象，且未验证墓碑时绝不写删除 marker；
- 未删除 artifact 阻止账号注销，删除 marker 后才能完成。
