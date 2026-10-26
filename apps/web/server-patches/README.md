# WEB 会话发布补丁

本目录不改变仓库 `main` 上的旧 API。发布基线是线上
`20261026-preference-ai-853f06b`：2026-10-26 21:13（北京时间）从活动不可变release只读拉回
210 个运行输入，逐文件核对 SHA-256；34 个部署文件仍与原核验版本完全一致。
它保留本日新增偏好AI的8个修改及5个新增文件。此前205文件基线只作历史证据，不再用于发布。
验证专用测试和构建器辅助输入继续使用此前独立核验的本地版本，全部单独固定哈希。
`baseline.json`、`deploy-baseline.json` 固定成员、长度和哈希；基线变化必须重新审计，不能自动接受。

`web-sessions.cjs` 仅为手机/邮箱 OTP 增加 `WEB` 平台。微信 code2Session 继续只接受
`MINIPROGRAM`，原生微信/QQ OAuth 继续只接受 `ANDROID`。会话查询未传参数时仍只返回
Android，`includePlatforms=ALL` 仍只返回 Android/小程序，浏览器需显式
`ALL_WITH_WEB`，避免旧版小程序无法解析新平台。

数据库 `0017_web_browser_sessions.sql` 仅扩展既有会话表的校验约束，不修改已有行、
身份、权限或保留期。原有 `IOS` 数据库枚举保留，但公开登录契约仍不接受 IOS。
当前仓库迁移只到 0014，SQL 必须由候选准备器放到已核验的 0016 基线后，不能改成0015或跳过连续版本门禁。

## 准备和验证

从仓库根目录运行，`--source` 指向用户指定且与线上一致的完整开发工作区。
输出必须是本工作区 `.codex-tmp` 下一个尚不存在的目录，脚本不覆盖已有候选或源文件。

```powershell
node apps/web/scripts/prepare-server-candidate.cjs --source '<已核验源码根目录>' --output '.codex-tmp/web-candidate' --mode web
node apps/web/scripts/prepare-server-candidate.cjs --source '<已核验源码根目录>' --output '.codex-tmp/web-recovery' --mode recovery
node apps/web/scripts/prepare-server-candidate.cjs --verify '.codex-tmp/web-candidate'
```

准备器先读取并核对全部原始字节，再执行限定次数的精确替换。候选 manifest 记录基线、
补丁和输出哈希；重验还会在内存反向还原补丁，对照原始哈希，并拒绝额外源文件。
它只准备文件，不声称已经安装依赖、通过测试、迁移或上线。

在 WEB 候选中安装冻结依赖后运行：

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd --filter @chi-shen-me/contracts test
pnpm.cmd --filter @chi-shen-me/api exec vitest run src/auth/auth.repository.test.ts src/auth/auth.service.test.ts src/auth/auth-session-query.test.ts src/auth/wechat-miniprogram-login.test.ts src/auth/web-browser-sessions.test.ts
pnpm.cmd --filter @chi-shen-me/api build
```

候选只复制相关既有测试，不是完整仓库，不将上述结果称为全仓测试。
从原仓库根运行 PostgreSQL 验证器，`--pg-bin` 必须是已安装的 PostgreSQL 17 + PostGIS 3.5 bin：

```powershell
node apps/web/scripts/verify-server-postgres.cjs --candidate '.codex-tmp/web-candidate' --pg-bin '<PostgreSQL bin>'
```

该验证器只接受本工作区的候选，创建新的回环临时集群，执行1–16迁移和ACL、保留旧会话，
执行17迁移与所有ACL校验、比较对象权限不变，验证真实SQL的旧/新会话可见性，
拒绝未知平台和错误ledger，最后停止集群。日志只含合成数据，不连接生产数据库。

部署包继续使用候选里的成熟构建器和 VerifyOnly；新包有35个源文件及 SHA256SUMS。

```powershell
& '<candidate>/scripts/build-ecs-deployment-bundle.ps1' -RepositoryRoot '<candidate>' -OutputDirectory '<new-deploy-directory>'
& '<candidate>/scripts/build-ecs-deployment-bundle.ps1' -RepositoryRoot '<candidate>' -OutputDirectory '<new-deploy-directory>' -VerifyOnly
```

## 发布顺序

1. 重新只读确认当前release、镜像、容器、完整迁移ledger和共享状态边界仍与预期一致。
2. 分别构建 WEB 候选镜像和恢复镜像。恢复镜像保留当前业务代码，但包含同一17迁移和兼容的部署门禁。
3. 建立两个新的不可变release，复制活动 `deployment.env` 到各自候选，仅更新镜像字段；不重建或复制Secret，不修改活动release。
4. 对两者运行 `harden-release-permissions.sh` 和 `preflight-deployment.sh`。
5. 在 WEB 候选 deploy 中运行
   `scripts/verify-rollback-release.sh <恢复release绝对路径> --target-image <WEB候选镜像ID>`。
6. 运行 `scripts/provision-database.sh --web-browser-cutover <恢复release绝对路径>`。
   它在既有mutation锁下先验证恢复镜像能接受候选的完整17计划，再验证活动16版、生成并校验新备份，
   才执行迁移、既有权限收敛、四项schema/ACL验证，以及真实17账本的恢复兼容性验证。
   该候选专用流程要求原PostgreSQL容器已存在且健康，迁移使用 `--no-deps`，不创建卷或重建数据库容器，并核对前后容器ID不变。
7. 成功后运行 `scripts/activate-candidate-release.sh --rollback-release <恢复release绝对路径>`，
   再完成运行文件哈希、readiness、旧客户端及WEB真实接口验收。

17迁移后原16镜像会因完整ledger不一致拒绝启动。回退必须使用预先准备的17兼容恢复release，
不能只把 `current` 指回原16版，也不自动降级数据库。权限白名单与16版保持一致；
`web-deployment.cjs` 为精确17状态增加兼容分支，并保留未知版本、错误名称、错误权限的失败门禁。

主站 `/api/v1` 反代另行发布。必须保留现行截图上传3MiB与限流、路线/餐厅池128KiB、
不落盘、不缓存、不记录敏感URI等限制，不能用通用反代绕过；网页定位需要主站
`Permissions-Policy` 的 `geolocation=(self)`。API子域和所有Secret仍保持现行边界。
