import type {
  BuildingQrRow,
  QrBackfillResp,
  QrRegenerateResp,
  QrResolveResp,
} from '@pms/shared-types';
import { request } from '../request';

/**
 * 解析小区/楼栋二维码（公开接口，扫码后未登录也能拿到位置信息）。
 * 传裸 token 或旧版普通二维码里的整条 URL 都能解析。
 */
export const resolve = (token: string) =>
  request<QrResolveResp>({ url: `/qr/${encodeURIComponent(token)}`, anonymous: true });

/** 后台：楼栋码总览（含未生成的楼栋） */
export const listBuildingCodes = (query?: { communityId?: number; tenantId?: number }) =>
  request<BuildingQrRow[]>({ url: '/qr-codes/buildings', query });

/** 后台：给存量楼栋批量补码。分批返回，remaining > 0 时继续调 */
export const backfillBuildings = (body: {
  communityId?: number;
  tenantId?: number;
  limit?: number;
  force?: boolean;
}) => request<QrBackfillResp>({ method: 'POST', url: '/qr-codes/backfill-buildings', data: body });

/** 后台：重新出图（换落地页/版本，或上次失败重试） */
export const regenerate = (body: {
  ids?: number[];
  buildingIds?: number[];
  refreshCaption?: boolean;
  tenantId?: number;
}) => request<QrRegenerateResp>({ method: 'POST', url: '/qr-codes/regenerate', data: body });
