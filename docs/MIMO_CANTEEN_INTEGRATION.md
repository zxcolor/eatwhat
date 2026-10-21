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

本机填写密钥不等于公网服务已启用。小程序访问 `https://api.eatwhat.pro`，服务端代码和受控配置必须部署到该服务。已完成本机 API 和生产同网络内候选镜像的真实 MiMo 调用，公网激活与小程序运行时结果以本次发布 PR 的最终记录为准。微信平台上传、体验版设置与真机验收分别记录。

## 部署与回滚

ECS 的非秘密开关在 `deployment.env`，密钥仅放入既有 root-only `secrets/api.env`。Compose 只把该文件交给公开 API。预检保留既有严格密钥门禁，增加 MiMo 精确字段及离线配置校验。默认关闭，未设置开关的旧部署配置仍视为关闭。

首次启用前，先从 `/opt/chi-shen-me/current/deploy` 完成活动版本的数据库备份与备份校验，再改变共享 Secret。备份脚本明确拒绝候选目录；提前加入 `MIMO_API_KEY` 会使不认识该字段的旧活动预检无法通过。

备份校验成功后，从尚未激活的候选 release 使用 `scripts/update-mimo-secrets.sh --enable --key-file /root/private/mimo-key` 更新配置；密钥输入须为 root:root、0600 的单行文件。该入口持有既有 mutation 锁，验证 bundle 摘要，原子替换环境文件并执行严格预检；失败时恢复原文件，不重启服务。禁用使用 `--disable`，保留未使用的密钥以便恢复。准备同一新镜像、MiMo 关闭的独立恢复候选，再走 `activate-candidate-release.sh --rollback-release <恢复候选>`；不修改活动 release 或放宽旧预检。

每个客户端 IP 每分钟最多 12 次食堂接口请求。每 API 进程默认最多 30 次模型调用/分钟、4 个并发，超时 8 秒；这些是单实例限制，不是跨实例或跨重启的财务预算。还应在供应商控制台设置账户消费额度。禁用 `MIMO_ENABLED` 或在小程序设置关闭 MiMo即可回到规则路径。回退到旧部署脚本前须处理其不识别的新环境字段，不能直接混用新 Secret 文件和旧脚本。

当前推荐菜单来源仍为 `apps/wechat/data/canteen-menu.json` 与默认候选配置，服务端使用由同一来源生成的 `packages/contracts/src/canteen-catalog.ts`。更新菜单时同步提高菜单版本并更新两端数据；现有菜单导出脚本已扩展为同步服务端目录。

## 本次执行边界

初次编码阶段按用户要求仅修改代码并静态阅读，没有运行测试或模型调用。用户随后填写本机密钥并要求启用，已将私有配置中的 `MIMO_ENABLED` 改为 `true`，通过既有隔离启动器完成 API/共享契约编译；启动器的开发监听在首次加载依赖时重启，随后使用同样的最小运行环境直接启动编译产物，进行真实接口联调。

2026-10-21 20:56（北京时间），使用合成的辣度 2、口味轻重 50 和当前公开菜单请求本机 `POST /v1/canteen/decisions`：HTTP 200，`source=MIMO`，`model=mimo-v2.6-flash`，`fallbackReason=null`，返回当前菜单中的 `hanshi-banfan-014`（鸡肉石锅拌饭），约 3.8 秒。该结果仅证明本机实际 API 到 MiMo 的调用和候选 ID 校验成功，不代表真实用户效果或公网接通。

启用前公网基线：`/health/ready` 返回 200，`/v1/canteen/decisions` 返回 404。随后在生产使用的 edge 网络内运行只接收 MiMo 配置的隔离候选容器，真实返回 `source=MIMO`、`fallbackReason=null`，耗时约 5.7 秒；没有改动当时正在服务的 API 或数据库。

2026-10-21，功能提交 `7789f6401fee74e50fa7dd94b94af365445adc8c` 通过完整 `./scripts/verify.ps1 -AlphaApiBaseUrl 'https://api.eatwhat.pro/'`：Node lint、类型检查、测试、构建、部署包门禁、Android Debug 单测/lint/构建、Release Manifest、Fixture/AndroidTest、Alpha 与 APK 端点/内容/签名校验均通过。Node 测试为 1877 项通过，13 项既有专用 PostgreSQL 集成测试因未配置专用测试库而跳过；其中微信小程序 516 项、API 1029 项、共享契约 106 项，新增 MiMo 单元用例 17 项通过。

`scripts/test-mimo-secrets.sh` 在只读根文件系统、无网络的临时 Linux 容器中通过启用、关闭、无效格式、错误权限、链接输入、预检失败恢复、并发锁和活动候选拒绝检查。部署包构建与完整性检查通过。首次检查发现的契约文档遗漏、测试宿主旧问卷假设及本机工具路径问题均已修复，没有删除门禁或放宽业务断言。

本次交付按明确要求不运行 GitHub Actions；推送和合并使用 `[skip ci]`，不把跳过报告为 CI 通过，也不修改工作流或分支保护。实际密钥只存在本机被忽略的配置和服务器受控文件/进程中，不进入源码、客户端、镜像构建环境或验证输出。独立审批、微信平台上传和真机验收不由上述检查替代。
