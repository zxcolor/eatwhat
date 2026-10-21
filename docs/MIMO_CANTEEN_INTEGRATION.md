# MiMo 食堂决策接入

本地代码版本：小程序 `0.1.23-alpha`。仅接入小米 MiMo；不接入 DeepSeek，也不将其作为备用供应商。现有附近餐厅的千问意图接口不属于本次食堂路径。

## 调用流程

小程序用户单独同意 MiMo 数据处理后，点击食堂决定按钮，调用自有 `POST /v1/canteen/decisions`。请求仅包含菜单版本、请求标识、偏好修订、辣度 0–6、口味轻重 0–100、本轮已展示菜品 ID，以及本版同意声明。没有自由文本提示、账号、设备或定位字段；请求校验拒绝额外字段。

服务端从构建时固化的公开菜单中移除已展示菜品，只把剩余候选和两项偏好发送给 MiMo。模型输出只有 `selectedItemId`，必须属于本次剩余候选；客户端再次校验请求、菜单和偏好修订，再从自己的菜单读取名称与价格。原始模型文字、推理过程不进入界面、业务日志或数据库。无菜单属性支持时，结果明确标为菜单名称层面的建议，不是精确口味或食材保证。

没有同意、已关闭 MiMo、网络失败、服务未部署或返回无效时，仍可通过原单按钮本机决定；服务端也在关闭、容量耗尽、上游失败和输出不合规时返回明确的 `LOCAL` 来源。不会把规则结果标为 MiMo 成功。页面隐藏、偏好变化、关闭 MiMo或撤回同意，会取消未完成的客户端请求并拒绝旧响应。已发往供应商的请求无法撤回。

## 官方接口

- 地址固定为 `https://api.xiaomimimo.com/v1/chat/completions`，不接受客户端或环境变量指定其他主机；HTTP 重定向关闭。
- 默认 `mimo-v2.6-flash`，允许显式改为 `mimo-v2.6-pro`。
- 认证：服务端 `api-key` 请求头。
- 单轮非流式，`thinking.type=disabled`，`response_format.type=json_object`，输出上限 256 tokens。
- JSON 模式只处理格式；仍单独执行结构、结束状态及候选成员校验。

依据：[官方 Chat Completions](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[官方结构化输出](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/structured-output)。

## 本机配置

将 `.env.local.example` 复制为被 Git 忽略的 `.env.local`，仅在本机填写：

```dotenv
MIMO_ENABLED=true
MIMO_API_KEY=
MIMO_MODEL=mimo-v2.6-flash
MIMO_TIMEOUT_MS=8000
MIMO_MAX_CALLS_PER_MINUTE=30
MIMO_MAX_CONCURRENCY=4
```

不要把真实密钥发到聊天、提交 Git 或写进小程序。`scripts/start-api-local.ps1` 已纳入 MiMo 白名单，只有启用时才把密钥注入 API 进程；构建进程不接收它。

本机填写密钥不等于公网服务已启用。小程序仍访问 `https://api.eatwhat.pro`，因此后续需要将本次服务端代码及受控配置部署到该服务，才会由这套小程序实际调用 MiMo。2026-10-21 已启动本机 API 并完成真实 MiMo 调用；公网接口尚未部署，未上传小程序。

## 部署与回滚

ECS 的非秘密开关在 `deployment.env`，密钥仅放入既有 root-only `secrets/api.env`。Compose 只把该文件交给公开 API。预检保留既有严格密钥门禁，增加 MiMo 精确字段及离线配置校验；未实际执行预检。默认关闭，未设置开关的旧部署配置仍视为关闭。

从尚未激活的候选 release 使用 `scripts/update-mimo-secrets.sh --enable --key-file /root/private/mimo-key` 更新配置；密钥输入须为 root:root、0600 的单行文件。该入口持有既有 mutation 锁，验证 bundle 摘要，原子替换环境文件并执行严格预检；失败时恢复原文件，不重启服务。禁用使用 `--disable`，保留未使用的密钥以便恢复。激活继续走既有备份、备份校验与 `activate-candidate-release.sh`；准备同一新镜像、MiMo 关闭的独立恢复候选，避免旧脚本不识别新增配置字段。

每个客户端 IP 每分钟最多 12 次食堂接口请求。每 API 进程默认最多 30 次模型调用/分钟、4 个并发，超时 8 秒；这些是单实例限制，不是跨实例或跨重启的财务预算。还应在供应商控制台设置账户消费额度。禁用 `MIMO_ENABLED` 或在小程序设置关闭 MiMo即可回到规则路径。回退到旧部署脚本前须处理其不识别的新环境字段，不能直接混用新 Secret 文件和旧脚本。

当前推荐菜单来源仍为 `apps/wechat/data/canteen-menu.json` 与默认候选配置，服务端使用由同一来源生成的 `packages/contracts/src/canteen-catalog.ts`。更新菜单时同步提高菜单版本并更新两端数据；现有菜单导出脚本已扩展为同步服务端目录。

## 本次执行边界

初次编码阶段按用户要求仅修改代码并静态阅读，没有运行测试或模型调用。用户随后填写本机密钥并要求启用，已将私有配置中的 `MIMO_ENABLED` 改为 `true`，通过既有隔离启动器完成 API/共享契约编译；启动器的开发监听在首次加载依赖时重启，随后使用同样的最小运行环境直接启动编译产物，进行真实接口联调。

2026-10-21 20:56（北京时间），使用合成的辣度 2、口味轻重 50 和当前公开菜单请求本机 `POST /v1/canteen/decisions`：HTTP 200，`source=MIMO`，`model=mimo-v2.6-flash`，`fallbackReason=null`，返回当前菜单中的 `hanshi-banfan-014`（鸡肉石锅拌饭），约 3.8 秒。该结果仅证明本机实际 API 到 MiMo 的调用和候选 ID 校验成功，不代表真实用户效果或公网接通。

同轮公网读取：`/health/ready` 返回 200，`/v1/canteen/decisions` 返回 404。未运行完整 `verify.ps1`、单测、lint、模拟器验证或 GitHub CI；未提交、推送、合并或部署。实际密钥只留在被忽略的本机环境文件中，不出现在证据文件中。
