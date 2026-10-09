import { request } from '../request';

export type AccessSystem = 'mjsystem' | 'iccard' | null;
export type ProjectPhase = 'phase1' | 'phase2';

export interface AccessCardPermissionResult {
  wgCardNo: string;
  accessSystem: 'mjsystem' | 'iccard';
  buildingNo: string | null;
  controller: string | null;
  door: string;
  sourceTable: 'MJ_MacPower' | 't_d_Privilege';
}

export interface AccessCardHistoryRow {
  id: number;
  sequence: number;
  roomLabel: string;
  legacyPersonNo: string | null;
  icCardNo: string | null;
  wgCardNo: string | null;
  issuedAt: string | null;
  accessStatus: string;
  legacySyncStatus: string;
  controllerResults: AccessCardPermissionResult[];
  latestAuthorization?: AccessCardAuthorization | null;
}

export interface AccessCardHouseContext {
  house: {
    id: number;
    roomNo: string;
    communityId: number;
    communityName: string;
    buildingId: number;
    buildingNo: string;
    lane: string | null;
    roomKey: string;
    displayAddress: string;
  };
  projectPhase: ProjectPhase;
  accessSystem: AccessSystem;
  routeReady: boolean;
  availableBuildings: Array<{
    id: number;
    buildingNo: string;
    accessSystem: AccessSystem;
    routeReady: boolean;
  }>;
  issuedCount: number;
  nextSequence: number;
  history: AccessCardHistoryRow[];
  historySources: {
    pms: boolean;
    legacy80: boolean;
    accessPermissions: boolean;
    accessPermissionsMessage: string;
    message: string;
  };
}

export interface AccessCardIssueItem {
  id: number;
  sequence: number;
  cardStatus: string;
  accessStatus: string;
  legacySyncStatus: string;
  icCardNo: string | null;
  wgCardNo: string | null;
  legacyPersonNo: string | null;
  cardCompletedAt: string | null;
  lastErrorRef: string | null;
  lastErrorMessage: string | null;
  controllerResults: Array<Record<string, unknown>>;
}

export interface AccessCardIssueBatch {
  id: number;
  houseId: number;
  addressSnapshot: string;
  projectPhase: ProjectPhase;
  accessSystem: AccessSystem;
  quantity: number;
  status: string;
  currentSequence: number;
  deliverable: boolean;
  items: AccessCardIssueItem[];
}

export interface AccessCardRecentRecord {
  id: number;
  batchId: number;
  houseId: number;
  address: string;
  projectPhase: ProjectPhase;
  accessSystem: AccessSystem;
  icCardNo: string | null;
  wgCardNo: string | null;
  legacyPersonNo: string | null;
  cardCompletedAt: string | null;
  accessStatus: string;
  legacySyncStatus: string;
  controllerResults: Array<Record<string, unknown>>;
  lastErrorRef: string | null;
  lastErrorMessage: string | null;
}

export interface LegacyRecentCardQuery {
  status: 'pending' | 'ready' | 'error';
  rows: Array<{ personId: number; personNo: string; personName?: string | null;
    icCardNo: string | null; wgCardNo: string | null; issuedAt: string | null }>;
  error: string | null;
  refreshedAt: string | null;
  permissionStatus: 'idle' | 'pending' | 'running' | 'ready' | 'error';
  permissions: Array<{ wgCardNo: string; accessSystem: 'mjsystem' | 'iccard'; buildingNo: string | null;
    controller: string | null; door: string }>;
  permissionError: string | null;
}

