/** Safe document HTML policy, mirrored by the API's experience-only sanitizer. */
export const REPAIR_EXPERIENCE_TABLE_LIMITS = {
  maxTables: 10, maxRows: 100, maxColumns: 20, maxSpan: 20,
  maxExpandedCells: 2000, maxNodes: 5000, maxDepth: 50, maxHtmlLength: 120000,
} as const;

export type RepairExperienceBlockType =
  | 'heading'
  | 'paragraph'
  | 'bullet'
  | 'ordered'
  | 'checklist'
  | 'quote'
  | 'warning'
  | 'divider'
  | 'image'
  | 'document';

export interface RepairExperienceBlock {
  id: string;
  type: RepairExperienceBlockType;
  text?: string;
  url?: string;
  caption?: string;
  checked?: boolean;
  /** 服务端清洗后的富文本文档HTML。表格保留table/thead/tbody/tfoot/tr/th/td，
   * th/td仅支持1..20的rowspan/colspan；不保留样式/列宽，不支持嵌套表。
   * 超出REPAIR_EXPERIENCE_TABLE_LIMITS返回400，不截断。旧内容块继续兼容。
   */
  html?: string;
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
  visibility?: 'private' | 'published' | 'legacy';
  communityIds?: number[];
  communityNames?: string[];
  repairTypes?: string[];
  repairTypeLabels?: string[];
  allowEdit?: boolean;
  allowDelete?: boolean;
  isOwner?: boolean;
  canManage?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  createdByName?: string;
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
  /** 兼容旧入口，此字段代表可创建自己的文档，不代表可编辑别人的文档。 */
  canEdit: boolean;
  canCreate?: boolean;
  notebookCount: number;
  /**
   * 一本都看不到时的原因（最常见：员工档案里还没配工种）。
   * 直接展示给用户——空页面不给理由，人只会以为功能坏了。
   */
  emptyReason?: string | null;
}

export interface SaveRepairExperienceNoteReq {
  /** 旧笔记本兼容字段；新私有文档不需要。 */
  officeId?: number;
  repairType?: string;
  visibility?: 'private' | 'published';
  communityIds?: number[];
  repairTypes?: string[];
  allowEdit?: boolean;
  allowDelete?: boolean;
  title: string;
  blocks: RepairExperienceBlock[];
  revision?: number;
}

export interface RepairExperienceLibraryQuery {
  q?: string;
  view?: 'all' | 'mine' | 'private' | 'favorites';
  communityId?: number;
  repairType?: string;
  page?: number;
  pageSize?: number;
}
export interface RepairExperienceLibraryView {
  items: RepairExperienceNoteSummary[];
  total: number;
  page: number;
  pageSize: number;
}
export interface RepairExperienceSharingOptions {
  canCreate: boolean;
  communities: Array<{
    id: number; name: string; officeId: number; officeName: string;
    repairTypes: Array<{ value: string; label: string }>;
  }>;
}
