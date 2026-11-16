# API生产部署验收（2026-11-16，北京时间，最新在上）

## 结果
- **12:40 正式API-only发布成功**，`publish-production.ps1 -Target api` 退出0；生产 `api-b9cbd70` / `b9cbd70478dad8988774aeb25b2946bf2271e956`，sourceHash `eb9e963f7b98e944e12dd875694fac1f77d0c2cdeeb394856330401b4a5a536a`。构建12:40:04，正式公网verify-live于12:40:16通过。
- 当前124.223.179.214实例已核对；未知类别办公室通知、管理处类别自学习/删除样例后恢复AI等API修复已上线，同时包含此前已验收的地址去重、公共区域及照片API改动。未重放旧工单、批改历史记录、做生产业务测试写入或发送测试通知。
- 自动发布台账提交 `803fd9f8c2fd1aaacb3a919606ff489672023fc0` 已推main；远端 `deployed/api` 已回读为本次源码b9cbd704。没有手改台账。
- **12:44–12:46 独立后验全部通过**：双路径HTTPS、当前实例/目录/存活PID、三关键线上制品字节数/SHA、旧回退包保留完整性均亲验通过；[独立报告](<review/postcheck-report.md>)、[机器比较断言](<review/comparison-result.json>)。本次授权API-only部署目标已完成。

## 各端版本与发布边界
| 端 | 当前公开/开发版本与提交 | 本次动作 |
|---|---|---|
| API | `api-b9cbd70` / `b9cbd70478dad8988774aeb25b2946bf2271e956` | 已生产部署 |
| Web | `2.0.20261115-0154` / `c0dcec1a98becf32bbd16d0e094e982080effb1e` | 只做本地真实build与隔离浏览器门禁，未部署 |
| Windows助手 | `2.5.54` / `d075f81de4941147fcc15e3cabba1e4f31e5ea7f` | 只读公开latest，未更新包/未现场安装 |
| 员工小程序 | 开发版 `1.0.20261116c` / `2043607a`，11:23:58上传 | 原先开发上传已完成，本次未重传/设体验/提审/正式发布 |
| 业主小程序 | 上一批开发版 `1.0.20261116b` / `74e332d0` | 未改、未重复上传 |

本轮发布前preflight只测API，没有Web/助手同时点前测；当前两路公开版本匹配最近正式历史基线，不冒称做过本轮Web/助手发布前后双测，也不据公开latest证明现场已安装助手。

## 证据
- [正式成功原始transcript](<publish-attempt7-transcript.txt>)：main已推送后完整正式门禁、真实build、stamp、上传前源码再验、打包/上传/远端PM2部署、verify-live、台账/标签推送及回读全部通过。包名 `pms-api-fast-20261116-123556.tar.gz`；切换初期3次health探针连接拒绝，随后ready成功，不声称零停机。
- [本机最终证明](<release-proof.json>)、[可复跑校验](<finalize-proof.cjs>)：936个API/员工/共享源码SHA仍与2043607a验收冻结一致；三个关键本地dist字节数及SHA与已验收构建相同；195/195本批API隔离回归，0fail。
- 正式脚本10轮Node测试分别为 `10/16/21/2/3/1/17/12/227/22`，每轮0fail；包括迁移、真实隔离SQL/Nest HTTP、真实Web入口浏览器、车位/停车/门禁。各命令可能重叠，不把数量相加冒充独立用例；均非生产业务写入/现场设备验收。
- [独立公开HTTPS记录](<review/public-postcheck.json>)：普通DNS实际socket为198.18.4.73；强制socket124.223.179.214但保留prsznh.cn SNI和正常证书校验，两路均200、ok/db up、target/version/commit/sourceHash/builtAt五字段一致，也读取Web/助手公开版本。
- [独立适配复核](<review/preflight-review.md>)：17/17，精确项目、原脚本/参数、stderr完整合流与失败传播；Vite-only环境触发esbuild原有IPC传输降级，无业务源码/编译器/共享依赖/权限patch。
- [浏览器门禁红绿](<review/browser-gate/report.md>)：正式第6次失败后，只补一处测试环境define；全部真实组件、mock与业务断言不变。实际1/1转绿，五入口contactWrites各1、businessWrites=0、pageErrors=[]；第7次完整组3/3通过。
- 原始6份PowerShell transcript的第6行均为系统自动生成的 `配置名称: `（末尾一个空格）；不为美化diff改写原始证据。完整cached diff检查仅报这6处；排除这些原始transcript后的源码/脚本/文档/JSON检查通过。
- [尝试历史](<attempts.md>)保留前6次门禁失败；早先pnpm确实触发过自动依赖核验/安装步骤，未改变tracked源码/锁文件。后续有界适配禁用自动安装，未改变junction/共享依赖或其他工作树。

## 回退准备
- 旧API快照 `/opt/pms-backups/api/pms-api-rollback-20261116-120900.tar.gz`，SHA256 `8a1332160de6165cdbdfc0a2a130e36b4fbf6a6faa68651c8afb83fd56a66d5d`，1474成员；不含env/依赖。[原始UTF-16日志](<backup-result.txt>)及[UTF-8可读副本](<backup-result.utf8.txt>)；上线后独立只读确认该旧包仍在、1,643,770字节、SHA一致及1474成员完整，未解包/执行回滚，见[原始SSH证据](<review/remote-postcheck.json>)。
- 未执行回滚；若将来确需回退，先核对当前124实例与目标快照，把备份复制到不同的`/tmp`输入路径后再按正式快速部署脚本回退，避免脚本备份输入时同文件cp。不读取旧机或将退役旧机作为回退来源。

## 自检对账及剩余风险
- **已完成**：已授权API-only正式发布；源码/构建一致性、195条隔离回归与正式跨端门禁；公网健康与来源校验；main台账/远端标签回读。
- **已完成**：reviewer独立双路TLS/健康/来源、SSH身份/3关键产物、旧回退包、Web/助手历史公开版本对账；lead已审查并用本机最终脚本再次逐项断言。
- **未完成/边界**：真实对应管理处建单→派单→下次识别、删除样例再识别、真实通知送达、完工保存+刷新、微信原生语音/开关仍未现场验证。健康及文件哈希不证明这些业务环节；API verified仍明确fieldBusiness/fieldInstallation未验收。
- 员工小结开关默认OFF、原话保留及候选显式采用已在开发版，仍需人工将1.0.20261116c选为体验版后真机验证；未正式发布小程序。学习入库为成功派单后的尽力执行，失败不回滚派单；并发学习未压力测试。
