import { useEffect, useMemo, useRef, useState } from 'react';
import GarageSpacePicker, { useGarageSpaces, type SpaceChoice } from '@/components/parking/GarageSpacePicker';
import { toggleGarage, garageNumbersFor, basementLabel, type BasementGarage } from '@/lib/garage-selection';
import { accessCardIssuance, request } from '@pms/api-client';
import type { ParkingQueryRow, DeliyunVehicle } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import { field, GARAGES, garageState } from '@/lib/parking-fields';
import { propertyCarBillingClass, readPlateBillingClass } from './propertyCarBilling';
import { can } from '@/lib/perm';
import { freshParkingQuery, freshRows, runOnTargets, pidOf, ymd, createIdempotencyKey, dbShort } from '@/lib/parking-ops';

type CloudState = 'loading' | DeliyunVehicle | null | undefined;

interface OpProps {
  plate: string;
  rows: ParkingQueryRow[];
  cloud: CloudState;
  onClose: () => void;
  onDone: (requeryTerm?: string) => void;
}

const targetsOf = (rows: ParkingQueryRow[]) => rows.filter((r) => r.database === 'parking1' || r.database === 'parking2');
const cloudVehicle = (c: CloudState): DeliyunVehicle | null => (c && c !== 'loading' ? (c as DeliyunVehicle) : null);
const prevOwnerIdOf = (r: ParkingQueryRow) => r.historyRef?.externalOwnerId || field(r.fields, 'ownerId') || '';

