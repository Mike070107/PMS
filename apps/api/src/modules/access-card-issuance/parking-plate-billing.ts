import { BadRequestException } from '@nestjs/common';
import { EntityManager, In, Repository } from 'typeorm';
import { ParkingOperation } from '../../entities/parking-operation.entity';
import { ParkingPlateTag } from '../../entities/parking-plate-tag.entity';
import { ParkingVehicle } from '../../entities/parking-vehicle.entity';
import { ParkingSpace } from '../../entities/parking-space.entity';
import { Community } from '../../entities/community.entity';
import { findParkingTarget } from '../business/parking-targets';
import { plateKey } from './parking-vehicle-preservation';

async function parkingSpaceCommunities(manager: EntityManager, tenantId: number, garage: 'main' | 'civil') {
  const target = findParkingTarget(garage === 'main' ? 'local:phase2_main_garage' : 'deliyun:枫桦景苑')!;
  const communities = await manager.getRepository(Community).findBy({ tenantId, name: In(target.communities) });
  return communities.map(community => community.id);
}

async function matchingSpaces(manager: EntityManager, tenantId: number, garage: 'main' | 'civil', plates: string[]) {
  const communities = await parkingSpaceCommunities(manager, tenantId, garage);
  if (!communities.length) return [];
  return manager.getRepository(ParkingSpace).createQueryBuilder('space').addSelect('space.vehicleBindings')
    .where('space.tenant_id = :tenantId AND space.garage = :garage AND space.community_id IN (:...communities)',
      { tenantId, garage, communities })
    .andWhere('(space.plate IN (:...plates) OR jsonb_exists_any(space.vehicle_bindings, ARRAY[:...plates]))', { plates })
    .orderBy('space.id', 'ASC').setLock('pessimistic_write').getMany();
}

function hasPlate(space: ParkingSpace, plate: string) {
  return plateKey(space.plate) === plate || Object.hasOwn(space.vehicleBindings ?? {}, plate);
}

export function civilCardNumber(value: string) {
  const number = value.trim();
  return /^\d+$/.test(number) ? 'MF' + number : number;
}
export async function originalCivilCard(manager: EntityManager, tenantId: number, plate: string) {
  const rows = await matchingSpaces(manager, tenantId, 'civil', [plate]);
  if (rows.length > 1) throw new BadRequestException('原车绑定多个人防车位，请先核对');
  return rows.length ? civilCardNumber(rows[0].spaceNo) : undefined;
}

export async function changeLinkedSpacePlate(manager: EntityManager, input: {
  tenantId: number; operatorId: number | null; garage: 'main' | 'civil'; oldPlate: string; newPlate: string; spaceNumber?: string;
}) {
  const { tenantId, operatorId, garage, oldPlate, newPlate, spaceNumber } = input;
  const candidates = await matchingSpaces(manager, tenantId, garage, [oldPlate, newPlate]);
  const oldSpaces = candidates.filter(space => hasPlate(space, oldPlate));
  const newSpaces = candidates.filter(space => hasPlate(space, newPlate));
  const space = oldSpaces.length === 1 ? oldSpaces[0] : null;
  if (space && (!spaceNumber || space.spaceNo === spaceNumber || (garage === 'civil' && civilCardNumber(space.spaceNo) === civilCardNumber(spaceNumber))) && !newSpaces.length) {
    const { [oldPlate]: binding, ...other } = space.vehicleBindings ?? {};
    if (binding) other[newPlate] = binding;
    await manager.getRepository(ParkingSpace).update({ id: space.id, tenantId },
      { ...(plateKey(space.plate) === oldPlate ? { plate: newPlate } : {}), vehicleBindings: other, updatedBy: operatorId });
    return { spaceNo: space.spaceNo };
  }
  return { needsReview: !!oldSpaces.length || (!newSpaces.length && !!spaceNumber) };
}

