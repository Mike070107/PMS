import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addressSearchKey, buildingMatchKeys, communityMatchKeys, formatBuildingLabel, houseMatchKeys, scoreAddressPath, tokenizeAddress,
  type AddressBuilding, type AddressCommunity, type AddressHouse,
} from '@pms/shared-types';
import Icon from '@/components/Icon';

/**
 * 列表页的搜索框（工单、账单、养护单、车辆门禁共用）：选地址直接集成在输入框里，没有单独按钮。
 *
 *   · 点输入框 → 下面展开「小区 | 楼栋 | 室号」三列，点到哪一层就按哪一层筛：
 *     小区 → 枫桦景苑二期；楼栋 → 228/4；室号 → 228/4/502；**选「不肯说」= 停在楼栋 228/4**（查整栋相关的单）。
 *     框里写成带弄号的短写，一期二期同号楼不会混。
 *   · 直接打字 → 列表实时按输入筛（停顿 0.4 秒），下拉换成匹配到的地址建议，点一下补全；
 *     电话、单号、维修工等非地址文字照样能搜（服务端识别）。
 */
const num = (s: string) => { const m = /\d+/.exec(s); return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER; };
const natural = (a: string, b: string) => num(a) - num(b) || a.localeCompare(b, 'zh');

type Sugg = { key: string; label: string; sub: string; score: number };

