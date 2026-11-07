import DateInput from '@/components/DateInput';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import ToneIcon from '@/components/ToneIcon';
import { Loading, Sheet, toast } from '@/components/ui';
import '@/styles/parking-glass.css';

interface SpaceRow {
  id: number; garage: 'main' | 'civil'; spaceNo: string; houseNo: string | null; areaSqm: string | null;
  /** 后端若已返回拼好的地址/房号，优先使用，不自己发明 */
  address?: string | null; roomLabel?: string | null; buildingNo?: string | null;
  plate: string | null; ownerName: string | null; ownerTel: string | null; note: string | null; source: string | null; endDate: string | null;
}


const PLATE_NEV_RE = /^[\u4e00-\u9fa5][A-Z][DF]/;
const compactPlate = (raw: string) => raw.replace(/[·\s.．]/g, '').toUpperCase();
/** 新能源牌：8 位车牌或第 3 位为 D/F；拿不准按蓝牌。 */
function isNewEnergyPlate(raw: string) {
  const plate = compactPlate(raw);
  return plate.length >= 8 || PLATE_NEV_RE.test(plate);
}
type RoomParts = { lane?: string; building: string; room: string };
/** 解析房号：228弄26号203室 / 228-21-801 / 51/1101 / 228/6/301。 */
function parseRoomText(raw?: string | null): RoomParts | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  let m = text.match(/(\d{1,4})\s*弄\s*(\d{1,4})\s*号?\s*(\d{2,5})\s*室?/);
  if (m) return { lane: m[1], building: m[2], room: m[3] };
  m = text.match(/(\d{1,4})\s*栋\s*(\d{1,4})\s*室?/);
  if (m) return { building: m[1], room: m[2] };
  m = text.match(/^(\d{1,4})\s*[-/]\s*(\d{1,4})\s*[-/]\s*(\d{2,5})$/);
  if (m) return { lane: m[1], building: m[2], room: m[3] };
  m = text.match(/^(\d{1,4})\s*[-/]\s*(\d{2,5})$/);
  if (m) return { building: m[1], room: m[2] };
  return null;
}
/** 统一显示 管理处号/楼栋号/室号；拿不到管理处号或解析不出时保留原值。 */
function formatRoomNo(row: SpaceRow, fallbackLane?: string) {
  const candidates = [row.roomLabel, row.address, row.houseNo];
  let lane = fallbackLane;
  let buildingRoom: { building: string; room: string } | null = null;
  for (const candidate of candidates) {
    const parts = parseRoomText(candidate);
    if (!parts) continue;
    if (parts.lane) {
      lane = parts.lane;
      buildingRoom = { building: parts.building, room: parts.room };
      break;
    }
    if (!buildingRoom) buildingRoom = { building: parts.building, room: parts.room };
  }
  if (buildingRoom && lane) return lane + '/' + buildingRoom.building + '/' + buildingRoom.room;
  return row.houseNo ? String(row.houseNo).trim() : '—';
}

const META = {
  main: { title: '二期大车库', sub: '地库车位清单 · 按车位收费 67.50 元/位·月', tone: 'slate' as const },
  civil: { title: '二期人防车库', sub: '人防车位清单 · 德立云系统 · 进库需先授权二期地面', tone: 'blue' as const },
};

/**
 * 车位管理：一个车库一页，车位卡片网格。
 * 数据 GET /business/parking-spaces?garage=main|civil（来源：43号地库清单 / 44号人防清单）。
 */