export interface AccessCardAuthorization {
  id: number;
  houseId: number;
  historyRowId: number;
  roomKey: string;
  icCardNo: string | null;
  wgCardNo: string;
  targetBuildings: Array<{ id: number; buildingNo: string; accessSystem: Exclude<AccessSystem, null> }>;
  controllerResults: Array<Record<string, unknown>>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempt: number;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface AccessCardReadiness {
  simulationEnabled: boolean;
  features: {
    cardWrite: boolean;
    legacyDbWrite: boolean;
    accessDbWrite: boolean;
    parkingDbRead: boolean;
    parkingDbWrite: boolean;
    controllerUpload: boolean;
    historicalAccessGrant?: boolean;
  };
  agents: Array<{
    id: string;
    kind: 'issuer' | 'access_gateway' | 'legacy_sync' | 'parking_gateway';
    name: string;
    version: string;
    status: 'online' | 'offline' | 'degraded';
    capabilities: Record<string, boolean>;
    lastSeenAt: string | null;
  }>;
  deliyun?: {
    configured: boolean;
    connected: boolean;
    readEnabled: boolean;
    writeEnabled: false;
    message: string;
    checkedAt: string | null;
  };
}

export interface ParkingQueryRow {
  database: string;
  fields: Record<string, string | number | boolean | null>;
  pmsMatch?: {
    userId: number;
    houseId: number | null;
    name: string | null;
    phone: string | null;
    contactNote: string | null;
    status?: 'active' | 'disabled';
    source?: 'manual' | 'self' | 'repair_intake' | 'legacy_import' | null;
    updatedAt?: string;
    updatedByName?: string | null;
    house: {
      id: number;
      roomNo: string;
      areaSqm: string | null;
      lane: string | null;
      buildingNo: string;
      communityId: number | null;
      communityName: string | null;
    } | null;
    matchedBy: 'phone' | 'room';
  } | null;
  historyRef?: {
    database: string;
    sourceRecordId: string | null;
    externalOwnerId: string | null;
    plate: string | null;
    pmsUserId: number | null;
  };
}

export interface ParkingHistoryChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface ParkingHistoryEntry {
  id: number;
  eventType: 'plate_change' | 'owner_rebind' | 'owner_info_update' | 'vehicle_added' | 'vehicle_renewed' | 'garage_authorization' | 'vehicle_type_update' | 'vehicle_deleted' | 'vehicle_download' | 'vehicle_sync';
  source: 'pms' | 'parking_gateway';
  database: string | null;
  sourceRecordId: string | null;
  pmsUserId: number | null;
  externalOwnerId: string | null;
  plateBefore: string | null;
  plateAfter: string | null;
  summary: string;
  changes: ParkingHistoryChange[];
  operator: string;
  occurredAt: string;
  timeBasis: 'operation' | 'detected';
}

export interface ParkingHistoryResponse {
  userHistory: ParkingHistoryEntry[];
  vehicleHistory: ParkingHistoryEntry[];
}

export interface ParkingQuery {
  id: number;
  term: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  rows: ParkingQueryRow[];
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface DeliyunVehicle {
  id: string;
  plate: string;
  cardNo: string | null;
  carType: string | null;
  cardType: string | null;
  beginDate: string | null;
  endDate: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  address: string | null;
  cardPoolId: string | null;
  cardPoolName: string | null;
  poolPeriods: Array<{ name: string | null; beginDate: string | null; endDate: string | null }>;
}

export interface ParkingMovementEntry {
  database: 'parking1' | 'parking2';
  plate: string;
  cardType: string | null;
  resident: string | null;
  inTime: string | null;
  outTime: string | null;
  inGate: string | null;
  outGate: string | null;
}

export interface ParkingMovementQuery {
  id: number;
  plate: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startDate: string;
  endDate: string;
  movements: ParkingMovementEntry[];
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface ParkingOwnerValues {
  name: string | null;
  phone: string | null;
  room: string | null;
  note: string | null;
}

export interface ParkingOwnerUpdate {
  id: number;
  database: 'parking1' | 'parking2';
  externalOwnerId: string;
  plate: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  values: ParkingOwnerValues | null;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export type ParkingOperationKind = 'add_vehicle' | 'renew_vehicle' | 'change_plate' | 'rebind_owner' | 'update_garages' | 'update_vehicle_type' | 'download_vehicle' | 'sync_vehicle_info' | 'delete_vehicle';
export interface ParkingOperation {
  id: number;
  kind: ParkingOperationKind;
  database: 'parking1' | 'parking2';
  sourceRecordId: string | null;
  pmsUserId: number | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
  rollbackOfOperationId: number | null;
}

export interface ParkingProofUpload {
  id: number;
  plate: string;
  url?: string;
  qrDataUrl?: string;
  expiresAt: string;
  openedAt?: string | null;
  submittedAt?: string | null;
  status: 'waiting' | 'opened' | 'submitted';
  fileName?: string | null;
  fileUrl?: string | null;
}

export const readiness = () =>
  request<AccessCardReadiness>({ url: '/access-card-issuance/readiness' });

export const enrollAgent = (data: {
  kind: 'issuer' | 'access_gateway' | 'legacy_sync' | 'parking_gateway';
  name: string;
}) => request<{
  id: string;
  kind: string;
  name: string;
  token: string;
  message: string;
}>({
  url: '/access-card-issuance/agents',
  method: 'POST',
  data,
});

export const createParkingQuery = (term: string) =>
  request<ParkingQuery>({
    url: '/access-card-issuance/parking/queries',
    method: 'POST',
    data: { term },
  });

export const parkingQuery = (id: number) =>
  request<ParkingQuery>({
    url: `/access-card-issuance/parking/queries/${id}`,
  });

export const deliyunVehiclesByPlate = (plate: string) =>
  request<{ project: string; rows: DeliyunVehicle[] }>({
    url: `/access-card-issuance/parking/deliyun/vehicles?plate=${encodeURIComponent(plate)}`,
  });

export const createParkingMovementQuery = (plate: string, startDate: string, endDate: string) =>
  request<ParkingMovementQuery>({
    url: '/access-card-issuance/parking/movements/queries',
    method: 'POST',
    data: { plate, startDate, endDate },
  });

export const parkingMovementQuery = (id: number) =>
  request<ParkingMovementQuery>({
    url: `/access-card-issuance/parking/movements/queries/${id}`,
  });

export const createParkingOwnerUpdate = (data: {
  database: 'parking1' | 'parking2';
  externalOwnerId: string;
  plate: string;
  pmsUserId?: number | null;
  idempotencyKey: string;
  expected: ParkingOwnerValues;
  values: ParkingOwnerValues;
  fieldHints?: Partial<Record<keyof ParkingOwnerValues, string | null>>;
}) => request<ParkingOwnerUpdate>({
  url: '/access-card-issuance/parking/owners/updates',
  method: 'POST',
  data,
});

export const parkingOwnerUpdate = (id: number) =>
  request<ParkingOwnerUpdate>({
    url: `/access-card-issuance/parking/owners/updates/${id}`,
  });

export const createParkingOperation = (data: {
  database: 'parking1' | 'parking2';
  kind: ParkingOperationKind;
  idempotencyKey: string;
  sourceRecordId?: string | null;
  pmsUserId?: number | null;
  payload: Record<string, unknown>;
  expected?: Record<string, unknown>;
}) => request<ParkingOperation>({
  url: '/access-card-issuance/parking/operations', method: 'POST', data,
});

export const parkingOperation = (id: number) => request<ParkingOperation>({
  url: `/access-card-issuance/parking/operations/${id}`,
});

export const rollbackParkingOperation = (id: number) => request<ParkingOperation>({
  url: `/access-card-issuance/parking/operations/${id}/rollback`, method: 'POST',
});

export const parkingHistory = (params: {
  pmsUserId?: number | null;
  database?: string | null;
  externalOwnerId?: string | null;
  sourceRecordId?: string | null;
  plate?: string | null;
}) => request<ParkingHistoryResponse>({
  url: '/access-card-issuance/parking/history',
  query: Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== '')) as Record<string, string | number>,
});

export const createParkingProofUpload = (data: { plate: string; ownerId?: string }) =>
  request<ParkingProofUpload>({
    url: '/access-card-issuance/parking/proof-uploads',
    method: 'POST',
    data,
  });

export const parkingProofUpload = (id: number) =>
  request<ParkingProofUpload>({
    url: `/access-card-issuance/parking/proof-uploads/${id}`,
  });

export const parkingProofByPlate = (plate: string) =>
  request<ParkingProofUpload | null>({
    url: '/access-card-issuance/parking/proof-uploads/by-plate',
    query: { plate },
  });

export const houseContext = (houseId: number) =>
  request<AccessCardHouseContext>({
    url: `/access-card-issuance/houses/${houseId}/context`,
  });

export const recentCards = () =>
  request<AccessCardRecentRecord[]>({
    url: '/access-card-issuance/recent-cards',
  });

export const requestRecentLegacyCards = () => request<LegacyRecentCardQuery>({
  url: '/access-card-issuance/recent-legacy-cards/queries', method: 'POST',
});

export const recentLegacyCards = () => request<LegacyRecentCardQuery>({
  url: '/access-card-issuance/recent-legacy-cards/queries',
});

export const createHistoryAuthorization = (houseId: number, historyId: number, data: {
  targetBuildingIds: number[];
  idempotencyKey: string;
}) => request<AccessCardAuthorization>({
  url: `/access-card-issuance/houses/${houseId}/history/${historyId}/authorizations`,
  method: 'POST',
  data,
});

export const uploadHistoryCardToController = (houseId: number, historyId: number, data: {
  idempotencyKey: string;
}) => request<AccessCardAuthorization>({
  url: `/access-card-issuance/houses/${houseId}/history/${historyId}/upload-controller`,
  method: 'POST',
  data,
});

export const historyAuthorization = (id: number) => request<AccessCardAuthorization>({
  url: `/access-card-issuance/history-authorizations/${id}`,
});

export const retryHistoryAuthorization = (id: number) => request<AccessCardAuthorization>({
  url: `/access-card-issuance/history-authorizations/${id}/retry`,
  method: 'POST',
});

export const createBatch = (data: {
  houseId: number;
  quantity: number;
  extraBuildingIds: number[];
  workstationId?: string;
  idempotencyKey: string;
}) =>
  request<AccessCardIssueBatch>({
    url: '/access-card-issuance/batches',
    method: 'POST',
    data,
  });

export const batch = (id: number) =>
  request<AccessCardIssueBatch>({ url: `/access-card-issuance/batches/${id}` });

export const retryAccessUpload = (batchId: number, itemId: number) =>
  request<AccessCardIssueBatch>({
    url: `/access-card-issuance/batches/${batchId}/items/${itemId}/retry-access`,
    method: 'POST',
  });

export const simulateNext = (id: number) =>
  request<AccessCardIssueBatch>({
    url: `/access-card-issuance/batches/${id}/simulate-next`,
    method: 'POST',
  });

export const simulateLegacySync = (id: number) =>
  request<AccessCardIssueBatch>({
    url: `/access-card-issuance/batches/${id}/simulate-legacy-sync`,
    method: 'POST',
  });
