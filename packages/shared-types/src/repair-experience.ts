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
}

export interface SaveRepairExperienceNoteReq {
  officeId: number;
  repairType: string;
  title: string;
  blocks: RepairExperienceBlock[];
  revision?: number;
}
