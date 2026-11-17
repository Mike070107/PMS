import { request } from '../request';
export type Operation = 'card.inspect' | 'card.write' | 'access.query' | 'access.grant' | 'access.revoke' | 'access.controller.apply' | 'parking.query' | 'parking.vehicle.upsert' | 'parking.vehicle.renew';
export interface IntegrationResource { id: string; label: string; capabilities: Array<{ operation: Operation; revision: 1 }> }
export interface LocalIntegration {
  id: number; key: string; name: string; kind: 'workstation' | 'service'; enabled: boolean;
  protocolVersion: '1.0'; version: string; status: 'online' | 'offline'; lastSeenAt: string | null;
  resources: IntegrationResource[]; ready: IntegrationResource[];
}
export interface BusinessCommand {
  card?: { uid?: string; number?: string; profileId?: string; allocationId?: string };
  person?: { externalId?: string; name?: string; room?: string };
  vehicle?: { plate: string; externalId?: string; vehicleType?: string };
  authorization?: { targetIds?: string[]; validFrom?: string; validUntil?: string };
  query?: { field: 'card' | 'plate' | 'room' | 'person'; value: string };
}
export interface IntegrationResult {
  outcome: 'succeeded' | 'failed' | 'unknown'; evidence?: 'observed' | 'card_readback' | 'database_readback' | 'controller_ack';
  code?: string; message?: string;
  records?: Array<Partial<Record<'cardUid' | 'cardNumber' | 'plate' | 'externalId' | 'room' | 'name' | 'targetId' | 'validUntil' | 'status', string>>>;
}
export interface IntegrationTask {
  id: number; integrationKey: string; resourceId: string; operation: Operation; revision: 1; protocolVersion: '1.0';
  idempotencyKey: string; command: BusinessCommand; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  result: IntegrationResult | null; createdAt: string; completedAt: string | null;
}
/** card.write remains allocator-gated; use the existing formal issuance flow for physical writing. */
export const createTask = (key: string, data: { resourceId: string; operation: Exclude<Operation, 'card.write'>; revision: 1; idempotencyKey: string; command: BusinessCommand }) =>
  request<IntegrationTask>({ method: 'POST', url: `/local-integrations/v1/${encodeURIComponent(key)}/tasks`, data });
export const getTask = (key: string, id: number) => request<IntegrationTask>({ url: `/local-integrations/v1/${encodeURIComponent(key)}/tasks/${id}` });
export const list = () => request<LocalIntegration[]>({ url: '/local-integrations/v1' });
export const enroll = (data: { name: string; kind: 'workstation' | 'service'; resources: IntegrationResource[] }) =>
  request<LocalIntegration & { token: string }>({ method: 'POST', url: '/local-integrations/v1', data });
export const setEnabled = (key: string, enabled: boolean) => request<LocalIntegration>({ method: 'POST', url: `/local-integrations/v1/${encodeURIComponent(key)}/enabled`, data: { enabled } });
export const rotateSecret = (key: string) => request<LocalIntegration & { token: string }>({ method: 'POST', url: `/local-integrations/v1/${encodeURIComponent(key)}/rotate-secret` });
