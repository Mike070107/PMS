# access-db-lab：.88 Access 库只读查询 / 副本写测试

本目录用于在**不连接生产库**的前提下核对 .88 两套 Access MDB 的结构、数据与写入 SQL。
生产写入只能由 `.88` 本机的 `tools/access-card-agent` 完成；这里只操作 2026-09-30 的真库备份和写入副本。

## 1. 已有资产（本机，2026-09-30 从 .88 共享目录复制）

位置：`D:\PMS-Access-Backups\20260930-125356\`

| 文件 | 说明 |
|---|---|
| `MJDataBase.mdb` | MjSystem 运行库备份（25,034,752 B，**无 MDB 密码**） |
| `iCCard.mdb` | iCCard 运行库备份（88,150,016 B，**有 MDB 密码**，DPAPI 只装在 .88） |
| `MJDataBase-write-test.mdb` / `iCCard-write-test.mdb` | 现场做过写入实验的副本 |
| `mjsystem-schema.json` | MjSystem 83 张表的表名/行数/列类型快照 |
| `iccard-schema.json` | iCCard 约 100 张表的表名/行数/列类型快照 |
| `mj-doors.json` / `ic-doors.json` | 门/控制器映射真实样本 |
| `mj26-samples.json` / `ic11-samples.json` | 员工/卡/权限真实样本 |
| `backup-manifest.json` | 源路径与 SHA-256（与备份逐字节一致） |

另：`before-live-write-20260930-130451\` 是临写前备份，SHA-256 同上。

> 这些文件只在本机开发环境；**不要**复制 `iCCard.mdb` 或密码到仓库、聊天、截图。
> 现场真库路径以 `docs/access-card-automation-handoff.md` §6/§7 为准。

## 2. 运行要求

- **必须 32 位 PowerShell**：`Microsoft.Jet.OLEDB.4.0` / `Microsoft.ACE.OLEDB.12.0` 只有 32 位版本。
  两个脚本都会在 64 位会话里自动转 32 位（`SysWOW64\WindowsPowerShell\v1.0\powershell.exe`）。
- 本机执行策略可能禁止直接双击运行 `.ps1`，统一用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\QueryAccessCard.ps1 -Term 06234735
```

- 密码只从**环境变量**或现场 DPAPI 文件读取，不写参数、不落盘：

```powershell
$env:PMS_ICCard_MdbPassword = '<现场安装的 iCCard MDB 密码>'   # 仅 .88 本机或受控副本测试
```

## 3. 只读查询：`QueryAccessCard.ps1`

按卡号 / 房号 / 姓名查询两套 MDB 的人员、卡、状态、楼栋权限和最近 50 条通行记录。

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Term` | 必填 | 卡号（6 位以上十六进制/数字）、房号（`228/26/602`）或姓名 |
| `-Mode` | `auto` | `card` / `room` / `name` / `auto` |
| `-MjSystemPath` | 备份 MjSystem 路径 | 只读 |
| `-IcCardPath` | 备份 iCCard 路径 | 只读；无密码时跳过并返回错误说明 |
| `-PasswordEnvVar` | `PMS_ICCard_MdbPassword` | 环境变量名，**不传密码本身** |
| `-OutputPath` | 空 | 写 UTF-8 JSON；空则输出到 stdout |

已验证命令与输出（2026-11-06，本机备份）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\QueryAccessCard.ps1 -Term 06234735 -OutputPath out.json
```

```text
term=06234735  matchedBy=card  cards=1
cardNo=06234735  personName=228/26/602/9  personNo=6890  endDate=2040-12-31
permissions=[{buildingNo:26, controller:26号单门控制器, door:26, sourceTable:MJ_MacPower}]
errors=[iCCard: env var PMS_ICCard_MdbPassword is not set; ...]
```

房号查询同样验证通过（`-Term 228/26/602` 返回该房 9 张卡，含历史多门权限；历史权限按原库原样展示，不作为 PMS 默认路由）。
`-Term` 命中 0 张卡且有错误时退出码 3；正常退出 0。

## 4. 副本写测试：`TestAccessCardLifecycle.ps1`

在**本地副本**上执行并回读 `extend`（延期）/`lost`（挂失）/`unlost`（解挂）/`cancel`（注销）的 SQL。
默认**事务回滚**，不留任何痕迹；`-Keep` 才提交，用于验证幂等（第二次执行必须 `skipped`）。

参数：

