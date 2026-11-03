# 停车管理 — 单车牌写操作实现规格 (Per-Plate Write Operations Spec)

Source of truth (do not re-read the 2163-line page unless this is wrong):
- API controller: `apps/api/src/modules/access-card-issuance/access-card-issuance.controller.ts`
- API service + validation: `access-card-issuance.service.ts`
- DTOs: `dto.ts`  ·  pricing/bits helpers: `parking-family.ts`
- On-site agent (actual SQL + result shape): `tools/access-card-agent/ParkingDatabase.cs`
- api-client typed wrappers: `packages/api-client/src/endpoints/access-card-issuance.ts`
- Legacy page (payload assembly + display mapping): `apps/admin-web/src/pages/ParkingManagementPage.tsx`

All endpoints are under base `/access-card-issuance`. All require auth; write endpoints need permission `business:edit`, reads need `business:view`. Client wrappers call `request` from `@pms/api-client`.

---

## 0. Core async model — how EVERY operation runs

Two shapes of write exist:

**A. Legacy old-DB operations (parking1 / parking2)** go through the generic queue:
- `POST /parking/operations` → returns a `ParkingOperation` with `status: 'pending'`.
- Then poll `GET /parking/operations/:id` until `status` is `completed` or `failed`.
- The on-site "parking_gateway" agent claims the task, runs a stored procedure against the old SQL Server DB, reads back the row to verify, and reports. Submit does NOT run the SQL inline.

**B. 德立云 (deliyun / 人防 civil-defense) operations** run inline on the API server (synchronous call to the deliyun service). They have dedicated endpoints (`/parking/deliyun/...`) and come back already `completed` or `failed` (DB record still a `ParkingOperation` with `database: 'deliyun'`). No polling needed, but the page still inspects `.status`.

### ParkingOperation response / poll shape (identical for all)
`parkingOperationResponse()` in service (L1902) and `ParkingOperation` type in api-client (L316):
```ts
{
  id: number;
  kind: ParkingOperationKind;              // see §1
  database: 'parking1' | 'parking2' | 'deliyun';
  sourceRecordId: string | null;           // old-DB P_id of the record
  pmsUserId: number | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  payload: Record<string, unknown>;        // echoed, normalized (strings trimmed)
  result: Record<string, unknown> | null;  // agent read-back (verified fields) — see each op
  error: string | null;                    // populated only when status==='failed'
  requestedAt: string;
  completedAt: string | null;
  rollbackOfOperationId: number | null;
}
```

### Polling loop the legacy page uses (ParkingManagementPage L505–513)
```
poll up to 112 times, 800ms apart, while status is 'pending' or 'running':
  task = GET /parking/operations/{id}
```
(≈90s budget per task.) Classify by `status`; `failed` → surface `task.error`; still pending/running after the loop → "现场助手响应超时，任务仍保留" (do NOT resubmit).

### Idempotency (critical)
Every write carries `idempotencyKey` (8–100 chars). The server dedupes: if a task with the same `(tenantId, idempotencyKey)` exists it returns the existing one unchanged. Generate a fresh key per logical submit (`createIdempotencyKey()`), and when fanning out to two DBs for one plate, suffix per DB: `` `${batchKey}-${database}` ``, and deliyun side-effects use `` `${batchKey}-deliyun` ``.

### CreateParkingOperationDto (dto.ts L566) — the generic submit body
```ts
{
  database: 'parking1' | 'parking2';   // IsIn
  kind: <one of §1>;                    // IsIn
  idempotencyKey: string;               // 8..100
  sourceRecordId?: string;              // <=100, the old-DB P_id of the target row
  pmsUserId?: number | null;
  payload: Record<string, unknown>;     // IsObject — op-specific, see each §
  expected?: Record<string, unknown>;   // optional optimistic-lock snapshot
}
```
Server normalizes payload/expected by trimming every string value (`normalizeParkingOperationPayload`, L3397). Gateway readiness is checked before queueing; if no online `parking_gateway` agent with `parkingDbWrite` + the right version supports the kind, it throws `503` with a version-upgrade message (see L1176–1188 for per-kind minimum agent versions, e.g. rebind_owner ≥2.5.20, update_garages/update_vehicle_type ≥2.5.21, sync ≥2.5.23, download ≥2.5.47).

