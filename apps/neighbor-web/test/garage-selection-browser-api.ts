export * from './preservation-browser-api';
import { accessCardIssuance as base, fixtureRows } from './preservation-browser-api';
const scenario = new URLSearchParams(location.search).get('scenario') || 'success';
const bits = (on: number[]) => Array.from({ length: 256 }, (_, i) => on.includes(i + 1) ? '1' : '0').join('');
fixtureRows[0].fields.P_Effective = bits([5, 7]); fixtureRows[1].fields.P_Effective = bits([]);
const fixture = { calls: [] as any[], tasks: [] as any[], released: false, choicesReleased: false, retries: 0 };
(window as any).__garage = fixture;
const choices = [
  { id: 1, garage: 'main', spaceNo: 'A-021', unavailableReason: '' },
  { id: 2, garage: 'main', spaceNo: 'A-099', unavailableReason: '车位号重复，请先核对档案' },
  { id: 3, garage: 'civil', spaceNo: 'R-012', unavailableReason: '' },
];
export const intake = { id: 1, kind: 'paid', status: 'waiting', houseId: 8, communityId: 8, houseLabel: '228/3/501', ownerName: '业主', ownerPhone: '13800000000', plate: '沪ATEST01', contactName: '业主', contactPhone: '13800000000', relation: '', vehicleClass: '住户车', garages: ['local:phase1_parking'], garageNumbers: {}, files: [], transaction: null, familyCarId: null, createdAt: '2026-11-18T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', qrValid: true, qr: { url: 'https://fixture.invalid', dataUrl: '', expiresAt: '2099-01-01' }, log: [] };
if (scenario === 'family') Object.assign(intake, { kind: 'family', garages: ['phase1'], relation: '父母' });
export const parkingTargets = [{ key: 'local:phase1_parking', label: '一期地面', short: '一期地面', communities: ['枫桦景苑二期'] }, { key: 'local:phase2_parking', label: '二期地面', short: '二期地面', communities: ['枫桦景苑二期'] }, { key: 'local:phase2_main_garage', label: '二期大车库', short: '二期大车库', communities: ['枫桦景苑二期'] }, { key: 'deliyun:枫桦景苑', label: '二期人防车库', short: '二期人防车库', communities: ['枫桦景苑二期'] }];
export async function request(input: any) {
  fixture.calls.push(structuredClone(input));
  if (input.url.endsWith('/parking-spaces') || input.url.endsWith('/space-choices')) {
    if (scenario === 'loadError' && !fixture.retries++) throw new Error('受控读取失败');
    if (scenario === 'loading') while (!fixture.choicesReleased) await new Promise(r => setTimeout(r, 40));
    return { rows: scenario === 'empty' ? [] : choices };
  }
  if (input.url === '/business/parking-targets') return parkingTargets;
  if (input.url.endsWith('/garages')) { if (scenario === 'saveError') throw new Error('受控登记保存失败'); Object.assign(intake, { garages: input.data.garages, garageNumbers: input.data.garageNumbers }); return structuredClone(intake); }
  if (input.url === '/vehicle-intakes/1') return structuredClone(intake);
  return { rows: [], total: 0 };
}
const finish = (op: any) => {
  for (const row of fixtureRows) {
    row.fields.P_Effective = row.database === 'parking1' ? bits(op.payload.garages.includes('phase1') ? [5, 7] : []) : bits([...(op.payload.garages.includes('phase2') ? [9, 11, 13] : []), ...(op.payload.garages.includes('main') ? [15, 17, 19, 21] : [])]);
    if (row.database === 'parking2' && op.payload.garages.includes('main')) row.fields.P_Spaces = op.payload.garageNumbers.main;
  }
  op.status = 'completed'; return op;
};
export const accessCardIssuance = new Proxy(base, { get(target, name) {
  if (name === 'deliyunVehiclesByPlate') return async () => ({ rows: scenario === 'civilExisting' ? [{ id: 'cloud1', plate: '沪ATEST01', civilDefenseAuthorized: true, parkingSpace: 'R-OLD' }] : [] });
  if (name === 'setDeliyunCivilDefenseAuthorization') return async (data: any) => { fixture.calls.push({ name, data }); return { status: 'completed' }; };
  if (name === 'createParkingOperation') return async (data: any) => {
    fixture.calls.push({ name, data }); const prior = fixture.tasks.find(t => t.idempotencyKey === data.idempotencyKey); if (prior) return structuredClone(prior);
    const op = { ...structuredClone(data), id: 900, status: 'pending', error: null }; fixture.tasks.push(op);
    if (scenario === 'failed') { op.status = 'failed'; op.error = '受控写入失败'; }
    else if (scenario !== 'waiting') finish(op);
    return structuredClone(op);
  };
  if (name === 'parkingOperation') return async () => { const op = fixture.tasks[0]; if (fixture.released) finish(op); return structuredClone(op); };
  return target[name];
} });
