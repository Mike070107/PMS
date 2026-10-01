import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 哪个 PMS 员工可以进入哪个内网应用。 */
@Entity('external_access_grants')
@Index(['appId', 'userId'], { unique: true })
@Index(['tenantId', 'userId'])
export class ExternalAccessGrant extends TenantEntity {
  @Column({ name: 'app_id', type: 'int' })
  appId: number;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;
}