### ParkingOperationKind union (dto.ts L570, api-client L315)
`'add_vehicle' | 'renew_vehicle' | 'change_plate' | 'rebind_owner' | 'update_garages' | 'update_vehicle_type' | 'download_vehicle' | 'sync_vehicle_info' | 'delete_vehicle'`

The six UI buttons map to kinds (page L1479–1489): 续期收费→`renew_vehicle`, 变更车牌→`change_plate`, 变更绑定用户→`rebind_owner`, 调整车库授权→`update_garages`, 下发设备→`download_vehicle`, 注销车辆→`delete_vehicle`. (Plus 修改车辆授权类型→`update_vehicle_type`, a 7th in-panel edit.)

---

## 1. Query result → display mapping (needed by every operation)

`POST /parking/queries {term}` → poll `GET /parking/queries/:id` → `ParkingQuery.rows`, an array of `{ database: 'parking1'|'parking2', fields: Record<string,string|number|boolean|null> }`. One plate may appear in BOTH parking1 and parking2 (page groups by normalized plate; `group.rows`, `group.merged`).

### Field keys that matter (raw old-DB column names in `fields`)
| Old-DB column | Meaning | Display label |
|---|---|---|
| `P_plate` | 车牌 | plate heading |
| `Car_Brand` / `Car_Beand` | 车辆授权类型/身份 (住户车/租户车/亲情车/…) | 车辆授权类型 |
| `Car_Lei` | 车型 code (int) | — |
| `Owner__owner_Name` | **房号** (old DB stores room, not a name) | 房号 / 地址 |
| `Owner__owner_Tel` | 业主电话 | phone |
| `Owner__owner_Add` | 地址 | address |
| `Sart_Time` | 开始/生效日期 (note the legacy misspelling) | 生效日期 |
| `End_Time` | 到期日期 | 到期 + 有效期天数 |
| `P_Effective` | 256-char `0/1` bit string — channel authorizations | drives 车库授权 checkboxes |
| `P_Download` | 256-char `0/1` bit string — which channels downloaded to device | 设备状态 |
| `P_Spaces` | 车位号 | 车位 |
| `Car_ID` | 卡号/车辆外部ID | — |
| `P_id` | record primary key | `sourceRecordId` |
| `P_note` | 备注 | note |

**Alias resolution** (`fieldAliases`, page L1019): matching is case-insensitive, strips `[\s_\-./]`, tries exact then substring. Owner/room/phone/note/address prefer `Owner__`-prefixed joined columns (`ownerFieldValue`, L1067). Key alias groups:
- plate: `carno,carcode,carnumber,plateno,plate,license,车牌`
- room: `ownername,owner_name,roomno,…,owneradd,address,room,房号,地址`
- phone: `mobile,…,ownertel,ownerphone,手机,电话`
- space: `parkno,parkingno,spaceno,berth,garage,车位,地库`
- begin: `stratime,sarttime,starttime,startdate,begindate,…`
- expiry: `enddate,expiredate,…,endtime,到期,有效期`
- identity: `carbrand,carbeand,…,carlei,车辆类型,身份,性质`
- note: `pnote,remark,note,备注`
- effective: `peffective`  ·  download: `pdownload`  ·  ownerId: `ownerid,住户编号,业主编号`

`vehicleIdentity()` (L1096) normalizes `Car_Brand`: contains "亲情"→`亲情车`, "租"→`租户车`, "业主"/"住户"→`住户车`, else `旧库车辆类型 {raw}`.

### 车库授权清单 (garage authorization list) — P_Effective bit decoding
`P_Effective` / `P_Download` are 256-char strings of `'0'`/`'1'`. **Position = channel number (1-based). char at index `channel-1`.** `enabledChannelNumbers()` (page L1126) returns the 1-based indices that are `'1'`.

