import { Cascader, Typography } from 'antd';
import type { DefaultOptionType } from 'antd/es/cascader';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  buildingMatchKeys,
  communityMatchKeys,
  formatBuildingFull,
  formatBuildingLabel,
  formatFullAddress,
  houseMatchKeys,
  scoreAddressPath,
  tokenizeAddress,
  type AddressBuilding,
  type AddressCommunity,
  type AddressHouse,
  type MatchKeys,
} from '@pms/shared-types';
import './HouseAddressPicker.css';

const { Text } = Typography;

/** 「不肯说」——业主不愿意报房号时只落到楼栋 */
export const UNKNOWN_HOUSE_VALUE = '__unknown_house__';
export const PUBLIC_AREA_VALUE = '__public_area__';

export interface PickedAddress {
  locationKind?: 'public';
  communityId: number;
  communityName: string;
  buildingId?: number;
  buildingText?: string;
  houseId?: number;
  roomNo?: string;
  ownerName?: string | null;
  ownerPhone?: string | null;
  /** 枫桦景苑二期/228弄4号/201 */
  fullText: string;
}

type AddrOption = DefaultOptionType & {
  value: number | string;
  keys: MatchKeys;
  kind: 'community' | 'building' | 'house' | 'public';
  community: AddressCommunity;
  building?: AddressBuilding;
  house?: AddressHouse;
  children?: AddrOption[];
};

const UNKNOWN_KEYS: MatchKeys = { exact: [], prefix: [], loose: ['不肯说'] };

function buildOptions(communities: AddressCommunity[], allowPublicArea = false): AddrOption[] {
  return communities
    .filter((community) => !community.isGroup)
    .map((community) => ({
      value: community.id,
      label: community.mainLane ? `${community.name}（${community.mainLane}弄）` : community.name,
      kind: 'community' as const,
            // Lazy consumers load buildings after this level is picked; do not close as a leaf.
            isLeaf: false,
            keys: communityMatchKeys(community),
      community,
      children: community.buildings.map((building) => ({
        value: building.id,
        label: formatBuildingLabel(community, building),
        kind: 'building' as const,
        keys: buildingMatchKeys(building),
        community,
        building,
        children: [
          ...(allowPublicArea ? [{
            value: PUBLIC_AREA_VALUE, label: '本楼栋公共区域', kind: 'public' as const,
            keys: { exact: [], prefix: [], loose: ['公共区域'] }, community, building, isLeaf: true,
          }] : []),
          {
            value: UNKNOWN_HOUSE_VALUE,
            label: '不肯说',
            kind: 'house' as const,
            keys: UNKNOWN_KEYS,
            community,
            building,
            isLeaf: true,
          },
          ...building.houses.map((house) => ({
            value: house.id,
            label: house.ownerName ? `${house.roomNo} · ${house.ownerName}` : house.roomNo,
            kind: 'house' as const,
            keys: houseMatchKeys(house),
            community,
            building,
            house,
            isLeaf: true,
          })),
        ],
      })),
    }));
}

/**
 * 按 rc-cascader 搜索时的遍历顺序摊平所有路径（changeOnSelect 下每一层都是一条路径）。
 * 顺序必须和它一致，我们自己算出的「第一条」才等于下拉里高亮显示的第一条。
 */
function flattenPaths(options: AddrOption[]): AddrOption[][] {
  const paths: AddrOption[][] = [];
  const dig = (list: AddrOption[], prefix: AddrOption[]) => {
    for (const option of list) {
      const next = [...prefix, option];
      paths.push(next);
      if (option.children) dig(option.children, next);
    }
  };
  dig(options, []);
  return paths;
}

function pathText(path: AddrOption[]): string {
  const community = path[0]?.community;
  if (!community) return '';
  const building = path[1]?.building;
  const house = path[2]?.house;
  const roomNo = path[2] && !house ? '' : house?.roomNo;
  const text = formatFullAddress(community.name, building, roomNo);
  return path[2]?.kind === 'public' ? `${text}/公共区域` : text;
}

export function describePickedAddress(path: AddrOption[]): PickedAddress | null {
  const community = path[0]?.community;
  if (!community) return null;
  const building = path[1]?.building;
  const house = path[2]?.house;
  return {
    ...(path[2]?.kind === 'public' ? { locationKind: 'public' as const } : {}),
    communityId: community.id,
    communityName: community.name,
    buildingId: building?.id,
    buildingText: building ? formatBuildingFull(building) : undefined,
    houseId: house?.id,
    roomNo: house?.roomNo,
    ownerName: house?.ownerName ?? null,
    ownerPhone: house?.ownerPhone ?? null,
    fullText: pathText(path),
  };
}

