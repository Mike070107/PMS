import type { EntityManager } from 'typeorm';
import type { BusinessTransaction, ParkingOperation } from '../../entities';
import { plateKey } from '../access-card-issuance/parking-vehicle-preservation';

export interface ParkingValidityReversal {
  originalId: number;
  plate: string;
  appliedEndDate: string;
  restoreEndDate: string;
  legacyAuditId?: string;
  expectedStartDate?: string;
}

export const LATER_PARKING_PAYMENT = '车牌已有后续有效停车收款，请人工核对有效期';

export async function hasLaterParkingPayment(manager: EntityManager, tenantId: number, originalId: number, plate: string) {
  const rows = await manager.query(`SELECT 1 FROM business_transactions t
    WHERE t.tenant_id=$1 AND t.id>$2 AND t.service_type='parking_monthly' AND t.status='paid'
      AND NOT (t.snapshot ? 'reversedByTxnNo')
      AND UPPER(regexp_replace(COALESCE(NULLIF(t.snapshot#>>'{parking,plate}',''), t.snapshot#>>'{vehicle,plateNo}'),
        '[[:space:]·.．・-]', '', 'g'))=$3 LIMIT 1`, [tenantId, originalId, plate]);
  return rows.length > 0;
}

export function parkingDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/** A quote is insufficient: recover the dates from the verified write receipt. */
export function planVerifiedParkingReversal(original: BusinessTransaction, operation: ParkingOperation, plate: string): ParkingValidityReversal | 'unchanged' | null {
  const result = operation.result;
  if (operation.tenantId !== original.tenantId || operation.kind !== 'renew_vehicle' || operation.status !== 'completed' ||
      !operation.sourceRecordId || operation.payload.businessTxnNo !== original.txnNo || plateKey(operation.payload.plate) !== plate ||
      result?.verified !== true || plateKey(result.plate) !== plate ||
      String(operation.database === 'deliyun' ? result.vehicleId : result.issueId) !== operation.sourceRecordId) return null;
  const appliedEndDate = parkingDate(result.endDate);
  const restoreEndDate = parkingDate(result.previousEndDate);
  if (!appliedEndDate || !restoreEndDate || appliedEndDate !== operation.payload.endDate) return null;
  if (appliedEndDate === restoreEndDate) return 'unchanged';
  const plan = { originalId: original.id, plate, appliedEndDate, restoreEndDate };
  if (operation.database === 'deliyun') return plan;
  if (!['parking1', 'parking2'].includes(operation.database)) return null;
  const startDate = parkingDate(result.startDate);
  const auditId = String(result.legacyAuditId ?? '');
  if (!startDate || startDate !== parkingDate(result.previousStartDate) || startDate > restoreEndDate ||
      result.legacyAuditVerified !== true || !/^\d+$/.test(auditId)) return null;
  return { ...plan, legacyAuditId: auditId, expectedStartDate: startDate };
}