export default function ParkingSpaces({ garage }: { garage: 'main' | 'civil' }) {
  const meta = META[garage];
  const [rows, setRows] = useState<SpaceRow[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'bound' | 'free'>('all');
  const [view, setView] = useState<'card' | 'table'>('card');
  const [edit, setEdit] = useState<SpaceRow | null>(null);

  const load = useCallback(async () => {
    setRows(null); setErr('');
    try {
      const r = await request<{ rows: SpaceRow[] }>({ url: '/business/parking-spaces', query: { garage } });
      setRows(r?.rows ?? []);
    } catch (e) {
      setRows([]); setErr(e instanceof Error ? e.message : '加载失败');
    }
  }, [garage]);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const kw = q.trim().toUpperCase();
    return (rows ?? []).filter((r) => {
      const bound = !!(r.plate && r.plate.trim());
      if (only === 'bound' && !bound) return false;
      if (only === 'free' && bound) return false;
      if (!kw) return true;
      return [r.spaceNo, r.plate, r.houseNo, r.ownerName].some((v) => (v || '').toUpperCase().includes(kw));
    });
  }, [rows, q, only]);

  const bound = (rows ?? []).filter((r) => r.plate && r.plate.trim()).length;
  const total = rows?.length ?? 0;
  const roomLane = (rows ?? []).map((row) => parseRoomText(row.roomLabel || row.address || row.houseNo)).find((parts) => parts?.lane)?.lane;

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row">
            <ToneIcon kind={garage === 'main' ? 'vehicles' : 'cards'} />
            <h1 style={{ fontSize: 22 }}>{meta.title}</h1>
          </div>
          <p>{meta.sub}</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />刷新</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="chips" style={{ display: 'flex', gap: 6 }}>
          {([['all', '全部'], ['bound', '已绑车牌'], ['free', '空车位']] as const).map(([k, l]) => (
            <button key={k} className={`chip ${only === k ? 'on' : ''}`} onClick={() => setOnly(k)}>{l}</button>
          ))}
        </div>
        <input className="in" style={{ width: 260 }} value={q} placeholder="车位号 / 车牌 / 房号 / 业主" onChange={(e) => setQ(e.target.value)} />
        <span className="tag mute">{total} 个车位 · 已绑 {bound} · 空 {total - bound}</span>
        <div className="chips" style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button className={`chip ${view === 'card' ? 'on' : ''}`} onClick={() => setView('card')}><Icon name="apps" size={14} />卡片</button>
          <button className={`chip ${view === 'table' ? 'on' : ''}`} onClick={() => setView('table')}><Icon name="kanban" size={14} />表格</button>
        </div>
      </div>

      {err ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}><Icon name="alert" />{err}</div> : null}

      {rows === null ? <Loading /> : shown.length === 0 ? (
        <div className="card" style={{ padding: 42, textAlign: 'center' }}><span className="muted">没有符合条件的车位</span></div>
      ) : (
        view === 'table' ? (
          <div className="card t-scroll">
            <table className="t" style={{ minWidth: 720 }}>
              <thead>
                <tr><th style={{ width: 90 }} className="nw">车位号</th><th className="nw">车牌</th><th>房号</th><th className="nw">业主</th><th className="nw">电话</th><th className="nw" style={{ width: 110 }}>有效期</th><th className="nw" style={{ width: 120 }}>备注</th><th className="nw" style={{ width: 70 }}>操作</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="nw"><b>{r.spaceNo}</b></td>
                    <td className="nw">{r.plate || <span className="muted">空车位</span>}</td>
                    <td className="sub">{formatRoomNo(r, roomLane)}</td>
                    <td className="nw">{r.ownerName || '—'}</td>
                    <td className="nw">{r.ownerTel || '—'}</td>
                    <td className="nw">{r.endDate ? dayjs(r.endDate).format('YYYY-MM-DD') : '—'}</td>
                    <td className="nw">{r.note ? <span className={`tag ${r.note.includes('租赁') ? 'warn' : (r.note.includes('来源') ? 'mute' : 'ok')}`}>{r.note}</span> : '—'}</td>
                    <td className="nw"><button className="btn sm" onClick={() => setEdit(r)}>编辑</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
        <div className="sp-glass-wrap">
          <div className="sp-grid">
          {shown.map((r) => {
            const hasPlate = !!(r.plate && r.plate.trim());
            const abnormal = !!r.note && /异常|停用|故障|损坏/.test(r.note);
            return (
              <div key={r.id} className={`sp-card ${hasPlate ? '' : 'is-free'}${abnormal ? ' is-abnormal' : ''}`} data-state={hasPlate ? 'bound' : 'free'}>
                <div className="sp-top">
                  <span className="ic-tile t-slate" style={{ width: 34, height: 34 }}>
                    <Icon name="car" size={18} />
                  </span>
                  <div className="sp-no">{r.spaceNo}<small>号位</small></div>
                  {r.note ? <span className={`tag ${r.note.includes('租赁') ? 'warn' : (r.note.includes('来源') ? 'mute' : 'ok')}`}>{r.note}</span> : null}
                </div>
                <div className="sp-plate" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{hasPlate ? (
                    <span className={`sp-plate-tag ${isNewEnergyPlate(r.plate!) ? 'nev' : 'blue'}`} title={r.plate || undefined}>{compactPlate(r.plate!)}</span>
                  ) : <span className="sp-empty">空车位</span>}</span>
                  <button className="btn sm" onClick={() => setEdit(r)}>编辑</button>
                </div>
                <dl className="sp-kv">
                  <dt>有效期</dt><dd>{r.endDate ? dayjs(r.endDate).format('YYYY-MM-DD') : '—'}</dd>
                  <dt>房号</dt><dd title={r.houseNo || undefined}>{formatRoomNo(r, roomLane)}</dd>
                  {r.ownerName ? <><dt>业主</dt><dd>{r.ownerName}</dd></> : null}
                  {r.ownerTel ? <><dt>电话</dt><dd>{r.ownerTel}</dd></> : null}
                </dl>
              </div>
            );
          })}
          </div>
        </div>
        )
      )}

      {edit ? <EditSheet row={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void load(); }} /> : null}

      <div className="note2" style={{ marginTop: 16 }}>
        <Icon name="alert" />
        {garage === 'main'
          ? '大车库按车位收费（67.50 元/位·月），车牌从老系统备注（地库/DK+车位号）回填；空车位等登记后再绑车牌。'
          : '人防车库在德立云系统，进库必须先授权二期地面；授权依赖已在车库授权里做了自动联动。'}
      </div>
    </>
  );
}

