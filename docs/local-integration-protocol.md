# 现场接入：兼容旧助手与标准适配协议 1.0

## 结论与边界

PMS 不应按数据库类型或厂商增加业务分支。PMS 只发送标准业务命令；本地适配器自行连接数据库/SDK、映射字段、处理厂商错误并提供回读证据。数据库地址、账号、表名、SQL、DLL 路径不能放入标准任务。

本次提供了标准连接注册/停用/密钥轮换、版本化任务 API、共用前端 API 客户端、可运行本地 runner 和**真实 SQLite 只读查询参考适配器**。参考适配器不是任意厂商驱动，也没有实现门禁授权/停车写入。

正式「门禁发卡」可显式选择标准工作站和资源；兼容旧工作站仍保留。注册本身不切换路由，多台/多资源时必须选择实际读卡器。标准写卡的批次、明细和原有分配账本在同一正式业务链中保存；门禁授权、旧库同步、控制器状态继续独立计算。停车订单与费用不从通用标准任务自动回填。

**通用任务 API 仍拒绝 `card.write`**：任意输入一个 `allocationId` 不等于卡号已真实分配。只有正式批次触发 `card.inspect`，取得唯一实卡 UID，再由原 .80 代理查重/分配、保存真实卡号预留后，服务器才事务式创建不可变的绑定写卡命令。回执必须读回一致的 UID 和已分配卡号，才能将原发卡明细保存为写卡完成；这不代表门禁/旧库/控制器或整个批次完成。过期/未知不得自动重写，后续旧库刷新也不得抹去暂停状态。

标准门禁/停车通用命令已有协议、队列和保存回读。新增的标准停车**精确完整车牌查询**桥接复用原查询入口、原记录和历史保存；其发布状态以本次台账为准，不因本文存在就算已上线。门禁授权、停车登记/续费/收费/进出记录以及模糊查询的标准路由仍未完成。参考适配器仅支持 SQLite 门禁只读示例；没有生产停车厂商模块、标准实卡适配器或现场硬件验收，不能把本地桥接测试算作新厂商已接通。

## 现有助手到底兼容什么

[现场助手 v2](../tools/data-sync-assistant-v2/README.md)继续保留，不需要迁移或重新注册。其兼容性来自具体适配实现，而不是“支持所有数据库”：

| 现场对象 | 当前方式 | 不能据此推出的结论 |
|---|---|---|
| .80 捷顺旧库 | 已有 SQL Server 查询、唯一卡号分配、人员/卡记录映射 | 任意 SQL Server 表结构都兼容 |
| .88 门禁 | MjSystem/iCCard MDB 字段映射及对应控制器 SDK | 任意 Access 文件或任意 SDK 都兼容 |
| 原停车库 | SQL Server 2008 和现场约定存储过程/字段 | 任意停车厂商都可直接使用 |
| 德立云 | 已有专用云协议与现有业务链路 | 云协议等于通用数据库协议 |
| 新 SQLite 参考适配器 | 本地 PermitCards 固定示例映射，只读门禁查询 | 可直接操作生产库、授权或停车续费 |

旧接口、旧版本门槛、v2 多连接逻辑和已发布下载均未删除/替换。本次写卡安装包不修改旧助手 Windows 服务、配置或启动项。

## PMS 稳定接口

接口相对正常 API 根地址，例如 `https://prsznh.cn/api/v1`。本文是协议说明，不代表本次代码已发布到该生产地址。

管理侧使用正常 PMS 用户 Bearer 凭据、所选企业、业务查看/编辑权限，且必须拥有企业全部小区范围：

| 方法 | API 相对路径 | 用途 |
|---|---|---|
| GET/POST | `/local-integrations/v1` | 列表 / 新连接，名称重复报冲突，不隐式轮换 |
| POST | `/local-integrations/v1/:key/enabled` | `{ "enabled": false }`；启停均清空就绪状态 |
| POST | `/local-integrations/v1/:key/rotate-secret` | 显式轮换，旧凭据立即失效 |
| POST | `/local-integrations/v1/:key/tasks` | 创建标准业务任务，幂等键必须匹配完整命令 |
| GET | `/local-integrations/v1/:key/tasks/:id` | 查询原任务与结果，不返回租约密钥 |
| GET/POST | `/local-integrations/v1/parking-query-routes` | 读取 / 整体保存本企业的一期、二期只读停车查询资源绑定 |

