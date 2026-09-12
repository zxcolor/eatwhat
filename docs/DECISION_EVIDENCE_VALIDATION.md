# 决策边界正确性修复与验证

> 产品范围（2026-09-12）：只服务一个人的用餐决策，永久取消多人用餐。历史群组方案与验收记录仅作追溯，不属于当前或未来待实施功能。

日期：2026-09-08。分支：`codex/android-decision-evidence`，基线 `284a74f572da2068c775532c047ca20327fd4d3f`。本批完成算法 V2 的第一批正确性修复；其余阶段见 [决策算法 V2](DECISION_ALGORITHM_V2.md)，不据此宣称 Android 2.x 全部完成。

## 本次行为变化

- 营业文本必须完整可解释才推导开闭店。混合未知修饰、无效时间、含日期但未解析的文本和含糊端点返回 `UNKNOWN`；`24:00` 与 `00:00` 的闭店端点一致，相邻明确开放区间仍可证明 `OPEN`。未知营业候选保留并提示核实。
- 预算理由注明来源参考人均，路线及往返/用餐时间注明固定规则估算和缺失的实际路线、等位、点餐、制作信息。保留现有理由代码与排序契约。
- 规则意图将无序菜系集合按注册顺序规范化并等权处理。Qwen 全路径显式偏好约束与群组偏好覆盖仍属于后续实现。
- Android 单人、群组响应共用菜系排除规则，选“川湘菜”可排除川菜、湘菜及原有单向包含类别；不把未知类别视为已知冲突，不推断配料或过敏安全。
- 群组 LIVE 页面隐藏软偏好，成员写入、复核、发送时同步清除不适用值；权限切换、旧草稿回写和晚到响应不能恢复旧偏好。LICENSED 的偏好编辑和精确提交仍可用。

本批不修改 API/Kotlin 传输字段或版本、数据库迁移、五个运营配置键、供应商选择、服务端密钥、普通 Debug 的公网 HTTPS 地址、部署配置或 CI 门禁。新增测试数据全部为合成场景。

## 已执行验证

| 检查 | 结果与范围 |
|---|---|
| `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` | 最后午夜端点修正后的全量 Node 检查通过：Contracts 86、Admin 52、API 870 项；API 另有 3 项有条件 PG 用例未启用；编译后运行 smoke 通过 |
| 对本批五个 API 文件执行 `pnpm exec biome check` | 通过；最后补充用例的两处格式已按 Biome 整理 |
| `./scripts/verify.ps1 -AlphaApiBaseUrl 'https://api.unfinished-era.com/'` | 已有完整通过记录：应用 JVM 466 项、构建逻辑 11 项，零失败/错误/跳过；Debug Lint/构建、Release manifest、Fixture App/Test、压缩 Alpha、端点/签名/DEX/敏感内容完整性检查通过 |
| `:app:assembleFixtureAndroidTest --no-daemon` | 窄屏测试启动滚动修正后重新编译通过；最终 App/Test 安装身份均经 SHA-256 核对 |
| `scripts/run-android-instrumentation.ps1`，类 `MainActivityGroupDecisionLocalFixtureTest`，参数 `groupDecisionLocalFixture=true`，`-UseDeviceLocalApiFixture` | API 36 亮色 1080×2400/420dpi/字体1.0：5/5；暗色720×1600/320dpi/字体1.3：5/5；最终每项开始/结束状态与严格 runner 结果通过，零跳过 |
| `git diff --check` 与变更/未跟踪文件审查 | 无空白错误；APK、SDK、缓存、日志与受控配置未加入提交；仅选取合成设备截图进入文档 |

完整验证首次 Node 阶段之后曾追加午夜端点反例，已对最终 Node 源码重跑上表全部 Node 检查。设备矩阵随后修正的是测试启动滚动，生产 Android 源码未变化。合并仍以最终源码的完整验证和当前 HEAD 的分支 push、PR、main 三阶段 CI 为准，具体 SHA、运行链接和最终结果记录在本批 PR；本地记录不能替代远端门禁。

## 设备证据和已暴露问题

[四张设备截图及说明](screenshots/decision-evidence-20260908/README.md)展示 LIVE 输入/复核和 LICENSED 复核/结果。外部原始证据保留两种最终环境各 8 张 PNG、每张 SHA-256、安装包身份、完整 runner 状态与首次失败日志。

暗色窄屏首轮 5 项在启动辅助函数等待“手动选择”时超时；原因是首页惰性列表未滚动，控件未进入组合。修复使用固定顶部副标题等待首页，再实际滚动到控件并验证可见后单击，没有新增点击重试、固定休眠或降低断言。外部安装辅助脚本另有一次单项数组被 PowerShell 展开为字符串造成映射校验失败；发生在 instrumentation 启动前，保留该记录并修复数组包装，设备原映射未被覆盖。

远端刷新曾出现 Windows Schannel TLS 握手失败，使用单次命令 `git -c http.sslBackend=openssl fetch origin` 成功，证书校验保持开启，未修改系统或仓库的持久 TLS 配置。

## 回退与待验收边界

本批没有 schema 或数据变更。必要时通过新 PR 反向撤销本批代码并重新执行相关测试及 CI；API/Android 可分别回退至兼容基线。生产发布及真实设备安装不在此证据中，不能用模拟器或构建完成代替上线验证。

真实 PG 三项条件用例、真实高德/模型调用、API 26–35 与厂商真机、TalkBack、1.1/1.2 全部专项、区域模型治理全流程、商户认领、真实样本核验及 Alpha/Beta 在本批均未完成；没有修改数据库的本批不伪造 PG 通过记录。后续工作需按路线图继续实现和验收。
