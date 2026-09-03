export type RepairExperienceBlockType = 'heading' | 'paragraph' | 'bullet' | 'warning' | 'image';

export interface RepairExperienceBlock {
  id: string;
  type: RepairExperienceBlockType;
  text?: string;
  url?: string;
  caption?: string;
}

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
