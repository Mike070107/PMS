import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 物业管理处：公司下的管理单元，一个管理处管多个小区。
 * 小区通过 communities.office_id 挂到管理处；角色数据范围可按管理处圈定，
 * 选中管理处即覆盖其下全部小区（含之后新增的）。
 */
@Entity('management_offices')
@Index(['tenantId'])
export class ManagementOffice extends TenantEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark: string | null;

  @Column({ default: true })
  enabled: boolean;
}
