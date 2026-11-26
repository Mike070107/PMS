import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export const VEHICLE_CLAIM_CONFLICT = '该车牌已有不兼容的登记，请联系有权限的管理人员核对';
export const REVERSED_INTAKE_RELEASED = '已红冲未入库，解除登记占用';
export const normalizedPlateSql = (column: string) => `regexp_replace(upper(${column}), '[[:space:]·.．・]', '', 'g')`;
export async function lockVehicleRegistration(manager: EntityManager, tenantId: number, plate: string) {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext('vehicle-registration:' || $1::text), hashtext($2::text))`, [tenantId, plate]);
}

export const CANCELLED_PLATE_RELEASED = '停车库注销已核实，释放车牌占用';

/** Lazily reconcile pre-existing receipts under the same lock as new registrations. */
export async function releaseConfirmedParkingIntakes(manager: EntityManager, tenantId: number, plate: string) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error('Vehicle ownership release requires the caller transaction');
  await lockVehicleRegistration(manager, tenantId, plate);
  const released = await manager.query(`WITH released AS (
    UPDATE vehicle_intakes i SET log = i.log || jsonb_build_array(jsonb_build_object(
      'at', now(), 'action', $3::text, 'userId', NULL, 'userName', '系统', 'note', '原登记及收款流水保留'))
    FROM business_transactions t
    WHERE i.tenant_id=$1 AND ${normalizedPlateSql('i.plate')}=$2
      AND i.kind='paid' AND i.status='approved' AND i.family_car_id IS NULL
      AND t.tenant_id=i.tenant_id AND t.id=i.transaction_id
      AND t.target_type='vehicle_intake' AND t.target_id=i.id
      AND NOT i.log @> jsonb_build_array(jsonb_build_object('action',$3::text))
      AND jsonb_array_length(i.garages)>0
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(i.garages) AS g(target)
        WHERE NOT EXISTS (SELECT 1 FROM parking_operations a JOIN parking_operations d
          ON d.tenant_id=a.tenant_id AND d.database=a.database
          WHERE a.tenant_id=i.tenant_id AND a.database=CASE g.target
            WHEN 'local:phase1_parking' THEN 'parking1' WHEN 'local:phase2_parking' THEN 'parking2'
            WHEN 'local:phase2_main_garage' THEN 'parking2' END
          AND a.kind='add_vehicle' AND a.status='completed'
          AND a.idempotency_key='biz:' || t.txn_no || ':register:' || a.database
          AND d.kind='delete_vehicle' AND d.status='completed'
          AND d.source_record_id=a.result->>'issueId'
          AND ${normalizedPlateSql("d.payload->>'plate'")}=$2
          AND d.result @> '{"verified":true,"remaining":0}'::jsonb
          AND d.requested_at >= a.completed_at AND d.completed_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM parking_operations newer
            WHERE newer.tenant_id=d.tenant_id AND newer.database=d.database AND newer.id<>d.id
              AND newer.kind IN ('add_vehicle','change_plate')
              AND newer.status NOT IN ('failed','cancelled')
              AND (newer.completed_at >= d.completed_at OR newer.requested_at >= d.requested_at OR newer.status IN ('pending','running'))
              AND ($2=${normalizedPlateSql("newer.payload->>'plate'")} OR $2=${normalizedPlateSql("newer.payload->>'newPlate'")}))))
    RETURNING i.id)
    SELECT id FROM released`, [tenantId, plate, CANCELLED_PLATE_RELEASED]);
  for (const row of released) await releaseVehicleRegistration(manager, tenantId, 'intake', row.id);
}

/** All callers must pass their transaction manager, including intake -> family handoff. */
export async function claimVehicleRegistration(manager: EntityManager, owner: {
  tenantId: number; plate: string; intakeId?: number | null; familyCarId?: number | null;
}) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error('Vehicle ownership requires the caller transaction');
  const plate = String(owner.plate || '').replace(/[\s·.．・]/g, '').toUpperCase();
  if (!plate || !owner.tenantId || (!owner.intakeId && !owner.familyCarId)) throw new BadRequestException('车辆办理占用信息不完整');
  const args = [owner.tenantId, plate, owner.intakeId ?? null, owner.familyCarId ?? null];
  // Two-key advisory locks serialize only this tenant/normalized plate, across connections and processes.
  await lockVehicleRegistration(manager, owner.tenantId, plate);
  const claims = await manager.query(`SELECT intake_id,family_car_id FROM vehicle_registration_claims
    WHERE tenant_id=$1 AND plate=$2 FOR UPDATE`, args.slice(0, 2));
  const existing = claims[0];
  if (existing && !(owner.intakeId && existing.intake_id === owner.intakeId) && !(owner.familyCarId && existing.family_car_id === owner.familyCarId)) {
    const predecessor = await manager.query(`SELECT previous.id FROM family_cars successor
      JOIN family_cars previous ON previous.id=successor.previous_id AND previous.tenant_id=successor.tenant_id
      WHERE successor.id=$1 AND successor.tenant_id=$2 AND previous.id=$3
        AND previous.house_id=successor.house_id AND previous.status IN ('active','expired')`, [owner.familyCarId ?? null, owner.tenantId, existing.family_car_id]);
    if (!predecessor.length) throw new BadRequestException(VEHICLE_CLAIM_CONFLICT);
  }
  // Do not backfill claims by choosing a winner. Every acquisition checks untouched historical rows too.
  const intakes = await manager.query(`SELECT i.id FROM vehicle_intakes i
    LEFT JOIN family_cars linked ON linked.id=i.family_car_id AND linked.tenant_id=i.tenant_id
    WHERE i.tenant_id=$1 AND ${normalizedPlateSql('i.plate')}=$2 AND (i.status <> 'void' OR
      (i.transaction_id IS NOT NULL AND NOT i.log @> '${JSON.stringify([{ action: REVERSED_INTAKE_RELEASED }])}'::jsonb))
      AND NOT i.log @> '${JSON.stringify([{ action: CANCELLED_PLATE_RELEASED }])}'::jsonb
      AND (i.family_car_id IS NULL OR linked.id IS NULL OR linked.status NOT IN ('void','expired'))
      AND i.id IS DISTINCT FROM $3::integer AND ($4::integer IS NULL OR i.family_car_id IS DISTINCT FROM $4::integer)
      AND NOT (linked.status='active' AND EXISTS (SELECT 1 FROM family_cars successor
        WHERE successor.id=$4::integer AND successor.tenant_id=i.tenant_id
          AND successor.previous_id=linked.id AND successor.house_id=i.house_id))
    LIMIT 1`, args);
  const families = await manager.query(`SELECT f.id FROM family_cars f
    WHERE f.tenant_id=$1 AND ${normalizedPlateSql('f.plate')}=$2
      AND f.status IN ('upload','office','manager','returned','opening','active')
      AND f.id IS DISTINCT FROM $4::integer
      AND NOT EXISTS (SELECT 1 FROM vehicle_intakes mine WHERE mine.id=$3::integer
        AND mine.tenant_id=$1 AND mine.family_car_id=f.id)
      AND NOT (f.status='active' AND EXISTS (SELECT 1 FROM family_cars successor
        WHERE successor.id=$4::integer AND successor.tenant_id=f.tenant_id
          AND successor.previous_id=f.id AND successor.house_id=f.house_id))
    LIMIT 1`, args);
  if (intakes.length || families.length) throw new BadRequestException(VEHICLE_CLAIM_CONFLICT);
  await manager.query(`INSERT INTO vehicle_registration_claims (tenant_id,plate,intake_id,family_car_id)
    VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,plate) DO UPDATE SET
    intake_id=COALESCE(EXCLUDED.intake_id, CASE WHEN vehicle_registration_claims.family_car_id=EXCLUDED.family_car_id THEN vehicle_registration_claims.intake_id END),
    family_car_id=EXCLUDED.family_car_id`, args);
  // A permitted original-record correction atomically relinquishes its former plate.
  await manager.query(`DELETE FROM vehicle_registration_claims WHERE tenant_id=$1 AND plate<>$2
    AND (($3::integer IS NOT NULL AND intake_id=$3) OR ($4::integer IS NOT NULL AND family_car_id=$4))`, args);
}

export async function releaseVehicleRegistration(manager: EntityManager, tenantId: number, kind: 'intake' | 'family', id: number) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error('Vehicle ownership release requires the caller transaction');
  await manager.query(`DELETE FROM vehicle_registration_claims WHERE tenant_id=$1 AND ${kind === 'intake' ? 'intake_id' : 'family_car_id'}=$2`, [tenantId, id]);
}
