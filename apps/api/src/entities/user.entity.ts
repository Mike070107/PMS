import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';
import { UserRole, UserStatus } from '../common/enums';

/**
 * 所有用户（业主 / 维修工 / 物业各角色 / 平台运营）。
 * - 平台 superadmin 的 tenantId 为 null
 * - 业主有 houseId；员工 houseId 为 null
 */
@Entity('users')
@Index(['tenantId'])
@Index(['wxUnionid'])
@Index(['phone'])
export class User extends BaseEntity {
  // 平台 superadmin 时为 null
  @Column({ name: 'tenant_id', type: 'int', nullable: true })
  tenantId: number | null;

  @Column({ name: 'wx_openid', type: 'varchar', length: 64, nullable: true })
  wxOpenid: string | null;

  @Column({ name: 'wx_unionid', type: 'varchar', length: 64, nullable: true })
  wxUnionid: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  name: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  phone: string | null;

  @Column({ name: 'wx_nickname', type: 'varchar', length: 120, nullable: true })
  wxNickname: string | null;

  // 后台账号（物业/平台角色）登录用；业主无密码
  @Column({ name: 'password_hash', type: 'varchar', length: 120, nullable: true })
  passwordHash: string | null;

  @Column({ name: 'login_account', type: 'varchar', length: 60, nullable: true })
  loginAccount: string | null;

  @Column({ type: 'varchar', length: 20 })
  role: UserRole;

  // 业主关联房号
  @Column({ name: 'house_id', type: 'int', nullable: true })
  houseId: number | null;

  @Column({ type: 'varchar', length: 20, default: UserStatus.ACTIVE })
  status: UserStatus;
}
