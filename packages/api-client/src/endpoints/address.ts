import type { AddressCommunity } from '@pms/shared-types';
import { request } from '../request';

/**
 * 小程序端地址簿：小区 → 楼栋 → 房号，**不含业主姓名/电话**。
 * 业主还没入驻（账号无 tenantId）时必须带 communityId —— 由扫码解析得到。
 */
export const book = (communityId?: number) =>
  request<AddressCommunity[]>({ url: '/address-book', query: { communityId } });

export interface PublicCommunity {
  id: number;
  name: string;
  /** 上级分组名，如「枫桦景苑一期」的分组是「枫桦景苑」 */
  groupName: string | null;
  /** 去掉分组前缀后的短名，如「一期」 */
  shortName: string;
  /** 该小区住宅楼栋占比最高的弄，如「198」 */
  mainLane: string | null;
}

/** 入驻时手动选小区用；只有 id + 名称 */
export const communities = () =>
  request<PublicCommunity[]>({ url: '/communities/public' });