export default function HouseAddressPicker(props: {
  communities: AddressCommunity[];
  value?: Array<number | string>;
  onChange?: (value: Array<number | string>) => void;
  onPicked?: (picked: PickedAddress | null) => void;
  loading?: boolean;
  id?: string;
  /** 挂载就展开下拉（搜索框里点「选地址」时用） */
  autoOpen?: boolean;
  allowPublicArea?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Search integrations keep the editable query separate from the selected address. */
  searchText?: string;
  onSearchText?: (text: string) => void;
  onSubmitText?: (text: string) => void;
  displayText?: string;
  selectionRevision?: number;
  inputRef?: { current: HTMLInputElement | null };
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  extraResults?: React.ReactNode;
  /** all permits community/building suggestions; default retains house-only search. */
  selectionLevel?: 'house' | 'all';
  showCopy?: boolean;
}) {
  const {
    communities,
    value,
    onChange,
    onPicked,
    loading,
    id,
    autoOpen,
  } = props;
  // Form.Item can explicitly pass undefined when resetting a controlled field.
  const controlled = Object.prototype.hasOwnProperty.call(props, 'value');
  const [internalValue, setInternalValue] = useState<Array<number | string>>([]);
  const selectedValue = controlled ? value : internalValue;
  const options = useMemo(() => buildOptions(communities, props.allowPublicArea), [communities, props.allowPublicArea]);
  const allPaths = useMemo(() => flattenPaths(options), [options]);
  const [internalSearch, setInternalSearch] = useState('');
  const searchValue = props.searchText ?? internalSearch;
  const setSearchValue = (text: string) => setInternalSearch(text);
  const [internalOpen, setInternalOpen] = useState(!!autoOpen);
  const open = props.disabled ? false : props.open ?? internalOpen;
  const setOpen = (next: boolean) => { setInternalOpen(next); props.onOpenChange?.(next); };
  const boxRef = useRef<HTMLDivElement>(null);
  const [commitRevision, setCommitRevision] = useState(0);
  useEffect(() => {
    const input = boxRef.current?.querySelector('input') ?? null;
    if (props.inputRef) props.inputRef.current = input;
  });
  useEffect(() => {
    const input = boxRef.current?.querySelector('input') ?? null;
    if (props.displayText && input && document.activeElement === input) input.select();
    // displayText also contains ordinary keystrokes: only a committed selection
    // or explicit submission may replace the user's caret with a full selection.
  }, [commitRevision, props.selectionRevision]); // eslint-disable-line react-hooks/exhaustive-deps
  // 按过上下键就说明用户自己在挑高亮项，Enter 交还给 Cascader 原生处理
  // （左右键只是在输入框里移光标，不算）
  const arrowUsedRef = useRef(false);
  // filter 会对每条路径调用一次，把分数缓存下来给 sort 复用
  const scoreCache = useRef<{ input: string; scores: Map<AddrOption, number> }>({
    input: '',
    scores: new Map(),
  });

  const scoreOf = (input: string, path: AddrOption[]) => {
    const cache = scoreCache.current;
    if (cache.input !== input) {
      cache.input = input;
      cache.scores = new Map();
    }
    const leaf = path[path.length - 1];
    const cached = cache.scores.get(leaf);
    if (cached !== undefined) return cached;
    const score = scoreAddressPath(
      tokenizeAddress(input),
      path.map((item) => item.keys),
    );
    cache.scores.set(leaf, score);
    return score;
  };

  const commitPath = (path: AddrOption[]) => {
    setCommitRevision(revision => revision + 1);
    const next = path.map((item) => item.value);
    if (!controlled) setInternalValue(next);
    onChange?.(next);
    onPicked?.(describePickedAddress(path));
    setSearchValue('');
    setOpen(false);
  };

  /**
   * rc-cascader 在搜索态下没有默认高亮项，直接回车什么都不会发生。
   * 这里接管 Enter：用和下拉同一套打分/排序算出第一条并选中，
   * 所以「228/4/201 + 回车」= 直接填上 枫桦景苑二期/228弄4号/201。
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (props.disabled) return;
    if (event.key === 'Enter' && props.onSubmitText && !arrowUsedRef.current) {
      setCommitRevision(revision => revision + 1);
      event.preventDefault(); event.stopPropagation(); props.onSubmitText(searchValue); return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      arrowUsedRef.current = true;
      return;
    }
    if (event.key !== 'Enter' || arrowUsedRef.current || !searchValue.trim()) return;
    const tokens = tokenizeAddress(searchValue);
    if (!tokens.length) return;
    let best: AddrOption[] | null = null;
    let bestScore = 0;
    for (const path of allPaths) {
      const kind = path[path.length - 1]?.kind;
      if (kind !== 'house' && kind !== 'public') continue;
      const score = scoreAddressPath(tokens, path.map((item) => item.keys));
      if (score > bestScore) {
        bestScore = score;
        best = path;
      }
    }
    if (!best) return;
    event.preventDefault();
    event.stopPropagation();
    commitPath(best);
  };

  const currentText = useMemo(() => {
    if (props.displayText !== undefined) return props.displayText;
    if (!selectedValue?.length) return '';
    const community = options.find((item) => item.value === selectedValue[0]);
    if (!community) return '';
    const building = community.children?.find((item) => item.value === selectedValue[1]);
    const house = building?.children?.find((item) => item.value === selectedValue[2]);
    return pathText([community, building, house].filter(Boolean) as AddrOption[]);
  }, [selectedValue, options, props.displayText]);

  return (
    <div ref={boxRef} className="house-address-picker" onKeyDownCapture={(event) => {
      // Capture before rc-select's own Enter handler can commit a different path.
      if (event.key === 'Enter' && props.onSubmitText && !arrowUsedRef.current) onKeyDown(event);
    }} onFocus={(event) => {
      if (selectedValue?.length && props.displayText && event.target instanceof HTMLInputElement) event.target.select();
    }}>
      <Cascader
        id={id}
        className="house-address-picker-control"
        popupClassName="house-address-picker-popup"
        options={options}
        value={selectedValue}
        loading={loading}
        disabled={props.disabled}
        changeOnSelect
        allowClear
        placeholder={props.placeholder ?? "输入 228/4/201，或点选 小区 → 楼栋 → 室号"}
        dropdownStyle={{ width: 720, maxWidth: 'calc(100vw - 32px)' }}
        displayRender={() => currentText}
        dropdownRender={props.extraResults ? (menus) => <>{menus}{props.extraResults}</> : undefined}
        open={open}
        onDropdownVisibleChange={(v) => {
          setOpen(v);
          // 关闭时清掉搜索词：下次点开回到「小区 → 楼栋 → 室号」逐级点选，而不是停在上次的搜索平铺
          if (!v) { setSearchValue(''); arrowUsedRef.current = false; }
        }}
        searchValue={searchValue}
        onSearch={(next) => {
          if (props.disabled) return;
          // rc-select emits an empty search on close. It is not a new user intent;
          // a real deletion has already made the DOM input empty before onSearch.
          if (!next && props.searchText !== undefined && boxRef.current?.querySelector('input')?.value) return;
          setSearchValue(next);
          props.onSearchText?.(next);
          arrowUsedRef.current = false;
        }}
        onKeyDown={onKeyDown}
        showSearch={{
          limit: 50,
          // 空输入时返回 false：下拉回到「小区 → 楼栋 → 室号」逐级点选列（和旧后台一致）；
          // 有输入时只放行「到室号」的整条路径，每行都能直接选中，不混入楼栋级半路径。
          filter: (input, path) => {
            if (!input.trim()) return false;
            const leaf = (path as AddrOption[])[path.length - 1];
            return (props.selectionLevel === 'all' || leaf?.kind === 'house' || leaf?.kind === 'public') && scoreOf(input, path as AddrOption[]) > 0;
          },
          sort: (a, b, input) =>
            scoreOf(input, b as AddrOption[]) - scoreOf(input, a as AddrOption[]),
          render: (_input, path) => pathText(path as AddrOption[]) || '—',
        }}
        onChange={(next) => {
          if (props.disabled) return;
          // Resolve against the current scoped tree, not an old popup's option objects.
          const opts: AddrOption[] = [];
          let level = options;
          for (const v of (next || []) as Array<number | string>) {
            const option = level.find(item => item.value === v);
            if (!option) return;
            opts.push(option); level = option.children ?? [];
          }
          if (!controlled) setInternalValue((next as Array<number | string>) || []);
          setCommitRevision(revision => revision + 1);
          onChange?.((next as Array<number | string>) || []);
          onPicked?.(describePickedAddress(opts));
          setSearchValue('');
          // 选到「室号」(叶子)就收起下拉；点小区/楼栋是在逐级展开，保持打开
          const leaf = opts[opts.length - 1];
          if (leaf?.kind === 'house' || leaf?.kind === 'public') setOpen(false);
        }}
      />
      {props.showCopy !== false && currentText && (
        // 选中的地址在 Cascader 里选不中也复制不了，这里给一份可选中 / 一键复制的纯文本
        <Text
          style={{ fontSize: 13, display: 'inline-block', marginTop: 8, userSelect: 'text' }}
          copyable={{ text: currentText, tooltips: ['复制地址', '已复制'] }}
        >
          {currentText}
        </Text>
      )}
    </div>
  );
}
