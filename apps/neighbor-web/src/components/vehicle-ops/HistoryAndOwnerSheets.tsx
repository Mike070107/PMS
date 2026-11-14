import { formatBeijingDateTime } from '@pms/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import type {
  ParkingQueryRow, DeliyunVehicle, ParkingHistoryEntry,
} from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import { dayjs } from '@/lib/format';
import { field } from '@/lib/parking-fields';
import { createIdempotencyKey, pidOf, dbShort } from '@/lib/parking-ops';

type CloudState = 'loading' | DeliyunVehicle | null | undefined;

interface OpProps {
  plate: string;
  rows: ParkingQueryRow[];
  cloud?: CloudState;
  onClose: () => void;
  onDone: (requeryTerm?: string) => void;
}

const targetsOf = (rows: ParkingQueryRow[]) => rows.filter((r) => r.database === 'parking1' || r.database === 'parking2');
const externalOwnerOf = (r: ParkingQueryRow) => r.historyRef?.externalOwnerId || field(r.fields, 'ownerId') || '';
const roomOf = (r: ParkingQueryRow) => field(r.fields, 'room', true) || '';
const phoneOf = (r: ParkingQueryRow) => field(r.fields, 'phone', true) || '';
const noteOf = (r: ParkingQueryRow) => field(r.fields, 'note') || '';

const EVENT_LABEL: Record<string, string> = {
  plate_change: '变更车牌',
  owner_rebind: '变更绑定用户',
  owner_info_update: '更新住户资料',
  vehicle_added: '新增车辆',
  vehicle_renewed: '续期',
  garage_authorization: '调整车库授权',
  vehicle_type_update: '修改授权类型',
  vehicle_deleted: '注销车辆',
  vehicle_download: '下发设备',
  vehicle_sync: '同步',
};