export async function syncLinkedSpaceDetails(manager: EntityManager, input: {
  tenantId: number; operatorId: number | null; garage: 'main' | 'civil'; plate: string;
  houseId?: number; houseNo?: string; ownerName?: string; ownerPhone?: string; endDate?: string;
}) {
  const { tenantId, garage, plate, houseId, houseNo, ownerName, ownerPhone, endDate } = input;
  if ([houseId, houseNo, ownerName, ownerPhone, endDate].every(value => value == null)) return {};
  const candidates = await matchingSpaces(manager, tenantId, garage, [plate]);
  if (candidates.length !== 1) return { needsReview: candidates.length > 1 };
  const space = candidates[0];
  const currentBinding = space.vehicleBindings?.[plate];
  const primary = plateKey(space.plate) === plate;
  const updatedBinding = currentBinding && {
    ...currentBinding,
    ...(houseId != null ? { houseId } : {}),
    ...(houseNo != null ? { houseNo } : {}),
    ...(ownerName != null ? { ownerName } : {}),
    ...(ownerPhone != null ? { ownerPhone } : {}),
    ...(endDate != null ? { endDate } : {}),
  };
  if (!primary && !updatedBinding) return { needsReview: true };
  await manager.getRepository(ParkingSpace).update({ id: space.id, tenantId }, {
    ...(primary && houseNo != null ? { houseNo } : {}),
    ...(primary && ownerName != null ? { ownerName } : {}),
    ...(primary && ownerPhone != null ? { ownerTel: ownerPhone } : {}),
    ...(primary && endDate != null ? { endDate } : {}),
    ...(updatedBinding ? { vehicleBindings: { ...space.vehicleBindings, [plate]: updatedBinding } } : {}),
    updatedBy: input.operatorId,
  });
  return { spaceNo: space.spaceNo };
}

export async function removeLinkedSpacePlate(manager: EntityManager, tenantId: number, plate: string, operatorId: number | null) {
  const candidates = await matchingSpaces(manager, tenantId, 'main', [plate]);
  if (candidates.length !== 1) return { needsReview: candidates.length > 1 };
  const space = candidates[0];
  const { [plate]: removed, ...remaining } = space.vehicleBindings ?? {};
  const primary = plateKey(space.plate) === plate;
  if (!primary && !removed) return { needsReview: true };
  const nextPlate = Object.keys(remaining).sort()[0];
  const next = nextPlate ? remaining[nextPlate] : null;
  await manager.getRepository(ParkingSpace).update({ id: space.id, tenantId }, {
    vehicleBindings: remaining, updatedBy: operatorId,
    ...(primary ? { plate: nextPlate ?? null, endDate: next?.endDate ?? null } : {}),
    ...(primary && next ? { houseNo: next.houseNo, ownerName: next.ownerName, ownerTel: next.ownerPhone } : {}),
  });
  return { spaceNo: space.spaceNo };
}

