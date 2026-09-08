# Android CI 构建复用与质量边界

Android CI 保留原有三个 job、所有测试、Lint、APK 内容扫描和未签名构建拒绝检查。优化集中于 Gradle 编译结果复用，不修改应用代码、依赖版本、Windows 增量编译保护或发布流程。

## 缓存策略

只由 `gradle/actions/setup-gradle@v4` 保存与恢复 Gradle User Home；`setup-java` 仅安装 JDK。两套缓存管理器同时操作该目录会导致 Gradle Action 因目录已存在而跳过恢复。

当前工作流只接收 `main`、`master`、`codex/**` 的 push，以及 pull request。仓库 push 可以保存所在分支的缓存，PR 只读。GitHub 的缓存分支隔离使开发分支能够复用自己的构建结果，同时不向 main 或其他开发分支提供该分支的缓存。不要通过 `pull_request_target`、共享可写远端缓存或缓存整个工作区绕过此边界。

主要构建启用 `--build-cache`。此处复用的是 Gradle 根据任务实现和已声明输入判断有效的任务输出；不直接保存 `app/build`、APK、签名材料或环境转储，也不启用 configuration cache。

## 每轮继续执行的检查

- `buildSrc test --rerun` 和 `testDebugUnitTest --rerun` 中，`--rerun` 紧随对应测试任务，只强制该任务执行，编译依赖仍可复用。两组 JVM 测试每轮真实运行，避免把直接读取仓库文件的测试结果误当作可复用输出。
- 随后解析两组 JUnit XML，要求报告存在、测试数大于零且失败、错误、跳过均为零；在 Actions Summary 显示实际数量，并保存不含测试内容的计数 JSON。
- `lintDebug` 仍是必需构建目标，使用 Android Gradle Plugin 的任务输入与缓存定义。
- 源码禁用项扫描、三个 APK 的 Manifest/DEX 内容扫描每轮重新读取当前产物。
- Alpha 和 Release 的未签名构建继续要求非零退出码、指定错误标记和无产物，且显式使用 `--no-build-cache --no-configuration-cache --no-daemon`。
- Release/Alpha 配置校验任务没有输出声明，不增加可缓存声明，不改变它们与 `pre*Build` 的依赖。
- `verify.ps1` 完整验证和分支、PR、最终 main 的 GitHub 门禁保持不变。

## 性能证据

三个主要 Gradle 调用增加 `--profile --console=plain`。Actions 只保存下面两个目录的性能报告和明确指定的测试计数 JSON，保留七天；不向外部 Build Scan 服务发布数据。

```text
apps/android/build/reports/profile/**
apps/android/buildSrc/build/reports/profile/**
apps/android/build/reports/ci/jvm-tests.json
```

报告 artifact 名称包含 run ID 和 run attempt。同一提交的首次运行与重跑分别保留，便于对比完整 job 耗时、Debug/Fixture 步骤耗时，以及缓存恢复和保存开销。报告缺失不会把已失败的构建改为成功。

## 优化验收

1. 在当前提交运行完整验证，确认测试、APK 和签名门禁未减少。
2. 在隔离工作树增加临时 Kotlin 测试，先通过，再改变其返回值而保留断言，确认编译失效并产生预期断言失败；移除临时文件后重跑正式测试。
3. 分支 push 首轮建立缓存；同一 SHA 再运行，确认缓存实际恢复、适用任务出现 `FROM-CACHE`，而两组 JVM 测试仍真实执行且数量完整。
4. 对照总时长和具体步骤，不把 runner 波动或依赖缓存命中当作已验证的编译提速。首次建立缓存不保证比旧工作流快。
5. 当前 HEAD 的所有检查成功后创建 PR，PR 检查成功后合并，继续验证最终 main。运行链接与实测结果记录在 PR 和交付记录中。

回滚只需 revert 本次 CI 变更；没有数据库、应用数据或客户端兼容性迁移。没有改变 Linux/Windows 的 Kotlin/KAPT 增量设置；后续只有性能报告证明仍有必要时才单独评估。

参考：[setup-gradle v4 缓存说明](https://github.com/gradle/actions/blob/v4/docs/setup-gradle.md)、[Gradle build cache](https://docs.gradle.org/current/userguide/build_cache.html)、[Gradle 命令行任务选项](https://docs.gradle.org/current/userguide/command_line_interface.html#sec:rerun_tasks)。
