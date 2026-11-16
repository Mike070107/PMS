# 未知类型管理处通知与可删除学习：只读调查

## 结果

调查与最终实现审查已完成，详见 [最终审查](implementation-review.md)。未改产品实现、依赖、索引、生产数据，未发送真实通知；按 lead 后续授权新增独立版本化地址学习回归，4/4通过。下文为修复前调查，保留历史根因与基线证据，不代表最终实现仍有这些缺口。

1. **通知不是字面上的无条件全租户广播，但默认接收群过宽。** [dispatchersToNotify](../../../apps/api/src/modules/repairs/repairs.service.ts#L5159-L5191) 已校验社区所属 office、租户、在职状态与派单权限；然而 [coverageOf](../../../apps/api/src/modules/staff/staff-assignment.util.ts#L46-L49) 把 null 工作范围视为覆盖所有 office。未配置专属收件人时，拥有全公司工作范围及派单权限的账号都能收到，不能等价于“仅该管理处办公室”。缺 office 已返回空，并非应补的广播兜底。
2. **另有明确的逾时广播路径。** [escalateOne watchers](../../../apps/api/src/modules/repairs/repairs.service.ts#L5581-L5595) 直接按 tenant + app:dispatch edit 查 ACTIVE 前20人，无 office/community/专属配置过滤。首次通知正确不代表逾时后仍正确；必须复用严格 office 收件 helper，覆盖未知单及普通候选单逾时。另外 [notifyOfficeOnTransfer](../../../apps/api/src/modules/repairs/repairs.service.ts#L5193-L5216) 自行判断 coverage，未应用专属配置/ACTIVE，并在 office=null 时通知全公司范围账号，也应复用同一 helper。
3. **派单后学习链缺失。** [assignWorkOrder](../../../apps/api/src/modules/repairs/repairs.service.ts#L2975-L3043) 写回报修类型但未写识别样例。[手工更正类型](../../../apps/api/src/modules/repairs/repairs.service.ts#L7307-L7387) 仅按可选 learnKeywords 修改规则并存 correction。另一个 [AiFeedbackService](../../../apps/api/src/modules/ai/ai-feedback.service.ts#L64-L94) 自动收录须两张独立工单一致纠错，不等于一次办公室派单自动记住。
4. **类型学习与正式创建尚未接通。** [guessRepairType](../../../apps/api/src/modules/repairs/repairs.service.ts#L7542-L7557) 是关键词判断；创建未调用样例或 AI，依赖前端解析后携带类型。仅把样例接到 parse，不足以覆盖不经过解析的录单入口。
5. **“按技能”候选池没有自动兜底。** [ruleCandidates](../../../apps/api/src/modules/repairs/repairs.service.ts#L7577-L7601) 只筛默认维修工 ID，未配置就空；已有 [listTechnicians](../../../apps/api/src/modules/repairs/repairs.service.ts#L1617-L1634) 会按 office 工种判断，但兼容默认名单，即默认人无此工种也可能入选。自动池不能把上次派给谁学成默认人。
6. **删除有种子复生边界。** [remove](../../../apps/api/src/modules/ai/extract-samples.service.ts#L149-L153) 物理删除；[ensureSeeded](../../../apps/api/src/modules/ai/extract-samples.service.ts#L36-L50) 以 count=0 判断首次启用，删光后的下一次读取会重新插入种子。必须有持久播种标志，而非进程内 Set。
7. **现有管理入口已支持停用与删除。** [API](../../../apps/api/src/modules/ai/ai.controller.ts#L98-L129) 全部 tenant 过滤；新版 [样例管理请求](../../../apps/neighbor-web/src/components/settings/ai.tsx#L127-L200) 已有列表、停用、确认删除、刷新，旧后台 [删除逻辑](../../../apps/admin-web/src/components/AiSamplesPanel.tsx#L219-L227) 也存在，不需另建平行管理页。

## 精确边界与最小实现建议

- 当前源码 [话机同义词](../../../apps/api/src/modules/repairs/repair-classify.util.ts#L32) 已存在，且有 [家里话机没信号](../../../apps/api/src/modules/repairs/repair-classify.util.test.ts#L38-L52) 双算法回归，故不应宣称当前默认词表必然复现 unknown。真实部署版本、租户有效类型、覆盖配置及实际接收账号未访问，无法由源码反推生产单根因。
- 严格 office 默认收件：派单权限 union → assignmentsOf → `rows.some(row.officeId===officeId)` → tenant/ACTIVE/排除提交者；显式 configured 仍与这组求交。null 配置表示默认，[] 表示静默。不要用 `coverage === 'office'`，同时有 null 与具体 office 的人会被 coverage 判成 all，但应保留显式 office 绑定。
- 工作范围与角色权限已拆分：[StaffAssignment](../../../apps/api/src/entities/staff-assignment.entity.ts#L4-L24) 没有 roleId；[新权限约定](../../../apps/api/src/modules/staff/staff-assignment.util.ts#L1-L8) 明确角色只决定做什么。不能用 assignmentsOf 证明“同一角色关联的 office”，亦不应复活过渡期旧 role_scopes 数据制造第二范围真相。
- 新学习若复用 expected 内部元数据：必须由服务端写入可信 office/type/workOrderId，普通 create 不可伪造，update 必须保留原内部字段；pruneExpected 白名单需明确区分内部与公开字段。
- 分类样例不能直接走 [repairResultFromSample](../../../apps/api/src/modules/ai/repair-text.ai.ts#L411-L430) 完整结果返回，否则缺失描述/地址/联系人会使这些字段被清空并跳过 AI。应独立查类型，其他字段维持规则/模型链路。
- forPrompt/findExact 均须过滤可信 office；无 office 不读有 scope 的条目；老样例无 scope 可按既有租户通用语义兼容。跨 office 同句不同类型、同 office 两小区变地址、禁用类型都要验证。
- 不把派单学习同步写入关键词规则，否则删掉样例仍会命中持久关键词，无法兑现删除恢复 AI。
- 已查 [LLM缓存](../../../apps/api/src/modules/ai/llm.service.ts#L68-L75)：key 含模型、system、user；[提示词样例](../../../apps/api/src/modules/ai/repair-text.ai.ts#L346-L367) 每次从库读取，未见样例进程缓存。删除影响 prompt 的样例会改变 key。分类样例若不进提示词，学习后的分类覆盖不能被写回相同旧 key 的模型原始结果缓存。

## 建议回归清单

1. A/B tenant 同社区/用户数值 ID 不交叉读取；inactive/disabled role/无派单权限不通知。
2. office A 有显式绑定、office B、null-only全公司、null+A混合、权限来自模板五类账号；仅 A 与 null+A 进入 A 默认通知；配置 null/[]/混入 B 与跨租户 ID；无 office 与继承父小区 office。
3. office 派单一次产生一条可管理分类样例；事务失败不学习；无效/停用类型不学习；同工单重派不无限重复，不学维修工 ID。
4. 下一次同句与替换门牌的同类句正确识别，但水管、室内门锁等不同设备不误泛化；同句另一 office 不取错误样例。
5. 无默认工人时按此 office 技能 + app:pool + ACTIVE 选候选；他处同技能、此处其他技能、无权限、非活跃均排除；候选池不冒称已完成具体派工。
6. 删除/停用后 findExact、分类查询、forPrompt均不命中；重新启动实例仍不复生；删除最后一条种子也不复生；原 AI 数据返回，不能被旧分类缓存或规则遗留覆盖。
7. 现有完整抽取样例与完工样例兼容；分类样例不清空地址、描述、联系电话，不覆盖维修工原文。

## 证据与剩余风险

源码静态证据如上；本地纯单元基线 [输出](baseline-tests.txt)：分类6、工作范围5、AI反馈6均通过；repair-text.ai 测试文件因 lead 并行修改中的 TS2554（参数个数尚未配齐）未编译通过，整体17 pass / 1 file fail，不标全绿。第一次输出因目录不存在未能捕获，已创建目录后重跑并保留失败事实。最终 lead diff 的隔离、删除、技能回归尚待审查。没有生产数据、真实通知送达、真实设备或微信原生渲染证据。