/** 车牌 / 住户的变更历史（旧停车系统 Up_Issue + PMS 写操作记录） */
export function HistorySheet({ plate, rows, onClose }: OpProps) {
  const [data, setData] = useState<{ userHistory: ParkingHistoryEntry[]; vehicleHistory: ParkingHistoryEntry[] } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    const first = rows[0];
    accessCardIssuance.parkingHistory({
      plate,
      pmsUserId: rows.find((r) => r.pmsMatch?.userId)?.pmsMatch?.userId ?? null,
      database: first?.database ?? null,
      sourceRecordId: first ? pidOf(first.fields) : null,
      externalOwnerId: first ? externalOwnerOf(first) || null : null,
    })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) { setData({ userHistory: [], vehicleHistory: [] }); setErr(e instanceof Error ? e.message : '历史记录加载失败'); } });
    return () => { alive = false; };
  }, [plate, rows]);

  const line = (h: ParkingHistoryEntry) => (
    <div key={`${h.id}-${h.occurredAt}`} className="card" style={{ padding: '10px 12px', marginBottom: 8, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>{EVENT_LABEL[h.eventType] || h.eventType}</b>
        {h.plateBefore && h.plateAfter && h.plateBefore !== h.plateAfter
          ? <span className="tag acc">{h.plateBefore} → {h.plateAfter}</span> : null}
        <span className="muted" style={{ fontSize: 13, marginLeft: 'auto' }}>{formatBeijingDateTime(h.occurredAt, 'YYYY-MM-DD HH:mm')}</span>
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.8 }}>
        {h.summary}
        <span className="muted">{h.database ? ` · ${dbShort(h.database)}` : ''}{h.operator ? ` · ${h.operator}` : ''}</span>
      </div>
      {h.changes?.length ? (
        <div style={{ fontSize: 13, marginTop: 4 }}>
          {h.changes.map((c) => (
            <div key={`${c.field}-${c.label}`} className="muted">
              {c.label}：{c.before || '—'} → <b style={{ color: 'var(--foreground)' }}>{c.after || '—'}</b>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  const empty = !data || (!data.vehicleHistory.length && !data.userHistory.length);

  return (
    <Sheet open onClose={onClose} width={600} title={`变更历史 · ${plate}`} subtitle="车牌与住户的历次变更">
      <div style={{ padding: '4px 2px' }}>
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}>{err}</div> : null}
        {!data ? <div className="muted">加载中…</div> : empty ? (
          <div className="muted" style={{ padding: 24, textAlign: 'center' }}>这辆车还没有变更记录</div>
        ) : (
          <>
            {data.vehicleHistory.length ? (
              <>
                <div className="sec-t">车牌 / 车辆变更<span className="r muted">{data.vehicleHistory.length} 条</span></div>
                {data.vehicleHistory.map(line)}
              </>
            ) : null}
            {data.userHistory.length ? (
              <>
                <div className="sec-t" style={{ marginTop: 16 }}>住户资料 / 绑定变更<span className="r muted">{data.userHistory.length} 条</span></div>
                {data.userHistory.map(line)}
              </>
            ) : null}
          </>
        )}
      </div>
    </Sheet>
  );
}

/** 更新旧停车系统住户资料：从 PMS 房号带出姓名/电话/房号，写回旧库并读回验证 */
export function OwnerInfoSheet({ plate, rows, onClose, onDone }: OpProps) {
  const targets = targetsOf(rows);
  const { communities } = useAddressTree();
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [room, setRoom] = useState(roomOf(targets[0]));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(phoneOf(targets[0]));
  const [note, setNote] = useState(noteOf(targets[0]));
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!picked) return;
    if (picked.ownerName) setName(picked.ownerName);
    if (picked.ownerPhone) setPhone(picked.ownerPhone);
    setRoom(`${picked.lane || ''}/${picked.buildingNo}/${picked.roomNo}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.houseId]);

  const missingOwnerId = targets.filter((t) => !externalOwnerOf(t));

  const run = async () => {
    setErr('');
    if (!targets.length) { setErr('这张车牌不在一期/二期旧库里'); return; }
    if (missingOwnerId.length) { setErr(`${missingOwnerId.map((t) => dbShort(t.database)).join('、')} 读不到住户编号，无法写回，请在旧页处理`); return; }
    if (!room.trim()) { setErr('请填写房号'); return; }
    setRunning(true); setLog([]);
    for (const t of targets) {
      const label = dbShort(t.database);
      setLog((l) => [...l, `正在写 ${label} …`]);
      try {
        const created = await accessCardIssuance.createParkingOwnerUpdate({
          database: t.database as 'parking1' | 'parking2',
          externalOwnerId: externalOwnerOf(t),
          plate,
          pmsUserId: picked?.ownerId ?? t.pmsMatch?.userId ?? null,
          idempotencyKey: createIdempotencyKey(),
          expected: { name: null, phone: phoneOf(t) || null, room: roomOf(t) || null, note: noteOf(t) || null },
          values: { name: name.trim() || null, phone: phone.trim() || null, room: room.trim() || null, note: note.trim() || null },
        });
        let task = created;
        for (let i = 0; i < 112 && (task.status === 'pending' || task.status === 'running'); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          task = await accessCardIssuance.parkingOwnerUpdate(created.id);
        }
        if (task.status === 'completed') setLog((l) => [...l, `✓ ${label} 已更新并读回验证`]);
        else { setErr(`${label} 更新失败：${task.error || '现场助手未完成'}`); setRunning(false); return; }
      } catch (e) {
        setErr(`${label} 更新失败：${e instanceof Error ? e.message : '失败'}`);
        setRunning(false);
        return;
      }
    }
    toast('旧停车系统住户资料已更新');
    onDone();
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} width={560}
      title={`更新旧库住户资料 · ${plate}`}
      subtitle={targets.map((t) => dbShort(t.database)).join(' + ')}>
      <div style={{ padding: '4px 2px' }}>
        <div className="note" style={{ marginBottom: 12, fontSize: 13 }}>房号和电话从 PMS 业主档案带出，写入旧停车系统后由现场助手读回验证。不会改到期日、收费类型和车库授权。</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>从 PMS 房号带出（可选）</div>
        <HousePicker communities={communities} value={picked} placeholder="输入 228/4/501 或业主姓名" onPick={setPicked} onClear={() => setPicked(null)} />
        <div style={{ height: 12 }} />
        <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px' }}>
          <dt className="muted">旧库房号</dt>
          <dd><input className="in" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="198/6/501" style={{ width: 180 }} /></dd>
          <dt className="muted">住户姓名</dt>
          <dd><input className="in" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} /></dd>
          <dt className="muted">电话</dt>
          <dd><input className="in" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: 180 }} /></dd>
          <dt className="muted">备注</dt>
          <dd><input className="in" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} placeholder="可留空" /></dd>
        </div>
        {missingOwnerId.length ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', margin: '10px 0', fontSize: 13 }}>{missingOwnerId.map((t) => dbShort(t.database)).join('、')} 读不到住户编号，无法在本页写回</div> : null}
        {log.length ? <div className="card" style={{ padding: '10px 12px', margin: '12px 0', background: 'var(--bg)' }}>{log.map((l, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{l}</div>)}</div> : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', margin: '12px 0' }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={running || !!missingOwnerId.length} onClick={() => void run()}>
            <Icon name="users" size={16} />{running ? '现场写入中…' : '写入旧库并读回'}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}

/** 旧库有这个住户、PMS 里没有业主档案：一键补建 PMS 业主 */
export function CreatePmsOwnerSheet({ plate, rows, onClose, onDone }: OpProps) {
  const targets = targetsOf(rows);
  const { communities } = useAddressTree();
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(phoneOf(targets[0]));
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');

  const existingPms = targets.find((t) => t.pmsMatch?.userId)?.pmsMatch;
  const oldRoom = roomOf(targets[0]) || '—';

  useEffect(() => {
    if (!picked) return;
    if (picked.ownerName && !name) setName(picked.ownerName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.houseId]);

  const run = async () => {
    setErr('');
    if (!picked?.houseId) { setErr('请从 PMS 房号里选一套房'); return; }
    if (!name.trim()) { setErr('请填写业主姓名'); return; }
    if (!phone.trim()) { setErr('请填写手机号'); return; }
    setRunning(true);
    try {
      await request({
        method: 'POST', url: '/owners-mgmt',
        data: {
          name: name.trim(), phone: phone.trim(), houseId: picked.houseId,
          contactNote: `旧停车系统 ${oldRoom}（车牌 ${plate}）`,
        },
      });
      toast('已补建 PMS 业主档案');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败');
      setRunning(false);
    }
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} width={540}
      title={`补建 PMS 业主 · ${plate}`} subtitle={`旧库房号 ${oldRoom}`}>
      <div style={{ padding: '4px 2px' }}>
        {existingPms ? (
          <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 12, fontSize: 13 }}>
            这辆车在 PMS 已经匹配到业主「{existingPms.name || '#' + existingPms.userId}」，不用重复建。要去改资料请到「业主」页。
          </div>
        ) : (
          <div className="note" style={{ marginBottom: 12, fontSize: 13 }}>旧停车系统有这个住户，但 PMS 里还没建档。选一套 PMS 房号、确认姓名电话即可补建；不会改动旧库数据。</div>
        )}
        {!existingPms ? (
          <>
            <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>绑定到哪套房</div>
            <HousePicker communities={communities} value={picked} placeholder="输入 228/4/501 或业主姓名" onPick={setPicked} onClear={() => setPicked(null)} />
            <div style={{ height: 12 }} />
            <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px' }}>
              <dt className="muted">姓名</dt>
              <dd><input className="in" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} placeholder="业主姓名" /></dd>
              <dt className="muted">手机号</dt>
              <dd><input className="in" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: 180 }} placeholder="13900001111" /></dd>
            </div>
          </>
        ) : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', margin: '12px 0' }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          {!existingPms ? (
            <button className="btn p" style={{ flex: 1 }} disabled={running} onClick={() => void run()}>
              <Icon name="plus" size={16} />{running ? '创建中…' : '补建业主档案'}
            </button>
          ) : null}
          <button className="btn" disabled={running} onClick={onClose}>{existingPms ? '知道了' : '取消'}</button>
        </div>
      </div>
    </Sheet>
  );
}