| 参数 | 说明 |
|---|---|
| `-Operation` | `extend` / `lost` / `unlost` / `cancel` |
| `-WgCardNo` | 8 位 WG 卡号 |
| `-ConfirmCopy` | 必填；确认两个路径都是本地副本 |
| `-MjSystemPath` / `-IcCardPath` | 本地副本路径；**拒绝 `\\` 网络路径** |
| `-EndDate` | `extend` 的目标到期日 `yyyy-MM-dd` |
| `-LostStatus` / `-CancelStatus` | iCCard 状态码；**未取证不准填假值**，留空时该项返回失败 |
| `-NormalStatus` | iCCard 正常状态码，默认 `0`（现网样例） |
| `-RestoreDoorIds` | `unlost` 时要恢复的门 ID（来自挂失时删掉的门列表） |
| `-AllowNonPms` | 允许操作 `f_Note`/`EmpMemo` 无 `PMS_` 标记的历史卡 |
| `-Keep` | 提交事务；不加则验证后回滚 |
| `-PasswordEnvVar` | iCCard MDB 密码环境变量名 |

已验证命令与输出（2026-11-06，`%TEMP%` 下的 MjSystem 备份副本）：

```powershell
# 1) 回滚模式：验证 SQL 和回读，然后恢复原状
powershell -NoProfile -ExecutionPolicy Bypass -File .\TestAccessCardLifecycle.ps1 `
  -Operation extend -WgCardNo 06234735 -ConfirmCopy -EndDate 2041-12-31

# 输出 rows[0]: mjsystem completed, before 2040-12-31 -> after 2041-12-31, committed=false
# 随后 QueryAccessCard 回读：endDate 仍为 2040-12-31（回滚成功）

# 2) 提交模式 + 幂等
... -Operation extend -EndDate 2041-12-31 -Keep   # completed
... -Operation extend -EndDate 2041-12-31 -Keep   # skipped（到期日已是目标）
... -Operation cancel -AllowNonPms -Keep          # completed（删 1 条权限 + 员工）
... -Operation cancel -AllowNonPms -Keep          # skipped（员工已不存在）
```

iCCard 部分在本机没有 MDB 密码，所以输出 `failed: iCCard password is not set ...`；
现场在 .88 本机安装 `iccard-db-password.dat` 后，同样命令即可验证 iCCard 的
`t_b_Consumer.f_EndYMD` / `t_b_IDCard.f_Deadline` / `f_LostDate` / `f_DeletedDate` / `t_d_Privilege` 写入。

## 5. Schema 探测（只读）

```powershell
# 表名/列类型/行数（输出 JSON；表名来自数据库自身，不接受外部 SQL）
powershell -NoProfile -ExecutionPolicy Bypass -File .\InspectAccessDb.ps1 -Path D:\PMS-Access-Backups\20260930-125356\MJDataBase.mdb -OutputPath mj-schema-new.json

# 单条只读 SQL（脚本只允许 SELECT / TRANSFORM）
powershell -NoProfile -ExecutionPolicy Bypass -File .\QueryAccessDb.ps1 -Path <mdb> -Sql "SELECT TOP 10 * FROM Employee"
```

`.88` 现场真库探测仍走代理：`Pms.DataSyncAssistant.exe --access-probe`。

## 6. 本轮核对结论（不影响生产）

| 项 | 结论 |
|---|---|
| MjSystem 加密 | 无 MDB 密码；Jet 4.0 可直读；`.88` 现场由 Windows 服务/本机盘符读取 |
| iCCard 加密 | 有 MDB 密码；本机备份不能直接打开，需要现场 DPAPI 密码 |
| MjSystem 挂失/解挂 | `Employee`/`MJ_MacPower` 没有挂失字段，**不能猜**；注销只能是删权限 + 删员工 |
| iCCard 挂失/注销 | `t_b_IDCard` 有 `f_LostDate / f_DeletedDate / f_StatusChangeDate / f_CardStatusDesc`；状态码含义未取证，脚本要求显式传入 |
| 通行记录 | MjSystem `MJ_MacRecord`（67,912 行，字段 `cCardNo,dTime,cDoorId,cStatus,vStatusType`）；iCCard `t_d_CardRecord`（267,989 行，字段 `f_CardNO,f_ReadDate,f_Character,f_ControllerSN,f_ReaderID`） |
| 权限组 | MjSystem `MJ_MacTime` 是时间组；`PowerHeader` 是软件功能菜单，**不是**门禁授权方案。iCCard 用户组是 `t_b_Group`。.80 捷顺“发卡方案”只在原厂 SDK `GetPermissionGroups`，SQL 表未确认 |
| 写权限实测 | 用「零行 UPDATE + 回滚」在副本上验证：MjSystem 可写；iCCard 待现场密码 |

## 7. 安全红线

- 本目录脚本只允许对**本地副本**做写测试；拒绝 `\\` 网络路径（脚本内硬校验）。
- 不把数据库密码写进脚本、参数、日志、Git；只接受环境变量或现场 DPAPI。
- 不在未备份/未验证路径时改 `.88` 真库；真库写入必须由代理在 .88 本机执行。
- 副本写测试默认回滚；需要提交时显式 `-Keep`，且测试后应删掉测试副本或重新复制。
