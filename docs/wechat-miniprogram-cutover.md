# 微信小程序登录：schema 0014 本地交付与上线门禁

小程序使用独立的 `WECHAT_MINIPROGRAM_AUTH_ENABLED`、`WECHAT_MINIPROGRAM_APP_ID` 和 `WECHAT_MINIPROGRAM_APP_SECRET`。AppSecret 只进入服务端受控 `api.env`，不得放入小程序、Android、仓库或日志。默认关闭；启用时仍要求现有账户和手机号通道正常开启，并复用稳定的 `WECHAT_OPEN_PLATFORM_REALM_ID` 与身份 HMAC key ring。

## 身份解析边界

schema 0014 只增加 `resolve_wechat_miniprogram_user_from_consumed_state(uuid)`，不创建账户、微信绑定或 UnionID alias。服务端验证小程序 code 后，在同一事务中消费一次性 proof、解析已有 alias、检查原绑定及账户状态、建立会话。小程序 AppID 下的 OpenID 与 Android OpenID 分别计算；只有相同 Open Platform realm 和 key version 下的已有 UnionID alias 能关联原账户。缺少 UnionID/alias、绑定冲突、撤销绑定、锁定或待注销账户均拒绝登录。

resolver 为固定 `search_path` 的 `SECURITY DEFINER`，只允许 `api_runtime` 执行；业务角色和 PUBLIC 不获得 alias 表或列的直接访问权限。运行 `verify-wechat-miniprogram-login.sql` 可只读核验精确 0014 ledger、函数身份、执行权限及表/列 ACL。

## 已有库升级顺序

1. schema 0010、0011 或 0012 必须先使用已批准的 schema 0013 发布包完成既有 PHONE_ONLY、Union alias 和配置管理切换。历史 bridge 的 approved plan head 仍为 13；schema 0014 镜像拒绝跳过这些门禁。
2. 准备独立候选发布和已验证的 schema 0014 兼容回滚发布，候选设置 `AUTH_SCHEMA_TRANSITION_MODE=none`、`WECHAT_MINIPROGRAM_AUTH_ENABLED=false`。回滚发布必须能够读取相同完整迁移计划；schema 0013 镜像不能作为 0014 的运行时回滚镜像。
3. 在候选发布中执行 `provision-database.sh --wechat-miniprogram-cutover ROLLBACK_RELEASE`。脚本持有全局变更锁，通过仍在运行的 0013 发布执行并验证备份，检查完整 13 条 ledger 和 active link，再应用 0014、收敛 ACL，执行两个只读 schema/ACL 检查并复核回滚兼容性。失败后输出恢复发布并要求人工读取实际 schema；不会自动降库。
4. 先在通道关闭状态激活并验证 0014 发布。再通过非活跃候选发布的 `update-auth-secrets.sh --apply --config-file FILE` 配置小程序密钥与开关。输入文件必须为 root:root 0600，必须含 `WECHAT_MINIPROGRAM_AUTH_ENABLED=true`；关闭时不提供小程序 AppID/Secret。脚本在写入候选配置前验证活跃发布、稳定 realm、Union alias ACL 和精确 0014 resolver ACL。
5. 重新创建 API 后运行 `verify-runtime.sh`，核对容器开关与公开 `wechatMiniProgramEnabled` 能力；再用已在原 App 绑定微信且已存在 alias 的受控账户做真机登录。新建空数据库可以直接应用完整迁移计划，但这不代表历史身份关联已经具备。

启用凭据会写入共享 `api.env`。通道关闭的 schema 0014 回滚发布允许该文件保留完整的 Mini AppID/Secret 对，配置加载器不消费它们；半组凭据始终拒绝。`update-auth-secrets.sh --disable` 仍删除 provider 凭据并保留身份/会话密钥环。启用后须再次验证预备回滚发布兼容性，不得使用缺少这一可选组门禁的旧发布。

本次实现没有执行生产迁移、配置密钥、开启生产通道或进行微信真机验收。备份恢复与发布切换仍需按既有运维流程执行。

## 本地验证

常规 API 测试包含迁移静态边界、数据库启动版本门禁和 role-grants 检查。真实 PostgreSQL 集成测试默认跳过，只允许明确指定非 5432 的 IPv4 loopback 端口，且服务端 `data_directory` 必须匹配临时目录 `eatwhat-schema14-<32位十六进制>/data`。该测试创建并删除独立数据库，使用合成身份验证 13→14 升级、幂等性、跨 AppID 原账户解析、冲突/撤销/状态拒绝、一次性消费与 ACL；不会连接生产数据库。

```powershell
$env:WECHAT_MINIPROGRAM_POSTGRES_E2E = '1'
$env:WECHAT_MINIPROGRAM_POSTGRES_PORT = '<临时 PostgreSQL 端口>'
$env:WECHAT_MINIPROGRAM_PSQL = '<psql 可执行文件绝对路径>'
pnpm.cmd --filter @chi-shen-me/api exec vitest run src/database/wechat-miniprogram-login.postgres.e2e.test.ts
```

CI 使用独立、仅映射 loopback 端口的临时 PostGIS 容器执行相同测试，结束时停止并删除容器。服务端会话创建、code 防重放和网络错误处理另由认证单元测试覆盖。
