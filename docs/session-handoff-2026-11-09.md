# 会话交接（2026-11-09 夜）

> 给新会话用：读完这份直接接着干，不要从头问需求。
> 用户偏好：直接做、少问、做完就发版；发现问题自己派子智能体修；数据必须真实，不许显示假的 0。

## 一、环境与发布

| 项 | 值 |
|---|---|
| 仓库 | `D:\00项目开发\PMS`，主线 `main`，直接提交推送 |
| 生产 | `ubuntu@124.223.179.214`（私网 10.0.4.8），密钥 `~/.ssh/pms_repair_key.pem` |
| API 部署目录 | `/opt/pms-repair/apps/api`（pm2 进程名 `pms-api`，pm2 属 ubuntu 用户） |
| 发布 | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/publish-production.ps1 -Target api\|web` |
| 部署状态 | `node deploy/mark-deployed.mjs status`（会告诉你线上落后几个提交） |
| 发布注意 | 常卡在「有未提交改动」；先 `git status --short -- apps/api apps/neighbor-web` 清干净再发 |
| 构建注意 | vite 必须设 `TEMP=D:\00项目开发\PMS\.tmp\build-temp`，否则 esbuild EACCES |
| 迁移 | 生产 `DB_SYNCHRONIZE` 未生效，**新列必须手工跑 SQL**（见下方「手工迁移」） |
| 数据库 | `sudo docker exec pms-postgres psql -U pms -d pms_repair` |

### 手工迁移 SQL（已执行过的，记下来备用）

```sql
-- page_views.source
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'web';
-- stock_movements.location_id
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS location_id int;
-- collection_targets 小区组 + 费项
ALTER TABLE collection_targets ADD COLUMN IF NOT EXISTS community_ids int[];
ALTER TABLE collection_targets ADD COLUMN IF NOT EXISTS fee_code varchar(20) NOT NULL DEFAULT 'property';
-- mis_sync_state 失败计数
ALTER TABLE mis_sync_state ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0;
ALTER TABLE mis_sync_state ADD COLUMN IF NOT EXISTS last_failure_at timestamptz;
```

## 二、线上版本（2026-11-10 02:00）

```
Web = 2.0.20261110-0157
API = api-fc57ca3（db up）
助手 = 2.5.52（已上传更新包；.80 现场需安装后才会上报发卡历史新字段）
```

> 22:11 上线：P0-4 最近30笔不再 pending、P0-5 门禁页助手状态按真实网关+能力分项显示（详见「待办」P0 4/5）。
> 22:50 上线：统计汇总 P1（`/statistics`：项目实收/欠费年度汇总 + 三级下钻 + 勾选筛选 + CSV），口径见 `docs/statistics-reports-spec.md`。
> 23:05 上线 P1.1：`mis_mirror_bill.nature_code` 行级房屋性质 + 镜像回填；统计按「收费时点性质」过滤，前端默认排除 06 空房。生产实测 01 管理处 ¥662,269.00、02 管理处 ¥745,182.10，与旧系统截图逐格一致（spec §8）。
> 23:36 上线统计汇总 UI 改版（web）：左侧菜单「分析」+「统计」合并为「统计分析」；统计汇总筛选改悬浮可收纳（localStorage、窄屏抽屉、收起后表格占满）；管理处编号独立列、表头/数值统一对齐、加表格线、年度列压缩减少横向滚动。截图见 `D:\pms-statistics-evidence\`。
> 01:57 上线统计汇总 P2-D：新增「收款分析（按户）」（历年欠收/当年欠收/当月应收/预缴/区间实收 + 点户逐笔 + CSV）与「收费月报表（核心指标）」（行=管理处 11 项指标含回收率；剩余约 10 列待旧系统截图，pendingColumns 明示不伪造）。生产实测：02 管理处前 5 户 5 指标逐项 = 文档 §4.8；月报表合计 月应收 112,172,140 / 月调整 -831,370 / 累计应收 15,671,407,806 / 旧欠应收 54,304,870 / 本期实收 93,313,440 / 预收转入 32,825,140 / 预收余额 140,948,070 / 累计欠收 288,620,240 与文档一致；当月欠收现为 53,069,090（04 上海新家今日新增 80,600 分未缴，较 11-09 文档快照漂移，属数据变化非口径问题）。> 01:41 上线统计汇总 P2-C：新增「欠收与溢收汇总」（欠收/溢收两页签、统计年月+收款截止日期、10 列明细+合计、逐笔抽屉、CSV）与「收缴考核」（12 月应收/收款、合计、金额/户数收缴率、指标卡、CSV）。生产实测（截至 202610、收款截止 2026-11-09）：欠收合计 ¥2,886,202.40（288,620,240 分）、溢收 ¥1,615,373.70（161,537,370 分），四管理处逐项与文档 §4.10 一致；02 管理处欠收首行 朱全锋 04 201404-202011 16 月 ¥15,825.00 一致；收缴考核 2026 02 管理处 应收 ¥1,829,573.20 / 已收 ¥1,102,392.00 / 60.25% 与 §4.11 一致；户数率（518/428/82.63%）待旧系统截图确认分母口径。> 01:22 上线统计汇总 P2-B：新增「收费汇总」（收费项目×13 房屋性质净额矩阵 + 收款/退款/调整/净额块 + 逐笔明细下钻 + CSV）与「收款日报表」（日期×收费项目 + 下钻 + CSV）；后端按收款块/退款块/调整块严格拆分（成对退款不双计、负调整归调整），新增 `/statistics/collection/fee-nature`、detail kind、options.paymentMethods。生产实测 02 管理处 2026-10：收款 15,374,220 / 退款 15,000 / 调整 -60,000 / 净额 15,314,220，与文档 §4.1 验收数一致；daily 合计=15,374,220。> 01:02 上线门禁发卡改版（web 2.0.20261110-0102 / api-f1675ae）：菜单「门禁卡管理」→「门禁发卡」，「远程门禁」拆成独立「设备管理」页（/access-devices，门禁管理组）；最近30笔做卡记录进页即显示、10条/页、表格与操作同发卡历史；发卡历史 10条/页、序号按全量倒序（30..21/20..11）、按人事资料添加时间倒序；「写入Access」→「添加到二期门禁系统」、去二次确认、成功绿色行内状态、修复 `/access-card-issuance` 前缀 404；授权楼栋改用 grant-options（本小区二期门栋、默认本楼栋）；历史空字段提示需升级 .80 助手。
> 01:04 助手 v2 **2.5.52 已上传生产更新包**（.80 LegacyDatabase 上报 HR.Person.OptDate / MC.LastBrushInfo.LastBrushCardTime / MC.Device.Name，与旧 PHP 页面同口径；v2 csproj 补 IcCardNumber）。**.80 现场必须安装 2.5.52** 后发卡历史/最后刷卡/出入口才有数据；升级后心跳版本变 2.5.52（每 6h 自动检查或手动「检查更新」）。
> 00:30 上线 P1.3（实收年度汇总口径对齐）：列按**应收年月年度**、值=已收流水；实收报表默认房屋性质 13 项含 06 空房、不按应收截止截断；下钻改「房屋×应收年月」逐笔清单。生产实测 01 管理处 ¥23,643,875.16、02 ¥28,177,273.90、03 ¥34,482,291.10、04 ¥66,739,438.00，小计 **¥153,042,878.16**，与旧系统截图逐项一致；01×2004 = ¥882.40、下钻 23 行；欠费仍 ¥662,269.00（spec §9）。
> 23:50 上线 P1.2：`mis_mirror_fee_item.category`（源 `SETUPSFXM.收费类别`，镜像已回填：代收费/其它/日常收费/停车收费）；筛选面板收费项目改为**分类树**（组级全选/半选、搜索），房屋性质 13 项按 code 排序，收款日期改为**范围（从/至，仅实收）**；生产实测选项 16 项分类顺序正确、实收 2026-01-01~03-31 小计与独立 SQL 一致（¥340,723.80）、明细=单元格、欠费仍 ¥662,269.00。

## 三、已完成并上线（不要重复做）

1. **账单与待缴页**：四段式、指标带、通知状态、表头排序、H5 卡片化、A5 通知单（12期/页、二维码 24mm、模板可配、预览）
2. **跟进提醒**：待办队列、搜索/筛选/排序/加载更多、电话列（权限控制明文）
3. **待跟进 Top10**：按户、金额降序、同业主标「另有 N 套」
4. **催收**：批次、短信（演练/真发/回执/规则）、T+30 效果、收款差异设计稿
5. **收费大屏 `/screen`**：三板块（年度/月度达成、今日实收）、累计 vs 指标（时间进度差额）、月度柱（仅当月判达标）、小区下拉多选、欠费结构、实时播报、Three.js 安静星空背景、5 分钟刷新
6. **收费指标**：`collection_targets` 支持小区组 + fee_code（默认物业费）；枫桦景苑一期+二期 2026 年度指标 ¥3,982,772.40（=2026 管理费应收，已用 MIS 账单核对一致）
7. **MIS 镜像**：8 张 `mis_mirror_*` 表 + `mis_sync_state`；5 分钟增量（ZJ_ID keyset + updatedate 15 分钟补漏）；mirror 支持 residential(含 trend/amount-brackets/detail)/today/recent-payments/options；设置页可切 mis/mirror、手工重灌、对账；当前 mode=mirror
8. **今日工作**：今日实收/退款/笔数/分项收入（环形图+中文分类+点击看登记时间明细）、今日收款清单（分页、登记时间）、最近收款
9. **办理记录**：行内展开业务明细（车牌/续期前后/操作人/收款方式/extra）
10. **系统日志**：使用统计（访问趋势/页面Top20/用户Top20/来源分布/登录统计/下钻明细）、用户反馈 tab（含标记已处理/批量）、顶部「意见与建议」入口（composer 内嵌缩略图、灯箱预览、20MB 校验、微信通知管理员）
11. **权限**：`bills`、`intranet` 页 key；PAGE_GROUPS 与菜单分组一致；导航→权限一致性回归测试
12. **门禁**：远程开门/常开、控制器在线、`check-online`、发卡历史（捷顺真实 8 条）、最近 30 笔、写入 .88 Access、多楼栋授权（独立失败）
13. **库存**：当前库存列/排序/库位明细/Excel 导出/仓库与库位管理/流水字段补全
14. **管理处页**：新建/编辑/划分/删除小区（真实可操作）
15. **登录安全**：密码入口仅 `?login=password` 可见、5 次失败锁 15 分钟、管理员微信告警

## 四、待办（按优先级）

### P0 数据正确性
1. **上海新家未设指标** → 大屏选三个小区时显示「部分口径」。需要用户给指标，或确认不考核。
2. **指标月度分解**：目前月度目标 = 年度/12（标「按年度均摊」）。要精确需 12 个月数字。
3. **今日页与收费报表的「其他」分类**：今日实收 ¥12,240 落在 other，需确认是什么费项（可能是置业泊位费）。
4. ~~**发卡历史「最近 30 笔」返回 pending/rows=0**~~ ✅ 已修复并上线（api-bcf058a / web 2.0.20261109-2211）：根因是 GET `/cards/recent` 每次无条件重置快照为 pending 并清空 history 后立即返回；现改为仅无快照/ready 超 60s 才入队，poll 最长 8s，超时保留旧 rows，error 30s 内不重复入队；行补齐 communityName/buildingId/lane/roomNo/houseId 供跳转。
5. ~~**门禁页「助手离线」误判**~~ ✅ 已修复并上线（同上）：根因是门禁页默认选中地址树第一个小区「枫桦景苑一期」(phase1)，`GET /door/controllers?communityId=1` 提前返回 agentOnline:false；现网关在线判定与所选小区解耦（一期返回真实在线 + controllers[] + message），readiness 新增 `doorControlCommunities`，页面默认二期并按能力分项显示（写卡工作站/`.80` 捷顺库/`.88` 门禁网关），不再谎报「发卡工作站离线」。生产已验证。

### P1 功能缺口（新增 2026-11-09 夜：统计汇总报表）

> 用户 2026-11-09 夜提出：旧「一通软件」的统计汇总菜单（约 30 张报表）要复刻，数字必须可向下穿透明细，筛选按管理处/收费项目/房屋性质勾选多选。
> 口径与数据盘点见 **`docs/statistics-reports-spec.md`**（已核对：项目欠费年度汇总 02 管理处合计 ¥745,182.10、2026 年度 ¥726,881.20、明细 宝秀路719号719 201410-201412 ¥477.90 与旧系统截图逐格一致）。
> **P1 已上线（22:50）**：`/statistics` 菜单「统计汇总」，后端 `apps/api/src/modules/statistics/`，前端 `apps/neighbor-web/src/pages/Statistics.tsx`；生产接口实测数字全部对上（见 spec §6）。
> **待用户用 MIS 截图对齐的差异**：01 管理处 2007–2018 欠费，PMS 比旧系统多 ¥232,344.20，已定位 4 套房（永德路199-201号199-201 王立 ¥166,417.20；永德路203号203 刘二珠 ¥32,642.00；永德路187号187 陈僮潼、陈明加 ¥23,180.00；永德路157-159号157-159、永德路191号191「开发商」商铺 ¥10,105.00），疑为核销/减免/空置口径，待确认后补镜像（票据、签报/减免、能耗抄表、空置状态）做 P2–P4 报表。
> 计划：P1 已做「统计汇总」页面 + 项目实收年度汇总 / 项目欠费年度汇总 + 三级下钻 + 勾选筛选 + 导出；P2 收费汇总/月报/日报/收款分析等。
> **P2 进展（2026-11-09 23:45）**：
> - `docs/statistics-p2-report-layouts.md` 已完成（report-designer）：旧菜单 30 项全量盘点 + P2 11 张逐张列定义/口径/真实 SQL 实测 + 16 条验收基准数字 + 缺镜像清单 + 旧 EXE 证据索引。
> - P2-A 后端（收费汇总/实收明细/日常收费项目日报表/月报表）代码已入库（`apps/api/src/modules/statistics/collection.*`，test:statistics-p2 20/20），**未发布**：文档指出退款语义需先改（refund_date 正数行=原收款被打退款标记，负数行是调整不是退款；现实现会双计 1 组成对退款），且「月报表」旧模板是「小区×28 列财务指标」而非「月×费项」，需用户截图定模板。
> - **待用户截图确认（阻塞 P2）**：①月报表（2026-10 全部管理处，两层表头+合计）②综合月报表B（2026-10）③收缴考核（2026，02）④含「实收」的报表用 2011 年（有退款）确认口径 A 收款流水（含退款）还是 B 有效净额（剔除退款）⑤欠收与溢收汇总两页签列头⑥综合月报表C 是否存在。P1 实收年度汇总当前用 A（历史比 B 多 ¥38,724.20，2026 年相等），确认后统一。



6. **MIS 镜像 Phase 3**：断线收款 + 核销（`pms_mis_receipts`、差异清单 `pms_mis_collection_differences`、页面放「账单与待缴 → 收款差异」页签）。设计稿 `docs/mis-mirror-design.md`。
7. **收费报表**：MIS 口径接入（方案已出，见 turn 日志：`source=auto|pms|mis`，byCashier MIS 显示 —）。当前报表只统计 PMS 收款，MIS 小区无数据。
8. **大屏**：目标达成口径已修（物业费），但需用户确认；另「上海新家」排行灰条。
9. **库存**：历史入库单库位全为「未分配」，需移库/指定功能；同材料多货架展示已验证。
10. **通知单**：A5「已打印」是否改「已登记」待用户定。

### P2 现场/授权
11. **`.88` 助手升级**：现有 2.5.50 不含发卡历史新增字段（人事资料时间/最后刷卡/出入口）与门禁远程写卡细节；新版源码已在仓库（tools/access-card-agent + v2），需现场安装。
12. **`.80` 捷顺**：发卡历史查询依赖 .80 助手新版字段。
13. **小程序体验版**：员工端 1.0.20261108b / 业主端 1.0.20261108a 已上传开发版，需在公众平台「选为体验版」+ 手机清缓存；页面访问埋点靠它生效。
14. **微信开发者工具登录**：上传前需扫码登录（`node tools/miniapp-ship.mjs staff --upload`），否则 CLI 报「需要重新登录」（脚本已能正确报错）。

### P3 清理
15. 并行 WIP：`.tmp/parallel-screen-wip/` 里有另一任务的「决策大屏」文件（Screen 重写版），未合入；如要保留该功能需单独评估。
16. `business-action-coverage.test.ts` 在 main 上仍红（9 条写路由未登记业务动作），需各模块补登记。

## 五、关键文件地图

| 功能 | 文件 |
|---|---|
| 待缴页 | `apps/neighbor-web/src/pages/ResidentialBills.tsx`、`styles/residential-bills.css` |
| 通知单渲染 | `apps/neighbor-web/src/lib/residential-bills.ts` |
| 跟进队列 | `apps/neighbor-web/src/components/CollectionFollowups.tsx` |
| 大屏 | `apps/neighbor-web/src/pages/Screen.tsx`、`components/ThreeBackdrop.tsx` |
| 今日 | `apps/neighbor-web/src/pages/Today.tsx` |
| 日志/反馈 | `apps/neighbor-web/src/pages/Logs.tsx`、`components/FeedbackDialog.tsx` |
| 门禁 | `apps/neighbor-web/src/pages/AccessCards.tsx` |
| 库存 | `apps/neighbor-web/src/pages/Stock.tsx`、`components/stock/WarehouseManager.tsx` |
| MIS 查询 | `apps/api/src/modules/fees/mis-fees.{service,query,dto}.ts`、`mis-fee-category.ts` |
| MIS 镜像 | `apps/api/src/modules/fees/mis-mirror.service.ts`、`entities/mis-mirror*.ts` |
| 大屏聚合 | `apps/api/src/modules/fees/screen-summary.util.ts` |
| 指标 | `apps/api/src/modules/fees/collection-targets.*` |
| 门禁后端 | `apps/api/src/modules/access-card-issuance/`（`legacy-card-history.util.ts`） |
| 库存后端 | `apps/api/src/modules/inventory/` |
| 权限注册表 | `apps/api/src/common/pages.ts` + `packages/shared-types/src/pages.ts` + `apps/neighbor-web/src/lib/page-access.ts` |
| 统计汇总后端 | `apps/api/src/modules/statistics/`（options/annual/annual-detail/annual-detail-bills） |
| 统计汇总前端 | `apps/neighbor-web/src/pages/Statistics.tsx`、`components/statistics/`、`lib/statistics.ts`、`styles/statistics.css` |
| 统计口径文档 | `docs/statistics-reports-spec.md`（含旧菜单报表清单、数据缺口、对账证据） |

## 六、恢复 MIS 镜像 / 指标的操作

```bash
# 手工重灌镜像（低峰执行，65 万行，约 2 分钟）
curl -X POST https://prsznh.cn/api/v1/fees/mis/mirror/reload -H "Authorization: Bearer <admin token>"
# 手工增量补齐
curl -X POST https://prsznh.cn/api/v1/fees/mis/mirror/sync -H ...
# 对账
curl https://prsznh.cn/api/v1/fees/mis/mirror/reconcile -H ...
```

指标（物业费、一期+二期）当前值：
```json
{"communityIds":[1,2],"year":2026,"annualCents":398277240,"monthCents":null,"feeCode":"property"}
```

## 七、新会话如何继续用团队

1. 新会话读本文件：`docs/session-handoff-2026-11-09.md`
2. 队友是会话级的，**新会话不会自动继承**，需要重新 `spawn_teammate`。建议角色：
   - `api-backend`：NestJS/API/DB/迁移/镜像/报表接口
   - `web-ui`：React 页面/样式/交互
   - `access-desk`：门禁与现场助手
   - `qa-review`：独立验收（tsc/测试/build/线上验证）
3. 派活模板（直接粘）：

```
你是 api-backend，负责 apps/api。先读 docs/session-handoff-2026-11-09.md，然后做 P0-4：
发卡历史「最近 30 笔」返回 pending/rows=0，需改为后台任务+轮询或加长等待。
约束：不 commit/push（Lead 发版）、api tsc 0、相关测试通过。
```

```
你是 web-ui，负责 apps/neighbor-web。先读 docs/session-handoff-2026-11-09.md，然后修门禁页「助手离线」误判：
readiness 三个 agent 均 online，但页面显示离线；改为按 readiness 接口判断。
```

## 八、用户沟通要点

- 用户会截图直接指问题，回复要短、先给结论再给原因
- 不要用「大概」「可能」，要么实测要么说不确定
- 改完直接发版并给版本号；线上没验证过的不要说「已解决」
- 数据口径问题必须先核对（如物业费 vs 全费项、收款日 vs 登记日）
