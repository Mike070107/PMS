export type PermissionCheckStatus = 'idle' | 'pending' | 'running' | 'ready' | 'error';

export function verifiedHistoryAccessStatus(
  phase: 'phase1' | 'phase2',
  permissionStatus: PermissionCheckStatus,
  permissionCount: number,
): string {
  if (phase === 'phase1') return 'not_required';
  if (permissionStatus === 'ready') return permissionCount > 0 ? 'controller_uploaded' : 'not_uploaded';
  if (permissionStatus === 'error') return 'permission_check_failed';
  return 'permission_check_pending';
}

export function sortAccessCardHistoryNewestFirst<T extends {
  issuedAt: string | Date | null;
  sequence: number;
  id: number;
}>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    const aTime = a.issuedAt ? new Date(a.issuedAt).getTime() : Number.NEGATIVE_INFINITY;
    const bTime = b.issuedAt ? new Date(b.issuedAt).getTime() : Number.NEGATIVE_INFINITY;
    const safeATime = Number.isFinite(aTime) ? aTime : Number.NEGATIVE_INFINITY;
    const safeBTime = Number.isFinite(bTime) ? bTime : Number.NEGATIVE_INFINITY;
    return safeBTime - safeATime || b.sequence - a.sequence || b.id - a.id;
  });
}
