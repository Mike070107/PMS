import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';
import { OwnerSource, UserRole, UserStatus } from '../common/enums';

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

  /**
   * 这条档案是怎么来的（只对业主有意义，员工留空）。
   * 报修时从一句话里抽出来的联系人会自动落一条 REPAIR_INTAKE 档案，
   * 后台得能把它和业主自己认证过的区分开。存量数据为 null。
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  source: OwnerSource | null;

  /**
   * 手机号之外的联系方式（固话、第二个手机、「找儿子」这类备注）。
   * 老系统的「联系方式」是自由文本，只有能认出来的 11 位手机号才进 phone，
   * 其余原样留在这里 —— 打电话前至少还有个号码可以试。
   */
  @Column({ name: 'contact_note', type: 'varchar', length: 255, nullable: true })
  contactNote: string | null;

  /**
   * 导入来源标识（如 wjwy:zh:1234 = 吴泾物业老库 业主表.ZH_ID），
   * 同一份数据重跑导入时按它认出已存在的档案，不会建重。手工建的档案为 null。
   */
  @Column({ name: 'legacy_ref', type: 'varchar', length: 60, nullable: true })
  legacyRef: string | null;
}
