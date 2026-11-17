# 六项遗漏交付账（2026-11-17，最新在上）
## 目标与授权
用户明确授权：补齐六项遗漏、逐项验收、自动上线、代设双端体验版；未授权提审/正式发布及真实业务/库存/硬件测试写。
## 已实现和本地验证
- 工单更多外点关闭、发卡页删除在用卡区块、反馈缩略图/大图：真实 Chrome 桌面/窄屏，相关 Web 24/24；尚未部署。
- 双端位置选择恢复：6/6 DOM/触摸回归、员工原生 SDK 隔离 fixture、双端类型检查；尚未上传本次开发包。
- 标准管理/工作站选择/正式发卡入口：浏览器14/14、API/Web类型检查通过。
- 标准卡桥接复用原批次、实卡UID、.80真实分配账；只在UID/分配号回读通过后完成写卡阶段，不伪造旧库/控制器完成。
- 协议/runner/真实TypeORM+PGlite及限定建表18/18；一期忽略额外楼栋的重试先复现409、归一化修复后通过；最终API tsc通过。
- 旧发卡227/227、停车22/22；限定生产建表只执行两项新接入迁移，事务/幂等/漂移回滚与部署前调用4/4；非全库测试。
- 原历史目录1917个tracked哈希和工作区状态保持不变；没有覆盖dirty草稿。
## 进行中
在D:/00项目开发/PMS-release-simplification-20261117（codex/omissions-20261117），基线bb3c2d69；正在最终差异审查、合入main、统一发布。
## 未完成（不能标为完成）
- 标准门禁授权/停车正式业务路由、真实标准硬件适配、现场实卡闭环；SQLite仅只读示例。
- 本次main推送、Web/API生产版本/提交/哈希及正式入口回读。
- 双端CLI开发包上传、公众平台体验指针设置和刷新回读；Chrome9223公众平台当前为未登录首页。
- 真机手势/现场设备验收；健康、心跳、队列、合成fixture不能代替这些证据。
## 关键证据
本地证据目录outputs/omission-release-20261117；preservation-final.json、standard-retry-{before-confirmed,after}.log、api-reviewed-tsc.log、access-legacy-reviewed.log、parking-owner-reviewed.log。
work-orders-browser、logs-feedback-browser、integrations-browser、native-*.png均为隔离测试；非生产业务写。
## 下一轮
先核对并提交明确文件，合入推送main后按./deploy/publish-production.ps1 -Target auto发布；禁止从未提交分支构建生产。
之后tools/miniapp-ship.mjs双端--upload（共享构建串行），核对同源与版本，再尝试代设体验；不可拿上传当体验指针完成。
生产唯一124.223.179.214，身份/目录/服务需再核验；不得连接退役旧机。汇报按六项结果→证据→风险。