function EditSheet({ row, onClose, onDone }: { row: SpaceRow; onClose: () => void; onDone: () => void }) {
  const [plate, setPlate] = useState(row.plate ?? '');
  const [houseNo, setHouseNo] = useState(row.houseNo ?? '');
  const [ownerName, setOwnerName] = useState(row.ownerName ?? '');
  const [ownerTel, setOwnerTel] = useState(row.ownerTel ?? '');
  const [note, setNote] = useState(row.note ?? '');
  const [area, setArea] = useState(row.areaSqm ?? '');
  const [endDate, setEndDate] = useState(row.endDate ? dayjs(row.endDate).format('YYYY-MM-DD') : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true); setErr('');
    try {
      await request({ method: 'PATCH', url: `/business/parking-spaces/${row.id}`, data: { plate, houseNo, ownerName, ownerTel: ownerTel.split(/[\/,，、;；\s]+/).filter(Boolean).join('/'), note, areaSqm: area, endDate } });
      toast('已保存');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} width={460} title={`车位 ${row.spaceNo}`} subtitle={row.garage === 'main' ? '二期大车库' : '二期人防车库'}>
      <div style={{ display: 'grid', gap: 10, padding: '4px 2px' }}>
        <label className="fl">车牌<input className="in" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="空着表示未绑车牌" /></label>
        <label className="fl">房号<input className="in" value={houseNo} onChange={(e) => setHouseNo(e.target.value)} /></label>
        <label className="fl">业主<input className="in" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></label>
        <label className="fl">电话<input className="in" value={ownerTel} onChange={(e) => setOwnerTel(e.target.value)} placeholder="多个电话用 / 隔开" /></label>
        <label className="fl">车牌续费有效期<DateInput className="in" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
        <label className="fl">面积（㎡）<input className="in" value={area} onChange={(e) => setArea(e.target.value.replace(/[^\d.]/g, ''))} /></label>
        <label className="fl">备注<input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：产权 / 租赁车位 / 来源停车系统" /></label>
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
          <button className="btn" onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}
