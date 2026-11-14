import { useState } from 'react';
import { accessCardIssuance } from '@pms/api-client';
import type { ParkingQueryRow, DeliyunVehicle } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import { field, vehicleIdentity, normPlate } from '@/lib/parking-fields';
import { runOnTargets, passthroughFields, ymd, createIdempotencyKey, dbShort } from '@/lib/parking-ops';

type CloudState = 'loading' | DeliyunVehicle | null | undefined;

interface OpProps {
  plate: string;
  rows: ParkingQueryRow[];
  cloud: CloudState;
  onClose: () => void;
  onDone: (requeryTerm?: string) => void;
}

function targetsOf(rows: ParkingQueryRow[]) {
  return rows.filter((r) => r.database === 'parking1' || r.database === 'parking2');
}
function cloudVehicle(cloud: CloudState): DeliyunVehicle | null {
  return cloud && cloud !== 'loading' ? (cloud as DeliyunVehicle) : null;
}

function normalizePlate(s: string) {
  return s.toUpperCase().replace(/[\s·.．・\-]/g, '');
}

export { ChangePlateSheet } from './PlateChangeSheet';

/** 下发设备：按当前授权通道重新生成下载任务，等旧系统确认（最多 60 秒） */
export function DownloadSheet({ plate, rows, onClose, onDone }: OpProps) {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const targets = targetsOf(rows);

  const run = async () => {
    setErr('');
    if (!targets.length) { setErr('这张车牌不在一期/二期旧库里'); return; }
    setRunning(true); setLog([]);
    const r = await runOnTargets(targets, 'download_vehicle', () => ({ plate }), { onLog: (l) => setLog((x) => [...x, l]) });
    if (!r.ok) { setErr(r.error || '下发失败'); setRunning(false); return; }
    toast('已下发并确认');
    onDone();
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} title={`下发设备 · ${plate}`}
      subtitle={targets.map((t) => dbShort(t.database)).join(' + ')} width={480}>
      <div style={{ padding: '4px 2px' }}>
        <div className="note" style={{ marginBottom: 12, fontSize: 13 }}>
          按当前授权通道重新生成下载任务，并等旧停车系统确认所有现行通道都已下载。只写入队列不算成功；60 秒内未确认会列出未完成通道（任务保留，可稍后重试）。
        </div>
        {log.length ? <div className="card" style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg)' }}>{log.map((l, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{l}</div>)}</div> : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={running} onClick={() => void run()}>
            <Icon name="download" size={16} />{running ? '下发中，等控制器确认…' : '下发设备'}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}

/** 注销车辆：调用旧系统 Add_Del_Plate 写注销流水（不直接删 Car_Issue），可填退费/退押金 */
export function DeleteSheet({ plate, rows, onClose, onDone }: OpProps) {
  const [refund, setRefund] = useState('');
  const [deposit, setDeposit] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const targets = targetsOf(rows);
  const identity = vehicleIdentity(field(rows[0]?.fields, 'identity'));

  const run = async () => {
    setErr('');
    if (!targets.length) { setErr('这张车牌不在一期/二期旧库里'); return; }
    setRunning(true); setLog([]);
    const r = await runOnTargets(targets, 'delete_vehicle', () => ({
      plate,
      refund: refund.trim() ? Number(refund) : 0,
      depositRefund: deposit.trim() ? Number(deposit) : 0,
    }), { onLog: (l) => setLog((x) => [...x, l]) });
    if (!r.ok) { setErr(r.error || '注销失败'); setRunning(false); return; }
    toast('已注销');
    onDone();
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} title={`注销车辆 · ${plate}`}
      subtitle={`${identity} · ${targets.map((t) => dbShort(t.database)).join(' + ')}`} width={500}>
      <div style={{ padding: '4px 2px' }}>
        <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 14, fontSize: 13 }}>
          注销会调用旧系统 Add_Del_Plate 写注销流水，并校验旧库不再有这张车牌。网页不会直接删 Car_Issue。此操作不可轻易撤销，请核对车牌。
        </div>
        <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px', marginBottom: 14 }}>
          <dt className="muted">退费（元）</dt>
          <dd><input className="in" value={refund} onChange={(e) => setRefund(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" style={{ width: 120 }} inputMode="decimal" /></dd>
          <dt className="muted">退押金（元）</dt>
          <dd><input className="in" value={deposit} onChange={(e) => setDeposit(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" style={{ width: 120 }} inputMode="decimal" /></dd>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ width: 16, height: 16 }} />
          我已核对，确认注销 <b>{plate}</b>
        </label>
        {log.length ? <div className="card" style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg)' }}>{log.map((l, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{l}</div>)}</div> : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn d solid" style={{ flex: 1 }} disabled={running || !confirmed} onClick={() => void run()}>
            <Icon name="trash" size={16} />{running ? '现场执行中…' : '确认注销'}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}
