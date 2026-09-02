import type {
  StocktakeDetailView,
  StocktakeStatus,
  StocktakeTaskView,
} from '@pms/shared-types';
import { request } from '../request';

export const list = (query: { warehouseId?: number; status?: StocktakeStatus } = {}) =>
  request<StocktakeTaskView[]>({ url: '/stocktakes', query: query as any });

export const detail = (id: number | string) =>
  request<StocktakeDetailView>({ url: `/stocktakes/${id}` });

export const create = (data: { warehouseId: number; title?: string }) =>
  request<StocktakeDetailView>({ method: 'POST', url: '/stocktakes', data });

export const countItem = (
  taskId: number | string,
  itemId: number | string,
  data: {
    actualQty: number;
    reasonCode?: string;
    note?: string;
    attachments?: string[];
  },
) => request<void>({ method: 'POST', url: `/stocktakes/${taskId}/items/${itemId}/count`, data });

export const submit = (id: number | string) =>
  request<StocktakeDetailView>({ method: 'POST', url: `/stocktakes/${id}/submit` });

export const review = (id: number | string, data: { approved: boolean; note?: string }) =>
  request<StocktakeDetailView>({ method: 'POST', url: `/stocktakes/${id}/review`, data });
