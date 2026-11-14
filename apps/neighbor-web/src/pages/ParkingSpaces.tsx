import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import ToneIcon from '@/components/ToneIcon';
import { Loading } from '@/components/ui';
import ParkingSpaceEditor, { type ParkingSpaceRow } from '@/components/parking/ParkingSpaceEditor';
import '@/styles/parking-glass.css';

/** 仅大车库提供示意图，three.js 在切换到该视图时才下载。人防业务/授权保留。 */
const ParkingGarage3D = lazy(() => import('@/components/parking/ParkingGarage3D'));
type SpaceRow = ParkingSpaceRow;
type Category = 'property' | 'rental' | 'vacant';
const CATEGORIES: Record<Category, { label: string }> = {
  property: { label: '产权' }, rental: { label: '租赁' }, vacant: { label: '空' },
};
/** 只读兼容精确旧备注，不猜测、不改写 category，也不把未绑车牌当作类别「空」。 */
function categoryOf(row: SpaceRow): Category {
  if (row.category === 'property' || row.category === 'rental' || row.category === 'vacant') return row.category;
  if (row.note?.trim() === '产权车位') return 'property';
  if (row.note?.trim() === '租赁车位') return 'rental';
  return 'property';
}
function CategoryTag({ row }: { row: SpaceRow }) {
  const category = categoryOf(row);
  return <span className={`sp-category category-${category}`} title={!row.category ? (category === 'rental' ? '沿用原档案租赁类别' : '默认产权车位') : undefined}>{CATEGORIES[category].label}</span>;
}

const PLATE_NEV_RE = /^[\u4e00-\u9fa5][A-Z][DF]/;
const compactPlate = (raw: string) => raw.replace(/[·\s.．]/g, '').toUpperCase();
function isNewEnergyPlate(raw: string) {
  const plate = compactPlate(raw);
  return plate.length >= 8 || PLATE_NEV_RE.test(plate);
}
type RoomParts = { lane?: string; building: string; room: string };
/** 解析真实地址，不从另一车位推断当前车位的弄号。 */
function parseRoomText(raw?: string | null): RoomParts | null {
  if (!raw) return null;
  const text = String(raw).trim();
  let m = text.match(/(\d{1,4})\s*弄\s*(\d{1,4})\s*号?\s*(\d{2,5})\s*室?/);
  if (m) return { lane: m[1], building: m[2], room: m[3] };
  m = text.match(/(\d{1,4})\s*栋\s*(\d{1,4})\s*室?/);
  if (m) return { building: m[1], room: m[2] };
  m = text.match(/^(\d{1,4})\s*[-/]\s*(\d{1,4})\s*[-/]\s*(\d{2,5})$/);
  if (m) return { lane: m[1], building: m[2], room: m[3] };
  m = text.match(/^(\d{1,4})\s*[-/]\s*(\d{2,5})$/);
  return m ? { building: m[1], room: m[2] } : null;
}
function formatRoomNo(row: SpaceRow) {
  const candidates = [row.roomLabel, row.address, row.houseNo];
  for (const candidate of candidates) {
    const parts = parseRoomText(candidate);
    if (parts?.lane) return `${parts.lane}/${parts.building}/${parts.room}`;
  }
  return candidates.find((value) => value?.trim())?.trim() || '—';
}
const dateLabel = (value: string | null) => value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD') : '—';
const META = {
  main: { title: '二期大车库', sub: '地库车位清单 · 按车位收费 67.50 元/位·月' },
  civil: { title: '二期人防车库', sub: '人防车位清单 · 德立云系统 · 进库需先授权二期地面' },
};

