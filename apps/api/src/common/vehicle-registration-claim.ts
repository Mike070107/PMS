import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export const VEHICLE_CLAIM_CONFLICT = '该车牌已有不兼容的登记，请联系有权限的管理人员核对';
export const normalizedPlateSql = (column: string) => `regexp_replace(upper(${column}), '[[:space:]·.．・]', '', 'g')`;

/** All callers must pass their transaction manager, including intake -> family handoff. */
export async function claimVehicleRegistration(manager: EntityManager, owner: {
  tenantId: number; plate: string; intakeId?: number | null; familyCarId?: number | null;
}) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error('Vehicle ownership requires the caller transaction');
  const plate = String(owner.plate || '').replace(/[\s·.．・]/g, '').toUpperCase();
  if (!plate || !owner.tenantId || (!owner.intakeId && !owner.familyCarId)) throw new BadRequestException('车辆办理占用信息不完整');
  const args = [owner.tenantId, plate, owner.intakeId ?? null, owner.familyCarId ?? null];
  // Two-key advisory locks serialize only this tenant/normalized plate, across connections and processes.
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext('vehicle-registration:' || $1::text), hashtext($2::text))`, args.slice(0, 2));
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
    WHERE i.tenant_id=$1 AND ${normalizedPlateSql('i.plate')}=$2 AND (i.status <> 'void' OR i.transaction_id IS NOT NULL)
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