前端正式封装为 [localIntegrations API 客户端](../packages/api-client/src/endpoints/local-integrations.ts)的 `list/enroll/setEnabled/rotateSecret/createTask/getTask`。注册 UI 在「系统与设备」，不要求写卡电脑持有数据库密码。标准连接资源和能力目前在注册时固定；调整能力应新建独立命名连接并完成现场切换验收，不能通过心跳越权扩容。

新标准注册请求示例：

```json
{"name":"门禁只读服务-现场A","kind":"service","resources":[{"id":"site.main","label":"现场A门禁","capabilities":[{"operation":"access.query","revision":1}]}]}
```

返回 `key` 和仅本次可见 `token`（格式 `local-<32hex>.<secret>`）；服务器只保存哈希。请通过密码管理器/受控服务凭据机制配置现场，勿粘贴到日志、工单、源码或聊天截图。

业务任务示例：

```json
{"resourceId":"site.main","operation":"access.query","revision":1,"idempotencyKey":"read-card-20261116-001","command":{"query":{"field":"card","value":"123"}}}
```

`idempotencyKey` 为 1–80 位字母/数字/`._:-`。请求超时先用**原连接、原幂等键和完全相同的命令**查询/重试创建，不生成新键强行执行。相同键不同命令返回冲突。

## 能力与证据

顶层协议 `protocolVersion: "1.0"`，每个 operation 的 `revision: 1`。未知版本/能力不降级、不模拟。逻辑资源 ID 是稳定标识，不是数据库连接字符串；资源 ID 长度 ≤80，标签 ≤100。

| operation | 标准命令要点 | 成功证据 |
|---|---|---|
| `card.inspect` | 正式批次读取唯一 `cardUid`（8 位大写十六进制）；适配器必须真实读卡 | `observed` |
| `card.write` | 仅正式发卡事务创建：绑定 UID、真实预留卡号、allocationId、资源 profile；禁止通用创建 | `card_readback`，唯一记录的 UID/number 须与绑定一致 |
| `access.query` | query.field = card/plate/room/person，query.value | `observed` |
| `access.grant` / `access.revoke` | card.number + authorization.targetIds | `database_readback` |
| `access.controller.apply` | card.number + authorization.targetIds | `controller_ack` |
| `parking.query` | 标准查询条件 | `observed` |
| `parking.vehicle.upsert` | vehicle.plate，可附 person/authorization | `database_readback` |
| `parking.vehicle.renew` | vehicle.plate + authorization.validUntil | `database_readback` |

可选标准对象：`person {externalId,name,room}`、`vehicle {plate,externalId,vehicleType}`、`authorization {targetIds,validFrom,validUntil}`。日期仅接受真实日历日期 `YYYY-MM-DD` 或 UTC ISO 时间（含秒，可含1–3位毫秒），拒绝2月30日/24点/反向时间范围。上限和全部字段见[服务端协议校验](../apps/api/src/modules/local-integrations/protocol.ts)。未知字段（包括 SQL/数据库密码）拒绝。

结果：

```json
{"outcome":"succeeded","evidence":"observed","records":[{"cardNumber":"123","name":"合成住户","room":"1/101","status":"active"}]}
```

`outcome` 只能为 succeeded/failed/unknown。`records` 至多100条，仅接受 `cardUid/cardNumber/plate/externalId/room/name/targetId/validUntil/status` 标准字符串字段；`parking.query` 额外接受 `ownerId/phone/note/plateChangedAt`，且其 `ownerId/name/phone/room/note/plateChangedAt` 可明确为 null。字符串沿用协议长度和控制字符限制，不是原始数据库行。`code` ≤80，`message` ≤500，不应包含密码、连接串或SQL。写库后必须重新查询核对再给 `database_readback`；控制器 SDK 返回“已提交”不是 `controller_ack`。

## 原停车查询的标准只读绑定（窄范围）

