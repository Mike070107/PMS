import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddressCommunity } from '@pms/shared-types';
import HouseAddressPicker, { type PickedAddress } from '@/components/HouseAddressPicker';
import './UniSearch.css';

/**
 * 收银台统一查询框（照旧页「门禁发卡」的选房输入框做）：一个入口，既能输入也能点选。
 *
 *   · 点输入框（空）→ 展开「小区 | 楼栋 | 室号」三列，点到哪一级就查哪一级
 *   · 打字 → 三列**实时按输入过滤**（可以继续点选），同时下面按 /business/search
 *     给出「车牌 / 门禁卡」匹配；房号也在结果里列一份，便于直接点
 *       房号：228/5/201、5/201、业主姓名
 *       电话：4 位以上手机尾号（如 3028）
 *       车牌：完整车牌或 4 位以上尾号（如 BX02）
 *   · 回车：只有一条命中就直接选中；多条留在列表里让人挑
 */
export interface UniHouse {
  id: number; communityId: number; roomNo: string; lane: string | null; buildingNo: string;
  communityName: string; owner: { id: number; name: string | null; phone: string | null } | null;
}
export interface UniVehicle { id: number; plateNo: string; houseId: number }
export interface UniCard { id: number; cardNo: string; houseId: number; status?: string }
export interface UniResult { houses: UniHouse[]; vehicles: UniVehicle[]; accessCards: UniCard[] }

export type UniPick =
  | { kind: 'house'; hit: UniHouse; all: UniResult }
  | { kind: 'vehicle'; vehicle: UniVehicle; all: UniResult }
  | { kind: 'card'; card: UniCard; all: UniResult };

const num = (s: string) => { const m = /\d+/.exec(s); return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER; };
const natural = (a: string, b: string) => num(a) - num(b) || a.localeCompare(b, 'zh');

