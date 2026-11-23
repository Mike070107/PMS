import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { BusinessTransaction } from '../../entities';

import type { ParkingQueryRow } from '../../entities/parking-query.entity';

export interface PropertySpaceRef {
  id: number; communityId: number; garage: 'main' | 'civil'; spaceNo: string;
}

export function mainSpaceFromQuery(rows: ParkingQueryRow[], plate: string, recordId: string) {
  const matches = rows.filter(row => row.database.toLowerCase() === 'parking2').map(row =>
    Object.fromEntries(Object.entries(row.fields).map(([k,v]) => [k.toLowerCase(), String(v ?? '').trim()])))
    .filter(f => f.p_plate?.toUpperCase() === plate && f.p_id === recordId);
  if (matches.length !== 1) throw new BadRequestException('大车库车辆记录不唯一或已变化，请重新查询车牌');
  const f = matches[0];
  if (![15,17,19,21].some(n => f.p_effective?.[n-1] === '1')) return null;
  const no = f.p_spaces || f.p_space || f.parkno || f.spaceno || f.berth;
  return no || '';
}

export async function updatePropertySpaces(manager: EntityManager, txn: BusinessTransaction, refs: PropertySpaceRef[]) {
  const plate = (txn.snapshot?.vehicle as {plateNo?:string})?.plateNo;
  const contact = txn.snapshot.propertyContact as {houseId:number|null;shopBuildingId?:number;houseNo:string;ownerName:string|null;ownerPhone:string|null;contactPhone:string|null};
  const shopBuildingId = (txn.snapshot.intake as { shopBuildingId?: number } | undefined)?.shopBuildingId;
  if (!contact?.houseNo || contact.houseId !== txn.houseId
      || (txn.houseId == null ? !shopBuildingId || contact.shopBuildingId !== shopBuildingId : contact.shopBuildingId != null))
    throw new BadRequestException('车位绑定房产与本次流水不一致');
  if (!plate || !txn.endDate) throw new BadRequestException('产权车流水缺少车牌或到期日');
  for (const ref of [...refs].sort((a,b) => a.id - b.id)) {
    // 行锁序和事务保护多库更新；共用车位分别保存每辆车的资料。
    const updated = await manager.query(
      `WITH changed AS (
        UPDATE parking_spaces
        SET plate = coalesce(nullif(trim(plate),''),$1),
            house_no = CASE WHEN coalesce(nullif(trim(plate),''),$1) = $1 AND coalesce((vehicle_bindings->$1->>'transactionId')::int,0) <= $9 THEN $10 ELSE house_no END,
            owner_name = CASE WHEN coalesce(nullif(trim(plate),''),$1) = $1 AND coalesce((vehicle_bindings->$1->>'transactionId')::int,0) <= $9 THEN $11 ELSE owner_name END,
            owner_tel = CASE WHEN coalesce(nullif(trim(plate),''),$1) = $1 AND coalesce((vehicle_bindings->$1->>'transactionId')::int,0) <= $9 THEN $12 ELSE owner_tel END,
            vehicle_bindings = jsonb_set(vehicle_bindings, ARRAY[$1::text],
              (CASE WHEN coalesce((vehicle_bindings->$1->>'transactionId')::int,0) > $9 THEN vehicle_bindings->$1
                    ELSE $13::jsonb || jsonb_build_object('transactionId',$9::int) END)
              || jsonb_build_object('endDate',greatest((vehicle_bindings->$1->>'endDate')::date,$2::date))),
            end_date = greatest(end_date, $2::date), updated_by = $3, updated_at = now()
        WHERE tenant_id = $4 AND id = $5 AND community_id = $6 AND garage = $7 AND space_no = $8
        RETURNING id
      ) SELECT id FROM changed`,
      [plate, txn.endDate, txn.createdBy, txn.tenantId, ref.id, ref.communityId, ref.garage, ref.spaceNo,txn.id,contact.houseNo,contact.ownerName,contact.ownerPhone,JSON.stringify(contact)]);
    if (updated.length !== 1) throw new BadRequestException('车位档案已变化，需核对原流水对应的车位');
  }
}
