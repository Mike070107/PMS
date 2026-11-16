import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 管理处 + 报修类别共享的维修经验笔记。正文采用安全的结构化内容块。 */
@Entity('repair_experience_notes')
@Index(['tenantId', 'officeId', 'repairType'])
@Index(['tenantId', 'updatedAt'])
export class RepairExperienceNote extends TenantEntity {
  @Column({ name: 'office_id', type: 'int' })
  officeId: number;

  @Column({ name: 'repair_type', type: 'varchar', length: 60 })
  repairType: string;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  blocks: Array<{
    id: string;
    type: 'heading' | 'paragraph' | 'bullet' | 'ordered' | 'checklist' | 'quote' | 'warning' | 'divider' | 'image' | 'document';
    text?: string;
    url?: string;
    caption?: string;
    checked?: boolean;
    html?: string;
  }>;

  /** legacy只用于迁移存量；新建默认private。占位officeId不参与新文档ACL。 */
  @Column({ type: 'varchar', length: 20, default: 'private' })
  visibility: 'private' | 'published' | 'legacy';

  @Column({ name: 'community_ids', type: 'jsonb', default: () => "'[]'" })
  communityIds: number[];

  @Column({ name: 'repair_types', type: 'jsonb', default: () => "'[]'" })
  repairTypes: string[];

  @Column({ name: 'allow_edit', default: false })
  allowEdit: boolean;

  @Column({ name: 'allow_delete', default: false })
  allowDelete: boolean;

  @Column({ name: 'search_text', type: 'text', default: '' })
  searchText: string;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  /** 乐观锁版本，防止两个人同时编辑时后保存的人覆盖前一个人的内容。 */
  @Column({ type: 'int', default: 1 })
  revision: number;
}
