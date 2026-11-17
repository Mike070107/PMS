/** PMS Local Integration Protocol. Vendor/database mappings MUST remain in the local adapter. */
export const PROTOCOL_VERSION = '1.0' as const;
export const OPERATIONS = ['card.inspect', 'card.write', 'access.query', 'access.grant', 'access.revoke',
  'access.controller.apply', 'parking.query', 'parking.vehicle.upsert', 'parking.vehicle.renew'] as const;
export type IntegrationOperation = typeof OPERATIONS[number];
export type TaskOutcome = 'succeeded' | 'failed' | 'unknown';
export type EvidenceStage = 'observed' | 'card_readback' | 'database_readback' | 'controller_ack';
export interface Capability { operation: IntegrationOperation; revision: 1 }
export interface Resource { id: string; label: string; capabilities: Capability[] }
export interface BusinessCommand {
  card?: { uid?: string; number?: string; profileId?: string; allocationId?: string };
  person?: { externalId?: string; name?: string; room?: string };
  vehicle?: { plate: string; externalId?: string; vehicleType?: string };
  authorization?: { targetIds?: string[]; validFrom?: string; validUntil?: string };
  query?: { field: 'card' | 'plate' | 'room' | 'person'; value: string };
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported contract fields');
}
function text(value: unknown, max = 160): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error('Invalid contract string');
}
export function validateCapabilities(value: unknown): asserts value is Capability[] {
  if (!Array.isArray(value) || !value.length || value.length > OPERATIONS.length) throw new Error('Invalid capabilities');
  const seen = new Set<string>();
  for (const cap of value) {
    keys(cap, ['operation', 'revision']);
    if (!OPERATIONS.includes(cap.operation as IntegrationOperation) || cap.revision !== 1 || seen.has(String(cap.operation))) throw new Error('Unsupported capability revision');
    seen.add(String(cap.operation));
  }
}
export function validateResources(value: unknown): asserts value is Resource[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('Invalid resources');
  const seen = new Set<string>();
  for (const resource of value) {
    keys(resource, ['id', 'label', 'capabilities']); text(resource.id, 80); text(resource.label, 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(resource.id) || seen.has(resource.id)) throw new Error('Invalid resource ID');
    seen.add(resource.id); validateCapabilities(resource.capabilities);
  }
}
export function validateCommand(operation: IntegrationOperation, value: unknown): asserts value is BusinessCommand {
  if (!OPERATIONS.includes(operation)) throw new Error('Unknown operation');
  keys(value, ['card', 'person', 'vehicle', 'authorization', 'query']);
  const fields: Record<string, string[]> = {
    card: ['uid', 'number', 'profileId', 'allocationId'], person: ['externalId', 'name', 'room'],
    vehicle: ['plate', 'externalId', 'vehicleType'], authorization: ['targetIds', 'validFrom', 'validUntil'], query: ['field', 'value'],
  };
  for (const [field, entry] of Object.entries(value)) {
    keys(entry, fields[field]);
    for (const [key, val] of Object.entries(entry)) {
      if (key === 'targetIds') {
        if (!Array.isArray(val) || !val.length || val.length > 100 || new Set(val).size !== val.length) throw new Error('Invalid targets');
        val.forEach(v => text(v, 80));
      } else { text(val); if (key === 'validFrom' || key === 'validUntil') {
        if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z)?$/.test(val)
          || !Number.isFinite(Date.parse(val)) || new Date(val).toISOString().slice(0, 10) !== val.slice(0, 10)) throw new Error('Invalid validity date');
      } }
    }
  }
  const command = value as BusinessCommand;
  if (command.authorization?.validFrom && command.authorization.validUntil
    && Date.parse(command.authorization.validFrom) > Date.parse(command.authorization.validUntil)) throw new Error('Invalid validity range');
  if (operation.endsWith('.query') && (!command.query || !['card', 'plate', 'room', 'person'].includes(command.query.field) || !command.query.value)) throw new Error('Query is required');
  if (operation === 'card.write' && (!command.card?.profileId || !command.card?.allocationId || !command.card.number)) throw new Error('Card allocation and local profile required');
  if (['access.grant', 'access.revoke', 'access.controller.apply'].includes(operation) && (!command.card?.number || !command.authorization?.targetIds?.length)) throw new Error('Card and targets required');
  if (operation.startsWith('parking.vehicle.') && !command.vehicle?.plate) throw new Error('Vehicle plate required');
  if (operation === 'parking.vehicle.renew' && !command.authorization?.validUntil) throw new Error('Renewal expiry required');
}
export function requiredEvidence(operation: IntegrationOperation): EvidenceStage {
  if (operation === 'card.write') return 'card_readback';
  if (operation === 'access.controller.apply') return 'controller_ack';
  if (['access.grant', 'access.revoke', 'parking.vehicle.upsert', 'parking.vehicle.renew'].includes(operation)) return 'database_readback';
  return 'observed';
}
export function validateResult(operation: IntegrationOperation, value: unknown) {
  keys(value, ['outcome', 'evidence', 'code', 'message', 'records']);
  if (!['succeeded', 'failed', 'unknown'].includes(String(value.outcome))) throw new Error('Invalid outcome');
  if (value.code !== undefined) text(value.code, 80);
  if (value.message !== undefined) text(value.message, 500);
  if (value.outcome === 'succeeded' && value.evidence !== requiredEvidence(operation)) throw new Error('Success requires operation-specific verification evidence');
  if (value.evidence !== undefined && !['observed', 'card_readback', 'database_readback', 'controller_ack'].includes(String(value.evidence))) throw new Error('Invalid evidence');
  if (value.records !== undefined) {
    if (!Array.isArray(value.records) || value.records.length > 100) throw new Error('Invalid result records');
    for (const record of value.records) {
      const parkingProjection = operation === 'parking.query' ? ['ownerId', 'phone', 'note', 'plateChangedAt'] : [];
      keys(record, ['cardUid', 'cardNumber', 'plate', 'externalId', 'room', 'name', 'targetId', 'validUntil', 'status', ...parkingProjection]);
      for (const [field, entry] of Object.entries(record)) {
        // Null means an explicitly observed missing value, never an omitted projection.
        if (operation === 'parking.query' && ['room', 'name', ...parkingProjection].includes(field) && entry === null) continue;
        text(entry);
      }
    }
  }
  return value;
}
export function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
