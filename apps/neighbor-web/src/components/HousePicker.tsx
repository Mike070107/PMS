import { useMemo } from 'react';
import type { AddressCommunity } from '@pms/shared-types';
import HouseAddressPicker, { type PickedAddress } from '@/components/HouseAddressPicker';

/**
 * 房号选择：直接复用旧后台的 HouseAddressPicker（antd Cascader 三列联动）。
 *
 * 排序、过滤、拼音/数字打分、"不肯说"、复制地址、回车选第一条，全部沿用那一份，
 * 不再另写一套。这里只做一层适配，把它的结果转成新界面页面里用的 PickedHouse。
 */
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

export default function HousePicker({
  communities, value, onPick, disabled, onFallbackSearch, onClear,
}: {
  communities: AddressCommunity[];
  value?: PickedHouse | null;
  onPick: (picked: PickedHouse) => void;
  placeholder?: string;
  disabled?: boolean;
  onFallbackSearch?: () => void;
  onClear?: () => void;
  onTextChange?: (text: string) => void;
}) {
  /**
   * 小区列的排序：有住宅房号的排在前面，纯商铺/办公（房号全是汉字或都带商铺名）排到最后。
   * 服务端按 id 返回，早期建的商铺小区会挤在最前面，办公室选房号时看着乱。
   * 同类之间保持服务端原序，不动其他顺序。
   */
  const ordered = useMemo(() => {
    const rank = (c: AddressCommunity) => {
      const houses = c.buildings.flatMap((b) => b.houses);
      if (!houses.length) return 2;
      const residential = houses.filter((h) => !h.shopName && /\d/.test(h.roomNo)).length;
      return residential > 0 ? 0 : 1;
    };
    return [...communities].sort((a, b) => rank(a) - rank(b));
  }, [communities]);

  const cascaderValue = useMemo<Array<number | string>>(() => {
    if (!value) return [];
    const list: Array<number | string> = [value.communityId, value.buildingId];
    if (value.houseId) list.push(value.houseId);
    return list;
  }, [value]);

  const toPicked = (p: PickedAddress): PickedHouse | null => {
    if (!p.buildingId || !p.houseId || !p.roomNo) return null;
    const community = communities.find((c) => c.id === p.communityId);
    const building = community?.buildings.find((b) => b.id === p.buildingId);
    if (!community || !building) return null;
    const house = building.houses.find((h) => h.id === p.houseId);
    const laneText = building.lane ? `${building.lane}弄` : '';
    return {
      communityId: community.id,
      communityName: community.name,
      lane: building.lane ?? null,
      buildingId: building.id,
      buildingNo: building.buildingNo,
      buildingText: p.buildingText ?? '',
      houseId: house?.id ?? p.houseId,
      roomNo: p.roomNo,
      ownerName: p.ownerName ?? house?.ownerName ?? null,
      ownerPhone: p.ownerPhone ?? house?.ownerPhone ?? null,
      ownerId: house?.ownerId ?? null,
      text: p.fullText,
      shortText: `${community.name}/${laneText}${building.buildingNo}号${p.roomNo}`,
    };
  };

  return (
    <div className="hp">
      <HouseAddressPicker
        communities={ordered}
        value={cascaderValue}
        onPicked={(p) => {
          if (!p) { onClear?.(); return; }
          const full = toPicked(p);
          if (full) onPick(full);
        }}
      />
      {disabled ? <div className="hp-mask" /> : null}
      {onFallbackSearch ? (
        <button type="button" className="hp-fallback-link" onClick={onFallbackSearch}>
          按车牌 / 姓名 / 电话查 →
        </button>
      ) : null}
    </div>
  );
}