Garage channel groups (page `garageRows` L1140, `garageBitString` L2084; backend `garageBitsMatch` service L3410; agent `GarageChannels` ParkingDatabase.cs L1625 — all three agree):
| Garage key | Label | Channels (1-based bit positions) | Lives in DB |
|---|---|---|---|
| `phase1` | 一期地面车库 | **5, 7** | parking1 |
| `phase2` | 二期地面车库 | **9, 11, 13** | parking2 |
| `main` | 二期大车库 | **15, 17, 19, 21** | parking2 |
| `civil` | 二期人防车库 | — (NOT bits; lives in 德立云) | deliyun |

Per-garage display state (`garageRows` L1143):
- `authorized` = this row's `database` matches the garage's DB **and** ANY of the garage's channels is `'1'` in `P_Effective`.
- `downloaded` = same DB match **and** every authorized channel of the garage is also `'1'` in `P_Download`.
- `civil` is shown from the deliyun lookup (`deliyunVehicle.civilDefenseAuthorized`), rendered gold/indeterminate until cloud status is known (`cloudKnown`).

Device-status tag (L1497): cloud→德立云已/未授权; authorized+downloaded→`旧库标记已下载` (success); authorized only→`设备状态未确认` (warning); else `未授权`.

### Two owner panels (side by side, page L1502–1529)
- **旧停车系统信息** (one per DB row): phone=`Owner__owner_Tel`, room=`Owner__owner_Name` (房号), note=`P_note`, 车位=`P_Spaces`, 有效期=`Sart_Time`→`End_Time`. Editable via a separate owner-update flow (`POST /parking/owners/updates`, not one of the six).
- **PMS系统业主信息**: from `row.pmsMatch` (name/phone/house/contactNote), editable via PMS user update.

### 德立云 (人防) lookup
`GET /parking/deliyun/vehicles?plate=` → `{ rows: DeliyunVehicle[] }`. Match by `normalizeParkingPlate(plate)`. `DeliyunVehicle` has `id, plate, endDate, beginDate, civilDefenseAuthorized, cardNo, parkingSpace, ownerName, ownerPhone, cardPoolId,…`. The page gates several ops on having read this ("cloudChecked").

---

## 2. 续期收费 — renew + charge  (`kind: 'renew_vehicle'`)

### Pricing (how 金额/amount is computed)
- Rates: `GET /parking/fee-rates` → `ParkingRates = Record<'owner'|'tenant', Record<months, yuan>>`. Save: `POST /parking/fee-rates {rates}`.
- `DEFAULT_PARKING_RATES` (parking-family.ts L4):
  - `owner`:  1→180, 2→360, 3→540, 6→1080, 12→1800
  - `tenant`: 1→260, 2→520, 3→780, 6→1560, 12→2760
- Allowed months: **1, 2, 3, 6, 12** only (`normalizeParkingRates` L12; amounts 0–1,000,000, ≤2 decimals).
- UI: `amount = amountOverride ?? feeRates.amount(identity, months)` (page L1685). Operator may override the amount. `identity` here selects owner vs tenant rate (亲情车 → 0).
- End date: `parkingRenewalEndDate(currentEndDate, months)` = `dayjs(currentEndDate).add(months,'month').endOf('month')` → `YYYY-MM-DD` (bills to natural month-end, keeps no day-of-month; manual DatePicker override allowed). parkingRenewal.ts L7.

### Two-DB / 人防 fan-out & dedup
- Same plate in parking1+parking2 is renewed in BOTH (targets = `operationRows`). **Charge is recorded only in the first DB**: `allocateParkingRenewalAmounts(amount, n)` → `[amount, 0, 0…]` (parkingRenewal.ts L14) to avoid double-counting in fee reports. Each target gets `previousEndDate` from its own row's expiry.
- If 德立云 shows `civilDefenseAuthorized`, after both old DBs succeed, a deliyun renewal is also submitted to sync the 人防 end date (see below).

