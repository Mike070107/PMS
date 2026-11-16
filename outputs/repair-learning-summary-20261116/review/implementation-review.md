# 初版实现只读审查

## 最终结果（2026-11-16 11:16，最新在上）

最终 diff 复核未发现未处理的已证实 P0/P1/P2。初版两个 P2 与追加的跨 office 重判异常边界均已修复；容量过滤与内部 marker 保护也已修正。

- 解析先从原文得到真实社区，再取对应有效类别与 office，避免 dto context 的 A 处学习污染明确地址 B。
- lite 分支从已验证的 matchedRaw 去除地址，仅将故障句查本处样例；不复制其他地址/联系人字段。
- AI 地址重试改变 office 时先清除旧分类及 sampleMatched，再调用新 office 分类；异常路径保留地址与描述，但不残留旧 office 类型。
- SQL JSON office 约束先于 take200；JS 再做严格整数 office 检查。
- 内部种子 marker 对 update/remove 均视为404，不能经常规CRUD移除标记。
- 独立边界回归最终证据见 [最终输出](adversarial-final.txt)；此前红证据保留在 [首轮](adversarial-first.txt) 与 [异常分支](adversarial-failure-path.txt)。

## 初版发现（以下为已修复的历史问题）

未发现已证实 P0/P1；发现并实测两个 P2：

- **P2：上下文 office 的分类学习残留到最终地址的另一 office。** [parseRepairAddress](../../../apps/api/src/modules/repairs/repairs.service.ts#L6222-L6359) 初次 parse 根据 dto.communityId 取 office A 样例，但地址识别可返回 B（dto 是 context，并非硬范围）。后置 B 查库若没新样例，保留已受 A 样例覆盖的类型。前端提交类型时会固定错误分类，正式创建不再重查学习。
- **P2：lite 精确门牌匹配分支绕过同类分类学习。** 地址已经细到房号且旧关键词命中时不调用 AI；后置查样例用完整含门牌 dto.text，而办公室学习保存的是 request.content。换门牌同类句即使应受本 office 人工确认指导，也没有样例命中或 AI 机会，退回旧关键词。
- **P2 容量风险（静态，未单独跑容量压测）：** [forPrompt/findExact](../../../apps/api/src/modules/ai/extract-samples.service.ts#L57-L107) 最近200条后才按 office 过滤，其他 office 大量录入会挤出目标 office 的提示样例及归一化精确召回。原文完全相同 exactRows 单独查询不受此条限制。

## 证据

- 独立只写输出目录的 [对抗测试](adversarial.cjs)，使用真实 ExtractSamplesService / RepairTextAiService，以及正式 RepairsService.parseRepairAddress 方法；仅数据库、地址规则结果和模型回复为内存 stub。
- 命令（apps/api 工作目录）：`node -r ts-node/register --test ../../outputs/repair-learning-summary-20261116/review/adversarial.cjs`。
- [首次输出](adversarial-first.txt)：3 tests，1 pass / 2 fail。跨 tenant、无 office 不读取本 office 样例通过；A→B expect intercom actual electric；lite带门牌 expect electric actual undefined。
- 原调查 [基线](baseline-tests.txt) 的 TS2554 是 lead 实现中间态，非最终类型检查结论；其余17条已通过。
- 现有 parse 原型 mock 仅发现 [notification-delivery.test](../../../apps/api/src/modules/notifications/notification-delivery.test.ts#L93-L104)：没有 dto.communityId、结果也无 communityId，不触发新增依赖，不需给产品加 optional injection 来掩盖缺失 mock。完整 affected 套件由 lead 运行。
- 已静态确认 AiModule 导出 ExtractSamplesService；strict helper 明确 office assignments，不用 all coverage；通知转单与逾时已复用 helper；分类 only 样例继续 AI 处理其它字段；create 不能伪造内部 metadata，update 保留 scope；删除前补持久种子 marker，读列表过滤 marker kind；技能候选只在无默认人时 fallback，保留 tenant/ACTIVE/office覆盖/app:pool权限。

## 剩余风险

独立复跑 [最终输出](adversarial-final.txt)：4 tests / 4 pass / 0 fail，覆盖原两个 P2、重判异常 failclosed、tenant/缺 office 隔离。按 lead 新授权新增了版本化 [地址边界回归](../../../apps/api/src/modules/repairs/repair-learning-address-boundary.test.ts)，没有修改产品实现或其它测试。其运行证据见 [版本化测试输出](versioned-boundary-tests.txt)。

未运行生产、真实微信通知或实际数据库事务并发；独立内存 repo 测试不证明 PostgreSQL 上并发播种/并发重复学习无重复。lead 新增 PGlite 测试另负责实际 TypeORM SQL 与 HTTP CRUD 验证；此处不把尚未收集的 lead 测试结果列作本 reviewer 亲跑证据。内部 marker 已禁止常规 update/remove，SQL Raw alias 后加空格以便 TypeORM 正确引用 JSON 列也已审查。
