import { Cascader, Typography } from 'antd';
import type { DefaultOptionType } from 'antd/es/cascader';
import { useMemo, useRef, useState } from 'react';
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

const { Text } = Typography;

/** 「不肯说」——业主不愿意报房号时只落到楼栋 */
export const UNKNOWN_HOUSE_VALUE = '__unknown_house__';

export interface PickedAddress {
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
  kind: 'community' | 'building' | 'house';
  community: AddressCommunity;
  building?: AddressBuilding;
  house?: AddressHouse;
  children?: AddrOption[];
};

const UNKNOWN_KEYS: MatchKeys = { exact: [], prefix: [], loose: ['不肯说'] };

function buildOptions(communities: AddressCommunity[]): AddrOption[] {
  return communities
    .filter((community) => !community.isGroup)
    .map((community) => ({
      value: community.id,
      label: community.mainLane ? `${community.name}（${community.mainLane}弄）` : community.name,
      kind: 'community' as const,
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
  return formatFullAddress(community.name, building, roomNo);
}

export function describePickedAddress(path: AddrOption[]): PickedAddress | null {
  const community = path[0]?.community;
  if (!community) return null;
  const building = path[1]?.building;
  const house = path[2]?.house;
  return {
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

export default function HouseAddressPicker({
  communities,
  value,
  onChange,
  onPicked,
  loading,
  id,
}: {
  communities: AddressCommunity[];
  value?: Array<number | string>;
  onChange?: (value: Array<number | string>) => void;
  onPicked?: (picked: PickedAddress | null) => void;
  loading?: boolean;
  id?: string;
}) {
  const options = useMemo(() => buildOptions(communities), [communities]);
  const allPaths = useMemo(() => flattenPaths(options), [options]);
  const [searchValue, setSearchValue] = useState('');
  const [open, setOpen] = useState(false);
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
    onChange?.(path.map((item) => item.value));
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
    if (!value?.length) return '';
    const community = options.find((item) => item.value === value[0]);
    if (!community) return '';
    const building = community.children?.find((item) => item.value === value[1]);
    const house = building?.children?.find((item) => item.value === value[2]);
    return pathText([community, building, house].filter(Boolean) as AddrOption[]);
  }, [value, options]);

  return (
    <div>
      <Cascader
        id={id}
        options={options}
        value={value}
        loading={loading}
        changeOnSelect
        allowClear
        placeholder="输入 228/4/201，或点选 小区 → 楼栋 → 室号"
        dropdownStyle={{ minWidth: 480, maxWidth: 760 }}
        displayRender={() => currentText}
        open={open}
        onDropdownVisibleChange={setOpen}
        searchValue={searchValue}
        onSearch={(next) => {
          setSearchValue(next);
          arrowUsedRef.current = false;
        }}
        onKeyDown={onKeyDown}
        showSearch={{
          limit: 50,
          filter: (input, path) => scoreOf(input, path as AddrOption[]) > 0,
          sort: (a, b, input) =>
            scoreOf(input, b as AddrOption[]) - scoreOf(input, a as AddrOption[]),
          render: (_input, path) => pathText(path as AddrOption[]) || '—',
        }}
        onChange={(next, selectedOptions) => {
          onChange?.((next as Array<number | string>) || []);
          onPicked?.(describePickedAddress((selectedOptions || []) as AddrOption[]));
          setSearchValue('');
        }}
      />
      {currentText && (
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