### Per-target request (page L493–504)
```
POST /parking/operations
{
  database: parkingDatabase(target.database),   // 'parking1' | 'parking2'
  kind: 'renew_vehicle',
  sourceRecordId: <target P_id>,
  idempotencyKey: n>1 ? `${batchKey}-${database}` : batchKey,
  payload: {
    plate, endDate,                 // required
    previousEndDate: <this row's current End_Time>,
    amount: renewalAmounts[index],  // first DB = full, others = 0
    months, identity, newPlate:'', ownerName, ownerRoom, ownerId, effective, download, note
  }
}
```
Server validation (`validateParkingOperation` L3426): requires `plate`, `endDate`.

### Agent SQL (ParkingDatabase.cs L802)
Calls stored proc **`Palte_extend`** with `@P_plate, @type (feeType, default 5 = 月租延期), @P_money (amount), @End_Time (endDate), @P_Admin='PMS'`. Then `VerifyVehicle` reads back, and `VerifyRenewalAudit` confirms a `P_moneyKeep` audit row (operator=`PMS`, type, Issue_ID) was written — fails if the charge-ledger row is missing.
- `result` includes: `verified, plate, issueId, endDate, effective, download, state, legacyOperator:'PMS', legacyAuditTable:'P_moneyKeep', legacyAuditId, legacyAuditType, legacyAuditVerified:true`.

### Confirmations / guards enforced by the old page (L453–459, 517–531)
- Must have read 德立云 state first (`cloudChecked`) else "人防车库状态尚未查明，请重新查询后续期".
- If 人防 authorized but its `endDate` unreadable → stop ("避免旧库先收费而人防未同步").
- New `endDate` must not be earlier than current 人防 endDate.
- After old-DB success, if 人防 endDate differs, call `renewDeliyunVehicle` (below) with key `${batchKey}-deliyun`; if that fails, error says old DBs done but retry only the 人防 task (勿重复收费).

### 德立云-only renewal (inline endpoint)
`POST /parking/deliyun/renewals` (`renewDeliyunVehicle`, api-client L390; dto `RenewDeliyunVehicleDto` L363):
```
{ vehicleId, plate (7..20), previousEndDate 'YYYY-MM-DD', endDate 'YYYY-MM-DD', idempotencyKey }
```
Returns a `ParkingOperation` (database `deliyun`) already completed/failed. On prior `failed` deliyun task, page retries with a fresh key (L426).

---

## 3. 变更车牌 — change plate  (`kind: 'change_plate'`)

### Request (payload built in page submit L1686)
```
POST /parking/operations
{
  database, kind:'change_plate', sourceRecordId:<P_id>, idempotencyKey,
  payload: { plate (原车牌), newPlate (新车牌), ownerName (绑定用户姓名),
             identity, ownerRoom, ownerId, endDate, previousEndDate, amount, months, effective, download, note }
}
```
Server validation (L3427): requires `plate` (原), `newPlate` (新), `ownerName`.

### Agent SQL (ParkingDatabase.cs L831)
Stored proc **`Up_PakIssue`** with `@Pak_plate=newPlate, @y_Pak_plate=plate (原), @P_Color, @Car_Lei, @owner_Name=LegacyOwnerRoom(payload), @Car_Brand=identity||'住户车', @P_note, @admin, @P_Spaces, @P_Effective, @P_Download`. Then `VerifyVehicle(newPlate)` reads back `{verified,plate,issueId,endDate,effective,download,state}`.

### 人防 sync & guards
- Page requires 德立云 state read first (L451: 漏改人防车牌 guard).
- After old-DB success, if a 德立云 row exists, call `changeDeliyunPlate` with `${batchKey}-deliyun`; failure → "旧停车系统换牌已完成，但人防换牌未完成".
- `POST /parking/deliyun/plate-changes` (`changeDeliyunPlate`, api-client L418; dto `ChangeDeliyunPlateDto` L388): `{ vehicleId, plate, newPlate, idempotencyKey }`. On prior failed deliyun change, retry with fresh key (L414).
- On full success, page re-queries using the **new** plate (L599).

