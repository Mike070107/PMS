# 工单类别自学习、管理处通知、完工小结开关验收

## 结果（2026-11-16，最新在上）
- **12:40 API生产发布完成**：`api-b9cbd70` / `b9cbd70478dad8988774aeb25b2946bf2271e956`；正式脚本退出0，公网健康 `ok/db up`、release身份匹配，台账及 `deployed/api` 已自动推送并回读确认。包含本批类别学习/通知修复及此前已验收的地址/公共区域/照片API改动。未重放旧单或发测试通知；[本次部署证据](<../repair-learning-deploy-20261116/release-proof.json>)。12:44–12:46独立生产后验全部通过，完整结项见[部署报告](<../repair-learning-deploy-20261116/verification.md>)。
- 员工小程序开发版 **1.0.20261116c**，11:23:58（北京时间）上传成功；AppID `wx002fde4bfaa4c7d9`。官方 CLI 明确 `√ build-npm`、`√ upload`；1,124,141 bytes。不是体验版设定、提审或正式发布。
- 源码 **2043607af0456ac5d1ace5f8489e635df304f6f3** 已先合入并推送 main，随后才构建 API、共享库及上传员工开发版。上传前冻结936个源码文件，上传后逐文件SHA256一致；58个共享运行库文件与本次构建逐文件一致；buildStamp已还原。
- 未知类别办公室通知只发对应管理处显式任职、具备权限且ACTIVE的员工；全公司数据权限不自动变成每处通知归属。无管理处或显式空接收人配置不发送。建单、转单、逾时升级路径一致。
- 办公室确认有效类别并成功派单后，自动保存该管理处“故障原话→类别”的识别样例；不是记死上次维修工。之后按该处有效类别规则/工种分流候选维修工，有显式默认人员时不擅自覆盖。失败派单不学习。
- 可从现有 AI 识别样例页禁用/删除错误样例；删除后下次恢复常规规则/AI识别，重启不会恢复被删种子。只学类别，不复制旧地址和联系人；真实地址管理处优先于输入上下文。
- 员工完工页新增“AI自动总结”开关，按本机租户/员工保存，默认关闭。先保留原话；开启时仅生成候选，必须点击“采用整理”才替换本次语音段，且只补空故障/收费字段、用料仅提示。可保留原文、重试；关闭/手改/退出/提交使迟到结果失效。

## 证据与可复跑命令
- [推送主线后的最终API套件输出](<api-regressions-pushed-main.utf8.txt>)：195/195，0 fail；[主线复跑脚本](<rerun-api.ps1>)，从 `apps/api` 运行 `& ../../outputs/repair-learning-summary-20261116/rerun-api.ps1`。覆盖真实Service建单/派单/转单/升级、类别学习/删除、地址、候选权限、状态机及通知。
- [SQL/HTTP专项](<learning-persistence-http.txt>)：11/11，包括9条路由与2条PGlite真实TypeORM SQL / Nest HTTP。验证作用域在take200之前过滤、201条其它管理处样例不挤掉本处、跨租户404、无编辑权限403、PATCH不可洗掉内部作用域、DELETE回读后恢复AI。JWT身份和模型/通知边界为测试fixture，不接外部服务。
- [独立审查](<review/implementation-review.md>)：发现的管理处串样例、lite入口漏学习及重判异常旧类型残留已先复现再修复；[版本化边界回归](<review/versioned-boundary-tests.txt>)4/4。无尚未处理的已证实P0/P1/P2。
- [员工Page VM报告](<summary/report.md>)、[14/14测试](<summary/after-tests.utf8.txt>)、[浏览器结果](<summary/browser-result.json>)：1440/390/320宽度，`passed=true`、`pageErrors=[]`；使用正式Page方法和本地WXML摘录，SDK/AI边界合成，不是微信原生真机。
- API类型检查：`node apps/api/node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json`，exit0。
- 员工类型检查：`node apps/api/node_modules/typescript/bin/tsc --noEmit -p apps/miniapp-staff/tsconfig.json --typeRoots node_modules/.pnpm/miniprogram-api-typings@3.12.0/node_modules`，exit0。
- API构建：`node node_modules/@nestjs/cli/bin/nest.js build`（apps/api），exit0；[构建产物哈希和功能标记](<build-proof.json>)。
- 员工构建上传：`node tools/miniapp-ship.mjs staff --upload --desc "完工小结默认关闭、原文保留及显式采用；管理处类别自学习配套"`，exit0；[官方CLI UTF-8副本](<cli-upload-staff.utf8.log>)、[上传审计](<upload-audit.json>)、[源码冻结](<source-freeze.json>)。原始PowerShell日志带UTF-16 BOM；首次审计误按UTF-8读取而失败，修正解码后验证通过，未因此重复上传。
- 上传包装器全局dirty=true源于包外未跟踪证据，描述因此带“+本地改动”；其包内manifest明确无夹带源码改动，独立冻结审计确认源码未漂移，未掩饰该标记。

## 剩余风险 / 未完成现场验收
- 本次“部署”已授权并完成API-only生产发布；Web仅本地真实构建供跨端门禁使用、补一处测试fixture环境字段，没有部署Web。Windows助手没有部署，不宣称现场升级。公网健康/制品身份不代替真实业务全链路验收。
- 只执行部署及只读核验，未做生产业务测试写入/重放旧单/发送测试微信通知；未做真实业务完工保存+刷新回读或微信真机录音/开关确认。API样例CRUD有隔离SQL/HTTP回读，不等同现场验收。
- 学习入库在成功派单后尽力执行；数据库故障会记录警告，不回滚已成功派单。并发播种/并发重复学习未做压力验证。
- 只上传开发版；需人工在公众平台把 **1.0.20261116c / 2043607a** 选为体验版，手机清掉旧缓存再验证。未操作体验指针/提审/正式发布。
- 业主端本批源码不变，未重复上传，仍为上一批开发版1.0.20261116b / 74e332d0。

- 原始失败证据逐字保留；其中[首次失败日志](<summary/before-tests.txt>)的原始终端输出含两行尾随空白，最终源码/文档diff检查通过，未为美化检查结果改写历史日志。

## 自检对账
- 已完成：后端实现与隔离数据库/HTTP/路由回归；员工开关与原文保护；实现独立审查、窄屏浏览器/VM交互；主线推送；API及员工构建；员工开发上传与哈希审计；已授权正式API上线及公网身份验证。
- 已完成：本次部署独立只读后验；双路径TLS/身份、当前124实例/目录/存活进程、三dist与验证构建SHA、旧回退包1474成员及完整SHA均通过；Web/助手当前公开版本与历史正式基线一致，不冒称本轮同时点前后双测。
- 未完成且非伪报成功：明确测试环境真实完工保存/刷新及微信真机验证；体验版人工选择；小程序提审/正式发布没有操作。生产健康不代替对应管理处真实业务验收。
