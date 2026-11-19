import type { EntityManager } from 'typeorm';
import { normalizedPlateSql } from './vehicle-registration-claim';

/** SELECT-only, usable before the claims migration. Potential conflicts are evidence, never an automatic cleanup plan. */
export async function vehicleRegistrationCompatibility(manager: EntityManager, tenantId: number) {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error('An explicit positive tenant id is required');
  const potentialConflicts = await manager.query(`WITH records AS (
    SELECT 'intake' AS kind,i.id,${normalizedPlateSql('i.plate')} AS plate,i.status,
      CASE WHEN i.family_car_id IS NOT NULL THEN 'family:'||i.family_car_id ELSE 'intake:'||i.id END AS canonical
      FROM vehicle_intakes i WHERE i.tenant_id=$1 AND trim(i.plate)<>'' AND (i.status<>'void' OR i.transaction_id IS NOT NULL)
    UNION ALL
    SELECT 'family',f.id,${normalizedPlateSql('f.plate')},f.status,'family:'||f.id
      FROM family_cars f WHERE f.tenant_id=$1 AND trim(f.plate)<>'' AND f.status IN ('upload','office','manager','returned','opening','active')
    ) SELECT plate,jsonb_agg(jsonb_build_object('kind',kind,'id',id,'status',status) ORDER BY kind,id) AS records
      FROM records GROUP BY plate HAVING count(DISTINCT canonical)>1 ORDER BY plate`, [tenantId]);
  const preapprovalWriteLinks = await manager.query(`SELECT id,status,registration_operation_id,open_operation_id,renew_operation_id,civil_operation_id
    FROM family_cars WHERE tenant_id=$1 AND status IN ('upload','office','manager','returned')
    AND (registration_operation_id IS NOT NULL OR open_operation_id IS NOT NULL OR renew_operation_id IS NOT NULL OR civil_operation_id IS NOT NULL)
    ORDER BY id`, [tenantId]);
  const openingWithoutApproval = await manager.query(`SELECT id,status,registration_operation_id,open_operation_id,renew_operation_id,civil_operation_id
    FROM family_cars WHERE tenant_id=$1 AND status='opening'
      AND (office_reviewed_by IS NULL OR office_reviewed_at IS NULL OR manager_reviewed_by IS NULL OR manager_reviewed_at IS NULL)
    ORDER BY id`, [tenantId]);
  return { tenantId, readOnly: true, automaticCleanup: false, potentialConflicts, preapprovalWriteLinks, openingWithoutApproval };
}