---

## 4. 变更绑定用户 — rebind owner  (`kind: 'rebind_owner'`)

**The page must NOT send free-typed name/phone/room.** Owner is chosen from a PMS house/owner picker (`ParkingOwnerPicker`, L1724) that only lists lane `198`/`228` houses with numeric building/room and an existing `ownerId`.

### Request (page submit L1680–1683)
```
POST /parking/operations
{
  database, kind:'rebind_owner', sourceRecordId:<P_id>,
  pmsUserId: <selected owner's PMS userId>,     // REQUIRED, taken from picker
  idempotencyKey,
  payload: {
    plate,                                       // readonly, from current row
    previousOwnerId: <current old-DB Owner_ID>,  // from row.ownerId — REQUIRED
    previousPmsUserId: row.pmsMatch?.userId ?? null,
    // from the ParkingOwnerSelection the picker returns:
    pmsUserId, houseId, ownerRoom, ownerName, ownerPhone
  }
}
```
`ParkingOwnerSelection` = `{ pmsUserId, houseId, ownerRoom:'198/8/102', ownerName, ownerPhone }` (L1722). `ownerRoom` is built as `${lane}/${Number(buildingNo)}/${Number(roomNo)}`.

### Server-side authoritative rebuild (service L1203–1223) — IMPORTANT
The server distrusts the client's name/phone/room. It re-derives everything from `houseId`+`pmsUserId`:
- Requires valid `houseId>0` and `pmsUserId` else "请从 PMS 房号或姓名搜索结果中选择要绑定的业主".
- Loads the house context and the OWNER user (must be ACTIVE, role OWNER, belong to that house) else "所选业主与房号不匹配或已停用".
- Lane must be `198|228` and building/room numeric>0 else "无法转换为旧停车系统的弄号/楼栋/室号格式".
- Overwrites: `payload.ownerRoom = '{lane}/{building}/{room}'`, `ownerName = owner.name`, `ownerPhone = owner.phone`, `pmsUserId = owner.id`, `bindingContract = 1`; deletes `ownerId`/`restoreOwnerId`.
- Validation (L3428): requires `plate`, `ownerRoom`, `previousOwnerId`.

### Agent SQL (`RebindParkingOwner`, ParkingDatabase.cs L1207)
Serializable txn. Requires `bindingContract==1`. Reads current vehicle + its owner by plate; verifies current `Owner_ID == previousOwnerId` (optimistic lock) else "车辆绑定住户已改变，请重新查询". Finds-or-creates a `P_Owner` row for the room (auto-suffixes `/2`,`/3` on room-name collision; stamps `owner_depa='PMS绑定:{taskId}'` as the idempotency marker). Then `Up_PakIssue` rebinds; asserts the vehicle's non-owner columns (`P_id,P_plate,End_Time,…,P_Effective,P_Download`) are unchanged.
- `result` (`BindingResult`): includes `previousOwnerId, targetOwnerId, previousRoom, previousPhone, targetRoom` — these power rollback.

### Rollback (service L1335) requires the completed `result.previousOwnerId/targetOwnerId/previousRoom`, else can't auto-reverse.

---

## 5. 调整车库授权 — adjust garage authorization  (`kind: 'update_garages'`)

### Checkboxes & payload (page L1688–1693, modal L1712)
Checkbox.Group values: `phase1` (一期地面), `phase2` (二期地面), `main` (二期大车库), `civil` (二期人防, disabled unless `deliyunWriteEnabled`). Initial checked state derived from `garageRows(...).authorized` + `deliyunVehicle.civilDefenseAuthorized`.
```
POST /parking/operations
{
  database, kind:'update_garages', sourceRecordId:<P_id>, idempotencyKey,
  payload: {
    plate, ownerRoom,
    garages: selectedGarages,                 // minus 'civil' — see below
    civilParkingSpace: <string, required if civil checked>,
    previousGarages: sourceGarageSummary(rows, plate), // 'phase1,phase2,…' for history diff
    // (effective is stripped server-side; page also sends identity/note/etc but unused)
  }
}
```
- The page strips `civil` out of `garages` before queueing the old-DB task (`localPayload.garages = requestedGarages.filter(g=>g!=='civil')`, L489) — 人防 is handled separately via 德立云.
- Server validation (L3429): requires `plate`, `ownerRoom`; `garages` must be a non-empty subset of `phase1|phase2|main` (unless a `familyReviewId` is present); server deletes `payload.effective`.

