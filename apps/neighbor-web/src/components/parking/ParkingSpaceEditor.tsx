import { useRef, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import type { DeliyunVehicle, ParkingQueryRow } from '@pms/api-client/src/endpoints/access-card-issuance';
import DateInput from '@/components/DateInput';
import RenewSheet from '@/components/vehicle-ops/RenewSheet';
import { Sheet, toast } from '@/components/ui';
import { dayjs } from '@/lib/format';
import { field, GARAGES, garageState, normPlate } from '@/lib/parking-fields';

export interface ParkingSpaceRow {
  id: number; garage: 'main' | 'civil'; spaceNo: string; houseNo: string | null; areaSqm: string | null;
  address?: string | null; roomLabel?: string | null; buildingNo?: string | null;
  plate: string | null; ownerName: string | null; ownerTel: string | null;
  note: string | null; source: string | null; endDate: string | null;
  category?: 'property' | 'rental' | 'vacant' | null;
  communityId?: number | null;
}

/** 档案保存与现场续费分开：本地 endDate 从不作为续费写入。 */
export default function ParkingSpaceEditor({ row, onClose, onDone }: {
  row: ParkingSpaceRow; onClose: () => void; onDone: () => void;
}) {
  const [plate, setPlate] = useState(row.plate ?? '');
  const [houseNo, setHouseNo] = useState(row.houseNo ?? '');
  const [ownerName, setOwnerName] = useState(row.ownerName ?? '');
  const [ownerTel, setOwnerTel] = useState(row.ownerTel ?? '');
  const [note, setNote] = useState(row.note ?? '');
  const [area, setArea] = useState(row.areaSqm ?? '');
  const [category, setCategory] = useState(row.category ?? (row.note?.trim() === '租赁车位' ? 'rental' : 'property'));
  const [savedPlate, setSavedPlate] = useState(row.plate ?? '');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [err, setErr] = useState('');
  const [renewal, setRenewal] = useState<{ rows: ParkingQueryRow[]; cloud: DeliyunVehicle | null } | null>(null);
  const [verifiedEndDate, setVerifiedEndDate] = useState('');
  const close = () => { if (!lock.current) { if (verifiedEndDate) onDone(); else onClose(); } };

  const save = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setErr('');
    try {
      const saved = await request<ParkingSpaceRow>({ method: 'PATCH', url: `/business/parking-spaces/${row.id}`, data: {
        plate, houseNo, ownerName, ownerTel: ownerTel.split(/[\/,，、;；\s]+/).filter(Boolean).join('/'),
        note, areaSqm: area, category: category || null,
        // source 保留在服务端；日期只通过续费业务更改，不 PATCH 本地日期。
      } });
      // 保存后必须读回，不能把一次接口接受当作已保存。
      const result = await request<{ rows: ParkingSpaceRow[] }>({ url: '/business/parking-spaces', query: { garage: row.garage } });
      const hit = result.rows.find(r => r.id === row.id);
      const clean = (v: unknown) => String(v ?? '').trim();
      const expected = { houseNo, ownerName, ownerTel: ownerTel.split(/[\/,，、;；\s]+/).filter(Boolean).join('/'), note, areaSqm: area };
      const mismatch = hit && Object.entries(expected).some(([key, value]) => key === 'areaSqm'
        ? (clean(hit.areaSqm) || clean(value)) && Number(hit.areaSqm) !== Number(value)
        : clean(hit[key as keyof ParkingSpaceRow]) !== clean(value));
      if (!hit || mismatch || (hit.category ?? null) !== (category || null) || normPlate(hit.plate || '') !== normPlate(plate) || hit.source !== row.source) throw new Error('档案读回不一致，请刷新核对；输入已保留');
      setSavedPlate(saved?.plate ?? hit.plate ?? ''); toast('档案已保存并读回'); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : '保存失败，输入已保留'); }
    finally { lock.current = false; setBusy(false); }
  };

  const openRenewal = async () => {
    if (lock.current) return;
    if (!normPlate(plate) || normPlate(plate) !== normPlate(savedPlate)) { setErr('请先保存当前车牌档案，再按已保存车牌查询续费'); return; }
    lock.current = true; setBusy(true); setErr('');
    try {
      // 复用 Vehicles 的真实停车查询链；人防查询失败不能冒充未授权。
      const [initialQuery, cloudResult] = await Promise.all([
        accessCardIssuance.createParkingQuery(savedPlate), accessCardIssuance.deliyunVehiclesByPlate(savedPlate),
      ]);
      let query = initialQuery;
      for (let i = 0; query.status !== 'completed' && query.status !== 'failed' && i < 20; i++) {
        await new Promise<void>(resolve => window.setTimeout(resolve, 1000));
        query = await accessCardIssuance.parkingQuery(query.id);
      }
      if (query.status !== 'completed') throw new Error(query.error || '现场查询仍在等待，请稍后查询；未提交续费');
      const rows = query.rows.filter(r => normPlate(field(r.fields, 'plate')) === normPlate(savedPlate));
      const cloud = cloudResult.rows.find(r => normPlate(r.plate) === normPlate(savedPlate)) ?? null;
      const authorized = row.garage === 'main'
        ? garageState(rows, GARAGES.find(g => g.key === 'main')!).authorized
        : !!cloud?.civilDefenseAuthorized;
      if (!authorized) throw new Error(`当前车辆未授权${row.garage === 'main' ? '二期大车库' : '二期人防车库'}；查询到记录不等于授权，本入口不会新增授权`);
      if (!rows.some(r => GARAGES.some(g => g.db === r.database && garageState([r], g).authorized))) throw new Error('未查到已授权的旧库收费记录，不能从本入口收费');
      setRenewal({ rows, cloud });
    } catch (e) { setErr(e instanceof Error ? e.message : '现场上下文查询失败，档案草稿已保留'); }
    finally { lock.current = false; setBusy(false); }
  };

  if (renewal) return <RenewSheet plate={savedPlate} rows={renewal.rows} cloud={renewal.cloud}
    garage={row.garage} initialCommunityId={row.communityId}
    onClose={() => setRenewal(null)} onDone={endDate => { setRenewal(null); setVerifiedEndDate(endDate); }} />;

  return <Sheet open onClose={close} width={500}
    title={`车位 ${row.spaceNo}`} subtitle={row.garage === 'main' ? '二期大车库' : '二期人防车库'}>
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="note" style={{ background: 'var(--bg)', color: 'var(--ink2)' }}>档案资料与现场有效期分别办理。保存档案不会收费、续期或新增授权。</div>
      <fieldset disabled={busy} style={{ display: 'grid', gap: 12, border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <label className="fl">车牌<input className="in" value={plate} onChange={e => setPlate(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="空着表示未绑车牌" /></label>
        <label className="fl">类别<select className="in" aria-label="车位类别" value={category} onChange={e => setCategory(e.target.value as typeof category)}>
          <option value="property">产权</option><option value="rental">租赁</option><option value="vacant">空</option>
        </select></label>
        <label className="fl">房号<input className="in" value={houseNo} onChange={e => setHouseNo(e.target.value)} /></label>
        <label className="fl">业主<input className="in" value={ownerName} onChange={e => setOwnerName(e.target.value)} /></label>
        <label className="fl">电话<input className="in" value={ownerTel} onChange={e => setOwnerTel(e.target.value)} placeholder="多个电话用 / 隔开" /></label>
        <label className="fl">面积（㎡）<input className="in" value={area} onChange={e => setArea(e.target.value.replace(/[^\d.]/g, ''))} /></label>
        <label className="fl">备注<input className="in" value={note} onChange={e => setNote(e.target.value)} /></label>
      </fieldset>
      <div className="card" style={{ padding: 12, minWidth: 0 }}>
        <label className="fl">档案到期日（只读）<DateInput className="in" type="date" disabled value={row.endDate ? dayjs(row.endDate).format('YYYY-MM-DD') : ''} /></label>
        <p className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>来源：{row.source || '未记录'}。现场日期以停车系统查询及续期后的读回为准。</p>
        {verifiedEndDate ? <><p role="status">续期已完成并读回核对。档案草稿保留，可继续编辑。</p><p><strong>现场已核对有效期：{verifiedEndDate}</strong>（独立读回，非本地档案日期）</p></> : null}
        <button type="button" className="btn p" style={{ minHeight: 44 }} disabled={busy || !normPlate(plate)} onClick={() => void openRenewal()}>{busy ? '正在处理，请等待…' : '查询现场并续期收费'}</button>
      </div>
      {err ? <div className="note" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)', overflowWrap: 'anywhere' }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn p" style={{ flex: 1, minHeight: 44 }} disabled={busy} onClick={() => void save()}>{busy ? '处理中…' : '保存档案'}</button>
        <button className="btn" disabled={busy} onClick={close}>取消</button>
      </div>
    </div>
  </Sheet>;
}
