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
  legacyPersonNo: string | null;
  icCardNo: string | null;
  wgCardNo: string | null;
  issuedAt: string | null;
  accessStatus: string;
  legacySyncStatus: string;
  controllerResults: AccessCardPermissionResult[];
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

export interface AccessCardReadiness {
  simulationEnabled: boolean;
  features: {
    cardWrite: boolean;
    legacyDbWrite: boolean;
    accessDbWrite: boolean;
    parkingDbRead: boolean;
    parkingDbWrite: boolean;
    controllerUpload: boolean;
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
    house: {
      id: number;
      roomNo: string;
      areaSqm: string | null;
      lane: string | null;
      buildingNo: string;
      communityId: number | null;
      communityName: string | null;
    } | null;
    matchedBy: 'phone';
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
  eventType: 'plate_change' | 'owner_rebind' | 'owner_info_update';
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

export const houseContext = (houseId: number) =>
  request<AccessCardHouseContext>({
    url: `/access-card-issuance/houses/${houseId}/context`,
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
