// Explicit controlled transport; business components are real, no production connections.
const scenario = new URLSearchParams(location.search).get('scenario') || 'success';
const plate = '沪ATEST01';
const fields = (id: number, identity: string | null) => ({ P_id: id, P_plate: plate, Car_Brand: identity,
  Car_Lei: id === 101 ? null : '历史授权', Owner_ID: 'owner', Owner__owner_Name: '228/3/501',
  P_Effective: '010000', P_Download: '001000', P_Spaces: 'A-021', P_note: '原备注', End_Time: '2027-01-31',
  Sart_Time: null, Car_Money: 20, Car_Deposit: 3, Car_Zt: 0, Car_ID: 'original-card', P_Color: null });
const rows: any[] = [{ database: 'parking1', fields: fields(101, null) }, { database: 'parking2', fields: fields(202, '租户车') }];
const fixture = { rows, calls: [] as any[], released: false, queryCount: 0, posts: 0, billed: '住户车-1' };
(window as any).__preserveFixture = fixture;
const operations = new Map<number, any>();
const record = (name: string, data: any) => fixture.calls.push({ name, data: structuredClone(data) });
const finish = (op: any) => {
  const row = rows.find(row => row.database === op.database && String(row.fields.P_id) === op.sourceRecordId);
  const before = structuredClone(row.fields);
  if (op.kind === 'change_plate') row.fields.P_plate = op.payload.newPlate; else row.fields.Car_Brand = op.payload.identity;
  op.status = 'completed'; op.result = { verified: true, preserved: true, preservationContract: 1, database: op.database,
    plate: row.fields.P_plate, previousPlate: before.P_plate, identity: row.fields.Car_Brand, issueId: op.sourceRecordId, before, after: structuredClone(row.fields) };
  if (scenario === 'badReceipt') op.result.preserved = false;
};
const query = (term: string) => ({ id: ++fixture.queryCount, term, status: 'completed', rows: structuredClone(rows.filter(r => r.fields.P_plate === term)), completedAt: new Date().toISOString(), error: null });
const methods = {
  async createParkingQuery(term: string) { record('createParkingQuery', { term }); return query(term); },
  async parkingQuery(id: number) { record('parkingQuery', { id }); return query(plate); },
  async deliyunVehiclesByPlate(term: string) { record('deliyunVehiclesByPlate', { term }); if (scenario === 'cloudUnknown') throw new Error('人防查询网络失败'); return { rows: [] }; },
  async createParkingOperation(data: any) {
    record('createParkingOperation', data); fixture.posts++;
    const previous = [...operations.values()].find(op => op.idempotencyKey === data.idempotencyKey);
    if (previous) return structuredClone(previous);
    const op = { ...structuredClone(data), id: 700 + operations.size, status: 'pending', result: null, error: null };
    operations.set(op.id, op);
    if (scenario === 'failed' || (scenario === 'partial' && data.database === 'parking2')) { op.status = 'failed'; op.error = '受控写入失败，事务已回滚'; }
    else if (!['waiting', 'pollFailure'].includes(scenario)) finish(op);
    if (scenario === 'lostResponse' && fixture.posts === 1) throw new Error('提交响应丢失，服务端可能已经完成');
    return structuredClone(op);
  },
  async parkingOperation(id: number) {
    record('parkingOperation', { id });
    if (scenario === 'pollFailure' && !fixture.released) throw new Error('原任务网络故障，结果未知');
    const op = operations.get(id); if (fixture.released && op.status === 'pending') finish(op);
    return structuredClone(op);
  },
  async parkingProofByPlate() { return null; },
};
export const accessCardIssuance: any = new Proxy(methods, { get(target, name) { return (target as any)[name] || (async () => ({ rows: [], total: 0 })); } });
export const address = { tree: async () => [] };
export class ApiError extends Error {}
export function configure() { /* Controlled transport only. */ }
export async function request(input: any) { record('request', input); return { rows: [], total: 0 }; }
export const fixtureRows = rows;
export const fixtureReadiness = { agents: [{ id: 1, kind: 'parking_gateway', status: 'online', version: '2.5.53', capabilities: { parkingDbWrite: true, parkingVehiclePreservationV1: true } }], features: { parkingDbRead: true }, deliyun: { configured: true, writeEnabled: true } };
