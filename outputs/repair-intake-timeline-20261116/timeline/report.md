# 时间线交付（task-40）

## 结果
- 实际进度/状态变更/处理历史按真实时间最新优先；复制稳定排序，不改变API数组、审计存储、计划步骤或状态机。
- 无效/缺失日期置底；同刻有id时按id倒序，同id或无id保持输入相对顺序。
- 两小程序共享实现先归一为真实时间正序算相邻停留，再返回倒序；未结束最新事件继续到现在，结束事件不续计，折叠取第0条。
- 新Web工单当前高亮随最新节点移到第0条。
- vehicle-ops无时间字段的执行字符串仅反转渲染副本，保留追加、调用和失败语义。

## 改动文件
- [共享helper](<../../../packages/shared-types/src/timeline.ts>)、[helper测试](<../../../packages/shared-types/src/timeline.test.ts>)、[共享导出](<../../../packages/shared-types/src/index.ts>)。
- [共享小程序format](<../../../packages/miniapp-ui/src/format.ts>)；员工/业主正式详情均调用此buildTimeline，页面无需再翻转。
- [旧Web工单](<../../../apps/admin-web/src/pages/WorkOrdersPage.tsx>)、[旧Web亲情车](<../../../apps/admin-web/src/pages/FamilyCarsPage.tsx>)。
- [新Web工单](<../../../apps/neighbor-web/src/components/WorkOrderSheet.tsx>)、[催缴跟进](<../../../apps/neighbor-web/src/components/CollectionFollowups.tsx>)、[催缴批次打印及户级跟进](<../../../apps/neighbor-web/src/pages/ResidentialBills.tsx>)。
- [新Web亲情车](<../../../apps/neighbor-web/src/pages/FamilyCars.tsx>)、[车牌资料审核](<../../../apps/neighbor-web/src/components/cashier/NewPlateCard.tsx>)。
- [续期过程](<../../../apps/neighbor-web/src/components/vehicle-ops/RenewSheet.tsx>)、[换绑/车库过程](<../../../apps/neighbor-web/src/components/vehicle-ops/RebindGarageSheets.tsx>)、[下发/注销过程](<../../../apps/neighbor-web/src/components/vehicle-ops/OtherOpSheets.tsx>)、[住户写回过程](<../../../apps/neighbor-web/src/components/vehicle-ops/HistoryAndOwnerSheets.tsx>)。
- [真实源码consumer回归](<../../../apps/miniapp-staff/test/timeline-order.test.mjs>)。

## 证据
- 第一轮红灯：真实buildTimeline乱序/错误当前事件、新WebTimelineTab升序共3失败；实现后通过。
- 扩scope红灯：亲情车、资料审核缺helper及4个执行日志入口共6失败；仅展示层修复后通过。
- `node --test apps/miniapp-staff/test/timeline-order.test.mjs`：16/16通过，见[consumer输出](<consumer-tests.txt>)。测试从实际TS/TSX AST抽取真实排序表达式/TimelineTab执行，并加载真实共享helper及format，不是复制一个假实现；覆盖无效时间、重复timestamp/同id稳定、finished无续计、运行中停留、照片/内容、不mutation、两正式小程序入口。
- 在apps/api运行 `node -r ts-node/register/transpile-only --test ../../packages/shared-types/src/timeline.test.ts ../../packages/shared-types/src/work-order-sort.test.ts`：10/10通过（6个新timeline +4个既有工单排序），见[shared输出](<shared-tests.txt>)。
- 在apps/api运行 `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --target es2020 --module commonjs ../../packages/shared-types/src/timeline.ts`：exit0。
- `git -c core.whitespace=cr-at-eol diff --check`：exit0。保留原CRLF；format混合换行未改行已恢复，diff仅8增7删。

## 盘点：保留的既有DESC契约 / 非实际时间线
- [日志服务](<../../../apps/api/src/modules/observability/observability.service.ts#L483>)：日志列表服务端id DESC分页；介绍页访问明细[createdAt DESC](<../../../apps/api/src/modules/observability/observability.service.ts#L305>)。两Web审计/访问列表不另排序页内数据，趋势图hour ASC不是历史事件时间线。
- [公寓收费历史](<../../../apps/api/src/modules/fees/fees.service.ts#L1219-L1222>)：paid_at DESC +receipt DESC分页，覆盖两Web/legacy及员工小程序读取，不破坏分页顺序。
- [通知列表](<../../../apps/api/src/modules/notifications/notifications.service.ts#L270-L280>)：已有最新id DESC，保留。
- [催缴批次/打印/事件API](<../../../apps/api/src/modules/fees/mis-fees.service.ts#L595-L607>)：已有id DESC，批次分页保留；详情helper仅加强真实时间/同刻稳定性，不改变取200条上限。
- [门禁历史](<../../../apps/admin-web/src/pages/AccessCardIssuancePage.tsx#L757-L765>)：已有复制排序issuedAt DESC、sequence DESC，无需改。
- [停车预览审计](<../../../apps/admin-web/src/pages/ParkingManagementPreviewPage.tsx#L699>)：静态示例已最新优先，无需改。
- [库存审批链](<../../../apps/admin-web/src/pages/InventoryPage.tsx#L2057-L2103>)：含未来/当前/跳过节点，是计划步骤，不倒置。
- 责任跟进的承诺/暂停列表、账单明细快照、资料照片顺序、批量操作目标顺序均非实际事件时间线，保留。

## 剩余风险 / lead验收
- 按委派边界未build、上传、发布、git add/commit/switch，也未写lead地址/照片/录单组件或API。
- 仍需lead集成后对两Web及两小程序运行正式受影响构建/完整类型检查，并在真实浏览器/开发者工具验证桌面/窄屏、展开/折叠、无数据/错误/成功及真实保存后刷新顺序；单元/AST证据不代表这些环节已完成。
- 本次未触发任何真实业务/外网/设备写入。偏好持久化由lead负责。