/** 变更绑定用户：从 PMS 房号/业主里选新业主（只传 pmsUserId+houseId+原住户编号，服务端重建权威房号/姓名/电话） */
export function RebindSheet({ plate, rows, onClose, onDone }: OpProps) {
  const { communities } = useAddressTree();
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const targets = targetsOf(rows);
  const missingPrev = targets.filter((t) => !prevOwnerIdOf(t));

  const ownerRoom = useMemo(() => {
    if (!picked) return '';
    const lane = picked.lane || '';
    const b = Number(picked.buildingNo); const r = Number(picked.roomNo);
    if (!/^(198|228)$/.test(lane) || !Number.isFinite(b) || b <= 0 || !Number.isFinite(r) || r <= 0) return '';
    return `${lane}/${b}/${r}`;
  }, [picked]);

  const run = async () => {
    setErr('');
    if (!targets.length) { setErr('这张车牌不在一期/二期旧库里'); return; }
    if (!picked || !picked.ownerId || !picked.houseId) { setErr('请从房号/姓名里选到有业主的房号'); return; }
    if (!ownerRoom) { setErr('只能绑定枫桦景苑（198/228 弄）数字门牌、且有业主的住户'); return; }
    if (missingPrev.length) { setErr(`${missingPrev.map((t) => dbShort(t.database)).join('、')} 读不到原住户编号，无法安全换绑，请在旧页处理`); return; }
    setRunning(true); setLog([]);
    const batch = createIdempotencyKey();
    const r = await runOnTargets(targets, 'rebind_owner', (row) => ({
      plate,
      previousOwnerId: prevOwnerIdOf(row),
      previousPmsUserId: row.pmsMatch?.userId ?? null,
      pmsUserId: picked.ownerId,
      houseId: picked.houseId,
      ownerRoom,
      ownerName: picked.ownerName,
      ownerPhone: picked.ownerPhone,
    }), { pmsUserId: picked.ownerId, batchKey: batch, onLog: (l) => setLog((x) => [...x, l]) });
    if (!r.ok) { setErr(r.error || '换绑失败'); setRunning(false); return; }
    toast(r.spaceNeedsReview ? '现场已换绑，车位卡片绑定待核对' : `已换绑到 ${picked.ownerName || ownerRoom}`);
    onDone();
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} title={`变更绑定用户 · ${plate}`}
      subtitle={targets.map((t) => dbShort(t.database)).join(' + ')} width={560}>
      <div style={{ padding: '4px 2px' }}>
        <div className="note" style={{ marginBottom: 12, fontSize: 13 }}>只认 PMS 里选中的业主，房号/姓名/电话由服务端按房号重建，不手输。只能绑枫桦景苑（198/228 弄）数字门牌的业主。</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>选新业主（按房号或姓名）</div>
        <HousePicker communities={communities} value={picked} placeholder="输入 228/4/501 或业主姓名"
          onPick={setPicked} onClear={() => setPicked(null)} />
        {picked ? (
          <div className="card" style={{ padding: '10px 12px', margin: '10px 0', background: 'var(--bg)' }}>
            <div style={{ fontSize: 14 }}><b>{picked.ownerName || '（无业主）'}</b> · {picked.ownerPhone || '无电话'}</div>
            <div className="muted" style={{ fontSize: 13 }}>{picked.communityName} {picked.buildingNo}/{picked.roomNo}{ownerRoom ? ` → 旧库 ${ownerRoom}` : ''}</div>
            {!picked.ownerId ? <div className="pill s-dang" style={{ marginTop: 6 }}>这个房号没有业主，不能绑</div> : null}
            {picked.ownerId && !ownerRoom ? <div className="pill s-dang" style={{ marginTop: 6 }}>非枫桦景苑数字门牌，不能绑</div> : null}
          </div>
        ) : null}
        {missingPrev.length ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', margin: '10px 0', fontSize: 13 }}>{missingPrev.map((t) => dbShort(t.database)).join('、')} 读不到原住户编号，无法在本页安全换绑</div> : null}
        {log.length ? <div className="card" style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg)' }}>{[...log].reverse().map((l, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{l}</div>)}</div> : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={running || !picked || !ownerRoom || !!missingPrev.length} onClick={() => void run()}>
            <Icon name="users" size={16} />{running ? '现场执行中…' : '确认换绑'}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}

/** 调整车库授权：一期/二期/大车库/人防 四选，旧库一个操作里跨库处理，人防走德立云副作用 */
export function GaragesSheet({ plate, rows, cloud, onClose, onDone }: OpProps) {
  const targets = targetsOf(rows);
  const civilV = cloudVehicle(cloud);
  const cloudKnown = cloud !== undefined && cloud !== 'loading';
  const initial = useMemo(() => {
    const set = new Set<string>();
    for (const g of GARAGES) {
      if (g.key === 'civil') { if (civilV?.civilDefenseAuthorized) set.add('civil'); continue; }
      if (garageState(rows, g).authorized) set.add(g.key);
    }
    return set;
  }, [rows, civilV]);
  const [sel, setSel] = useState<Set<string>>(() => new Set(initial));
  const [nums, setNums] = useState<Record<string, string>>(() => ({ main: field(rows.find(r => r.database === 'parking2')?.fields, 'space'), civil: civilV?.parkingSpace || '' }));
  const [spaceGarage, setSpaceGarage] = useState<BasementGarage | null>(null);
  const spaceSource = useGarageSpaces('/access-card-issuance/parking/space-choices');
  const [submitted, setSubmitted] = useState(false);
  const batch = useRef(createIdempotencyKey());
  const civilTouched = useRef(false);
  // 云端可比抽屉晚返回，只初始化未编辑的人防状态，不覆盖用户点选。
  useEffect(() => {
    if (!cloudKnown || civilTouched.current || submitted) return;
    setSel(s => { const next = new Set(s); if (civilV?.civilDefenseAuthorized) next.add('civil'); else next.delete('civil'); return next; });
    setNums(n => ({ ...n, civil: civilV?.parkingSpace || '' }));
  }, [cloudKnown, civilV, submitted]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const ownerRoom = field(targets[0]?.fields, 'room', true) || '';
  const oldDbSel = [...sel].filter((k) => k !== 'civil');
  const prevOldDb = GARAGES.filter((g) => g.key !== 'civil' && garageState(rows, g).authorized).map((g) => g.key);
  const toggle = (k: string) => {
    if (running || submitted) return;
    if (k === 'civil') civilTouched.current = true;
    if (!sel.has(k) && (k === 'main' || k === 'civil')) { setSpaceGarage(k); return; }
    const next = toggleGarage([...sel], k);
    if (k === 'phase2' && sel.has('phase2') && sel.has('civil')) next.push('civil');
    setSel(new Set(next)); setNums(n => garageNumbersFor(next, n));
  };
  const confirmSpace = (space: SpaceChoice) => {
    const next = space.garage === 'civil' ? [...new Set([...sel, 'civil'])] :
      toggleGarage([...sel].filter(g => g !== space.garage), space.garage);
    if (space.garage === 'civil') civilTouched.current = true;
    setSel(new Set(next)); setNums(n => ({ ...n, [space.garage]: space.spaceNo })); setSpaceGarage(null);
  };
  const keepCivil = oldDbSel.length === 0 && sel.has('civil') && civilV?.civilDefenseAuthorized &&
    (nums.civil || '') === (civilV.parkingSpace || '');
  const needsChoices = sel.has('main') || (sel.has('civil') && !keepCivil);
  const missingSpace = needsChoices && (['main', 'civil'] as const).some(g => sel.has(g) && !spaceSource.rows.some(s => s.garage === g && s.spaceNo === nums[g] && !s.unavailableReason));

  // 一二期到期日一致性（phase1 在 parking1，phase2/main 在 parking2）
  const end1 = ymd(field(rows.find((r) => r.database === 'parking1')?.fields, 'expiry'));
  const end2 = ymd(field(rows.find((r) => r.database === 'parking2')?.fields, 'expiry'));
  const mixing = sel.has('phase1') && (sel.has('phase2') || sel.has('main'));

  const run = async () => {
    setErr('');
    // 只有勾了人防才需要德立云状态；只改一期/二期/大车库时不查德立云也能保存
    const needCivil = sel.has('civil');
    if ((needCivil || !oldDbSel.length) && !cloudKnown) { setErr('请等人防状态查回再提交'); return; }
    if (oldDbSel.length && !ownerRoom) { setErr('读不到房号，无法调整授权，请在旧页处理'); return; }
    if (mixing && end1 && end2 && end1 !== end2) { setErr(`一期(${end1})和二期(${end2})到期日不一致，请先续期同步再一起授权`); return; }
    if (spaceGarage || missingSpace || (needsChoices && (spaceSource.loading || spaceSource.error))) { setErr('请先从对应车库档案选定有效车位号'); return; }
    if (oldDbSel.length && !targets.length) { setErr('读不到原车辆记录，无法安全调整授权'); return; }
    if (needsChoices && !can('business','edit')) { setErr('当前账号没有修改车辆收费档位的权限'); return; }
    setRunning(true); setLog([]);
    let spaceNeedsReview = false;
    try {
    const billingClass = needsChoices ? await propertyCarBillingClass(plate, targets[0]?.pmsMatch?.house?.communityId) : null;
    setSubmitted(true);
    const onLog = (line: string) => setLog(lines => [...lines, line]);
    const localToRemove = oldDbSel.length ? [] : targetsOf(await freshRows(plate));
    if (localToRemove.some(row => !pidOf(row.fields)) || new Set(localToRemove.map(row => row.database)).size !== localToRemove.length)
      throw new Error('本地车牌记录不唯一或缺少编号，请核对后办理');
    // 旧库：一个操作里现场助手会跨 parking1/parking2 处理（提交到任一现存库即可）
    if (oldDbSel.length) {
      const srcDb = (targets[0].database as 'parking1' | 'parking2');
      setLog((l) => [...l, '正在写旧库车库授权…']);
      const r = await runOnTargets([targets[0]], 'update_garages', (row) => ({
        plate, ownerRoom, garages: oldDbSel, previousGarages: prevOldDb.join(','), sourceDatabase: srcDb,
        spaceSelection: 1, selectedGarages: [...sel], garageNumbers: garageNumbersFor([...sel], nums),
      }), { batchKey: batch.current, onLog: (l) => setLog((x) => [...x, l]) });
      if (!r.ok) { setErr(r.error || '车库授权失败'); setRunning(false); return; }
      spaceNeedsReview = !!r.spaceNeedsReview;
    }
    // 人防：期望态 ≠ 当前态时同步德立云
    const wantCivil = sel.has('civil');
    if ((!oldDbSel.length && !wantCivil) || wantCivil !== !!civilV?.civilDefenseAuthorized || (wantCivil && !keepCivil && nums.civil !== civilV?.parkingSpace)) {
      setLog((l) => [...l, `正在${wantCivil ? '开通' : '关闭'}人防（德立云）…`]);
      try {
        const result = await accessCardIssuance.setDeliyunCivilDefenseAuthorization({
          plate, authorized: wantCivil, ownerRoom: /^\d+\/\d+\/\d+$/.test(ownerRoom) ? ownerRoom : undefined,
          parkingSpace: nums.civil?.trim() || undefined, vehicleId: civilV?.id, endDate: end2 || undefined,
          idempotencyKey: `${batch.current}-deliyun`,
        });
        if (result.status !== 'completed') throw new Error(result.error || '人防任务尚未完成，请核对原任务');
        spaceNeedsReview ||= !!(result.result?.pmsBindings as { needsReview?: boolean } | undefined)?.needsReview;
        setLog((l) => [...l, '✓ 人防已同步']);
      } catch (e) {
        setErr(`人防同步未完成：${e instanceof Error ? e.message : '失败'}，请核对原任务`);
        setRunning(false); return;
      }
    }
    if (!oldDbSel.length) {
      const cloudNow = await accessCardIssuance.deliyunVehiclesByPlate(plate);
      if (wantCivil ? cloudNow.rows.length !== 1 || !cloudNow.rows[0].civilDefenseAuthorized ||
        (civilV?.id && civilV.id !== cloudNow.rows[0].id) : cloudNow.rows.length !== 0)
        throw new Error('人防车牌登记与所选状态不一致，请核对原任务');
      for (const row of localToRemove) {
        const r = await runOnTargets([row], 'delete_vehicle', () => ({ plate, refund: 0, depositRefund: 0 }),
          { batchKey: batch.current + '-delete-' + row.database, onLog });
        if (!r.ok) throw new Error(r.error || '本地车库注销失败');
        spaceNeedsReview ||= !!r.spaceNeedsReview;
      }
      const finalQuery = await freshParkingQuery(plate);
      if (targetsOf(finalQuery.rows).length) throw new Error('注销后一期或二期仍有车辆记录，请核对原任务');
      if (!wantCivil) {
        onLog('三个停车系统已核实，正在办理 PMS 注销…');
        const retired = await request<{verified:boolean}>({method:'POST', url:'/access-card-issuance/parking/deregistrations',
          data:{queryId:finalQuery.id, cloudOperationKey:batch.current + '-deliyun'}});
        if (retired?.verified !== true) throw new Error('未收到 PMS 注销回执，请核对原任务');
      }
      if (billingClass && await readPlateBillingClass(plate) !== billingClass) {
        await request({method:'POST', url:'/business/plate-tags', data:{plate, vehicleClass:billingClass}});
        if (await readPlateBillingClass(plate) !== billingClass) throw new Error('产权车收费档位读回不一致');
      }
    } else if (billingClass) {
      setLog(lines => [...lines,'车库授权已确认，正在同步产权车收费档位…']);
      const latest = await freshRows(plate);
      const databases = new Set(oldDbSel.map(key => key === 'phase1' ? 'parking1' : 'parking2'));
      const selectedRows = [...databases].sort().map(database => {
        const matches = latest.filter(row => row.database === database);
        if (matches.length !== 1 || !pidOf(matches[0].fields) || field(matches[0].fields,'room',true) !== ownerRoom)
          throw new Error('车库授权已办理，车辆记录或房号有变化，产权车收费档位待核对');
        return matches[0];
      });
      const result = await runOnTargets(selectedRows, 'update_vehicle_type', (row,index) => ({
        plate, ownerRoom: field(row.fields,'room',true), identity:'住户车',
        ...(index === selectedRows.length-1 ? {billingClass} : {}),
      }), {batchKey: batch.current + '-type', onLog:line => setLog(lines => [...lines,line])});
      if (!result.ok) { setErr('车库授权已办理，产权车收费档位待核对：' + result.error); return; }
      const [confirmed, savedClass] = await Promise.all([freshRows(plate), readPlateBillingClass(plate)]);
      if (savedClass !== billingClass || selectedRows.some(row => !confirmed.some(current =>
        current.database === row.database && pidOf(current.fields) === pidOf(row.fields) &&
        field(current.fields,'identity') === '住户车' && field(current.fields,'room',true) === ownerRoom))) {
        setErr('车库授权已办理，车辆身份或产权车收费档位读回不一致，请核对原任务');
        return;
      }
    }
    const message = sel.size ? '车库授权已更新' : 'PMS 已注销，可以重新登记此车牌';
    toast(spaceNeedsReview ? message + '，车位卡片绑定待核对' : message);
    onDone();
    } catch (e) { setErr(`${e instanceof Error ? e.message : '授权结果未知'}；请核对原任务，不要重复办理`); }
    finally { setRunning(false); }
  };

  return (
    <Sheet open onClose={() => (running || spaceGarage ? null : onClose())} title={`调整车库授权 · ${plate}`}
      subtitle={targets.map((t) => dbShort(t.database)).join(' + ')} width={560}>
      <div style={{ padding: '4px 2px' }}>
        <div className="note" style={{ marginBottom: 12, fontSize: 13 }}>{needsChoices ? '本次收费档位：产权车' : '请选择允许通行的车库。'}</div>
        <div className="veh-garages" style={{ marginBottom: 14 }}>
          {GARAGES.map((g) => {
            const on = sel.has(g.key);
            const disabled = running || submitted || (g.key === 'civil' && !cloudKnown);
            return (
              <label key={g.key} className={`veh-garage ${on ? 'on' : ''}`} style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
                <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(g.key)} style={{ width: 16, height: 16 }} />
                <b>{g.label}</b>
                {g.key === 'civil' ? <span className="pill s-info">人防/德立云</span> : null}
              </label>
            );
          })}
        </div>
        {(['main', 'civil'] as const).filter(g => sel.has(g)).map(g => <div key={g} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <b>{basementLabel(g)}车位号（必选）</b>
          <button type="button" className="btn" disabled={running || submitted} onClick={() => setSpaceGarage(g)}>{nums[g] || '请选择车位号'} · 更换车位</button>
        </div>)}
        <GarageSpacePicker garage={spaceGarage} value={spaceGarage && sel.has(spaceGarage) ? nums[spaceGarage] || '' : ''} source={spaceSource} onCancel={() => setSpaceGarage(null)} onConfirm={confirmSpace} />
        {spaceSource.error ? <div role="alert">{spaceSource.error}<button type="button" className="btn sm" onClick={spaceSource.reload}>重试读取车位</button></div> : null}
        {missingSpace ? <p role="alert">请为勾选的地下车库选择对应档案中的有效车位号。</p> : null}
        {submitted ? <p className="muted">请求已保留，选择已锁定；再次核对沿用原任务，不会重复新建。</p> : null}
        {mixing && end1 && end2 && end1 !== end2 ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 12, fontSize: 13 }}>一期({end1})和二期({end2})到期日不一致，混选前请先续期同步</div> : null}
        {sel.has('civil') && !cloudKnown ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 12, fontSize: 13 }}>人防状态还在查，可先保存其它车库；人防要等状态查回再勾</div> : null}
        {log.length ? <div className="card" style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg)' }}>{[...log].reverse().map((l, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{l}</div>)}</div> : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={running || !!spaceGarage || missingSpace || (needsChoices && (spaceSource.loading || !!spaceSource.error)) || (sel.has('civil') && !cloudKnown) || (!sel.has('civil') && !!civilV?.civilDefenseAuthorized && !cloudKnown)} onClick={() => void run()}>
            <Icon name="car" size={16} />{running ? '现场执行中…' : submitted ? '核对原任务（不重复办理）' : !sel.size ? '注销所有车库登记' : '保存车库授权'}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}
