# PMS 本批交接（2026-11-15 北京时间）
## 目标
换牌保护已发布；Pending新办待审核入口、自定义月份计价、办理记录中文车辆系统明细为本地未发布增量。lead单写，审查并行，保护全部脏树。
## 已完成
换牌原值保护及独立车型入口已推送main；前批API252/252、保护15/15、浏览器27项、双Web构建、助手Release/self-test通过。
此前正式版本：API api-b34f7a0/b34f7a0a；Web2.0.20261115-0043/d075f81d；统一助手包2.5.54/d075f81d。
前批公网后验：DNS+固定124.223.179.214真实socket/TLS、版本/commit/sourceHash、HTML/JS/EXE SHA均匹配。
Pending：submitted付费+亲情车、原登记精确深链、15秒/焦点/手动刷新、错误保留、成功收款去重、最多200提示；权限不扩。
计价：显式档位优先，缺档按同组明确1月价×月数；无月价仍拦、保留0元/套餐；审查P1空值转0已先红后绿堵漏，双端源码一致。
办理记录：中文系统/动作/原目标日期/分步结果/任务，隐藏内部英文键/JSON；人工/旧单/设备证据边界清楚，精确key匹配，无额外查询。
日期date列转文本避免时区前移；目标与测算日期真有差异明确警告不改原单；时间统一北京，legacy执行计划独立注明来源。
终审三P2（共库双目标React key/浏览器时区/旧云计划日期）均修复，browser-check只读复核通过。
最终验收：API续期60/60、账本SQL/HTTP2/2；Web续期41/41、账本13/13、Pending及审核浏览器6/6；双端build exit0、diff --check通过。
Records真实React→ledger service→PGlite SQL浏览器1440/390、纽约时区、等待/失败/恢复通过，截图已目检；非生产登录/支付/设备证据。
## 进行中
用户已明确授权“全部修好后自己上线生产”；主控正集成提交main并按正式auto入口发布API/Web，独立公网后验待执行。
## 待办/未完成
助手包发布不等于现场安装；六小时更新机制未改，须实际心跳版本和设备/刷卡确认。
旧库存储过程/PostgreSQL并发/原机原账户DPAPI跨进程恢复未现场验收；不宣称现场业务闭环。
Pending原导航准入不变，family-cars-only仍不能进入；family经理流程不混入submitted资料队列；manager-only旧库查重可能403。
事故5045/task153/query885不修复/重放，不猜原identity；旧助手/快照缺失须人工核对。
## 关键文件
[办理记录验收与截图](<../../outputs/records-operation-details-20261115/verification.md>)；[计价验收](<../../outputs/parking-custom-months-20261115/verification.md>)。
[Pending验收](<../../outputs/pending-plate-review-20261115/verification.md>)；[此前公网证据](<../../outputs/release-20261114/final-public-check/result.md>)。
## 验证命令
`pnpm --filter @pms/api test:parking-renewal`；`pnpm --filter @pms/neighbor-web test:parking-renewal`；`pnpm --filter @pms/neighbor-web test:records`。
`node --test apps/neighbor-web/test/pending-plate-review-browser.test.cjs apps/neighbor-web/test/plate-review-browser.test.cjs`；双端build。
默认Web build使用既有进程级TEMP preload及pnpm verify_deps=warn；勿安装/清理共享依赖或调整ACL。
## 下一轮
新增发布须用户当次明确授权，clean/pushed main→正式auto入口→独立公网后验；Records/计价须API+Web一并更新，不改其他脏树。
