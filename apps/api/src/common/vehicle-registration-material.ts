export interface VehicleMaterialHistory {
  version: number;
  at: string;
  actorId: number | null;
  reason: string;
  data: Record<string, unknown>;
  officeConfirmedVersion: number | null;
  managerApprovedVersion: number | null;
}
export interface VersionedVehicleMaterial {
  dataVersion: number;
  officeConfirmedVersion: number | null;
  managerApprovedVersion?: number | null;
  materialHistory: VehicleMaterialHistory[];
}
/** Call BEFORE changing any material field. History is append-only, including old approval bindings. */
export function reviseVehicleMaterial(row: VersionedVehicleMaterial, data: Record<string, unknown>, actorId: number | null, reason: string) {
  const version = row.dataVersion ?? 0;
  const snapshot = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  row.materialHistory = [...(row.materialHistory ?? []), {
    version, at: new Date().toISOString(), actorId, reason, data: snapshot,
    officeConfirmedVersion: row.officeConfirmedVersion ?? null,
    managerApprovedVersion: row.managerApprovedVersion ?? null,
  }];
  row.dataVersion = version + 1;
  row.officeConfirmedVersion = null;
  if ('managerApprovedVersion' in row) row.managerApprovedVersion = null;
}
