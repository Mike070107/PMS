import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ParkingOperation } from '../../entities/parking-operation.entity';
import { ParkingPlateTag } from '../../entities/parking-plate-tag.entity';

/** Source tag stays effective during split-plate partial success; temporary target tag is
 * removed only when every server-observed source has a verified successful task. */
export async function preservePlateBilling(task: ParkingOperation, tags: Repository<ParkingPlateTag>, operations: Repository<ParkingOperation>) {
  if (!Object.prototype.hasOwnProperty.call(task.expected, 'billingTag')) throw new BadRequestException('旧换牌任务没有服务端类别快照，不能确认成功');
  const oldPlate = String(task.payload.plate), newPlate = String(task.payload.newPlate);
  const locked = await tags.createQueryBuilder('tag').where('tag.tenant_id = :tenantId AND tag.plate IN (:...plates)', {
    tenantId: task.tenantId, plates: [oldPlate, newPlate],
  }).orderBy('tag.id', 'ASC').setLock('pessimistic_write').getMany();
  let oldTag = locked.find(tag => tag.plate === oldPlate), newTag = locked.find(tag => tag.plate === newPlate);
  const original = task.expected.billingTag as { id: number; vehicleClass: string; houseId: number | null } | null;
  if (!original) {
    if (oldTag || newTag) throw new BadRequestException('换牌期间出现新的 PMS 类别，禁止覆盖，请核对原任务');
    return;
  }
  // Query after obtaining the source-tag lock, so concurrent database reports observe
  // the first committed task's provisional-tag provenance, not a stale client snapshot.
  const siblings = await operations.createQueryBuilder('task')
    .where('task.tenant_id = :tenantId AND task.kind = :kind AND task.created_by = :userId', {
      tenantId: task.tenantId, kind: 'change_plate', userId: task.createdBy,
    }).andWhere("task.payload->>'batchId' = :batchId AND task.payload->>'plate' = :plate AND task.payload->>'newPlate' = :newPlate", {
      batchId: String(task.payload.batchId), plate: oldPlate, newPlate,
    }).getMany();
  const targets = task.expected.batchTargets as Array<{ database: string; sourceRecordId: string }>;
  if (!Array.isArray(targets) || !targets.length) throw new BadRequestException('换牌批次缺少真实双库来源清单');
  const complete = targets.every(target => siblings.some(item => item.database === target.database && item.sourceRecordId === target.sourceRecordId &&
    (item.id === task.id || (item.status === 'completed' && item.result?.verified === true && item.result?.preserved === true))));
  const matches = (tag: ParkingPlateTag) => tag.vehicleClass === original.vehicleClass && tag.houseId === original.houseId;
  const provisionalId = task.expected.billingTargetTagId ?? siblings.find(item => item.expected.billingTargetTagId)?.expected.billingTargetTagId;
  if (oldTag && (oldTag.id !== original.id || !matches(oldTag))) throw new BadRequestException('原 PMS 类别已改变，禁止覆盖');
  if (newTag && (!matches(newTag) || (newTag.id !== original.id && newTag.id !== provisionalId))) throw new BadRequestException('新车牌 PMS 类别冲突，禁止覆盖');
  if (!oldTag) {
    if (!complete || !newTag || newTag.id !== original.id) throw new BadRequestException('原 PMS 类别关联异常，请核对原批次');
    return;
  }
  if (complete) {
    if (newTag) await tags.remove(newTag);
    oldTag.plate = newPlate;
    oldTag.updatedBy = task.createdBy;
    await tags.save(oldTag);
    task.expected.billingFinalized = true;
  } else {
    if (!newTag) newTag = await tags.save(tags.create({ tenantId: task.tenantId, plate: newPlate,
      vehicleClass: original.vehicleClass, houseId: original.houseId, createdBy: task.createdBy, updatedBy: task.createdBy }));
    task.expected.billingTargetTagId = newTag.id;
    task.expected.billingFinalized = false;
  }
}
