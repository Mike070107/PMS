import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 亲情车登记（每年一次）。
 *
 * 流程：办公室登记 → 资料上传（办公室本地或业主扫码）→ 办公室审核 → 物业经理审核
 * → 调用停车模块开通车库并续期一年 → 已生效；到期自动停用车库权限。
 *
 * 旧停车库的写入全部复用 parking_operations（add_vehicle / update_garages / renew_vehicle），
 * 本表只记录业务状态和各步关联的停车任务编号，不直接写旧库。
 */
export type FamilyCarStatus =
  | 'upload' // 待上传资料
  | 'office' // 待办公室审核
  | 'manager' // 待物业经理审核
  | 'returned' // 经理退回办公室
  | 'opening' // 开通中（车库授权 + 续期任务执行中）
  | 'active' // 已生效
  | 'expired' // 已过期 / 已停用
  | 'void'; // 已作废

/** new = 旧库没有该车牌，登记时先暂存待审核车辆；existing = 旧库已是本户亲情车（续登 / 补登记） */
export type FamilyCarMode = 'new' | 'existing';

export interface FamilyCarFile {
  objectKey: string;
  fileName: string;
  contentType: string;
  source: 'office' | 'owner';
  uploadedAt: string;
}

export interface FamilyCarLogEntry {
  at: string;
  userId: number | null;
  userName: string;
  action: string;
  note?: string;
}

@Entity('family_cars')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'plate'])
@Index(['tenantId', 'houseId'])
export class FamilyCar extends TenantEntity {
  @Column({ name: 'house_id', type: 'int', nullable: true })
  houseId: number | null;

  /** 弄（198 / 228） */
  @Column({ type: 'varchar', length: 10 })
  lane: string;

  /** 号（楼栋） */
  @Column({ name: 'building_no', type: 'varchar', length: 10 })
  buildingNo: string;

  /** 室 */
  @Column({ name: 'room_no', type: 'varchar', length: 20 })
  roomNo: string;

  @Column({ name: 'owner_name', type: 'varchar', length: 50, default: '' })
  ownerName: string;

  @Column({ name: 'owner_phone', type: 'varchar', length: 30, default: '' })
  ownerPhone: string;

  @Column({ name: 'owner_user_id', type: 'int', nullable: true })
  ownerUserId: number | null;

  @Column({ name: 'car_owner_name', type: 'varchar', length: 50, default: '' })
  carOwnerName: string;

  @Column({ name: 'car_owner_phone', type: 'varchar', length: 30, default: '' })
  carOwnerPhone: string;

  @Column({ type: 'varchar', length: 20, default: '' })
  relation: string;

  @Column({ type: 'varchar', length: 20 })
  plate: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  remark: string;

  /** parking1 = 一期旧库（198 弄），parking2 = 二期旧库（228 弄） */
  @Column({ type: 'varchar', length: 20 })
  database: string;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  garages: string[];

  @Column({ name: 'garage_numbers', type: 'jsonb', default: () => "'{}'::jsonb" })
  garageNumbers: Record<string, string>;

  @Column({ type: 'varchar', length: 20, default: 'new' })
  mode: FamilyCarMode;

  @Column({ type: 'varchar', length: 20, default: 'upload' })
  status: FamilyCarStatus;

  /** 登记时由业主扫码填写车主信息 */
  @Column({ name: 'owner_fill', type: 'boolean', default: false })
  ownerFill: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  files: FamilyCarFile[];

  /** 当前使用的扫码上传会话（parking_proof_uploads.id），审核通过时同时作为开通凭证 */
  @Column({ name: 'proof_upload_id', type: 'int', nullable: true })
  proofUploadId: number | null;

  @Column({ name: 'registration_operation_id', type: 'int', nullable: true })
  registrationOperationId: number | null;

  @Column({ name: 'open_operation_id', type: 'int', nullable: true })
  openOperationId: number | null;

  @Column({ name: 'renew_operation_id', type: 'int', nullable: true })
  renewOperationId: number | null;

  @Column({ name: 'expire_operation_id', type: 'int', nullable: true })
  expireOperationId: number | null;

  @Column({ name: 'civil_operation_id', type: 'int', nullable: true })
  civilOperationId: number | null;

  @Column({ name: 'office_reviewed_by', type: 'int', nullable: true })
  officeReviewedBy: number | null;

  @Column({ name: 'office_reviewed_at', type: 'timestamptz', nullable: true })
  officeReviewedAt: Date | null;

  @Column({ name: 'office_note', type: 'varchar', length: 500, default: '' })
  officeNote: string;

  @Column({ name: 'manager_reviewed_by', type: 'int', nullable: true })
  managerReviewedBy: number | null;

  @Column({ name: 'manager_reviewed_at', type: 'timestamptz', nullable: true })
  managerReviewedAt: Date | null;

  @Column({ name: 'manager_note', type: 'varchar', length: 500, default: '' })
  managerNote: string;

  /** 生效日（经理审核通过、开通当天） */
  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate: string | null;

  /** 到期日（生效日起一年的前一天） */
  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate: string | null;

  @Column({ name: 'reminded_at', type: 'timestamptz', nullable: true })
  remindedAt: Date | null;

  /** 续登 / 补登记的来源记录 */
  @Column({ name: 'previous_id', type: 'int', nullable: true })
  previousId: number | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  log: FamilyCarLogEntry[];
}
