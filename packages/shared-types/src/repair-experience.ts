export type RepairExperienceBlockType = 'heading' | 'paragraph' | 'bullet' | 'warning' | 'image';

export interface RepairExperienceBlock {
  id: string;
  type: RepairExperienceBlockType;
  text?: string;
  url?: string;
  caption?: string;
}

/**
 * 「本管理处公共」笔记本的 repairType 编码：不对应任何报修类型，同一管理处范围内的人都能看、都能写
 * （2026-09-04 要求）。前端按它判断显示「公共」标识，别拿它去查报修类型表。
 */
export const OFFICE_PUBLIC_REPAIR_TYPE = '_office';
export const OFFICE_PUBLIC_REPAIR_TYPE_LABEL = '本管理处公共';

export interface RepairExperienceNoteSummary {
  id: number;
  officeId: number;
  repairType: string;
  title: string;
  preview: string;
  imageCount: number;
  revision: number;
  updatedAt: string;
  updatedByName: string;
  /** 当前用户收藏了没有；小程序列表默认只展开收藏的 */
  favorite: boolean;
}

export interface RepairExperienceNoteView extends RepairExperienceNoteSummary {
  blocks: RepairExperienceBlock[];
  createdAt: string;
  createdByName: string;
  canEdit: boolean;
  officeName: string;
  repairTypeLabel: string;
}

export interface RepairExperienceNotebookView {
  officeId: number;
  officeName: string;
  repairType: string;
  repairTypeLabel: string;
  canEdit: boolean;
  /** 本管理处公共笔记本（repairType = OFFICE_PUBLIC_REPAIR_TYPE） */
  isPublic: boolean;
  notes: RepairExperienceNoteSummary[];
}

export interface RepairExperienceAccessView {
  canView: boolean;
  canEdit: boolean;
  notebookCount: number;
  /**
   * 一本都看不到时的原因（最常见：员工档案里还没配工种）。
   * 直接展示给用户——空页面不给理由，人只会以为功能坏了。
   */
  emptyReason?: string | null;
}

export interface SaveRepairExperienceNoteReq {
  officeId: number;
  repairType: string;
  title: string;
  blocks: RepairExperienceBlock[];
  revision?: number;
}