export async function moveLinkedSpace(manager: EntityManager, tenantId: number, garage: 'main' | 'civil', plate: string, spaceNo: string, operatorId: number | null) {
  const communities = await parkingSpaceCommunities(manager, tenantId, garage);
  if (!communities.length) return { needsReview: true };
  const repo = manager.getRepository(ParkingSpace);
  // Lock the source and destination in the same order for concurrent moves.
  const spaces = await repo.createQueryBuilder('space').addSelect('space.vehicleBindings')
    .where('space.tenant_id = :tenantId AND space.garage = :garage AND space.community_id IN (:...communities)',
      { tenantId, garage, communities })
    .andWhere('(space.space_no = :spaceNo OR space.plate = :plate OR jsonb_exists(space.vehicle_bindings, :plate))', { spaceNo, plate })
    .orderBy('space.id', 'ASC').setLock('pessimistic_write').getMany();
  const origins = spaces.filter(space => hasPlate(space, plate));
  const target = spaces.find(space => space.spaceNo === spaceNo);
  if (origins.length !== 1 || !target) return { needsReview: true };
  const source = origins[0];
  if (source.id === target.id) return { spaceNo };
  if (target.plate?.trim() || Object.keys(target.vehicleBindings ?? {}).length) return { needsReview: true };
  const { [plate]: binding, ...remaining } = source.vehicleBindings ?? {};
  const primary = plateKey(source.plate) === plate;
  if (!primary && !binding) return { needsReview: true };
  const houseNo = binding?.houseNo ?? source.houseNo;
  if (target.houseNo?.trim() && target.houseNo.trim() !== houseNo?.trim()) return { needsReview: true };
  const nextPlate = Object.keys(remaining).sort()[0];
  const next = nextPlate ? remaining[nextPlate] : null;
  await repo.update({ id: source.id, tenantId }, {
    vehicleBindings: remaining, updatedBy: operatorId,
    ...(primary ? { plate: nextPlate ?? null, endDate: next?.endDate ?? null } : {}),
    ...(primary && next ? { houseNo: next.houseNo, ownerName: next.ownerName, ownerTel: next.ownerPhone } : {}),
  });
  await repo.update({ id: target.id, tenantId }, {
    plate, vehicleBindings: binding ? { [plate]: binding } : {},
    endDate: binding?.endDate ?? source.endDate,
    houseNo,
    ownerName: binding?.ownerName ?? source.ownerName,
    ownerTel: binding?.ownerPhone ?? source.ownerTel,
    updatedBy: operatorId,
  });
  return { spaceNo };
}

/** A partial batch cannot retire a plate that still exists in one of the source databases. */
export function supersededParkingPlates(tasks: ParkingOperation[]): string[] {
  const batches = new Map<string, ParkingOperation[]>();
  const plates = new Set<string>();
  for (const task of tasks) {
    const { batchId, plate, newPlate } = task.payload;
    if (task.kind === 'delete_vehicle') {
      if (task.status === 'completed' && typeof plate === 'string' && task.result?.verified === true && task.result.remaining === 0)
        plates.add(plate);
      continue;
    }
    if (!batchId || typeof plate !== 'string' || typeof newPlate !== 'string' || !newPlate || plate === newPlate ||
        task.status !== 'completed' || task.result?.verified !== true || task.result?.preserved !== true ||
        task.result?.plate !== newPlate || String(task.result?.issueId) !== task.sourceRecordId) continue;
    const key = JSON.stringify([task.createdBy, batchId, plate, newPlate]);
    const batch = batches.get(key) ?? [];
    batch.push(task);
    batches.set(key, batch);
  }
  for (const batch of batches.values()) {
    const targets = batch[0].expected.batchTargets as Array<{ database: string; sourceRecordId: string }> | undefined;
    if (Array.isArray(targets) && targets.length && targets.every(target => target
      && batch.some(task => task.database === target.database && task.sourceRecordId === target.sourceRecordId))) {
      plates.add(String(batch[0].payload.plate));
    }
  }
  return [...plates];
}