### Old-page confirmation guards (L449–487)
- Must have read 德立云 state (`cloudChecked`) else stop.
- If mixing phase1 with phase2/main, their end dates must match (else "勾选车库的有效期不一致…请先续期同步").
- `civil` requires: `deliyunWriteEnabled`, a readable 二期 source row, 人防 endDate not later than 二期 endDate, and a complete `198/228/楼/室` room (`civilOwnerRoom`), plus `civilParkingSpace`.

### Agent SQL (`UpdateGarageAuthorizations`, ParkingDatabase.cs L1337)
Reads source vehicle, then for **both** parking1 AND parking2 in serializable txns:
- `requested` = garage keys. `RequestedGaragesForDatabase`: parking1 only honors `phase1`; parking2 honors `phase2`,`main`.
- `ApplyGarageSelection(P_Effective, requested, db)` (L1576): clears that DB's managed channels, then sets channels for requested garages (phase1=5,7 / phase2=9,11,13 / main=15,17,19,21). `ClearManagedDownload` zeroes the same channels in `P_Download` (forces re-download).
- If the vehicle doesn't exist in a DB but is wanted there, `InsertVehicleCopy` (copies from source via `AddIssue`). If not wanted and not present, no-op.
- Writes via `Up_PakIssue` (overriding `@P_Effective`,`@P_Download`; sets `Car_Zt=1` if `familyReviewId`). Re-reads and `AssertGarageSelection` verifies each garage's channels match the selection, else rolls back.
- `result`: `{ verified:true, plate, garages:'phase1,phase2', databases:[ {database, existed, changed, issueId, effective, download, state}, … ] }`.

### Server read-back verification (service L1544)
For each of parking1/parking2 in `result.databases`, asserts `garageBitsMatch(effective, requested, db)` (same 5/7, 9/11/13, 15/17/19/21 logic) else "车库授权读回结果与本次勾选不一致，不能标为成功".

### 人防 (civil) side-effect (page L540–569)
After old DBs succeed, if `civil` desired-state ≠ current `deliyunVehicle.civilDefenseAuthorized`, call `setDeliyunCivilDefenseAuthorization`:
`POST /parking/deliyun/civil-defense-authorizations` (dto `SetDeliyunCivilDefenseAuthorizationDto` L399):
```
{ plate (7..20), authorized: boolean,
  ownerRoom?: /^\d+\/\d+\/\d+$/, parkingSpace?, vehicleId?, beginDate? 'YYYY-MM-DD', endDate? 'YYYY-MM-DD', remark?,
  idempotencyKey (8..100) }
```
Also syncs 人防 endDate up to 二期 endDate if behind. Backend records it as a `database:'deliyun', kind:'update_garages'` ParkingOperation run inline (service L931), with retry-of-failed support.

---

## 6. 下发设备 — download to device  (`kind: 'download_vehicle'`)

### Request (page L498, modal L1715)
```
POST /parking/operations
{ database, kind:'download_vehicle', sourceRecordId:<P_id>, idempotencyKey,
  payload: { plate, …other vehicle fields echoed } }
```
Server validation (L3439): requires `plate`. Requires agent ≥ **2.5.47** (older agents can only queue, not confirm) — else 503 (service L1186).

