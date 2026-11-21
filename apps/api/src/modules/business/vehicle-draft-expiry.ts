import type { VehicleIntake } from '../../entities/vehicle-intake.entity';

export const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const expiredDraftSql = (alias: string) => `(${alias}.status = 'waiting'
  AND ${alias}.created_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
  AND ${alias}.submitted_at IS NULL AND ${alias}.reviewed_at IS NULL AND ${alias}.office_confirmed_version IS NULL
  AND ${alias}.transaction_id IS NULL AND ${alias}.family_car_id IS NULL AND coalesce(${alias}.files, '[]'::jsonb) = '[]'::jsonb)`;

export function discardDeadline(row: VehicleIntake) {
  return row.status === 'waiting' && !row.submittedAt && !row.reviewedAt && row.officeConfirmedVersion == null &&
    !row.transactionId && !row.familyCarId && !row.files?.length && row.createdAt
    ? new Date(row.createdAt).getTime() + DRAFT_LIFETIME_MS : Infinity;
}
