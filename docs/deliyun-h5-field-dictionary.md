# 德立云停车管理助手 H5 字段字典

> 更新日期：2026-10-15  
> 适用范围：PMS 当前使用专用账号、密码登录的德立云停车管理助手小程序/H5 接口。  
> 不适用：`openapi.deliyun.cn` AccessKey 开放 API。该协议仍因缺少有效停车 API `version` 而未接通。

## 1. 证据等级

| 标记 | 含义 |
|---|---|
| A · 真实读取 | 已用当前专用账号从「枫桦景苑」真实接口读到，不代表可写 |
| B · 真实写回 | 已有真实业务记录证明接口接受，并从详情接口回读到目标值 |
| C · 页面契约 | 已从德立云正式 H5 页面的请求参数确认，但尚未用真实数据写入验收 |
| D · 未核实 | 响应中可能出现或 PMS 代码已保留，但不得宣称已读/已写 |

## 2. 当前接口能力

| 功能 | 方法 | 主要参数 | 当前状态 |
|---|---|---|---|
| 账号登录 | `POST /user/login` | 账号、密码 | A；返回 Token，只在 API 进程内缓存 |
| 项目列表 | `POST /punit/parkList` | `pageNum`、`name` | A；按项目名精确选择「枫桦景苑」 |
| 项目统计 | `POST /punit/findParkCount` | `unitKey` | A；车辆、在场车、通道、设备在线数 |
| 车辆列表/搜索 | `GET /pma/card/findParkCards` | `unitKey`、页码、页大小、`plateNum` | A；列表不保证返回 `cardNo` |
| 车辆详情 | `POST /pma/card/findCard` | `unitKey`、`id` | A；是字段回读真值的主要来源 |
| 新增车辆 | `POST /pma/card/addCard` | 车辆写入字段 | B/C；已证实能建档，但同次提交的 `cardNo` 可被忽略 |
| 修改车辆 | `POST /pma/card/updateCard` | `unitKey`、`id` 及完整车辆字段 | B/C；`cardNo` 已真实写回验证，其它字段见下表 |
| 删除车辆 | `POST /pma/card/deleteCard` | `unitKey`、`id` | C；PMS 已接入，删除后必须按车牌回读不存在 |
| 人员查询 | `GET /pma/card/findPeopleList` | `unitKey`、`pname` | A；PMS 用完整房号精确匹配 |
| 新增人员 | `POST /pma/card/addPeople` | `unitKey`、`name` | C；新建后必须再查人员 ID |
| 车库列表 | `GET /pma/base/findParkGarageList` | `unitKey` | A；真实返回 4 个车库 |
| 计费类型 | `GET /pma/base/findCardTypeList` | `unitKey` | A；包括月票车、车位池车等 |
| 车型列表 | `GET /pma/base/findCarTypeList` | `unitKey` | A；小型/中型/大型车 |
| 车位池有效期 | `GET /pma/card/findCardPoolParks` | `unitKey`、`cardPoolId` | A；返回关联车位及起止日期 |

## 3. 车辆字段字典

| 接口字段 | 德立云语义 | PMS 对应 | 列表可读 | 详情可读 | 新增 | 修改 | 证据/注意 |
|---|---|---|---|---|---|---|---|
| `unitKey` | 停车项目标识 | 枫桦景苑项目 | — | — | 必传 | 必传 | A；登录后从项目列表取得，不由前端填写 |
| `id` | 车辆记录主键 | 德立云车辆 ID | 是 | 是 | 不传/上游生成 | 必传 | A；修改和删除都必须用原 ID |
| `plateNum` | 车牌号 | 车牌号 | 是 | 是 | 必传 | 可改 | A/C；换牌后需同时确认新牌可查、旧牌不再命中 |
| `cardNo` | **卡号/注册号** | **PMS 「地库车位号」的业务存放位置** | 不稳定 | 是 | 接受参数，但可忽略 | **已真实写回** | B；不是德立云名为“车位号”的字段。新增后必须用 `updateCard.cardNo` 补写，再用 `findCard.cardNo` 确认 |
| `pgIds` | 授权车库 ID，多个可逗号分隔 | PMS 车库授权 | 不保证 | 是 | 可写 | 可写 | A/C；修改某项时必须保留原有其它车库 ID |
| `pgNames` | 已授权车库名称 | 授权展示 | 不保证 | 是 | 不直接写 | 不直接写 | A；名称是展示值，写入使用 `pgIds` |
| `cardTypeId` | 计费类型 ID | 月票车/车位池车等 | 通常 | 是 | 必传 | 可写 | A/C；PMS 新建普通人防车动态查「月票车」 ID，不硬编码 |
| `cardType` / `tname` | 计费类型名称 | 类型展示/配置选项 | 是 | 可能 | 不直接写 | 不直接写 | A；写入用 ID |
| `carTypeId` | 车辆类型 ID | 小型车等 | 通常 | 是 | 必传 | 可写 | A/C；PMS 新建时动态查「小型车」 ID |
| `carType` / `tname` | 车型名称 | 车型展示/配置选项 | 是 | 可能 | 不直接写 | 不直接写 | A；写入用 ID |
| `peopleId` | 所属人员 ID | PMS 房号对应的德立云人员 | 不保证 | 是 | 可写 | 可写 | A/C；必须先按完整房号精确查人员，无记录才新建 |
| `pname` | 人员姓名 | 当前存放完整房号 | 是 | 可能 | 通过人员接口 | 不由车辆接口改 | A |
| `pmobile` | 人员手机 | 车主电话 | 是/可空 | 可能 | 当前不写 | 当前不写 | A；仅读验证，尚未确认应由人员接口还是车辆接口写入 |
| `addr` | 人员地址 | 业主地址 | 是/可空 | 可能 | 当前不写 | 当前不写 | A；尚未真实写回验证 |
| `cprtId` | **缴费规则 ID** | 暂无 | 不保证 | 是/可空 | 可选 | 可写 | A/C；**不是车位号**，不得把 PMS 车位号写入此字段 |
| `cardGroupId` | 车辆分组 ID | 暂无 | 不保证 | 是/可空 | 可选 | 可写 | A/C；当前 PMS 新建不选分组 |
| `poolId` / `cardPoolId` | 车位池 ID | 车位池车关联 | 是/可为 0 | 是/可为 0 | 可选 | 可写 | A/C；`0`/`"0"` 表示未关联，不是真实车位池 ID |
| `cardPoolName` | 车位池名称 | 车位池展示 | 是/可空 | 可能 | 不直接写 | 不直接写 | A |
| `money` | 登记金额 | PMS 人防建档固定为 0 | 可能 | **实测详情可缺失** | 可写 | 可写 | A/C；缺失时不得宣称金额已回读核对 |
| `beginTime` | 车辆有效期开始（Unix 秒） | 人防开始日 | 列表通常给 `beginDate` | 是 | 可写 | 可写 | A/C；上海时区当日 00:00:00 |
| `endTime` | 车辆有效期结束（Unix 秒） | 人防到期日 | 列表通常给 `endDate` | 是 | 可写 | 可写 | A/C；上海时区当日 23:59:59 |
| `beginDate` | 格式化开始日 | PMS 展示 | 是/可空 | 可能 | 不直接写 | 不直接写 | A；写入使用 `beginTime` |
| `endDate` | 格式化结束日 | PMS 展示 | 是/可空 | 可能 | 不直接写 | 不直接写 | A；写入使用 `endTime` |
| `remark` | 车辆备注 | 来源/业务备注 | 不保证 | 是/可空 | 可写 | 可写 | A/C；当前 PMS 新建写「来自PMS」；不再用备注假装成车位号字段 |