/** GET /business/parking-spaces?garage=main|civil；两库共用卡片及正式编辑器。 */
export default function ParkingSpaces({ garage }: { garage: 'main' | 'civil' }) {
  const meta = META[garage];
  const [rows, setRows] = useState<SpaceRow[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'bound' | 'free'>('all');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [view, setView] = useState<'card' | 'table' | 'iso'>('card');
  const [edit, setEdit] = useState<SpaceRow | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setRows(null); setErr('');
    try {
      const r = await request<{ rows: SpaceRow[] }>({ url: '/business/parking-spaces', query: { garage } });
      if (current === sequence.current) setRows((r?.rows ?? []).filter((row) => row.garage === garage));
    } catch (e) {
      if (current === sequence.current) { setRows([]); setErr(e instanceof Error ? e.message : '加载失败'); }
    }
  }, [garage]);
  useEffect(() => {
    setView('card'); setEdit(null); setQ(''); setOnly('all'); setCategory('all');
    void load();
    return () => { sequence.current += 1; };
  }, [load]);

  const currentRows = useMemo(() => (rows ?? []).filter((row) => row.garage === garage), [rows, garage]);
  const shown = useMemo(() => {
    const kw = q.trim().toUpperCase();
    return currentRows.filter((r) => {
      const bound = !!r.plate?.trim();
      if (only === 'bound' && !bound) return false;
      if (only === 'free' && bound) return false;
      if (category !== 'all' && categoryOf(r) !== category) return false;
      return !kw || [r.spaceNo, r.plate, r.houseNo, r.roomLabel, r.address, r.ownerName, r.ownerTel].some((v) => (v || '').toUpperCase().includes(kw));
    });
  }, [currentRows, q, only, category]);
  const matchIds = useMemo(() => only === 'all' && category === 'all' && !q.trim() ? null : new Set(shown.map((r) => r.id)), [only, category, q, shown]);
  const bound = currentRows.filter((r) => r.plate?.trim()).length;
  const total = currentRows.length;
  // 即使从大车库图直接切换人防，也不在effect执行前短暂挂载人防3D。
  const activeView = garage === 'civil' && view === 'iso' ? 'card' : view;

  return (
    <section className="parking-spaces" aria-label={meta.title}>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind={garage === 'main' ? 'vehicles' : 'cards'} /><h1 style={{ fontSize: 22 }}>{meta.title}</h1></div><p>{meta.sub}</p></div>
        <div className="act"><button className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />刷新</button></div>
      </div>
      <div className="sp-toolbar">
        <div className="chips" role="group" aria-label="车牌绑定筛选">
          {([['all', '全部'], ['bound', '已绑车牌'], ['free', '未绑车牌']] as const).map(([k, l]) => <button key={k} className={`chip ${only === k ? 'on' : ''}`} aria-pressed={only === k} onClick={() => setOnly(k)}>{l}</button>)}
        </div>
        <label className="sp-category-filter">车位类别<select className="in" aria-label="车位类别" value={category} onChange={(e) => setCategory(e.target.value as Category | 'all')}>
          <option value="all">全部类别</option>{(Object.keys(CATEGORIES) as Category[]).map((key) => <option key={key} value={key}>{CATEGORIES[key].label}</option>)}
        </select></label>
        <input className="in sp-search" aria-label="搜索车位" value={q} placeholder="车位号 / 车牌 / 房号 / 业主 / 电话" onChange={(e) => setQ(e.target.value)} />
        <span className="tag mute" aria-live="polite">{rows === null ? '车位加载中' : err ? '未取得车位数据' : `${total} 个车位 · 已绑 ${bound} · 未绑 ${total - bound}`}</span>
        <div className="chips sp-view-switch" role="group" aria-label="车位视图">
          <button className={`chip ${activeView === 'card' ? 'on' : ''}`} aria-pressed={activeView === 'card'} onClick={() => setView('card')}><Icon name="apps" size={14} />卡片</button>
          <button className={`chip ${activeView === 'table' ? 'on' : ''}`} aria-pressed={activeView === 'table'} onClick={() => setView('table')}><Icon name="kanban" size={14} />表格</button>
          {garage === 'main' && <button className={`chip ${view === 'iso' ? 'on' : ''}`} aria-pressed={view === 'iso'} onClick={() => setView('iso')}><Icon name="layers" size={14} />车位图</button>}
        </div>
      </div>
      {err ? <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}><Icon name="alert" />{err}</div> : null}
      {rows === null ? <Loading /> : err ? null : garage === 'main' && view === 'iso' ? (
        <Suspense fallback={<div className="sp-map-loading"><Loading text="正在加载车位示意图…" /></div>}>
          <ParkingGarage3D rows={currentRows.filter((r): r is SpaceRow & { garage: 'main' } => r.garage === 'main')} matchIds={matchIds} selectedId={edit?.id ?? null} onSelect={(row) => { const full = currentRows.find((r) => r.id === row.id); if (full) setEdit(full); }} />
        </Suspense>
      ) : shown.length === 0 ? <div className="card" style={{ padding: 42, textAlign: 'center' }}><span className="muted">没有符合条件的车位</span></div> : activeView === 'table' ? (
        <div className="card t-scroll"><table className="t" style={{ minWidth: 800 }}>
          <thead><tr><th className="nw">车位号</th><th>类别</th><th className="nw">车牌</th><th>房号</th><th>业主</th><th>电话</th><th className="nw">有效期</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>{shown.map((r) => <tr key={r.id}>
            <td className="nw"><b>{r.spaceNo}</b></td><td><CategoryTag row={r} /></td>
            <td className="nw">{r.plate || <span className="muted">未绑车牌</span>}</td><td>{formatRoomNo(r)}</td><td>{r.ownerName || '—'}</td><td>{r.ownerTel || '—'}</td><td className="nw">{dateLabel(r.endDate)}</td><td>{r.note || '—'}</td>
            <td><button className="btn sm" aria-label={`编辑车位 ${r.spaceNo}`} onClick={() => setEdit(r)}>编辑</button></td>
          </tr>)}</tbody>
        </table></div>
      ) : (
        <div className="sp-glass-wrap"><div className="sp-grid">{shown.map((r) => {
          const hasPlate = !!r.plate?.trim();
          const abnormal = !!r.note && /异常|停用|故障|损坏/.test(r.note);
          return <article key={r.id} aria-label={`车位 ${r.spaceNo}`} className={`sp-card ${hasPlate ? '' : 'is-free'}${abnormal ? ' is-abnormal' : ''}`} data-state={hasPlate ? 'bound' : 'free'}>
            <div className="sp-top"><span className="ic-tile t-slate"><Icon name="car" size={18} /></span><div className="sp-no"><span title={r.spaceNo}>{r.spaceNo}</span><small>号位</small></div><CategoryTag row={r} /></div>
            <div className="sp-plate"><span>{hasPlate ? <span className={`sp-plate-tag ${isNewEnergyPlate(r.plate!) ? 'nev' : 'blue'}`}>{compactPlate(r.plate!)}</span> : <span className="sp-empty">未绑车牌</span>}</span><button className="btn sm" aria-label={`编辑车位 ${r.spaceNo}`} onClick={() => setEdit(r)}>编辑</button></div>
            <dl className="sp-kv">
              <dt>有效期</dt><dd title={dateLabel(r.endDate)}>{dateLabel(r.endDate)}</dd><dt>房号</dt><dd title={formatRoomNo(r)}>{formatRoomNo(r)}</dd>
                            <dt>业主</dt><dd title={r.ownerName || '—'}>{r.ownerName || '—'}</dd><dt>电话</dt><dd title={r.ownerTel || '—'}>{r.ownerTel || '—'}</dd>
            </dl>
            <p className="sp-note"><span>备注</span><span className="sp-note-value" title={r.note || '—'}>{r.note || '—'}</span></p>
          </article>;
        })}</div></div>
      )}
      {edit?.garage === garage ? <ParkingSpaceEditor key={`${garage}:${edit.id}`} row={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void load(); }} /> : null}
      <div className="note2" style={{ marginTop: 16 }}><Icon name="alert" />{garage === 'main' ? '大车库按车位收费（67.50 元/位·月），车牌从老系统备注（地库/DK+车位号）回填；未绑车牌不代表车位类别为空。' : '人防车库在德立云系统，进库必须先授权二期地面；授权依赖已在车库授权里做了自动联动。'}</div>
    </section>
  );
}
