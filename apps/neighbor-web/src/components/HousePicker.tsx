import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddressBuilding, AddressCommunity, AddressHouse } from '@pms/shared-types';
import {
  buildingMatchKeys,
  communityMatchKeys,
  formatBuildingFull,
  formatBuildingLabel,
  formatFullAddress,
  houseMatchKeys,
  scoreAddressPath,
  sortedBuildings,
  sortedHouses,
  tokenizeAddress,
} from '@pms/shared-types';
import Icon from '@/components/Icon';

export interface PickedHouse {
  communityId: number;
  communityName: string;
  lane: string | null;
  buildingId: number;
  buildingNo: string;
  buildingText: string;
  houseId: number;
  roomNo: string;
  ownerName: string | null;
  ownerPhone: string | null;
  ownerId: number | null;
  text: string;
}

interface Entry {
  community: AddressCommunity;
  building: AddressBuilding;
  house: AddressHouse;
  keys: ReturnType<typeof communityMatchKeys>[];
  text: string;
}

/**
 * 房号选择：一个输入框同时干两件事——
 *   1. 直接打字：「228/4/201」「4/201」「枫桦」「502」都能联想；
 *   2. 点选：小区 → 楼栋 → 室号，不需要另开面板。
 * 交互与旧后台「先确认报修地址」一致，办公室接电话时边听边打就能选中。
 */
