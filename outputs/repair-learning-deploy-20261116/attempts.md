# 本机发布门禁记录（2026-11-16，最新在上）

## 实际时间线
- 第7次：12:40候选main `b9cbd70478dad8988774aeb25b2946bf2271e956` 正式API-only发布成功，命令退出0；12:44–12:46独立双路HTTPS、当前实例/三dist、旧回退包后验全部通过。完整[正式transcript](<publish-attempt7-transcript.txt>)及[最终报告](<verification.md>)。其相对上一候选仅追加浏览器测试Vite环境字段，未改变本批业务源码。
- 第6次：真实Web build已通过（3354模块）；随后隔离档案SQL/HTTP通过，但 `test:property-archive` 的浏览器组2/3通过、1失败。真实组件新增引用 upload.ts，而测试IIFE缺 `import.meta.env.VITE_API_BASE_URL`。仅补正式环境对应的 `"/api/v1"` define，保留全部请求与断言；该真实浏览器单测1/1转绿、五入口 pageErrors=[]。红绿证据见 [review/browser-gate](<review/browser-gate/report.md>)。不是修改业务源码或跳过门禁。
- 第5次：在pnpm child先设不存在TEMP的尝试失败，pnpm启动会主动mkdir该目录，Vite仍创建传输文件；保留 [原始transcript](<publish-ipc-transcript.txt>)，不计为成功。
- 第4次后：权限技能在本会话已授权完全权限下检查失败临时文件及祖先，`NOT_THIS_CLASS`、WRITE_DAC/WRITE_OWNER有效；未改权限，无回滚命令。保留JSONL报告，停止ACL修复路径，不据此声称已解决原生删除根因。
- 第3/4次：Web均完成3354个模块转换，随后esbuild 0.21.3原生进程删除 >1MiB 输入传输临时文件时AccessDenied；系统TEMP及新工作区TEMP均复现。两个Node版本24.15/24.21最小输入都复现，同步写文件仍复现。保留 [第三次](<publish-transcript.txt>)、[第四次](<publish-final-transcript.txt>)，文件名final不代表成功。
- 第2次：正常 pnpm `$ tsc --noEmit && vite build` stderr被PS5.1外层 `2>&1`/严格错误模式转为NativeCommandError，不是编译器业务错误。
- 第1次：pnpm11.28.5递归任务状态拒绝原有根node_modules junction，`ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`。此前确实执行默认依赖核验/自动安装，显示lockfile up to date；全部tracked源码及锁文件未改。未修改junction、共享依赖或其它工作树源码。
- 前6次均在上传前被门禁中止，没有替换生产dist。前两次Tee没有产出原日志（Out-Host/错误中止），错误原文来自工具返回，不伪造文件。

## 当前有界兼容方式
- 精确项目name复核，用bundled Node+pnpm `--dir --ignore-workspace --config.verify-deps-before-run=false` 执行同一原build/test/exec；关闭的是pnpm自动安装与递归状态写入，不是编译/测试。未知selector拒绝，exec参数保留。
- child `stdio:['inherit',1,1]` 合流完整显示stderr/stdout，失败退出码保留，spawn异常抛出；使用Start-Transcript，不再在外层合并stderr。
- 仅精确 neighbor-web build 追加环境preload；pnpm/tsc不改TEMP，仅实际Vite CLI且本仓库对应cwd才切到不存在的TEMP，避免pnpm先mkdir。无fs/compiler API或库/业务源码/权限patch。esbuild原库 writeFile失败时 callback(null)，原输入走IPC并照常编译；这是库内建传输降级，不是修复原生delete根因。
- 独立适配复核17/17（VM/库片段，不冒充业务测试）；第6次已真实完整Webbuild通过，仍须完整正式API发布与公网/独立后验通过。
- 已预存旧API快照，不含env/依赖，SHA256 `8a1332160de6165cdbdfc0a2a130e36b4fbf6a6faa68651c8afb83fd56a66d5d`；部署后仍须确认保留。