## 4. 车位号的唯一当前映射

```text
PMS 字段：地库车位号
       ↓ 业务映射（不是同名字段）
德立云页面：卡号 / 注册号
       ↓
H5 接口字段：cardNo
```

已确认的限制：

1. 普通车辆的 `addCard` / `updateCard` 契约中没有独立名为「车位号」的参数。
2. `cprtId` 是缴费规则，`poolId` 是车位池关系，都不是地库车位号。
3. `addCard.cardNo` 实测可被上游忽略；正确流程是建档后读详情，若 `cardNo` 不一致，再调 `updateCard.cardNo`，最后用 `findCard.cardNo` 确认。
4. 车辆列表不返回 `cardNo` 时，不得判定车位号为空；必须查车辆详情。
5. 车位池接口返回的 `parkName` / `spaceName` / `parkNo` 是车位池内的车位展示信息，不等于普通月票车的可写 `cardNo`。

## 5. 安全修改规则

- 修改前必须用 `findCard` 读完整详情，核对车辆 ID 和车牌。
- `updateCard` 应保留原 `cardNo`、`pgIds`、`cardTypeId`、`carTypeId`、`peopleId`、`cprtId`、`cardGroupId`、`poolId`、`money`、`beginTime`、`endTime`、`remark`，只替换本次明确修改的字段。
- 可选数字外键为空时不传，不传空字符串，不猜 `0`。
- 写接口返回成功只表示德立云已接受；必须再查详情并逐字段核对才能在 PMS 显示完成。
- 未知结果重试前先查最终状态，不盲目重复新增、续期或删除。

## 6. 尚未摸清的字段/能力

| 项目 | 当前未知 | 验证方式 |
|---|---|---|
| 人员电话 `pmobile` | `addPeople` 或独立人员编辑的真实写字段和权限 | 先分析 H5 人员编辑页，再用可恢复测试人员写回 |
| 人员地址 `addr` | 是否由人员接口维护，车辆更新是否会改人员资料 | 同上 |
| 车辆分组 | 分组变更是否有独立约束/联动 | 先读 `findCardGroupSelList`，再受控写测 |
| 缴费规则 | `findCardPayRuleList` 当前项目返回空，`cprtId` 实际规则未验收 | 由德立云后台先确认是否配置 |
| 车位池写入 | 普通车切换车位池、车位编号写入和有效期修改契约 | 分析车位池 H5 编辑页，不用普通车 `updateCard` 猜测 |
| 车主姓名 | 当前 PMS 把完整房号作为人员名；真实姓名是否可安全并存未定 | 需先明确项目人员数据规则 |
| 删除的业务影响 | 是否同时影响在场记录、历史费用或其它项目 | 用可恢复测试车辆受控验证，不用业主真实车首测 |

## 7. 实现位置

- PMS 服务端适配：`apps/api/src/modules/access-card-issuance/deliyun-parking.service.ts`
- 回归用例：`apps/api/src/modules/access-card-issuance/deliyun-parking.service.test.ts`
- 协议只读研究工具：`tools/deliyun/analyze-miniapp.py`
- 调研与事故记录：`docs/parking-management-implementation.md`