export default function HousePicker({
  communities, value, onPick, placeholder, disabled, onFallbackSearch, onClear, onTextChange,
}: {
  communities: AddressCommunity[];
  value?: PickedHouse | null;
  onPick: (picked: PickedHouse) => void;
  placeholder?: string;
  disabled?: boolean;
  /** 面板底部的「按车牌 / 姓名 / 电话查」入口 */
  onFallbackSearch?: () => void;
  /** 清除已选房号 */
  onClear?: () => void;
  /** 输入内容变化（外部「查询」按钮按文本查时用） */
  onTextChange?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<0 | 1 | 2>(0);
  const [community, setCommunity] = useState<AddressCommunity | null>(null);
  const [building, setBuilding] = useState<AddressBuilding | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setLevel(0);
    setCommunity(null);
    setBuilding(null);
    setActive(0);
  };

  /** 叶子级（房号）扁平表：搜索与回车都用它 */
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    for (const c of communities) {
      if (c.isGroup) continue;
      for (const b of sortedBuildings(c.buildings)) {
        const ck = communityMatchKeys(c);
        const bk = buildingMatchKeys(b);
        for (const h of sortedHouses(b.houses)) {
          list.push({
            community: c,
            building: b,
            house: h,
            keys: [ck, bk, houseMatchKeys(h)],
            text: formatFullAddress(c.name, b, h.roomNo),
          });
        }
      }
    }
    return list;
  }, [communities]);

  const results = useMemo(() => {
    const tokens = tokenizeAddress(query);
    if (!tokens.length) return [];
    const scored = entries
      .map((entry) => ({ entry, score: scoreAddressPath(tokens, entry.keys) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    return scored.map((item) => item.entry);
  }, [entries, query]);

  const pick = (entry: Entry) => {
    onPick({
      communityId: entry.community.id,
      communityName: entry.community.name,
      lane: entry.building.lane,
      buildingId: entry.building.id,
      buildingNo: entry.building.buildingNo,
      buildingText: formatBuildingFull(entry.building),
      houseId: entry.house.id,
      roomNo: entry.house.roomNo,
      ownerName: entry.house.ownerName ?? null,
      ownerPhone: entry.house.ownerPhone ?? null,
      ownerId: entry.house.ownerId ?? null,
      text: entry.text,
    });
    close();
    inputRef.current?.blur();
  };

  const searching = query.trim().length > 0;
  const communitiesList = useMemo(() => communities.filter((c) => !c.isGroup), [communities]);
  const buildingsList = useMemo(() => (community ? sortedBuildings(community.buildings) : []), [community]);
  const housesList = useMemo(() => {
    if (!building) return [];
    const list = sortedHouses(building.houses);
    const kw = query.trim();
    return kw ? list.filter((h) => h.roomNo.includes(kw) || (h.ownerName || '').includes(kw)) : list;
  }, [building, query]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'Enter') {
      if (searching && results[active]) { event.preventDefault(); pick(results[active]); }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((n) => Math.min(n + 1, Math.max(0, (searching ? results.length : 0) - 1)));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((n) => Math.max(0, n - 1));
    }
  };

  return (
    <div className="hp" ref={boxRef}>
      <div className={`hp-box ${open ? 'is-open' : ''}`}>
        <Icon name="home" size={18} />
        <input
          ref={inputRef}
          className="hp-input"
          disabled={disabled}
          value={open ? query : (value?.text || query)}
          placeholder={placeholder || '输入 228/4/201，或点选 小区 → 楼栋 → 室号'}
          onFocus={() => { if (!disabled) setOpen(true); }}
          onChange={(e) => { setQuery(e.target.value); setActive(0); onTextChange?.(e.target.value); }}
          onKeyDown={onKeyDown}
        />
        {value && !open && onClear ? (
          <button type="button" className="hp-clear" title="清除" onClick={() => { onClear(); setQuery(''); }}>
            ✕
          </button>
        ) : (
          <Icon name="search" size={18} />
        )}
      </div>

      {open ? (
        <div className="hp-pop">
          {searching ? (
            results.length ? (
              <div className="hp-list">
                {results.map((entry, index) => (
                  <button key={`${entry.house.id}`} type="button"
                    className={`hp-item ${index === active ? 'is-active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(entry)}>
                    <span className="hp-item-main">{entry.text}</span>
                    {entry.house.ownerName ? <span className="hp-item-side">{entry.house.ownerName}</span> : null}
                  </button>
                ))}
                <div className="hp-hint">回车选第一条 · Esc 关闭</div>
              </div>
            ) : (
              <div className="hp-empty">没有匹配的房号，试试「228/4/201」「4/201」「502」或业主姓名</div>
            )
          ) : level === 0 ? (
            <>
              <div className="hp-head">选择小区</div>
              <div className="hp-list">
                {communitiesList.map((c) => (
                  <button key={c.id} type="button" className="hp-row"
                    onClick={() => { setCommunity(c); setBuilding(null); setLevel(1); }}>
                    <span>{c.name}{c.mainLane ? `（${c.mainLane}弄）` : ''}</span>
                    <Icon name="chev" size={16} className="hp-arrow" />
                  </button>
                ))}
                {!communitiesList.length ? <div className="hp-empty">当前账号范围内没有小区</div> : null}
              </div>
            </>
          ) : level === 1 ? (
            <>
              <div className="hp-head">
                <button type="button" className="hp-back" onClick={() => { setCommunity(null); setLevel(0); }}>← 小区</button>
                <span>{community?.name}</span>
              </div>
              <div className="hp-list">
                {buildingsList.map((b) => (
                  <button key={b.id} type="button" className="hp-row"
                    onClick={() => { setBuilding(b); setLevel(2); }}>
                    <span>{community ? formatBuildingLabel(community, b) : b.buildingNo}</span>
                    <Icon name="chev" size={16} className="hp-arrow" />
                  </button>
                ))}
                {!buildingsList.length ? <div className="hp-empty">这个小区还没有楼栋</div> : null}
              </div>
            </>
          ) : (
            <>
              <div className="hp-head">
                <button type="button" className="hp-back" onClick={() => { setBuilding(null); setLevel(1); }}>← 楼栋</button>
                <span>{community && building ? formatBuildingLabel(community, building) : ''}</span>
              </div>
              <div style={{ padding: '8px 10px 4px' }}>
                <input className="hp-filter" value={query} autoFocus placeholder="输入房号或业主姓名过滤"
                  onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="hp-grid">
                {housesList.map((h) => (
                  <button key={h.id} type="button" className="hp-house"
                    onClick={() => { if (community && building) pick({ community, building, house: h, keys: [], text: formatFullAddress(community.name, building, h.roomNo) }); }}>
                    <b>{h.roomNo}</b>
                    <span>{h.ownerName || '空户'}</span>
                  </button>
                ))}
                {!housesList.length ? <div className="hp-empty">没有匹配的房号</div> : null}
              </div>
            </>
          )}

          {onFallbackSearch ? (
            <button type="button" className="hp-fallback" onClick={() => { close(); onFallbackSearch(); }}>
              按车牌 / 姓名 / 电话查 →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