export default function AddressSearch({ communities, value, onChange, placeholder, width = 360, live = true, onTextChange }: {
  communities: AddressCommunity[];
  value: string;
  /** 已防抖：打字停顿 0.4 秒、回车、选地址、清空时触发 */
  onChange: (text: string) => void;
  placeholder?: string;
  width?: number;
  /** false = 只在回车 / 选地址 / 清空时触发（查询代价大的页面，如现场停车库） */
  live?: boolean;
  /** 每次按键（不防抖）；live=false 时页面上的「查询」按钮靠它拿到框里的字 */
  onTextChange?: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  /** pick = 三列点选；type = 用户在打字，显示地址建议 */
  const [mode, setMode] = useState<'pick' | 'type'>('pick');
  const [cid, setCid] = useState<number | null>(null);
  const [bid, setBid] = useState<number | null>(null);
  const [hi, setHi] = useState(-1);
  const last = useRef(value);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (value !== last.current) { last.current = value; setText(value); } }, [value]);
  const emit = (next: string, force = false) => { const v = next.trim(); if (v === last.current && !force) return; last.current = v; onChange(v); };
  useEffect(() => { if (!live) return undefined; const t = window.setTimeout(() => emit(text), 400); return () => window.clearTimeout(t); }, [text, live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  /** 点选写入：立即查（不等防抖） */
  const setPicked = (v: string) => { setText(v); onTextChange?.(v); emit(v, true); };

  // 三列：只列有楼栋的小区；楼栋、室号按数字自然序
  const comms = useMemo(() => communities.filter((c) => c.buildings.length), [communities]);
  const curC = comms.find((c) => c.id === cid) ?? null;
  const buildings = useMemo(() => (curC ? [...curC.buildings].sort((a, b) => natural(a.lane || '', b.lane || '') || natural(a.buildingNo, b.buildingNo)) : []), [curC]);
  const curB = buildings.find((b) => b.id === bid) ?? null;
  const houses = useMemo(() => (curB ? [...curB.houses].sort((a, b) => natural(a.roomNo, b.roomNo)) : []), [curB]);

  const pickCommunity = (c: AddressCommunity) => { setCid(c.id); setBid(null); setPicked(addressSearchKey(c)); };
  const pickBuilding = (c: AddressCommunity, b: AddressBuilding) => { setBid(b.id); setPicked(addressSearchKey(c, b)); };
  /** 室号：选具体一户就写到户；选「不肯说」就停在楼栋（228/4），查整栋相关的单 */
  const pickHouse = (c: AddressCommunity, b: AddressBuilding, h: AddressHouse | null) => {
    setPicked(addressSearchKey(c, b, h?.roomNo));
    setOpen(false);
    input.current?.blur();
  };

  // 打字时的地址建议：楼栋 + 户两层一起打分，取前 12
  const suggestions = useMemo<Sugg[]>(() => {
    if (mode !== 'type') return [];
    const tokens = tokenizeAddress(text);
    if (!tokens.length) return [];
    const out: Sugg[] = [];
    for (const c of comms) {
      const ck = communityMatchKeys(c);
      for (const b of c.buildings) {
        const bk = buildingMatchKeys(b);
        const bs = scoreAddressPath(tokens, [ck, bk]);
        if (bs) out.push({ key: addressSearchKey(c, b), label: `${c.name} ${formatBuildingLabel(c, b)}`, sub: '整栋', score: bs + 0.5 });
        if (tokens.length < 2 && !/\D/.test(tokens[0]) && tokens[0].length < 3) continue; // 「20」先只认楼号
        for (const h of b.houses) {
          const hs = scoreAddressPath(tokens, [ck, bk, houseMatchKeys(h)]);
          if (hs) out.push({ key: addressSearchKey(c, b, h.roomNo), label: `${c.name} ${formatBuildingLabel(c, b)}${h.roomNo}${/^\d+$/.test(h.roomNo) ? '室' : ''}`, sub: h.ownerName || h.shopName || '', score: hs });
        }
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 12);
  }, [text, comms, mode]);
  useEffect(() => setHi(-1), [text]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (mode === 'type' && suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
      setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length + 1) % suggestions.length);
      return;
    }
    if (e.key === 'Enter') {
      // 用方向键挑过建议就用建议；否则按框里原文查（电话、单号也走这里）
      if (mode === 'type' && hi >= 0 && suggestions[hi]) setPicked(suggestions[hi].key); else emit(text, true);
      setOpen(false);
    }
  };

  return (
    <div ref={box} className="addr-search" style={{ width, maxWidth: '100%', position: 'relative' }}>
      <div className={`addr-search-row ${open ? 'on' : ''}`} onMouseDown={(e) => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus(); } setOpen(true); }}>
        <Icon name="search" size={16} />
        <input ref={input} className="in" value={text} placeholder={placeholder ?? '198/20、一期20号601、电话、单号…'}
          onFocus={() => { setOpen(true); setMode(text.trim() ? 'type' : 'pick'); }}
          onChange={(e) => { setText(e.target.value); onTextChange?.(e.target.value); setMode(e.target.value.trim() ? 'type' : 'pick'); setOpen(true); }}
          onKeyDown={onKeyDown} />
        {text ? (
          <button type="button" className="addr-search-x" title="清空"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setCid(null); setBid(null); setMode('pick'); setPicked(''); }}>✕</button>
        ) : null}
      </div>
      {open ? (
        <div className="addr-search-pop">
          {mode === 'type' ? (
            suggestions.length ? (
              <div className="as-sugg">
                {suggestions.map((s, i) => (
                  <button type="button" key={s.key} className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)}
                    onClick={() => { setPicked(s.key); setOpen(false); }}>
                    <span className="l">{s.label}</span><span className="muted">{s.sub}</span>
                  </button>
                ))}
              </div>
            ) : <div className="muted as-empty">没有匹配的地址，正在按「{text.trim()}」搜电话、单号、维修工…</div>
          ) : (
            <div className="as-cols">
              <div className="as-col">
                {comms.map((c) => (
                  <button type="button" key={c.id} className={c.id === cid ? 'on' : ''} onClick={() => pickCommunity(c)}>
                    <span className="l">{c.name}</span><span className="ar">›</span>
                  </button>
                ))}
              </div>
              <div className="as-col">
                {curC ? buildings.map((b) => (
                  <button type="button" key={b.id} className={b.id === bid ? 'on' : ''} onClick={() => pickBuilding(curC, b)}>
                    <span className="l">{formatBuildingLabel(curC, b)}</span><span className="ar">›</span>
                  </button>
                )) : <div className="muted as-empty">先选小区</div>}
              </div>
              <div className="as-col">
                {curC && curB ? (
                  <>
                    <button type="button" onClick={() => pickHouse(curC, curB, null)}><span className="l">不肯说（查整栋）</span></button>
                    {houses.map((h) => (
                      <button type="button" key={h.id} onClick={() => pickHouse(curC, curB, h)}>
                        <span className="l">{h.roomNo}</span>{h.ownerName ? <span className="muted">{h.ownerName}</span> : null}
                      </button>
                    ))}
                  </>
                ) : <div className="muted as-empty">{curC ? '再选楼栋' : ''}</div>}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