全小区业务编辑权限通过上表配置 API 显式保存完整配置，例如：

```json
{"routes":{"parking1":null,"parking2":{"integrationKey":"local-<实际连接key>","resourceId":"parking.readonly"}}}
```

一期、二期必须绑定各自独立的逻辑资源；适配器的外部记录号必须与该原停车库的稳定车辆记录号同义，切换厂商前须验证标识映射，不能复用其他车辆的号码覆盖快照。配置仅含逻辑连接/资源，不含数据库地址、表名或凭据。null/未绑定仍走原旧网关；有绑定但离线、停用、不就绪则明确失败，**不自动回退**。配置 API 不是现场厂商适配器，不能因注册了资源就标记可用。

从原停车查询 API 以明确的 `database: parking1|parking2` 和完整车牌发起。服务器在同一事务创建原 `ParkingQuery` 与服务端 `parkingQueryId` 绑定任务，原查询 GET、页面轮询、PMS 匹配和快照/历史仍复用；不伪造旧网关身份或旧租约。通用任务不接受客户端业务绑定，不会更新原查询。原网关无法领取或报告标准拥有的查询。

成功结果必须提供 `records` 数组（确实无车辆时为 []）；每条包含 `externalId,plate,ownerId,name,phone,room,note,plateChangedAt`。换牌时间须真实读取并规范化（未知/未映射不能伪装为 null），沿用原历史的2000年至当前后一天可信时间窗；null表示源库确无值。记录号稳定唯一，车牌精确等于冻结查询；后六字段缺失不等于 null，不能用部分投影擦除既有快照。适配器必须真实完整查询，不可把截断、异常、映射失败当成空列表。任务回执、原记录、快照和历史同一事务提交；重报不重复历史。租约过期为未知失败，不重新排队；原租约迟到回执可对账。此处仍缺实际生产停车厂商模块/现场验证，不支持尾号、电话、姓名、房号、进出、收费或写操作。

## 现场执行协议

现场 Bearer 是该连接的完整一次性 token，仅能访问本连接的 agent 路由：

| POST 相对路径 | 输入/输出 |
|---|---|
| `/local-integration-agent/v1/:key/heartbeat` | `{protocolVersion,version,ready}`，每5秒；ready 必须是已注册能力子集 |
| `/local-integration-agent/v1/:key/claim` | `{}`；返回 `{task:null}` 或带 `leaseToken/leaseExpiresAt` 的任务 |
| `/local-integration-agent/v1/:key/tasks/:id/report` | `{leaseToken,result}`；同一结果可重报，不可覆盖成不同结果 |

15秒内未收到心跳不能领取任务。`ready: []` 明确表示没有可用本地连接/硬件，不能当成所有能力都可用。任务领取采用事务和行锁，60秒随机租约。过期任务变为 unknown，**不重新排队**；原租约的已验证迟到结果可以对账，但不得再次执行原动作。停用/轮换在事务内验证当前身份，旧心跳不能恢复旧密钥或启用状态。

## 本地适配器开发与部署

共用 [runner](../tools/local-integration-adapter/runner.cjs)负责 HTTPS、心跳、领取、持久执行意图、回执重传和单实例；厂商模块只实现：

```js
module.exports = {
  version: '1.0.0',
  async ready() { /* 实测DB/SDK/读卡器；返回已实现且当前可用资源；失败返回 [] */ },
  async execute({ operation, revision, resourceId, command, taskId,
                  idempotencyKey, deadline, signal }) {
    // 只在这里：本地字段/表/SDK映射；参数绑定；真实操作 + 回读/设备确认。
    // 尊重 deadline/signal；未知结果返回 unknown，禁止收到任务后自动模拟。
    return { outcome: 'unknown', code: 'IMPLEMENTATION_REQUIRED' };
  }
};
```

runner要求 Node.js 22.16+（实际已验证24.15），SQLite 示例使用原生 `node:sqlite`；其他数据库由适配器引入所需驱动、ODBC或独立原生桥，不要求PMS服务器安装这些依赖。不要将 Node runner 用作旧 Windows 写卡程序的替代品。

