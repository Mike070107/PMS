import type {
  RepairExperienceAccessView,
  RepairExperienceNotebookView,
  RepairExperienceNoteView,
  SaveRepairExperienceNoteReq,
  RepairExperienceLibraryQuery,
  RepairExperienceLibraryView,
  RepairExperienceSharingOptions,
} from '@pms/shared-types';
import { request, uploadMediaTo, uploadBlobTo } from '../request';

export const access = () => request<RepairExperienceAccessView>({ url: '/repair-experiences/access' });
export const library = (query: RepairExperienceLibraryQuery = {}) =>
  request<RepairExperienceLibraryView>({ url: '/repair-experiences/library', query: { ...query } });
export const sharingOptions = () => request<RepairExperienceSharingOptions>({ url: '/repair-experiences/sharing-options' });
export const remove = (id: number, revision: number) =>
  request<{ deleted: boolean }>({ method: 'DELETE', url: `/repair-experiences/${id}`, query: { revision } });
export interface RepairExperienceAsset {
  objectKey: string;
  displayUrl: string;
  /** 兼容既有编辑器；也是短签名URL，不是公开对象URL。 */
  publicUrl: string;
  expiresAt: string;
}
export const uploadAsset = (tempFilePath: string) =>
  uploadMediaTo<RepairExperienceAsset>(tempFilePath, '/repair-experiences/assets', 120000);
export const uploadAssetFile = (file: File) => {
  if (file.size > 50 * 1024 * 1024) return Promise.reject(new Error('图片不能超过50MB'));
  return uploadBlobTo<RepairExperienceAsset>(file, '/repair-experiences/assets', file.name, 120000);
};
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
