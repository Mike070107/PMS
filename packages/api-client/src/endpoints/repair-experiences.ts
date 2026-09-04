import type {
  RepairExperienceAccessView,
  RepairExperienceNotebookView,
  RepairExperienceNoteView,
  SaveRepairExperienceNoteReq,
} from '@pms/shared-types';
import { request } from '../request';

export const access = () => request<RepairExperienceAccessView>({ url: '/repair-experiences/access' });
/** q：搜标题和正文里的关键词，只在自己看得到的笔记本里搜；不传就是全部 */
export const list = (q?: string) =>
  request<RepairExperienceNotebookView[]>({ url: '/repair-experiences', query: q ? { q } : undefined });
/** 收藏 / 取消收藏一篇（小程序列表默认只展开收藏的） */
export const setFavorite = (id: number, on: boolean) =>
  request<{ favorite: boolean }>({ method: on ? 'POST' : 'DELETE', url: `/repair-experiences/${id}/favorite` });
export const detail = (id: number) => request<RepairExperienceNoteView>({ url: `/repair-experiences/${id}` });
export const create = (data: SaveRepairExperienceNoteReq) =>
  request<RepairExperienceNoteView>({ method: 'POST', url: '/repair-experiences', data });
export const update = (id: number, data: SaveRepairExperienceNoteReq) =>
  request<RepairExperienceNoteView>({ method: 'PUT', url: `/repair-experiences/${id}`, data });
