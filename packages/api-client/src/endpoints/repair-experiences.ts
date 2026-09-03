import type {
  RepairExperienceAccessView,
  RepairExperienceNotebookView,
  RepairExperienceNoteView,
  SaveRepairExperienceNoteReq,
} from '@pms/shared-types';
import { request } from '../request';

export const access = () => request<RepairExperienceAccessView>({ url: '/repair-experiences/access' });
export const list = () => request<RepairExperienceNotebookView[]>({ url: '/repair-experiences' });
export const detail = (id: number) => request<RepairExperienceNoteView>({ url: `/repair-experiences/${id}` });
export const create = (data: SaveRepairExperienceNoteReq) =>
  request<RepairExperienceNoteView>({ method: 'POST', url: '/repair-experiences', data });
export const update = (id: number, data: SaveRepairExperienceNoteReq) =>
  request<RepairExperienceNoteView>({ method: 'PUT', url: `/repair-experiences/${id}`, data });