[SQLite 只读参考适配器](../tools/local-integration-adapter/sqlite-readonly.example.cjs)真实打开既有数据库、只读模式、参数化查询；预期本地表 `PermitCards(CardNo TEXT,HolderName TEXT,Room TEXT,Enabled INTEGER)`，只实现 access.query 的 card/room/person 条件。数据库不存在/字段不符即撤回能力。没有生产数据库、没有样例库自动创建、没有写权限、没有模拟成功分支。

在现场服务专用账号下，以受控方式注入环境变量后运行（示例值必须替换，勿将真实凭据提交到脚本）：

```powershell
$env:PMS_API_BASE_URL = 'https://<已部署本协议的测试或正式PMS>/api/v1'
$env:PMS_LOCAL_INTEGRATION_TOKEN = '<系统与设备的一次性完整token>'
$env:SITE_DB_PATH = 'C:\Site\vendor.sqlite'
$env:SITE_RESOURCE_ID = 'site.main'
node tools/local-integration-adapter/runner.cjs tools/local-integration-adapter/sqlite-readonly.example.cjs C:\PMS-State\SiteA
```

每个连接单独本机状态目录；仅服务账号/管理员可读写，不使用共享盘。Unix创建目录700/文件600；Windows必须另核验NTFS ACL，不能假设 POSIX mode 设置了 Windows ACL。状态不保存数据库凭据或业务命令；租约日志和回执仍应视为敏感文件。

runner在外部动作之前落盘 `executing`，结果先落盘再报；网络失败只重报原结果，不重新执行。重启遇到中断意图回报 unknown。每个任务的已报告编号保留在 receipts，不能为“清理磁盘”删除仍可能用于去重的回执。文件日志不承诺断电、存储损坏下的 exactly-once；物理/写库适配器仍必须使用厂商端可持久去重或人工回读对账，不能把单机文件锁当成设备事务。

异常退出保留 `runner.lock`，**不自动抢锁**。恢复时由运维确认旧进程及其全部设备/SDK工作线程已退出，且无其他启动器在重启，然后人工移除锁，保留 journal/receipts，再启动完成原任务对账。正常 SIGINT/SIGTERM 等待当前执行返回后退出；适配器必须支持超时取消，不能强杀进程后假定动作未发生。

## 生产建表边界

统一 API 部署会在重载服务之前，显式执行冻结包中的 `production-local-integration-migration.js --apply`。仅白名单 `1796200000000` / `1796200100000` / `1796200200000` 三项：新增接入表、可空绑定字段及索引；不扫描其他待执行迁移、不改迁移台账、不更新历史业务行。默认 `--check` 是只读核对，`--apply` 使用数据库事务、5 秒锁等待/30 秒语句限制和事务级互斥锁；结构不符回滚并停止部署。应用回退保留新增表，不执行 `down()`。真实 PGlite 回归覆盖默认只读、重复执行保留数据、结构漂移回滚。

## 新厂商接入验收清单

1. 保持 PMS 协议和资源 ID 不变，只新增/修改现场模块及其私有映射；确认授权和数据库备份。
2. ready探测失败→空能力；无驱动/无库/无卡模板/读卡器断开不得假在线可写。
3. 从正式业务 API 创建任务，用真实本地测试库/硬件执行，随后 GET 原任务核对标准结果。
4. 重复创建、断网丢回执、进程中断、租约过期、并发实例、密钥轮换与租户隔离全部验收。
5. 写操作逐层留证据：数据库回读 → 控制器已确认 → 现场刷卡；登记/心跳不是业务成功。
6. 写卡已连接正式批次/明细与原分配账本；其他既有页面流程仍需各自完成明确路由绑定、订单保存与刷新读取，不通过启用连接偷偷切换。

本地证据：API 协议持久化/真实 SQLite HTTP 链路、原 .80 分配报告→绑定标准写卡→原明细保存、重复 UID/错号/预留被改/租约过期暂停、runner 丢回执/中断/去重，以及系统设备和正式发卡的真实 Chrome 桌面/窄屏/错误/等待/成功测试。生产是否发布以本次发布台账与公网版本/哈希回读为准。现场生产厂商库、控制器、真实刷卡、签名及历史 Windows 环境仍需现场验收。
