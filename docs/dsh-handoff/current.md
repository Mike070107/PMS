# PMS 本批交接（2026-11-16 北京时间）
## 目标
微信通知、工单及共用选址安全裁掉重复弄号；保留永南/永北独立小区身份。小程序验证后默认CLI上传开发版。
## 已完成
1. 共享/API镜像统一完整数字边界与相邻重复弄号去重：永南140弄/140弄6号 大门→永南140弄6号 大门；不跨名称、不删不同弄号。
2. 工单7类通知语义地址、详情返回副本/列表回退、公区识别、两小程序选址统一；不批量改历史地址/审计。
3. 详情编辑往返若位置ID未变且只差展示去重，保留旧快照，不虚构地址更正日志；真正改位置正常保存。
4. 补齐QR新文案/旧码展示、Web收费流水/统一搜索、员工今日收费手工join，只改显示，不改查询/费用/ID。
5. 137/137共享/API回归+30/30Web实际纯函数/员工真Page回归通过；API、两小程序、两Web noEmit类型检查通过。
6. 两轮独立只读审查无P0/P1；公众号/订阅fallback18条内存真通知链验证，无真实微信发送/数据库写入。
## 进行中
功能合入并推main后构建受影响端、顺序CLI上传staff和owner，记录源码/运行包哈希与明确√ upload。
## 待办/未验证
API/Web生产未部署（仍c0dcec1a）；线上通知/存量详情须授权部署API才生效，不应声称本批已线上生效。
小程序体验版指向、审核/正式发布与原生手机验收尚未操作；上传开发版不等于体验版/正式发布。
## 配置建议
永南150弄与永北150弄分别保留独立小区及ID；弄号填150、楼号填6、房号填201，不把150弄6号塞入楼号，不为去重删弄号。
## 关键文件/证据
[回归日志](<../../outputs/address-dedupe-20261116/regression.log>)；[前端回归](<../../outputs/address-dedupe-20261116/frontend-tests.log>)；[共享规则](<../../packages/shared-types/src/address.ts>)；[真实工单回归](<../../apps/api/src/modules/repairs/repair-address-dedupe.test.ts>)。
## 验证命令
`node --test apps/admin-web/test/address-caption.test.mjs apps/miniapp-staff/test/apartment-cashier*.test.mjs`；TS_NODE_PROJECT=apps/api/tsconfig.json下运行shared/API相关node --test；`git diff --check`。
## 下一轮
先核对本批上传证据再决定体验版指向；API/Web发布另需当次明确授权。仅连接124.223.179.214，不依赖退役1.15.172.131。
