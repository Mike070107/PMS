# API 发布前置适配独立复核

## 结论
对本次正式发布已出现的**明确单项目** `pnpm --filter <准确name> build/test:*` 和 `exec <保留全部参数>`，该适配为有条件等价执行，没有发现跳过正式业务脚本、吞掉失败退出码或绕开发布脚本门禁。不是任意 workspace/filter 语法的通用替代，也不证明本次 API 已上线。

## 已核对
- [适配](<../bin/pnpm-project.cjs>) 只接受五个确切 name，读取选中项目 package name 二次核身；模糊 selector、非 filter 调用拒绝。本次 API 精确映射至 `apps/api`。
- build/test 参数映射到 bundled pnpm 的 `--dir <项目绝对目录> --ignore-workspace --config.verify-deps-before-run=false run <原脚本/原参数>`；exec 保留原参数，不改成测试替身。
- `@pms/api` build 仍为 `nest build`。最新 child 使用 `stdio:['inherit',1,1]`：stdin 继承，stdout/stderr 都直接写父进程 stdout，避免 Windows PowerShell 5.1 把 pnpm 正常 stderr 提示误判为异常。stderr 内容没有被丢弃；非零原样传回，spawn 异常抛出，空状态按 1 处理。合流会失去日志通道区分，不改变脚本/退出状态。
- 当前适配关闭的是 pnpm11 执行前自动依赖核验/安装（当前 junction 兼容问题），不是项目 build、测试或正式发布 guard。lead 已告知：最初 bundled pnpm 尝试触发过默认依赖核验/自动安装步骤，锁文件及所有 tracked 源码未改变；不能泛称整个会话“没跑 install”。当前适配禁用该自动行为；本 reviewer 未执行安装或改 junction/lockfile。workspace 的 overrides/allowBuilds 主要影响安装，当前执行已有依赖、不安装时不会重算依赖树。
- 正式发布脚本仍独立执行：互斥锁、fetch 标签、源码冻结、发布自测、目标脏检查、相关回归、依赖变化判定、真实 build、stamp、上传前 verify-source、上传/远端部署、verify-live、最后标记 deployed。
- `release-check.mjs` 的 main/origin/main/已部署祖先/源码未变/manifest 全依赖存在校验和同源码证据匹配均在适配外，不因 `verify-deps-before-run=false` 而删除。
- 本轮只读取代码与 manifest，没有运行 adapter 中的实际 pnpm/build/部署；用 VM 截获 spawn，仅验证参数传递和错误处理。最新 stdio、失败传播、Vite-only preload 限定、原生 IPC 回退等用例见最终输出：[adapter-tests.txt](<adapter-tests.txt>)。

## 精确命令
```powershell
node --test outputs/repair-learning-deploy-20261116/review/adapter-review.test.cjs
```

## esbuild 传输兼容增量复核（最新版本）
- 已替换早先“pnpm child 直接设不存在 TEMP”的分支；该旧方案由 lead 确认会被 pnpm 主动 mkdir，正式入口失败，不计成功证据。
- 最新适配**仅精确 neighbor-web build**追加 NODE_OPTIONS require preload，保留原 NODE_OPTIONS 和正常 TEMP/TMP；API、test、exec、其它项目、附加参数命令不追加。parent 环境不变。
- preload 只有 argv[1] basename 为 `vite.js` 才工作；cwd 必须是本仓库 neighbor-web（Windows 大小写无关），否则 throw；目标目录已存在即 throw。pnpm/tsc/test 非 Vite 子进程完全不改环境。无创建目录、删除、权限修改或 fs/compiler API patch。
- 已实际只读检查 esbuild 0.21.3 main.js：793–796 为 >1MiB 输入选择临时文件优化；1851–1857 为 writeFile 失败时 callback(null)；721–733 的 null 路径明确设置 inputFS:false，传原始输入给 IPC，**不是跳过编译**。本 reviewer 从原库提取 fsAsync 片段、模拟 ENOENT，验证实际实现返回 null；没有写库或运行正式 build。
- 这是环境层触发库原有降级，不是修复原生删除失败；所有 Vite 插件继承该不存在 TEMP，若其它插件确实依赖可写 TEMP，仍可能失败。目录存在检查仅当前时刻，不排除后续第三方创建；最终完整正式 build 必须实际通过，probe/VM 成功不代表已完成发布。
- lead 报告 1,327,116 字节直接 Node probe 输出 `let a = 1;` 和完整 195 隔离 API 通过；此两项为 lead 证据，本 reviewer 未重复/冒认亲验。
- 最新 reviewer 测试 **17/17 通过**；[适配哈希](<reviewed-adapter-hashes.json>)、[完整测试](<adapter-tests.txt>)。只新增/更新 review 目录证据，无生产后验。

## 后续状态（更新）
上述“未生产后验”为当时审查阶段状态；现已收到 lead 明确正式第7次部署成功通知，2026-11-16 12:44–12:46 +08 独立完成 HTTPS 双路五字段/TLS、SSH三dist SHA、旧回退包SHA/成员数及公开Web/助手历史身份核验，全部通过。见 [完整后验](<postcheck-report.md>) / [机器断言JSON](<comparison-result.json>)。无 env 读取、业务写入、通知、部署或回滚。