### Agent behavior (ParkingDatabase.cs L870)
`ExecuteDownloadVehicle` → reads the vehicle, computes target machine channels from `P_Effective` (`DownloadMachineIds` = every `'1'` position; errors if none authorized), and for each channel calls stored proc **`Add_DownloadCard`** (params auto-mapped: plate, Car_ID, P_id, Sart_Time/End_Time, effective, download, admin, color, brand, owner, space, note…; sets a pending `Car_Zt=1`). Verifies each channel appears in `Car_Download` with `Car_Zt=1`.
Then **`WaitForDownloadConfirmation`** polls up to **60s**: re-reads vehicle, computes `MissingDownloadMachineIds` (authorized managed channels whose `P_Download` bit is not yet `'1'`). Returns `{ verified:true, deviceVerification:'confirmed', effective, download, message }` when all confirmed; throws listing unconfirmed channels on timeout (task preserved, re-run later).

### UI note (L1715)
"系统会按当前授权通道重新生成下载任务，并等待旧停车系统确认所有现行通道已下载；只写入队列不会显示成功，60秒未确认会列出未完成通道。" No extra confirm dialog; no 人防 side-effect. **No safe DB rollback** for download (rollback throws, service L1344).

---

## 7. 注销车辆 — void vehicle  (`kind: 'delete_vehicle'`)

### Request (page L498, modal L1716 warning)
```
POST /parking/operations
{ database, kind:'delete_vehicle', sourceRecordId:<P_id>, idempotencyKey,
  payload: { plate, refund?, depositRefund? } }
```
Server validation (L3439): requires `plate`.

### Agent SQL (ParkingDatabase.cs L851)
Stored proc **`Add_Del_Plate`** with `@P_plate, @Up_moey=refund(0), @Up_Yajin=depositRefund(0), @Admin`. Writes a 注销 ledger entry (does NOT hard-delete `Car_Issue` directly). Then asserts `SELECT COUNT(*) FROM Car_Issue WHERE P_plate=@plate` is 0, else "注销存储过程执行后旧库仍存在该车牌". `result: { verified:true, remaining:0 }`.

### Confirmation
UI uses a danger OK button labeled **确认注销** (page L1697) with warning Alert "注销会调用旧系统 Add_Del_Plate … 网页不会直接删除 Car_Issue". Rollback of a delete re-adds via `add_vehicle` (needs full plate saved; service L1332).

---

## 8. (bonus) 修改车辆授权类型 — `update_vehicle_type`
Not one of the six buttons but shares the modal (type selector 住户车/租户车/亲情车/小区服务车/小区工作车). Payload requires `plate, ownerRoom, identity`. Agent `UpdateVehicleType` (L1309) runs `Up_PakIssue` overriding `@Car_Brand=identity`, reads back, result `{verified,plate,issueId,previousIdentity,identity}`.

---

## 9. Implementation checklist for the new neighbor-web app
1. Use `request` wrappers: `createParkingOperation`, `parkingOperation` (poll), `renewDeliyunVehicle`, `changeDeliyunPlate`, `setDeliyunCivilDefenseAuthorization`, `parkingFeeRates`, `saveParkingFeeRates`, `createParkingQuery`/`parkingQuery`, `deliyunVehiclesByPlate`.
2. Generate one `idempotencyKey` per submit; suffix `-${database}` per DB and `-deliyun` for cloud side-effects; never resubmit a pending/timed-out task.
3. Decode `P_Effective`/`P_Download` with the exact channel map (phase1=5,7 / phase2=9,11,13 / main=15,17,19,21; 1-based char index). `civil` is cloud-only.
4. Renewal amount = rate table lookup by `identity`×`months∈{1,2,3,6,12}` (owner/tenant), overridable; end date = month-end add; multi-DB charge only in first DB (others amount 0).
5. rebind_owner: send only `pmsUserId`+`houseId`+`previousOwnerId`+plate; the server rebuilds authoritative room/name/phone — do not trust free text.
6. Poll with the completed/failed/timeout classification; show `task.error` on failure; re-query the plate (new plate for change_plate) on success.
7. Enforce the page's pre-submit guards (德立云 state read, end-date consistency, civil parking space required, etc.) before calling the API.
