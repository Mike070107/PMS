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

## 二、线上版本（2026-11-10 10:26）

```
Web = 2.0.20261110-1025
API = api-475b21f（db up）
助手 = 2.5.52（.80 / .88 现场均已升级；发卡历史人事资料添加时间已回传）
```

> 22:11 上线：P0-4 最近30笔不再 pending、P0-5 门禁页助手状态按真实网关+能力分项显示（详见「待办」P0 4/5）。
> 22:50 上线：统计汇总 P1（`/statistics`：项目实收/欠费年度汇总 + 三级下钻 + 勾选筛选 + CSV），口径见 `docs/statistics-reports-spec.md`。
> 23:05 上线 P1.1：`mis_mirror_bill.nature_code` 行级房屋性质 + 镜像回填；统计按「收费时点性质」过滤，前端默认排除 06 空房。生产实测 01 管理处 ¥662,269.00、02 管理处 ¥745,182.10，与旧系统截图逐格一致（spec §8）。
> 23:36 上线统计汇总 UI 改版（web）：左侧菜单「分析」+「统计」合并为「统计分析」；统计汇总筛选改悬浮可收纳（localStorage、窄屏抽屉、收起后表格占满）；管理处编号独立列、表头/数值统一对齐、加表格线、年度列压缩减少横向滚动。截图见 `D:\pms-statistics-evidence\`。
> 10:25 统计汇总筛选真正悬浮：移除左侧 324px 预留；结果区/表格始终占满内容宽度；筛选默认收起，点「筛选条件（N）」弹出 fixed 400px 浮层覆盖内容（桌面点外部关闭、≤900 遮罩、≤640 底部抽屉），点统计/收起/外部/Esc 关闭；导出仍在结果标题右侧。> 10:10 门禁发卡与全站表格布局：最近 30 笔做卡记录移到页面最底部并默认折叠（折叠不请求，展开记住状态）；发卡历史「已隐藏」记录按普通行展示（去灰化/去标签，操作可用）；全站表格宽度改为 width:100%+auto+nowrap、去掉固定 min-width，屏幕够宽填满、内容超宽才内部滚动（门禁发卡 11 列 1440 完整显示；统计宽表允许滚动、窄表填满；收费报表/明细抽屉同规则）。> 09:50 门禁发卡日志修正上线：任务成功状态白名单补齐（controller_uploaded/access_db_written 等，此前真实成功被误判「失败」）；详情改为「操作日志（最新在上）」逐行动作，写入 Access 库只显示 DB 写入记录、授权楼栋只显示控制器回执，互不混；日志默认折叠，点击表格行 ▸ 展开；左侧菜单默认展开「门禁管理」。> 09:33 收费报表（/reports 收费 tab）接入旧系统：summary 合并 PMS 收款与 mis_mirror_bill 实收（01→community1、02/03→community2、04→community16），byCommunity 带 PMS/旧系统来源标签；新增 /fees/reports/detail 下钻（dimension=community|fee|method|cashier|day、source、分页）；导出 5 个汇总 sheet + 新增「旧系统实收明细」sheet。生产实测 2026-10：旧系统 4 管理处合计 ¥933,134.40 / 3,035 行（02 下钻 844 行 ¥153,142.20），导出 179KB xlsx。> 09:15 收缴考核表格美化：低饱和语义色（收款=应收绿、欠收红、预收蓝、无数据灰；收缴率 ≥95 绿/80–95 琥珀/<80 红）、两级表头+奇偶月色带、sticky 前三列、斑马纹/hover、合计行强调、单位上表头（月列去 ￥）、表下图例、指标卡阈值着色；其他统计表统一负数红/零「—」/合计行 .stats-total-row（欠收红、溢收蓝、减免绿、收费汇总退款调整红）。> 08:56 统计汇总布局：点「统计」或「收起」后筛选面板自动折叠为左上角 sticky「筛选条件（N）」入口，表格占满宽度；「导出 Excel」从筛选面板移到结果表格右上角；窄屏默认折叠。> 08:37 门禁发卡操作区改造上线：已添加的卡按钮变绿色「✓ 已添加二期门禁系统」（disabled，不再重复 tag）；授权楼栋提交后轮询控制器回执，全部 completed 且读回 .88 权限表确认后才自动关闭弹窗（失败/超时保留并显示中文逐栋原因）；「最新任务」中文+请求/完成时间+逐栋回执（acknowledgement）；新增「权限读回/重新核验权限」= POST cards/:id/verify-grant 只读 .88 Access 权限表二次验证。生产实测：recent 30 行中 24 行已添加、卡 12025 读回 50 号楼授权（checkedAt 08:38）。completed 语义=控制器 SDK 回执确认（非仅入队）。> 08:18 修复门禁发卡历史「需升级现场助手（.80）」误报：现场助手实为 2.5.52 最新版，人事资料添加时间已正常；最后刷卡时间/出入口来自 .80 捷顺库，该库刷卡记录止于 2020 年（2021 年后二期改用 .88 Access）。现仅 fieldsIncomplete=true 才提示升级，无记录显示「—」并说明来源（生产实测：198/22/201 2013 年卡有 2020-07-29/2020-11-16 刷卡记录，2024/2026 新卡为 —）。下一步：接入 .88 access_gateway 的 accessCardQuery（2.5.52 已在线、只读能力已探测），补 2021 年后二期最后刷卡/出入口（需再发助手版本并现场升级 .88）。> 08:05 上线统计汇总 P2-E：新增「收款汇总表」（费项×5 种收款方式动态列+合计、按收款人×方式×合计×笔数、票据口径：票据金额/税额/不含税收入/张数、CSV）与「票据情况统计」（588 张票据、16 列含入库单/付款人/金额/税额/开票人/作废/核销/发票号/状态色标、CSV）。生产实测：02 管理处 2026-10 方式合计 现金 1,550,820 / 支付宝 2,187,900 / 微信 9,296,700 / 银联 0 / 转账 2,278,800 / 总额 15,314,220 与文档 §4.2 一致；按收款人 赵丽萍 ¥465,085.00（362 笔）、刘微微 ¥347,977.40（1,943 笔）、伍庆中 ¥120,072.00（730 笔），合计 ¥933,134.40（3,035 笔）；票据 588 张全部「已开」，金额合计 ¥1,174,845.80。> 02:45 上线统计汇总 P4-A：新增「减免情况统计」「签报情况统计」。生产补齐 MIS 只读镜像：票据 588 / 票据开票数据 597 / 票据核销 0 / 签报 23 / 签报减免 19 行，`mis_mirror_bill` 增 income_cents（收入）/receipt_warehouse_no（票据入库单编号）/invoice_no（发票号码）/receipt_voucher_no（凭证号码）并 reloadAll 全量补数（648,782 行）。生产实测：减免 19 条（原应收 ¥164,971.90 / 现应收 ¥32,410.70 / 减免 ¥112,211.20），签报 23 条（1 作废/12 结束，类型 更名/减免/收费标准调整）。票据镜像就绪后「收款汇总表」可做（P2 剩余）。> 02:16 上线统计汇总 P3-A：新增「房产汇总」（管理处行+合计+13 房屋性质房屋数列）、「住户台账」（性质/关键词/分页，2,080 行）、「楼房台账」（207 栋，楼/房屋数/业主数/面积）。生产实测：楼 207 / 房 2,346 / 业主记录 2,080 / 面积 207,555.38㎡；01 管理处 89 栋/548 房/539 业主、商品房 502 间；住户台账 totals 2,079 房/204,503.21㎡；楼房台账 totals 同全库。02:21 修复台账关键词：支持 228/50/202 多段房号（token AND），生产验证 10 条命中。> 01:57 上线统计汇总 P2-D：新增「收款分析（按户）」（历年欠收/当年欠收/当月应收/预缴/区间实收 + 点户逐笔 + CSV）与「收费月报表（核心指标）」（行=管理处 11 项指标含回收率；剩余约 10 列待旧系统截图，pendingColumns 明示不伪造）。生产实测：02 管理处前 5 户 5 指标逐项 = 文档 §4.8；月报表合计 月应收 112,172,140 / 月调整 -831,370 / 累计应收 15,671,407,806 / 旧欠应收 54,304,870 / 本期实收 93,313,440 / 预收转入 32,825,140 / 预收余额 140,948,070 / 累计欠收 288,620,240 与文档一致；当月欠收现为 53,069,090（04 上海新家今日新增 80,600 分未缴，较 11-09 文档快照漂移，属数据变化非口径问题）。> 01:41 上线统计汇总 P2-C：新增「欠收与溢收汇总」（欠收/溢收两页签、统计年月+收款截止日期、10 列明细+合计、逐笔抽屉、CSV）与「收缴考核」（12 月应收/收款、合计、金额/户数收缴率、指标卡、CSV）。生产实测（截至 202610、收款截止 2026-11-09）：欠收合计 ¥2,886,202.40（288,620,240 分）、溢收 ¥1,615,373.70（161,537,370 分），四管理处逐项与文档 §4.10 一致；02 管理处欠收首行 朱全锋 04 201404-202011 16 月 ¥15,825.00 一致；收缴考核 2026 02 管理处 应收 ¥1,829,573.20 / 已收 ¥1,102,392.00 / 60.25% 与 §4.11 一致；户数率（518/428/82.63%）待旧系统截图确认分母口径。> 01:22 上线统计汇总 P2-B：新增「收费汇总」（收费项目×13 房屋性质净额矩阵 + 收款/退款/调整/净额块 + 逐笔明细下钻 + CSV）与「收款日报表」（日期×收费项目 + 下钻 + CSV）；后端按收款块/退款块/调整块严格拆分（成对退款不双计、负调整归调整），新增 `/statistics/collection/fee-nature`、detail kind、options.paymentMethods。生产实测 02 管理处 2026-10：收款 15,374,220 / 退款 15,000 / 调整 -60,000 / 净额 15,314,220，与文档 §4.1 验收数一致；daily 合计=15,374,220。> 01:02 上线门禁发卡改版（web 2.0.20261110-0102 / api-f1675ae）：菜单「门禁卡管理」→「门禁发卡」，「远程门禁」拆成独立「设备管理」页（/access-devices，门禁管理组）；最近30笔做卡记录进页即显示、10条/页、表格与操作同发卡历史；发卡历史 10条/页、序号按全量倒序（30..21/20..11）、按人事资料添加时间倒序；「写入Access」→「添加到二期门禁系统」、去二次确认、成功绿色行内状态、修复 `/access-card-issuance` 前缀 404；授权楼栋改用 grant-options（本小区二期门栋、默认本楼栋）；历史空字段提示需升级 .80 助手。
> 01:04 助手 v2 **2.5.52 已上传生产更新包**（.80 LegacyDatabase 上报 HR.Person.OptDate / MC.LastBrushInfo.LastBrushCardTime / MC.Device.Name，与旧 PHP 页面同口径；v2 csproj 补 IcCardNumber）。**.80 现场必须安装 2.5.52** 后发卡历史/最后刷卡/出入口才有数据；升级后心跳版本变 2.5.52（每 6h 自动检查或手动「检查更新」）。
> 00:30 上线 P1.3（实收年度汇总口径对齐）：列按**应收年月年度**、值=已收流水；实收报表默认房屋性质 13 项含 06 空房、不按应收截止截断；下钻改「房屋×应收年月」逐笔清单。生产实测 01 管理处 ¥23,643,875.16、02 ¥28,177,273.90、03 ¥34,482,291.10、04 ¥66,739,438.00，小计 **¥153,042,878.16**，与旧系统截图逐项一致；01×2004 = ¥882.40、下钻 23 行；欠费仍 ¥662,269.00（spec §9）。
> 23:50 上线 P1.2：`mis_mirror_fee_item.category`（源 `SETUPSFXM.收费类别`，镜像已回填：代收费/其它/日常收费/停车收费）；筛选面板收费项目改为**分类树**（组级全选/半选、搜索），房屋性质 13 项按 code 排序，收款日期改为**范围（从/至，仅实收）**；生产实测选项 16 项分类顺序正确、实收 2026-01-01~03-31 小计与独立 SQL 一致（¥340,723.80）、明细=单元格、欠费仍 ¥662,269.00。

### 当前在制：P4-B 开票统计前后端（2026-11-10，未发布）

- 新增 `ticket-items/summary`（费项/管理处/日期分组）、`ticket-items/detail`（分页及独立全量合计）、`tickets/:id/items`（逐票明细），均在 `/statistics` 下且要求 business:view，管理处按小区权限收敛，越权逐票返回404。
- 开票数据按源全部开票行，不默认剔除作废/预开/核销；不是收款或有效净开票。日期可不传查询全部历史；双侧日期沿用366天差上限。详细契约与边界见 `docs/statistics-p2-report-layouts.md` 附录D。
- 新增动态 `coverage`（当前授权管理处/费项下的镜像开票日期、行数/张数、非零/未知税额行数），不要硬编码历史年份或全零税额。未同步金额与count返回null而非假0。
- API typecheck通过，统计P1–P8全部88/88通过，新增P8为7/7。597行/588票只是依据上一轮只读生产聚合基准构造的合成测试，不是生产明细；本轮未连接或发布生产，线上版本不变。
- task-40 前端已实现：启用「开票数据统计」，管理处/费项多选、可选单侧开票日期/全历史/重置、费项/管理处/日期分组、金额下钻、票号精确/关键词、200行分页、独立全量合计、全量CSV与公式防护；水位/合计/count变化中止导出，隔离迟到响应。现有「票据情况统计」票号接逐票摘要及全部行抽屉，不新增未经确认的「住户票据查询」菜单。
- 浏览器使用真实Chromium+生产组件+合成201行/2票API，新增P4-B定向2/2通过（含等待/错误/未同步/1440/390/320、日期验证/单侧/重置、水位变更与迟到响应）；前端typecheck通过，最终完整统计浏览器回归16/16通过（138531ms）。前端`b69a911b`合入并推送main后，本地正式构建通过（14.74s，仅>500KB分块提示）；后端`e93c9998`已在main。构建时前端无未提交修改，其他API/文档WIP保留；未上传产物。截图在 `D:/pms-statistics-evidence/statistics-ticket-items-*.png`。仅为隔离夹具验收，尚无本轮生产正式入口/API/公网验收。默认单agent，发布须当次明确授权。
- 本轮未碰工作区其他任务的 telemetry 和网关文档改动。

### 当前在制：日常收费日报与明细合计修复（2026-11-10，第 10 轮，未发布）

- 已启用“日常收费项目收款日报表”，与收款日报共用日期×费项矩阵；**仅当前口径实现，不是旧模板已精确复刻**。不自动限定“日常收费”类别，旧表列/方式分组/类别范围仍待证据；详见[报表口径 §4.9](<docs/statistics-p2-report-layouts.md#L803>)。
- 正收款、退款、调整三块分列；仅退款/调整日也保留，全零日不补行。日期/费项/期间收款与退款/调整合计均可逐笔下钻；导出同表并固定已应用筛选，负数可计算、文本公式防护。
- 修复共享逐笔抽屉的真实契约：后端返回 `totals`，不是顶层 `totalCents`；按明细类型读取分类总额，退款正数、调整带符号，未知/未就绪显示“—”而非假 0。切换目标重置类型与过期摘要。
- 后端 P2 定向 19/19，统计 P1–P8 全部 88/88 通过（108042ms，隔离 PGlite，镜像超时警告为预期失败场景）。本轮未连接/发布生产，未改门禁或其他任务 telemetry/网关 WIP。
- 前后端 typecheck 通过；最终完整统计浏览器 **18/18** 通过（160537ms）。真实 Chromium + 生产组件 + 合成 API，仅证明 UI/契约，不代表生产业务验收。覆盖完整月份、退款/负调整独立业务日、八类金额/合计下钻、草稿与已应用快照、CSV 负数/公式防护、1440/390/320、等待/错误/未同步/重试。首轮 16/18 的两处旧断言（CSV 表头和待接入菜单数量）已更新并全量重跑。
- 已查看[桌面金额区](<D:/pms-statistics-evidence/statistics-daily-fees-amounts-1440.png>)、[320 窄屏](<D:/pms-statistics-evidence/statistics-daily-fees-320.png>)和[负调整逐笔](<D:/pms-statistics-evidence/statistics-daily-adjust-detail-1440.png>)截图。实现提交 `f68669af` 已合入并推送 main，随后以已推送且前端无未提交修改的源码运行 `tsc --noEmit && vite build`，20.07s 通过（仍有 >500KB 分块提示）。临时目录使用 `.tmp/build-temp`，未上传产物；未对含其他任务 telemetry WIP 的 API 工作区生成交付构建。线上 Web/API/助手版本均未变。

### 当前在制：GPT 团队复核与统计边界修复（2026-11-10，第 11 轮，未发布）

- 用户明确要求 GPT 团队，本轮前四项专项均显式指定 `openai-codex / gpt-6.1-sol / high`：年度后端、三类明细前端、旧菜单与全局待办审计、票据块未知值；Lead 分配不重叠写范围并统一集成。没有把旧持久队友的 DeepSeek 路由冒充 GPT；子会话缺任务板工具由 Lead 管理，不是业务阻塞。
- 年度后端已交付：保留 `period` 归年与带符号已缴流水；补多管理处×费项×账单性质、授权交集、去重/越权、空范围、缺房屋和逐级金额守恒回归。新增严格真实日期/倒序日期校验，不给年度套 366 天限制；类型检查通过。年度专项 **37/37**；Lead 独立跑 P1–P8 **96/96** 通过（171683ms，新增 8 项；镜像失败隔离的模拟 timeout 为预期）。后续票据变更须另跑其受影响专项，不能据此说所有源码最终全绿。
- 三类明细已交付：世代隔离首屏/分页迟到响应，跨关闭重开的同步锁，失败保留完整已有 200 行/独立全量摘要，同 offset 重试；未知金额/count 显示「—」，原行金额只标「待核对」，不冒充实际明细合计。真实 Chromium 原 18 + 新增 11 = **29/29**，最新隔离 harness CSS 另复验其中 **11/11**，不能相加冒充 40 项。类型检查通过；对隔离旧 HEAD 的两项有效先红已持久化。[完整验收记录](<D:/pms-statistics-evidence/gpt-detail-acceptance.md>)含日志与 27 张截图；Lead 抽看[320 等待](<D:/pms-statistics-evidence/statistics-gpt-analysis-waiting-320.png>)、[390 失败](<D:/pms-statistics-evidence/statistics-gpt-bills-failure-390.png>)与[1440 成功](<D:/pms-statistics-evidence/statistics-gpt-collection-success-1440.png>)，均正常。
- 独立盘点已交付：[旧 30 菜单映射与真实剩余表](<docs/statistics-p2-report-layouts.md#L240-L277>)、[全局过期待办校正](<docs/statistics-p2-report-layouts.md#L1324>)。Lead 已补齐遗漏 11 个灰字身份，当前 17 个可选/18 个待接入标签（15 个旧专用身份 + 3 个额外），不等于旧 30 项完成；黄金映射先红 6/7、修后 7/7，与新增票据及旧接口兼容契约合跑 **12/12**。年度提示已修；月报仍 11 核心指标，不是旧 28/33 列；能耗/空置/部分标准缺源或镜像。P1 不重开 A/B，不造入口/数字。
- 票据专项已交付并经 Lead 审查：缺票据头/明细表或未同步时，四个票据字段行与合计为 null、readiness=false、独立水位，真实收款/收款人保留；同步空表/无匹配/越权是真实 0，张数去重不变。CSV 原只有收款主表，本次增加票据/收款人独立块，unknown 留空而真零可计算，局部公式防护。新增 API 7 项/前端 4 项先红后绿，P7 **11/11** + P8 **7/7**，类型检查绿；1440/390/320 共 **18 场景**含真实 Blob 导出通过，[专项报告](<.tmp/gpt-ticket-summary/REPORT.md>)。Lead 抽看[320 未同步张数列](<.tmp/gpt-ticket-summary/evidence/ticket-summary-unknown-320-right.png>)，未同步非零的边界正确；不泛化修改新 `ticket-items`。Lead 另补 1 项旧 API 兼容先红后绿：有未同步告警/partial 的占位零仍未知，无告警旧数值响应保留真零，票据契约现 5/5、合并菜单 12/12；用最终源码独立重验上述 18 场景通过。
- 票据整合后 Lead 独立重跑最终后端 P1–P8 **103/103**（110493ms，exit 0；预期镜像超时失败隔离日志，不是套件失败），替代上一行 96/96 的旧时点证据。
- 用户新截图明确驳回原“宽表”效果：根因 Shell 居中 `.wrap max-width:1460`，不是 table。新增第五项真实 GPT `d2b4fabd-4b50-402d-a6ee-77eea7026d56` 专项，统计路由解除父级限宽；各屏宽均顶部悬浮抽屉，进退 transform/opacity、入口占位始终保留、下方几何/滚动不变，不再移动内容或用手机底部抽屉。Lead 最终独立回归：2886/1920/1440/390/320 真实 Shell 共 311 帧实测几何/滚动最大变化 0px，含日期 portal、等待/错误/成功；统计前端 **43/43**（浏览器脚本 31 + 独立契约 12）、typecheck 通过，**不提前称已发布**。规则见[统计页设计例外](<design-system/pages/statistics.md>)。
- 本轮按选择性暂存→合入推送 main→干净本任务前端源码构建执行，最终提交/构建结果见[Lead 验收记录](<.tmp/gpt-stats-layout/LEAD-ACCEPTANCE.md>)。保留其他任务 telemetry、网关文档等 WIP，不对混入其 WIP 的 API 生成交付构建。**没有当次生产授权，未连接生产、上传或发布；合成 API/PGlite/浏览器证据不等于现网或旧模板验收。**

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
2. **指标月度分解**：已有 12 个月配置能力，显式值优先，空月才按年度/12；待用户给真实月目标数字，不是待实现分月功能。见[目标工具](<apps/api/src/modules/fees/collection-targets.util.ts#L20-L55>)及[大屏取值](<apps/api/src/modules/fees/screen-summary.util.ts#L20-L24>)，本轮未查生产配置。
3. **今日页与收费报表的「其他」分类**：今日实收 ¥12,240 落在 other，需确认是什么费项（可能是置业泊位费）。
4. ~~**发卡历史「最近 30 笔」返回 pending/rows=0**~~ ✅ 已修复并上线（api-bcf058a / web 2.0.20261109-2211）：根因是 GET `/cards/recent` 每次无条件重置快照为 pending 并清空 history 后立即返回；现改为仅无快照/ready 超 60s 才入队，poll 最长 8s，超时保留旧 rows，error 30s 内不重复入队；行补齐 communityName/buildingId/lane/roomNo/houseId 供跳转。
5. ~~**门禁页「助手离线」误判**~~ ✅ 已修复并上线（同上）：根因是门禁页默认选中地址树第一个小区「枫桦景苑一期」(phase1)，`GET /door/controllers?communityId=1` 提前返回 agentOnline:false；现网关在线判定与所选小区解耦（一期返回真实在线 + controllers[] + message），readiness 新增 `doorControlCommunities`，页面默认二期并按能力分项显示（写卡工作站/`.80` 捷顺库/`.88` 门禁网关），不再谎报「发卡工作站离线」。生产已验证。

### P1 统计汇总剩余（2026-11-10 源码审计校正）

> 用户要求旧「一通软件」30 张菜单逐项对齐，金额能向下穿透明细，管理处/费项/房屋性质可多选。最新逐张状态见[旧 30 项映射](<docs/statistics-p2-report-layouts.md#L240-L277>)及[剩余工作表](<docs/statistics-p2-report-layouts.md#L1349>)；不能把当前 17 个可选入口当旧 30 项已全部验收。
> **不重复做 P1**：年度口径与历史上线基准见[统计 spec](<docs/statistics-reports-spec.md>) §9 及本页 P1.1/P1.3 时间线；已收按应收年月年度、带符号已缴流水，默认含 06；欠费默认排 06。旧 01 管理处 ¥232,344.20 差额记录已被行级性质验收覆盖，不再据旧推测重开年度算法，也不能把 06 当实时空置状态。
> **已实现不等于旧模板已验收**：收费汇总、日报、收款分析、欠收/预收、考核、台账、签报/减免、票据等已有入口/API；开票和日常收费日报新增仍只在本地合入，历史发布身份见本页第 9/10 轮。票据、签报/减免、费项 category 已镜像，旧「一概未镜像」清单作废。
> **仍缺旧表证据/源字段**：月报只有 11 核心指标，完整月报 28 列、综合 B/C 33 列及若干旧打印/分组待截图与公式；四张专用欠/溢旧表不能因共享能力而算逐张完成。租赁户、记账/变动日期、能耗、出租空置及普通/分等标准等按映射表分别补源/镜像，需授权，未知不得补 0。
> **本地继续处理**：第 11 轮 GPT 团队修复分页竞态/日期校验/票据块未知值；Lead 补旧目录遗漏的禁用身份。旧 `/statistics/monthly` 的调用与 P2-A 净额逻辑仍需独立梳理，不能误称等于新 `monthly-report`；不借此统一所有报表成净额。生产升级与现场完整链路验收另需当次明确授权。



6. **MIS 镜像 Phase 3**：断线本地收款→恢复核对→差异处理→去重统计的完整闭环仍待独立验收，见[设计稿](<docs/mis-mirror-design.md#L496-L512>)。已有[幂等收款写回](<apps/api/src/modules/fees/mis-posting.service.ts>)，不能报「完全没写回」，也不能把它等同完整离线闭环；优先复用现有实现，不另建平行收款路径。
7. **收费报表**：旧「只统计 PMS、MIS 无数据」待办已被历史 09:33 发布覆盖；[现服务](<apps/api/src/modules/fees/fees.service.ts#L497-L617>)已合并 MIS，含来源/明细互斥与收款人分组。本轮未做现网重验，不能将旧待办作为新缺口再实现。
8. **大屏**：目标达成口径已修（物业费），但需用户确认；另「上海新家」排行灰条。
9. **库存**：历史入库单库位全为「未分配」，需移库/指定功能；同材料多货架展示已验证。
10. **通知单**：A5「已打印」是否改「已登记」待用户定。

### P2 现场/授权
11. **`.88` 助手现场验收**：本页 10:26 历史记录已报告两现场 2.5.52，不再按「仍 2.5.50、全部未安装」重复派发。发卡历史新增字段、远程写卡及设备刷卡需按真实现场回执分别确认；本轮未连接现场，不外推全能力通过。
12. **`.80` 捷顺**：同上，版本记录不等于字段/设备确认；缺的是真实现场验证与当次授权，不是默认还缺整套升级源码。
13. **小程序体验版**：员工端 1.0.20261108b / 业主端 1.0.20261108a 已上传开发版，需在公众平台「选为体验版」+ 手机清缓存；页面访问埋点靠它生效。
14. **微信开发者工具登录**：上传前需扫码登录（`node tools/miniapp-ship.mjs staff --upload`），否则 CLI 报「需要重新登录」（脚本已能正确报错）。

### P3 清理
15. 并行 WIP：`.tmp/parallel-screen-wip/` 里有另一任务的「决策大屏」文件（Screen 重写版），未合入；如要保留该功能需单独评估。
16. [业务动作覆盖测试](<apps/api/src/modules/observability/business-action-coverage.test.ts>)曾有「9 条写路由未登记」历史失败；本轮统计专项没有重跑，当前红绿未知。独立专项先复现，再按真实缺口补登记，不能把旧数字当当前事实。

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