export async function syncPmsPlateBindings(task: ParkingOperation, manager: EntityManager, operations: Repository<ParkingOperation>) {
  const oldPlate = String(task.payload.plate);
  const newPlate = String(task.payload.newPlate);
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`parking-plate-bindings:${task.tenantId}`, oldPlate]);
  const siblings = await operations.createQueryBuilder('task')
    .where("task.tenant_id = :tenantId AND task.kind = 'change_plate' AND task.status = 'completed' AND task.created_by = :userId",
      { tenantId: task.tenantId, userId: task.createdBy })
    .andWhere("task.payload->>'batchId' = :batch AND task.payload->>'plate' = :oldPlate AND task.payload->>'newPlate' = :newPlate",
      { batch: String(task.payload.batchId), oldPlate, newPlate }).getMany();
  const batch = [...siblings.filter(item => item.id !== task.id), task];
  if (!supersededParkingPlates(batch).includes(oldPlate)) return { status: 'waiting' };
  const warnings: string[] = [];
  const vehicles = manager.getRepository(ParkingVehicle);
  const bindings = await vehicles.find({ where: { tenantId: task.tenantId, plateNo: In([oldPlate, newPlate]) }, order: { id: 'ASC' } });
  const current = bindings.find(row => row.plateNo === oldPlate && row.status === 'active');
  if (current && bindings.some(row => row.plateNo === newPlate)) warnings.push('新车牌已有 PMS 车辆档案，请核对归属');
  else if (current) await vehicles.update({ id: current.id, tenantId: task.tenantId, plateNo: oldPlate },
    { plateNo: newPlate, updatedBy: task.createdBy });

  const phase2 = batch.find(item => item.database === 'parking2');
  const snapshot = phase2?.result?.after as Record<string, unknown> | undefined;
  const effective = String(snapshot?.P_Effective ?? '');
  let mainSpace: string | null = null;
  if ([15, 17, 19, 21].some(channel => effective[channel - 1] === '1')) {
    const result = await changeLinkedSpacePlate(manager, {
      tenantId: task.tenantId, operatorId: task.createdBy, garage: 'main', oldPlate, newPlate,
      spaceNumber: String(snapshot?.P_Spaces ?? '').trim(),
    });
    mainSpace = result.spaceNo ?? null;
    if (result.needsReview) warnings.push('大车库车位档案未能唯一核对，请检查车位号或新旧车牌绑定');
  }
  return { status: warnings.length ? 'review' : 'synced', mainSpace, warnings };
}

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

/** Move the current family registration only after all participating systems verified the change. */
export async function syncFamilyPlate(manager: EntityManager, task: ParkingOperation) {
  const { plate, newPlate } = task.payload;
  const args=[task.tenantId,plate,newPlate];
  for(const key of [String(plate),String(newPlate)].sort())
    await manager.query("SELECT pg_advisory_xact_lock(hashtext('vehicle-registration:' || $1::text),hashtext($2))",[task.tenantId,key]);
  const families=await manager.query("SELECT id,status FROM family_cars WHERE tenant_id=$1 AND plate=$2 AND status NOT IN ('expired','void') FOR UPDATE",args.slice(0,2));
  if(!families.length) return;
  if(families.length!==1 || families[0].status!=='active') throw new Error('亲情车有未结束的办理，请核对原申请');
  const familyId=families[0].id;
  const collision=await manager.query(`SELECT 1 FROM family_cars WHERE tenant_id=$1 AND plate=$3 AND status NOT IN ('expired','void')
    UNION ALL SELECT 1 FROM vehicle_registration_claims WHERE tenant_id=$1 AND (plate=$3 OR (plate=$2 AND family_car_id IS DISTINCT FROM $4))
    UNION ALL SELECT 1 FROM vehicle_intakes WHERE tenant_id=$1 AND plate=$3 AND status<>'void' LIMIT 1`,[...args,familyId]);
  if(collision.length) throw new Error('新旧牌关联其他在办登记，请核对归属');
  const audit=JSON.stringify([{at:new Date().toISOString(),userId:task.updatedBy,userName:'PMS',action:'经理批准变更车牌',note:plate+' → '+newPlate+' · 申请 #'+task.id}]);
  await manager.query('UPDATE family_cars SET plate=$3,log=log || $5::jsonb,updated_at=now(),data_version=data_version+1 WHERE tenant_id=$1 AND plate=$2 AND id=$4',[...args,familyId,audit]);
  await manager.query("UPDATE vehicle_intakes SET plate=$3,log=log || $5::jsonb,updated_at=now() WHERE tenant_id=$1 AND plate=$2 AND family_car_id=$4 AND status='approved'",[...args,familyId,audit]);
  await manager.query('UPDATE vehicle_registration_claims SET plate=$3 WHERE tenant_id=$1 AND plate=$2 AND family_car_id=$4',[...args,familyId]);
}
