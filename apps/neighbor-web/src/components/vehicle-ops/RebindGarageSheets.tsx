import { useMemo, useState } from 'react';
import { accessCardIssuance } from '@pms/api-client';
import type { ParkingQueryRow, DeliyunVehicle } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import { field, GARAGES, garageState } from '@/lib/parking-fields';
import { runOnTargets, pidOf, ymd, createIdempotencyKey, dbShort } from '@/lib/parking-ops';

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
    toast(`已换绑到 ${picked.ownerName || ownerRoom}`);
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
        {log.length ? <div className="card" style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg)' }}>{log.map((l, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{l}</div>)}</div> : null}
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
  const [civilSpace, setCivilSpace] = useState(civilV?.parkingSpace || '');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const ownerRoom = field(targets[0]?.fields, 'room', true) || '';
  const oldDbSel = [...sel].filter((k) => k !== 'civil');
  const prevOldDb = GARAGES.filter((g) => g.key !== 'civil' && garageState(rows, g).authorized).map((g) => g.key);
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // 一二期到期日一致性（phase1 在 parking1，phase2/main 在 parking2）
  const end1 = ymd(field(rows.find((r) => r.database === 'parking1')?.fields, 'expiry'));
  const end2 = ymd(field(rows.find((r) => r.database === 'parking2')?.fields, 'expiry'));
  const mixing = sel.has('phase1') && (sel.has('phase2') || sel.has('main'));

  const run = async () => {
    setErr('');
    // 只有勾了人防才需要德立云状态；只改一期/二期/大车库时不查德立云也能保存
    const needCivil = sel.has('civil');
    if (needCivil && !cloudKnown) { setErr('开通/关闭人防需要先读到德立云状态，请稍候'); return; }
    if (!ownerRoom) { setErr('读不到房号，无法调整授权，请在旧页处理'); return; }
    if (oldDbSel.length === 0 && !needCivil) { setErr('至少选一个车库'); return; }
    if (mixing && end1 && end2 && end1 !== end2) { setErr(`一期(${end1})和二期(${end2})到期日不一致，请先续期同步再一起授权`); return; }
    if (sel.has('civil') && !civilSpace.trim()) { setErr('开通人防车库要填人防车位号'); return; }
    setRunning(true); setLog([]);
    const batch = createIdempotencyKey();
    // 旧库：一个操作里现场助手会跨 parking1/parking2 处理（提交到任一现存库即可）
    if (oldDbSel.length) {
      const srcDb = (targets[0].database as 'parking1' | 'parking2');
      setLog((l) => [...l, '正在写旧库车库授权…']);
      const r = await runOnTargets([targets[0]], 'update_garages', (row) => ({
        plate, ownerRoom, garages: oldDbSel, previousGarages: prevOldDb.join(','), sourceDatabase: srcDb,
      }), { batchKey: batch, onLog: (l) => setLog((x) => [...x, l]) });
      if (!r.ok) { setErr(r.error || '车库授权失败'); setRunning(false); return; }
    }
    // 人防：期望态 ≠ 当前态时同步德立云
    const wantCivil = sel.has('civil');
    if (wantCivil !== !!civilV?.civilDefenseAuthorized) {
      setLog((l) => [...l, `正在${wantCivil ? '开通' : '关闭'}人防（德立云）…`]);
      try {
        await accessCardIssuance.setDeliyunCivilDefenseAuthorization({
          plate, authorized: wantCivil, ownerRoom: /^\d+\/\d+\/\d+$/.test(ownerRoom) ? ownerRoom : undefined,
          parkingSpace: civilSpace.trim() || undefined, vehicleId: civilV?.id, endDate: end2 || undefined,
          idempotencyKey: `${batch}-deliyun`,
        });
        setLog((l) => [...l, '✓ 人防已同步']);
      } catch (e) {
        setErr(`旧库授权已完成，但人防同步未完成：${e instanceof Error ? e.message : '失败'}，请在办理记录只重试人防`);
        setRunning(false); return;
      }
    }
    toast('车库授权已更新');
    onDone();
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} title={`调整车库授权 · ${plate}`}
      subtitle={targets.map((t) => dbShort(t.database)).join(' + ')} width={560}>
      <div style={{ padding: '4px 2px' }}>
        <div className="note" style={{ marginBottom: 12, fontSize: 13 }}>勾选这张车牌能进的车库。保存后现场会重新下发；去掉的车库会被收回。</div>
        <div className="veh-garages" style={{ marginBottom: 14 }}>
          {GARAGES.map((g) => {
            const on = sel.has(g.key);
            const disabled = g.key === 'civil' && !cloudKnown;
            return (
              <label key={g.key} className={`veh-garage ${on ? 'on' : ''}`} style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
                <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(g.key)} style={{ width: 16, height: 16 }} />
                <b>{g.label}</b>
                {g.key === 'civil' ? <span className="pill s-info">人防/德立云</span> : null}
              </label>
            );
          })}
        </div>
        {sel.has('civil') ? (
          <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px', marginBottom: 12 }}>
            <dt className="muted">人防车位号</dt>
            <dd><input className="in" value={civilSpace} onChange={(e) => setCivilSpace(e.target.value)} placeholder="如 R-012" style={{ width: 160 }} /></dd>
          </div>
        ) : null}
        {mixing && end1 && end2 && end1 !== end2 ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 12, fontSize: 13 }}>一期({end1})和二期({end2})到期日不一致，混选前请先续期同步</div> : null}
        {sel.has('civil') && !cloudKnown ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 12, fontSize: 13 }}>人防状态还在查，可先保存其它车库；人防要等状态查回再勾</div> : null}
        {log.length ? <div className="card" style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg)' }}>{log.map((l, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{l}</div>)}</div> : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={running || (sel.has('civil') && !cloudKnown)} onClick={() => void run()}>
            <Icon name="car" size={16} />{running ? '现场执行中…' : '保存车库授权'}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}
