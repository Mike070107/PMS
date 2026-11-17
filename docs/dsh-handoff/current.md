# 工单完工浮层优先修复 / 六项遗漏（2026-11-17，Asia/Shanghai）
## 目标与授权
- 当前优先：登记完工面板紧接顶部按钮下方展开、覆盖Tab区域；切Tab及时收起，失败保留输入。用户在本轮发布确认中明确选择“授权现在上线”，允许官方auto发布及只读版本/哈希核对；无真实完工/库存/收费测试写授权。
- 原六项逐项验收自动上线及双端体验代设仍有效；未授权提审/正式发布、真实客户/库存/硬件测试写。总目标未完成，goal active/armed、revision2、round2/64。
## 当前修复已完成 / 正在收尾
- 修复前真实Chrome回归2/2失败：面板落在Tab下方、切处理进度仍残留；不是只看源码猜测。
- 已窄修：保留顶部按钮、按实际按钮底部定位（手机动作换行不留大间隔）、独立视口内滚动；Tab切换/外点/取消/再次点击/Esc收起，首个Esc不关工单。
- 收起保留表单、错误、等待请求及幂等键；成功或关闭工单清理。旧工单迟到结果不覆盖/关闭新工单，失败提示自动滚入视口。
- Chrome桌面1440×1000、375×812、812×375、缺料完工入口、动态缩放及等待/错误/成功通过；连同原列表/阶段/More/图库回归26/26，应用tsc退出0。隔离合成API，无生产业务写，不冒充正式登录态验收。
- 修复已有source-isolation测试缺失WorkOrderMedia适配和旧“打开表单隐藏按钮”断言；仅恢复本文件新增行LF，保留原有混合换行，scoped diff --check通过。
- 修复e9750a04059eba931f51354b96273b6784c0204b已合回push main并远端回读一致；推送后Web build退出0、同一冻结提交26/26再次通过，源码未变。未部署；保留原有3个API发布证据dirty及历史目录，不暂存产物。
## 此前上线 / 上传（不是当前修复上线）
- 16:51标准停车精确完整车牌查询已发布：原正式入口→显式租户/DB/逻辑资源→canonical ParkingQuery+绑定任务→原GET/快照/历史事务；无假旧网关、平行页面或自动fallback。
- API api-3fb3e8d，sourceHash 5f91ecfd4bbdba7525f37c6eec310cf71583e7953f449a7684231a214a41155e；官方auto退出0/95.310秒，16:53公网提交/哈希及BEGIN READ ONLY新列/索引二次回读通过，businessRowsWritten0。17/17标准、227/227旧发卡、22/22停车通过。
- 当前生产Web2.0.20261117-1455/37acc988、助手2.5.54/d075f81d；More外关、删除在用卡、图库已覆盖生产制品。37发卡UID+.80分配桥接上线≠现场设备闭环，助手未验现场安装。
- 双端开发包1.0.20261117a/4912774f，staff wx002fde4bfaa4c7d9、owner wx8ef4de0e498064c4；335上传输入与37产品一致，未因停车重传。体验指针尚未保存/刷新回读，不能把upload成功当体验生效。
## 未完成 / 下一步
- 当前修复：实现、回归、类型、构建及main提交/推送均完成；已获当次生产授权，正核对DNS/实例/服务后官方auto发布并回读公网版本/哈希，结果尚未确认。
- 原六项：标准门禁授权/控制器正式路由、停车非精确/登记/续费/收费/进出等标准路由、真实厂商与硬件适配；停车绑定仅受保护配置API，管理UI及真实绑定未验收。
- 正式登录态Web、手机picker手势、现场实卡/控制器闭环无最终证据；双端体验指针需管理员本人认证后lead代设并刷新回读，不提审/正式发布。
- 16:48只读CDP：PMS9222仍/login，公众平台9223为/且无token；15:51PMS新页Target crashed。不要盲目重复旧开页/二维码脚本；认证缺口不能冒充设备或业务验收。
## 关键文件与证据
- [修复](<apps/neighbor-web/src/components/WorkOrderSheet.tsx>)、[局部样式](<apps/neighbor-web/src/components/WorkOrderSheet.css>)、[浏览器回归](<apps/neighbor-web/test/work-orders-browser.test.cjs>)、[26/26日志](<outputs/work-order-completion-overlay-20261117/browser-acceptance.log>)、[tsc](<outputs/work-order-completion-overlay-20261117/typecheck-acceptance.log>)、[失败证据](<outputs/work-order-completion-overlay-20261117/before-regression.log>)。
- [协议](<docs/local-integration-protocol.md>)、[六项交付账](<outputs/omission-release-20261117/delivery-audit-after-upload.md>)、[停车服务](<apps/api/src/modules/local-integrations/standard-parking-query.service.ts>)、[共享历史](<apps/api/src/modules/access-card-issuance/parking-query-history.ts>)。
## 验证命令 / 接续
- bundled Node24.21.0运行`--test apps/neighbor-web/test/work-orders-browser.test.cjs apps/neighbor-web/test/work-order-stages.test.cjs apps/neighbor-web/test/work-order-media-browser.test.cjs`；应用编译器`apps/neighbor-web/node_modules/typescript/bin/tsc --noEmit --project apps/neighbor-web/tsconfig.json`，根目录无typescript，不要再用根路径。
- 构建用bundled Node/pnpm；PATH先outputs/omission-release-20261117/tool-bin再Node/bin；verify_deps_before_run=warn、node_linker=isolated、virtual_store_dir=D:/00项目开发/PMS-release-batch-eight-20261116/node_modules/.pnpm，store_dir同级.pnpm-release-store。
- task99当前in_progress；task58/98/56/62等仍未完成。原六项后续读AccessCardIssuanceService正式授权enqueue/claim/report及原助手处理器，先加真实事务失败回归。不要重建任务，不把本地或任务回执当现场完成；汇报结果→证据→风险。
