# 账单与待缴 · 设计与执行说明（交给 Codex）

> 目的：让另一个 agent 在同一套规则下继续做，不推倒已上线的东西。
> 现状基准：`origin/main`（含 `1d7a69c7` 通知单改版）。改之前先 `git fetch && git pull --ff-only`。

## 1. 目标与边界

- 这一页回答四件事：**谁欠、催过没有、催了有没有用、下一步动谁**。
- **数据口径只认 MIS**（一通），页面不读本地 `fee_bills`，**不收款、不核销**；收款仍在 MIS/收银台。
- 通知与短信都走「批次」：一次生成 = 一个批次，打印、短信、回执、缴费归因全部挂在该批次上。
- 不改其他模块（抄表、停车、门禁、小程序、现场助手）。

## 2. 页面结构（已成）

`apps/neighbor-web/src/pages/Bills.tsx` 只有一行 `export { default } from './ResidentialBills'`，实体页面在 `ResidentialBills.tsx`。

三个页签：

| 页签 | 内容 | 状态 |
|---|---|---|
| 收费总览 | 4 个统计卡、缴费趋势、待缴分类、收费项目汇总 | MIS 版已有，不动 |
| 待缴与催缴 | 按户清单、**账龄列**、勾选、批量 A5 / 短信预览 | 已有（账龄是本轮加的） |
| 催缴记录 | 批次列表、快照查看、**发送短信**按钮 | 已有，缺打印登记与回执展示 |

## 3. 已实现，不要重写

| 能力 | 位置 |
|---|---|
| 待缴清单（按户、分页 20、MIS 只读） | `ResidentialBills.tsx` + `/fees/mis/residential?view=households` |
| **账龄列**：按最早未缴账期分档 ≤30 / >30 / >60 / >90，60 天橙、90 天红 | `agingOf()` + `.rb-age` 样式 |
| 批次生成（≤200 户、指纹、幂等键、余额二次复核） | `/fees/mis/collections/preview` → `/fees/mis/collections` |
| A5 通知单 | `src/lib/residential-bills.ts` → `renderNoticeDocument()` |
| 短信发送 | `POST /fees/mis/collections/:id/sms`（后端解析明文号、逐户发送、逐户落库） |
| 短信回执 | `POST /fees/mis/sms/callback`（按 BizId 推进 delivered/failed，`x-sms-token` 校验） |
| 短信记录表 | `mis_collection_sms`（只存尾号），`CollectionSmsLogService` |

### 通知单规则（已被测试锁定，改动必须同步改测试）

- A5 竖版 148×210mm，`@page margin:0`，内边距 9mm，**8 行一页**，超出续页
- **一个月一行**，不合并同费同月
- 页眉：服务中心 + `编号 <batchNo>` + 开单日期；页脚：责任声明「本单为欠费提醒，不作为收款凭证」
- 不得出现「如果您已缴费请通知我们再次核对。」
- 合计一次（最后一页）+ 人民币大写；缴费方式三栏 + 「线上缴费已开通」
- A4 时两联一纸，`grid-template-columns:repeat(2,...)`
- 非法账期原样输出并转义；金额非安全整数必须抛错

## 4. 待执行（按顺序）

### 4.1 催收效果归因（最高优先）

`GET /fees/mis/collections/effect?windowDays=30&from&to`

返回每个批次：通知金额、回款金额、回款率、缴清户数、平均回款天数；另给汇总。

**口径（写死，不许漂移）**：
1. **按金额归因**：缴 3/12 期算 25%，不能算「已回款户」
2. **窗口 T+30**：只算通知后 30 天内的缴费，跨窗口不重复
3. **户级封顶**：单户回款不超过该户通知金额
4. 窗口外缴费算自然回款，不计入本批

数据来源：MIS 已缴账单（`view:'detail', status:'paid'`，按 `ZJ_SKRQ`/`updatedate` 落在批次时间之后）。先在 `mis-fees.service.ts` 加一个只读方法，不要复制 SQL。

前端在「催缴记录」下加「效果」子页或独立页签，展示汇总卡 + 批次表（回款率、平均天数）。

### 4.2 承诺还款 / 争议冻结

- 表：`mis_collection_promises`（houseKey、promisedDate、promisedCents、status）、`mis_collection_holds`（houseKey、reason: dispute/request/complaint、until、status）
- 批次预览时**冻结户直接剔除**，并在返回里列出被剔除的户与原因
- 承诺到期未还：在清单里标「承诺已到期」，并计入顶部「今日待跟进」
- 前端：行内操作「记电话 / 承诺还款 / 冻结」，写进批次时间线

### 4.3 打印登记

现在点「打印 A5」只是打开打印窗口，不记录。补 `mis_collection_prints`（batchId、operatorId、pageCount、printedAt），点打印时先落库再 `window.print()`；批次详情展示「打印于 X，共 N 页」。

### 4.4 短信配置提示

系统设置里已有 `CollectionSmsService`（阿里云凭据加密、签名、模板、时段、冷却、每日上限）。页面在未配置时应显示 **readiness.reason**，不要只说「通道未接入」。

## 5. 协作与验收

```powershell
# 每个任务：独立工作树，别和别的 agent 共用 checkout
git worktree add ..\PMS-bills -b feat/bills-xxx origin/main

# 提交前
pnpm --filter @pms/api exec tsc --noEmit
pnpm --filter @pms/neighbor-web exec tsc --noEmit
node --test apps/neighbor-web/test/residential-bills.test.cjs apps/neighbor-web/test/residential-notice.test.cjs apps/neighbor-web/test/residential-sms.test.cjs apps/neighbor-web/test/residential-list.test.cjs
pnpm --filter @pms/neighbor-web build

# 发布：一次一个 target，不要用 auto（assistant 版本闸门会连累）
node deploy/mark-deployed.mjs status
./deploy/publish-production.ps1 -Target api
./deploy/publish-production.ps1 -Target web
```

**红线**：
- 不 `git add -A`，只加本次任务的文件
- 不在 `apps/**` 下留 `.tmp` 产物（会挡发布）
- 改助手必须递增版本号，否则 `-Target auto` 必挂
- 发布权同一时间只给一个会话

## 6. 验收标准

- 清单：账龄分档正确（按最早未缴账期），60/90 天颜色生效
- 通知单：12 个月 → 12 行、2 页；编号与责任声明在；旧提示不在；大写金额正确
- 短信：未配置时点发送给出明确原因；配置后逐户成功/失败/无号码分开计数；回执能把 submitted 推成 delivered
- 效果：部分缴费按金额计入、不虚增缴清户；批次表可下钻到户