/** 输入切成检索词：228/5/201、5-201、228弄5号201室 都归一 */
function tokensOf(text: string): string[] {
  return text.toLowerCase()
    .replace(/[弄幢栋号室]/g, '/')
    .split(/[\/\s,，、\-]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function UniSearch({ communities, onPick, search, placeholder, width = '100%' }: {
  communities: AddressCommunity[];
  onPick: (p: UniPick) => void;
  search: (kw: string) => Promise<UniResult>;
  placeholder?: string;
  width?: number | string;
}) {
  const [text, setText] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [selectedPath, setSelectedPath] = useState<Array<number | string>>([]);
  const [selectionText, setSelectionText] = useState<string | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [cid, setCid] = useState<number | null>(null);
  const [bid, setBid] = useState<number | null>(null);
  const [res, setRes] = useState<UniResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const pickSeq = useRef(0);
  // 所有用户意图共用失效入口，避免只给某一条异步路径补保护。
  const invalidate = () => {
    pickSeq.current += 1;
    seq.current += 1;
    setRes(null);
    setBusy(false);
    setErr('');
    return pickSeq.current;
  };
  useEffect(() => {
    invalidate();
    return () => {pickSeq.current += 1; seq.current += 1;};
  }, [communities]);

  useEffect(() => {
    // React 已提交受控 value 和 ref，再按展示值全选；不主动 focus，避免异步回填抢焦点。
    const el = input.current;
    if (selectionText !== null && el && document.activeElement === el) el.select();
  }, [selectionText, selectionRevision]);

  // Cascader owns portal-aware outside-click handling; the former box-only
  // listener treated its body-mounted menus as outside and collapsed columns.


  const kw = text.trim();
  const typed = kw.length > 0;

  useEffect(() => {
    if (!typed) { setRes(null); setErr(''); setBusy(false); return undefined; }
    const my = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(() => {
      search(kw)
        .then((r) => { if (seq.current === my) { setRes(r); setErr(''); } })
        .catch((e) => { if (seq.current === my) { setRes(null); setErr(e instanceof Error ? e.message : '查询失败'); } })
        .finally(() => { if (seq.current === my) setBusy(false); });
    }, 300);
    return () => { window.clearTimeout(t); seq.current += 1; };
  }, [kw, typed, search]);

  const comms = useMemo(() => communities.filter((c) => c.buildings.length), [communities]);

  /**
   * 把输入按「弄/楼栋/室」的位置解析（228/6/5、6/5、228/6 都认），
   * 这样过滤不会把 6 号楼输成「房号含 6」（601 不该被 6 号楼带出来）。
   */
  const parsed = useMemo(() => {
    const t = tokensOf(kw);
    const isLane = (x: string) => x === '198' || x === '228';
    if (!t.length) return null;
    if (t.length === 1) return { loose: t[0], lane: null, building: null, room: null };
    if (t.length === 2 && isLane(t[0])) return { loose: null, lane: t[0], building: t[1], room: null };
    if (t.length === 2) return { loose: null, lane: null, building: t[0], room: t[1] };
    return { loose: null, lane: isLane(t[0]) ? t[0] : null, building: t[1], room: t[2] };
  }, [kw]);

  const matchLane = (lane: string | null) => !parsed?.lane || (lane || '') === parsed.lane;
  const matchBuilding = (bNo: string) => !parsed?.building || (bNo || '').startsWith(parsed.building);
  const matchRoom = (roomNo: string) => !parsed?.room || (roomNo || '').startsWith(parsed.room);
  /** 单段输入（姓名/房号/楼栋）用宽松匹配 */
  const looseHit = (s?: string | null) => !parsed?.loose || (s || '').toLowerCase().includes(parsed.loose);

  const houseMatches = (lane: string | null, bNo: string, roomNo: string, ownerName?: string | null) =>
    parsed?.loose ? (looseHit(roomNo) || looseHit(ownerName) || looseHit(bNo) || looseHit(lane))
      : (matchLane(lane) && matchBuilding(bNo) && matchRoom(roomNo));

  const filteredComms = useMemo(() => {
    if (!typed) return comms;
    return comms.filter((c) => parsed?.loose
      ? (looseHit(c.name) || c.buildings.some((b) => looseHit(b.buildingNo) || looseHit(b.lane) || b.houses.some((h) => looseHit(h.roomNo) || looseHit(h.ownerName))))
      : c.buildings.some((b) => matchLane(b.lane) && matchBuilding(b.buildingNo) && b.houses.some((h) => matchRoom(h.roomNo))));
  }, [comms, typed, kw]); // eslint-disable-line react-hooks/exhaustive-deps

  const curC = comms.find((c) => c.id === cid) ?? (typed ? filteredComms[0] ?? null : null);
  const buildings = useMemo(() => (curC ? [...curC.buildings].sort((a, b) => natural(a.lane || '', b.lane || '') || natural(a.buildingNo, b.buildingNo)) : []), [curC]);
  const shownBuildings = useMemo(() => (typed ? buildings.filter((b) => matchLane(b.lane) && matchBuilding(b.buildingNo)) : buildings), [buildings, typed, kw]); // eslint-disable-line react-hooks/exhaustive-deps
  const curB = buildings.find((b) => b.id === bid) ?? (typed ? shownBuildings[0] ?? null : null);
  const houses = useMemo(() => (curB ? [...curB.houses].sort((a, b) => natural(a.roomNo, b.roomNo)) : []), [curB]);
  const shownHouses = useMemo(() => {
    if (!typed || !parsed) return houses;
    if (parsed.loose) return houses.filter((h) => looseHit(h.roomNo) || looseHit(h.ownerName));
    return houses.filter((h) => matchRoom(h.roomNo));
  }, [houses, typed, kw]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 点选 → 拼成 228/5/201 这种带弄号的短写去查；唯一命中直接选中 */
  const pickFromColumns = (c: AddressCommunity, b: AddressCommunity['buildings'][number] | null, roomNo: string | null) => {
    const term = b ? [b.lane, b.buildingNo, roomNo].filter(Boolean).join('/') : c.name;
    const my = invalidate();
    setBusy(true);
    setSelectionText(null);
    setText(term);
    setOpen(true);
    void search(term).then((r) => {
      if(my !== pickSeq.current) return;
      setRes(r);
      const selected = roomNo ? b?.houses.find(h => h.roomNo === roomNo) : null;
      const exact = selected ? r.houses.find(h => h.id === selected.id && h.communityId === c.id) : null;
      if (exact) { choose({kind:'house',hit:exact,all:r}); return; }
      if(roomNo){setErr('未查到所选房间，请重新选择或重试；不会自动替换成其他住户。');return;}
      // Partial selection is navigation/filtering, never consent to charge the only matching household.
    }).catch((e) => {
      if (my === pickSeq.current) setErr(e instanceof Error ? e.message : '查询失败，请重试');
    }).finally(() => {
      if (my === pickSeq.current) setBusy(false);
    });
  };

  const choose = (p: UniPick) => {
    setBrowsing(false);
    invalidate();
    setSelectionRevision((value) => value + 1);
    if(p.kind === 'house') {
      const h = p.hit;
      const c = communities.find(c => c.id === h.communityId);
      const b = c?.buildings.find(b => b.buildingNo === h.buildingNo && (b.lane || '') === (h.lane || ''));
      setSelectedPath(b ? [h.communityId, b.id, h.id] : []);
      const building = /^\d+$/.test(h.buildingNo) ? `${h.buildingNo}号楼` : h.buildingNo;
      const room = /^\d+$/.test(h.roomNo) ? `${h.roomNo}室` : h.roomNo;
      setSelectionText([h.communityName, `${h.lane ? `${h.lane}弄` : ''}${building}`, room].filter(Boolean).join(' / '));
    } else setSelectionText(null);
    onPick(p); setOpen(false);
  };

  /**
   * 回车：不能只等防抖那次查询的结果（多半还没回来，按下去像没反应）。
   * 房号形状先在当前三列里精确落一户；否则自己发起一次查询，唯一命中直接进。
   */
  const submit = async () => {
    const term = text.trim();
    if (!term) return;
    if (parsed && !parsed.loose && curC && curB) {
      const h = shownHouses.find((x) => (parsed.room ? x.roomNo.startsWith(parsed.room) : false)) ?? shownHouses[0];
      if (h) { pickFromColumns(curC, curB, h.roomNo); return; }
    }
    // Enter 查询属于本次输入意图；不能复用上一查询词的结果。
    const my = invalidate();
    setBusy(true);
    setErr('');
    let r: UniResult;
    try {
      r = await search(term);
      if (my !== pickSeq.current) return;
      setRes(r);
    } catch (e) {
      if (my === pickSeq.current) setErr(e instanceof Error ? e.message : '查询失败');
      return;
    } finally {
      if (my === pickSeq.current) setBusy(false);
    }
    if (my !== pickSeq.current) return;
    const total = r.houses.length + r.vehicles.length + r.accessCards.length;
    if (total === 1) {
      if (r.houses.length === 1) return choose({ kind: 'house', hit: r.houses[0], all: r });
      if (r.vehicles.length === 1) return choose({ kind: 'vehicle', vehicle: r.vehicles[0], all: r });
      return choose({ kind: 'card', card: r.accessCards[0], all: r });
    }
    if (r.houses.length === 1) return choose({ kind: 'house', hit: r.houses[0], all: r });
    setOpen(true);
  };

  const houseLabel = (h: UniHouse) => `${h.communityName} ${h.buildingNo}/${h.roomNo}`;
  const noCols = !comms.length || (typed && !filteredComms.length);
  // 三列能选房时，底部只放车牌/门禁卡；没有这些就不占高度（旧页级联就是这么干净）
  const showBottom = !!err || (busy && !res) || (noCols && !!res?.houses.length) || !!res?.vehicles.length || !!res?.accessCards.length;
  const empty = typed && res && !res.houses.length && !res.vehicles.length && !res.accessCards.length && noCols;

  const pickAddress = (p: PickedAddress | null) => {
    setBrowsing(true);
    if (!p) { invalidate(); setSelectionText(null); setText(''); setSelectedPath([]); setCid(null); setBid(null); return; }
    const c = communities.find(c => c.id === p.communityId);
    if (!c) return;
    if (!p.buildingId) {
      invalidate(); setSelectionText(null); setText(''); setCid(c.id); setBid(null); return;
    }
    const b = c.buildings.find(b => b.id === p.buildingId);
    if (!b) return;
    setCid(c.id); setBid(b.id);
    pickFromColumns(c, b, p.roomNo ?? null);
  };
  const extraResults = showBottom ? (
          <div className="as-sugg">
            {err ? <div className="muted as-empty" style={{ color: 'var(--dang)' }}>{err}</div> : null}
            {busy && !res ? <div className="muted as-empty">查询中…</div> : null}
            {empty ? <div className="muted as-empty">没查到「{kw}」。房号可写 228/5/201 或 5/201；电话尾号、车牌尾号至少 4 位</div> : null}
            {noCols && res?.houses.length ? (
              <>
                <div className="as-group">房号 · 物业费 / 泊位费（进户后四类同办）</div>
                {res.houses.slice(0, 8).map((h) => {
                  // 一处输入要能看出这户在四类业务里各有什么：停车 N 辆、门禁卡 N 张（账单进户后按 tab 看）
                  const vn = res.vehicles.filter((v) => v.houseId === h.id).length;
                  const cn = res.accessCards.filter((c) => c.houseId === h.id).length;
                  return (
                    <button type="button" key={`h${h.id}`} onClick={() => choose({ kind: 'house', hit: h, all: res })}>
                      <span className="l">{houseLabel(h)}</span>
                      <span className="muted">
                        {h.owner?.name || '未登记业主'}
                        {vn ? ` · 车${vn}` : ''}{cn ? ` · 卡${cn}` : ''}
                      </span>
                    </button>
                  );
                })}
              </>
            ) : null}
            {res?.vehicles.length ? (
              <>
                <div className="as-group">车牌 · 停车费</div>
                {res.vehicles.slice(0, 8).map((v) => {
                  const h = res.houses.find((x) => x.id === v.houseId);
                  return (
                    <button type="button" key={`v${v.id}`} onClick={() => choose({ kind: 'vehicle', vehicle: v, all: res })}>
                      <span className="l">{v.plateNo}</span>
                      <span className="muted">{h ? houseLabel(h) : '未关联房号'}</span>
                    </button>
                  );
                })}
              </>
            ) : null}
            {res?.accessCards.length ? (
              <>
                <div className="as-group">门禁卡 · 新办/补办</div>
                {res.accessCards.slice(0, 6).map((c) => {
                  const h = res.houses.find((x) => x.id === c.houseId);
                  return (
                    <button type="button" key={`c${c.id}`} onClick={() => choose({ kind: 'card', card: c, all: res })}>
                      <span className="l">卡号 {c.cardNo}</span>
                      <span className="muted">{h ? houseLabel(h) : '未关联房号'}</span>
                    </button>
                  );
                })}
              </>
            ) : null}
          </div>
          ) : null;
  return (
    <div ref={box} className="addr-search uni-box" style={{ width, maxWidth: '100%', position: 'relative' }}>
      <HouseAddressPicker communities={communities} value={selectedPath} onChange={setSelectedPath}
        placeholder={placeholder ?? '房号 / 姓名 / 手机尾号 / 车牌尾号，回车查询'}
        searchText={browsing ? '' : selectionText ?? text} displayText={selectionText ?? text}
        selectionRevision={selectionRevision} inputRef={input} showCopy={false}
        open={open} onOpenChange={setOpen} extraResults={extraResults}
        onPicked={pickAddress} onSubmitText={() => { void submit(); }}
        onSearchText={next => { setBrowsing(false); invalidate(); setSelectionText(null); setSelectedPath([]); setText(next); setCid(null); setBid(null); setOpen(true); }} />
    </div>
  );
}
