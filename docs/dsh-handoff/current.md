# 六项遗漏交付账（2026-11-17，Asia/Shanghai，最新在上）
## 目标与授权
用户授权六项逐项验收自动上线及代设双端体验；未授权提审/正式发布、真实客户/库存/硬件测试写。整项未完成，goal active/armed，round2/64。
## 最新进展（16:51上线、16:53回读；本增量已发布）
- 新增标准停车精确完整车牌查询：原正式入口 → 显式租户/数据库/独立逻辑资源 → canonical ParkingQuery+绑定任务 → 原查询GET/快照/历史事务保存；没有平行业务入口、假旧网关或自动fallback。
- 标准报告要求明确完整投影；匹配冻结车牌/稳定原记录号；null不等于遗漏；重报幂等、未知不重排、原租约迟到对账；旧网关不能抢领或报告。保留另一数据库的旧查询可用性，不伪造写/控制器能力。
- 最终冻结源码：API tsc、标准/卡/停车/限定三迁移17/17、旧发卡227/227、停车22/22通过；含任务创建失败、快照/历史失败全事务回滚。测试是本地真实TypeORM/PGlite，不是生产业务/硬件验收。
- 17文件提交3fb3e8d8已push main，官方auto发布退出0/95.310秒，API api-3fb3e8d已上线；16:53二次公网提交/哈希核验通过。sourceHash5f91ecfd4bbdba7525f37c6eec310cf71583e7953f449a7684231a214a41155e。发布记录main d9bee68d、远端deployed/api=3fb3e8d8。Web/助手无差异跳过，未上传小程序新包。
- 生产预检确认124.223.179.214，VM-4-8-ubuntu，machineId005acd736e534836bddf1997a7cc0636，pms-api online，cwd/opt/pms-repair/apps/api；本机DNS为代理合成198.18.4.73，Google公网DNS确认域名为124.223.179.214。
## 此前已发布/上传（保持有效，不冒充新增源码证据）
- API api-37acc98，Web2.0.20261117-1455，产品37acc988；官方发布退出0，公网版本/哈希及限定DDL只读回读通过。37发卡UID+.80真实分配账桥接已部署，不等于设备闭环。
- More外关、删除在用卡、反馈图库已修复并被生产Web制品覆盖；Web24/24、标准UI14/14。picker6/6、双端tsc和员工原生隔离fixture通过。
- 两端开发包均1.0.20261117a/4912774f，staff wx002fde4bfaa4c7d9、owner wx8ef4de0e498064c4；335 tracked上传输入与37产品相同、前后SHA保持；upload成功不等于体验生效。
- 15:58原历史目录1917 tracked哈希、HEAD、dirty状态完全保持。助手仍2.5.54/d075f81d，未验现场安装。
## 仍未完成（不关闭总任务）
- 标准门禁授权/控制器正式路由、停车非精确查询/登记/续费/收费/进出等标准路由、真实生产厂商和标准硬件适配；新增停车绑定目前只有受保护配置API，尚无管理UI及真实绑定验收。不是只等登录，SQLite只读示例不能代替厂商适配。
- 现场实卡/控制器闭环，正式登录态Web三项行为验收、实际小程序/手机手势均无最终证据；禁止真实测试写。16:53用BEGIN READ ONLY确认新绑定列integer/nullable及唯一部分索引，transaction_read_only=on、businessRowsWritten0。
- 双端体验指针均未保存/刷新回读，实际指针未知；15:51公众平台9223未登录并刷新二维码。需要管理员本人认证，之后lead代设，不提审/正式发布。
- 16:48只读CDP已有标签：PMS9222仍/login，公众平台9223为/且无token，未登录；未刷新二维码、未写业务。15:51新开PMS页Target crashed，无新业务截图。
## 关键文件与验证
- [协议](<docs/local-integration-protocol.md>)；[逐项交付账](<outputs/omission-release-20261117/delivery-audit-after-upload.md>)；[标准回归](<outputs/omission-release-20261117/standard-parking-full-standard.log>)；[旧发卡](<outputs/omission-release-20261117/standard-parking-legacy-core.log>)；[停车](<outputs/omission-release-20261117/standard-parking-legacy-owner.log>)。
- 关键文件：[停车服务](<apps/api/src/modules/local-integrations/standard-parking-query.service.ts>)、[停车回归](<apps/api/src/modules/local-integrations/standard-parking-query.test.ts>)、[共享历史](<apps/api/src/modules/access-card-issuance/parking-query-history.ts>)、[限定第三迁移](<apps/api/src/migrations/1796200200000-StandardParkingQuery.ts>)。
- bunded Node24.21.0/pnpm11.28.5；PATH先outputs/omission-release-20261117/tool-bin再Node/bin；verify_deps_before_run=warn、node_linker=isolated、virtual_store_dir=D:/00项目开发/PMS-release-batch-eight-20261116/node_modules/.pnpm、store_dir=该目录同级.pnpm-release-store。
## 下一步
本增量提交/推送/官方发布/公网和DDL回读均完成，相关job全部收齐。下一轮主攻标准门禁正式授权/控制器路由与真实厂商缺口：读AccessCardIssuanceService的createHistoryAuthorization/enqueueHistoryAuthorization/claimHistoryAuthorization/reportHistoryAuthorization及原助手实际处理器，先补真实事务回归，不能新建平行页面或假网关。体验登录后lead代设双端并刷新回读。task58/98/56/62等均in_progress，goal armed；不重建，不把本地或队列当现场完成。结果→证据→风险。
