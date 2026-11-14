# PMS 本批交接（2026-11-15 北京时间）
## 目标
按用户“全部修好后自己上线生产”授权，完成Pending新办待审核、自定义月份计价、办理记录中文车辆系统明细；lead单写源码，审查/后验并行。
## 已完成
源码c0dcec1a98becf32bbd16d0e094e982080effb1e合入并推送main；正式auto发布成功，API/Web远端部署标签均=c0dcec1a，部署日志机器提交。
生产API api-c0dcec1（01:52）；Web2.0.20261115-0154（01:55），均上述commit；助手代码无变化跳过，已发布包仍2.5.54/d075f81d。
API sourceHash 2dac8d0073c03e49c69f704ba91c07d9bab410fce7236d72f5424d1b957c87c3；Web 59cb542e1be51d2aeaf10ca9ab5022fcbfcc5196fb989f241e64d561374d9eee。
Pending支持submitted付费+亲情车、登记精确深链、15秒/焦点/手动刷新、错误保留、成功收款去重、最多200提示；权限未扩大。
计价显式档位优先，缺档按同组明确1月价×月数；无月价仍拦，保留0元/套餐；空值/布尔/数组/对象非法金额拒绝；双端源码一致。
办理记录中文系统/动作/原目标日期/分步结果/任务；人工、快照、旧计划日期分清，不等同新读回/设备放行；共库双目标不丢，时间统一北京。
最终定点验收API续期60/60、账本SQL/HTTP2/2；Web续期41/41、账本13/13、Pending审核浏览器6/6；双端build、发布脚本自测10/10通过。
真实React→ledger service→PGlite浏览器1440/390及纽约时区、等待/失败恢复通过，截图已目检；三P2经独立终审通过。
正式流程回归/构建、公网verify-live通过；API服务器main/计价/账本编译JS与冻结dist三文件全SHA一致；无业务数据修复/重放。
## 进行中
无本批进行中任务；独立双路线22次只读GET后验通过，关键6个JS/CSS与根首页/主JS全SHA、版本/commit/sourceHash匹配，固定11次实际socket=124.223.179.214且TLS授权。
## 待办/未验证
助手包发布不等于现场安装；实际心跳版本、设备/刷卡、旧库存储过程/PostgreSQL并发/原机原账户DPAPI跨进程恢复未现场验收，不宣称现场业务闭环。
Pending原导航准入不变，family-cars-only仍不能进入；经理流程不混入submitted资料队列；manager-only旧库查重可能403。
事故5045/task153/query885不修复/重放，不猜原identity；旧助手/缺快照须人工核对；既有小程序未发布提交不属本批、不上传提审。
## 关键证据
[本批生产验收](<../../outputs/release-20261115/verification.md>)；[独立公网通过报告](<../../outputs/release-20261115/independent-public-check/result.md>)。
[办理记录](<../../outputs/records-operation-details-20261115/verification.md>)；[计价](<../../outputs/parking-custom-months-20261115/verification.md>)；[Pending](<../../outputs/pending-plate-review-20261115/verification.md>)。
## 验证命令
`pnpm --filter @pms/api test:parking-renewal`；Web `test:parking-renewal`、`test:records`、`test:pending-plate-review`；`node deploy/mark-deployed.mjs status`。
## 下一轮
本批已完成；后续需求先读验收及未验证边界，勿重发包或重放业务。勿安装/清理共享依赖或调整ACL。新发布仍须用户当次明确授权，已push main后正式auto→公网独立后验。
