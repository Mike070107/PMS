// Deterministic API adapter only. Components, authorization decoder, quote handling,
// submit/poll/recovery and DateInput are production source; no live payments/devices.
const params = new URLSearchParams(location.search);
const garage = params.get('garage') === 'civil' ? 'civil' : 'main';
const scenario = params.get('scenario') || 'success';
const plate = '沪ATEST01';
const bits = (...channels: number[]) => Array.from({ length: 32 }, (_, i) => channels.includes(i + 1) ? '1' : '0').join('');
const fields = (id: number, effective: string) => ({ P_id: id, P_plate: plate, P_enddate: '2027-01-31', P_Effective: effective, P_Download: effective, Car_Brand: '住户车', P_note: '原停车备注' });
const rows = [
  { database: 'parking1', fields: fields(101, scenario === 'fanout' ? bits(5, 7) : bits()) },
  { database: 'parking2', fields: fields(202, scenario === 'unauthorized' ? bits() : bits(9, 11, 13, 15, 17, 19, 21)),
    pmsMatch: { userId: 1, houseId: 1, name: '续费测试业主', house: { communityId: 2 } } },
];
let cloud = { id: 'cloud-1', plate, beginDate: '2026-01-01', endDate: '2027-02-28', civilDefenseAuthorized: garage === 'civil' && scenario !== 'unauthorized', garageNames: ['人防'], poolPeriods: [] };
const space = { id: 21, garage, spaceNo: garage === 'main' ? 'A-021' : 'RF-021', plate, houseNo: '228/3/501', ownerName: '续费测试业主', ownerTel: '13800000001/021-12345678', areaSqm: '12.50', category: null, note: '原备注不能被类别覆盖', source: '原导入来源', endDate: '2027-01-31', communityId: 2 };
const calls: any[] = [];
const ops = new Map<number, any>();
let seq = 700, cloudAttempts = 0, querySeq = 0;
const fixture = { calls, released: false, cloudAttempts: 0, space, done: 0 };
(window as any).__renewFixture = fixture;
const record = (name: string, data: any) => calls.push({ name, data: structuredClone(data) });
const query = () => ({ id: ++querySeq, status: scenario === 'lookupWait' && !fixture.released ? 'running' : 'completed', rows: structuredClone(rows), error: null });
const operation = (database: string, data: any, status: string) => ({ id: ++seq, status, database, payload: data.payload || data, error: status === 'failed' ? '受控现场失败，未完成' : null, result: status === 'completed' ? { verified: true } : null });
export const accessCardIssuance = {
  async createParkingQuery(term: string) { record('createParkingQuery', { term }); return query(); },
  async parkingQuery(id: number) { record('parkingQuery', { id }); return query(); },
  async deliyunVehiclesByPlate(term: string) { record('deliyunVehiclesByPlate', { term }); return { project: '枫桦景苑', rows: [structuredClone(cloud)] }; },
  async createParkingOperation(data: any) {
    record('createParkingOperation', data);
    if (scenario === 'lostResponse') throw new Error('网络中断，提交响应丢失');
    const op = operation(data.database, data, ['waiting', 'timeout'].includes(scenario) ? 'pending' : scenario === 'legacyFailed' ? 'failed' : 'completed');
    if (scenario === 'existingMismatch') op.payload = { ...op.payload, amount: Number(op.payload.amount) + 1 };
    ops.set(op.id, op);
    if (op.status === 'completed' && scenario !== 'readbackMismatch') rows.find(r => String(r.fields.P_id) === data.sourceRecordId)!.fields.P_enddate = data.payload.endDate;
    return structuredClone(op);
  },
  async parkingOperation(id: number) {
    record('parkingOperation', { id });
    const op = ops.get(id);
    if (scenario === 'waiting' && fixture.released && op.status === 'pending') {
      op.status = 'completed'; rows.find(r => String(r.fields.P_id) === op.payload.pid || r.database === op.database)!.fields.P_enddate = op.payload.endDate;
    }
    return structuredClone(op);
  },
  async renewDeliyunVehicle(data: any) {
    record('renewDeliyunVehicle', data); cloudAttempts++; fixture.cloudAttempts = cloudAttempts;
    const op = operation('deliyun', data, scenario === 'cloudQueued' ? 'running' : scenario === 'cloudFailed' && cloudAttempts === 1 ? 'failed' : 'completed');
    ops.set(op.id, op); if (op.status === 'completed') cloud.endDate = data.endDate;
    return structuredClone(op);
  },
};
export async function request({ url, method = 'GET', data = {}, query: args = {} }: any): Promise<any> {
  record('request', { url, method, data, query: args });
  if (url === '/business/parking-spaces/21' && method === 'PATCH') { Object.assign(space, data); return structuredClone(space); }
  if (url === '/business/parking-spaces') return { rows: [structuredClone(space)] };
  if (url === '/business/communities') return [{ id: 2, name: '续费测试小区二期' }];
  if (url === '/business/rules') return [{ id: 67, communityId: 2, serviceType: 'parking_monthly', enabled: true, name: '车库月费规则', unitPriceCents: 6750, config: { vehicleClass: '住户车-1', parkingTargets: ['local:phase2_main_garage', 'deliyun:枫桦景苑'] } }];
  if (url === '/business/estimate') return { quantity: data.months, amountCents: data.months * 6750, startDate: '2027-02-01', endDate: '2027-07-31' };
  if (url === '/owners-mgmt/business-contacts') return [{ id: 1, name: '续费测试业主', phone: '13800000001', contactPhones: ['13800000001', '021-12345678'] }];
  if (url === '/owners-mgmt/1/business-contact' && method === 'PATCH') return { id: 1, ...data };
  throw new Error(`Unexpected fixture request ${method} ${url}`);
}
export const address = { tree: async () => [] };
export const fixtureSpace = space;
