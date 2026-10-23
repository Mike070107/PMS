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
  /** 完整地址：枫桦景苑二期 228弄3号502室 */
  text: string;
  /** 输入框里显示的路径：枫桦景苑二期/228弄3号502 */
  shortText: string;
}

interface Entry {
  community: AddressCommunity;
  building: AddressBuilding;
  house: AddressHouse;
  keys: ReturnType<typeof communityMatchKeys>[];
  text: string;
}

const COL_WIDTH = 218;

/**
 * 房号选择：一个输入框 + 三列联动（小区 | 楼栋 | 室号），与旧后台「先确认报修地址」一致。
 *   - 点开框：三列同屏，最左列小区，点小区第二列出楼栋，点楼栋第三列出室号，点室号即选中；
 *   - 直接在框里打 228/2/802、2/802、502 或业主姓名：切成联想列表，回车选第一条。
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
  const [community, setCommunity] = useState<AddressCommunity | null>(null);
  const [building, setBuilding] = useState<AddressBuilding | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = () => { setOpen(false); setQuery(''); setActive(0); };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 打开时把已选的小区/楼栋回填到左右两列，位置不跳
  useEffect(() => {
    if (!open) return;
    if (!value) return;
    const c = communities.find((x) => x.id === value.communityId) ?? null;
    setCommunity(c);
    setBuilding(c?.buildings.find((b) => b.id === value.buildingId) ?? null);
  }, [open, value, communities]);

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
    return entries
      .map((entry) => ({ entry, score: scoreAddressPath(tokens, entry.keys) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((item) => item.entry);
  }, [entries, query]);

  const pick = (c: AddressCommunity, b: AddressBuilding, h: AddressHouse) => {
    const laneText = b.lane ? `${b.lane}弄` : '';
    onPick({
      communityId: c.id,
      communityName: c.name,
      lane: b.lane,
      buildingId: b.id,
      buildingNo: b.buildingNo,
      buildingText: formatBuildingFull(b),
      houseId: h.id,
      roomNo: h.roomNo,
      ownerName: h.ownerName ?? null,
      ownerPhone: h.ownerPhone ?? null,
      ownerId: h.ownerId ?? null,
      text: formatFullAddress(c.name, b, h.roomNo),
      shortText: `${c.name}/${laneText}${b.buildingNo}号${h.roomNo}`,
    });
    close();
    inputRef.current?.blur();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { close(); inputRef.current?.blur(); return; }
    if (event.key === 'Enter' && query.trim() && results[active]) {
      const r = results[active];
      event.preventDefault();
      pick(r.community, r.building, r.house);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((n) => Math.min(n + 1, Math.max(0, results.length - 1)));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((n) => Math.max(0, n - 1));
    }
  };

  const searching = query.trim().length > 0;
  const communityList = useMemo(() => communities.filter((c) => !c.isGroup), [communities]);
  const buildingList = useMemo(() => (community ? sortedBuildings(community.buildings) : []), [community]);
  const houseList = useMemo(() => (building ? sortedHouses(building.houses) : []), [building]);

  return (
    <div className="hp" ref={boxRef}>
      <div className={`hp-box ${open ? 'is-open' : ''}`}>
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          className="hp-input"
          disabled={disabled}
          value={open ? query : (value?.shortText ?? '')}
          placeholder={placeholder || '输入 228/2/802，或点选 小区 → 楼栋 → 室号'}
          onFocus={() => { if (!disabled) setOpen(true); }}
          onChange={(e) => { setQuery(e.target.value); setActive(0); onTextChange?.(e.target.value); }}
          onKeyDown={onKeyDown}
        />
        {value && !open && onClear ? (
          <button type="button" className="hp-clear" title="清除" onClick={() => { onClear(); setQuery(''); }}>✕</button>
        ) : null}
      </div>

      {open ? (
        <div className="hp-pop" style={{ width: searching ? 470 : COL_WIDTH * 3 + 2 }}>
          {searching ? (
            results.length ? (
              <div className="hp-list">
                {results.map((entry, index) => (
                  <button key={entry.house.id} type="button"
                    className={`hp-item ${index === active ? 'is-active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => setActive(index)}
                    onDoubleClick={() => pick(entry.community, entry.building, entry.house)}>
                    <span className="hp-item-main">{entry.text}</span>
                    {entry.house.ownerName ? <span className="hp-item-side">{entry.house.ownerName}</span> : null}
                  </button>
                ))}
                <div className="hp-hint">回车选第一条 · 双击直接选中 · Esc 关闭</div>
              </div>
            ) : (
              <div className="hp-empty">没有匹配的房号，试试「228/2/802」「2/802」「502」或业主姓名</div>
            )
          ) : (
            <div className="hp-cols">
              {/* 一列：小区 */}
              <div className="hp-col">
                {communityList.map((c) => (
                  <button key={c.id} type="button"
                    className={`hp-cell ${community?.id === c.id ? 'is-on' : ''}`}
                    onClick={() => { setCommunity(c); setBuilding(null); }}>
                    <span className="hp-cell-t">{c.name}{c.mainLane ? `（${c.mainLane}弄）` : ''}</span>
                    <Icon name="chev" size={14} className="hp-arrow" />
                  </button>
                ))}
                {!communityList.length ? <div className="hp-empty">当前账号范围内没有小区</div> : null}
              </div>

              {/* 二列：楼栋 */}
              <div className="hp-col">
                {buildingList.map((b) => (
                  <button key={b.id} type="button"
                    className={`hp-cell ${building?.id === b.id ? 'is-on' : ''}`}
                    onClick={() => setBuilding(b)}>
                    <span className="hp-cell-t">{community ? formatBuildingLabel(community, b) : b.buildingNo}</span>
                    <Icon name="chev" size={14} className="hp-arrow" />
                  </button>
                ))}
                {!community ? <div className="hp-empty">先选小区</div> : null}
                {community && !buildingList.length ? <div className="hp-empty">没有楼栋</div> : null}
              </div>

              {/* 三列：室号 */}
              <div className="hp-col">
                {houseList.map((h) => (
                  <button key={h.id} type="button" className="hp-cell hp-cell-house"
                    onClick={() => { if (community && building) pick(community, building, h); }}>
                    <span className="hp-cell-t">{h.roomNo}{h.ownerName ? ` · ${h.ownerName}` : ''}</span>
                  </button>
                ))}
                {!building ? <div className="hp-empty">先选楼栋</div> : null}
                {building && !houseList.length ? <div className="hp-empty">这个楼栋还没有房号</div> : null}
              </div>
            </div>
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
