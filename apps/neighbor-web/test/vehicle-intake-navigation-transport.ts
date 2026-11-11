// Dedicated synthetic transport for the real Vehicles / Plates / Cashier pages.
import qrFixture from './vehicle-intake-navigation-qr.json';
const w = window as any;
w.__calls = [];
w.__holds = {};
w.__release = (key: string) => { w.__holds[key]?.(); delete w.__holds[key]; };
export const session = { user: { id: 1, name: '合成操作员' }, access: { scopeAll: false, communityIds: [1] } };
export const targets = [{ key: 'phase1', label: '合成小区 一期地面', short: '一期地面', system: 'local', billing: 'vehicle', database: 'parking1', communities: ['合成小区'] }];
const house = { id: 501, roomNo: '901', propertyType: 'residential', shopName: null, ownerId: 701, ownerName: '合成住户', ownerPhone: '13800000000' };
const tree = [{ id: 1, name: '合成小区', isGroup: false, parentId: null, mainLane: '198', buildings: [{ id: 11, lane: '198', buildingNo: '8', roadName: null, houses: [house, { ...house, id: 502, roomNo: '902', ownerId: 702, ownerName: '第二合成住户' }] }] }, { id: 2, name: '未授权小区', isGroup: false, parentId: null, mainLane: '228', buildings: [{ id: 21, lane: '228', buildingNo: '8', roadName: null, houses: [{ ...house, id: 999 }] }] }];
const qr = { url: 'https://mock.invalid/intake/synthetic-only', dataUrl: qrFixture.dataUrl, expiresAt: '2099-11-11T23:59:00+08:00' };
export function seed(id = 61, extra: any = {}) { return { id, kind: 'paid', status: 'waiting', houseId: 501, houseLabel: '不可解析的原始地址（不要当导航依据）', ownerName: '合成住户', ownerPhone: '', plate: '', contactName: '', contactPhone: '', relation: '', vehicleClass: '住户车-1', garages: ['phase1'], garageNumbers: {}, expiresAt: qr.expiresAt, qrValid: true, openedAt: null, submittedAt: null, reviewedAt: null, reviewNote: '', files: [], transaction: null, familyCarId: null, createdAt: '2026-11-11T08:00:00+08:00', qr, ...extra }; }
w.__intakes = { 61: seed(), 62: seed(62, { houseId: 502, plate: '浙ADD422', status: 'approved' }), 63: seed(63, { kind: 'family' }), 64: seed(64, { status: 'void', qrValid: false }), 65: seed(65, { status: 'approved', transaction: { id: 800, txnNo: 'MOCK-800', amountCents: 15000, startDate: '2026-11-11', endDate: '2026-12-10', externalSyncStatus: 'awaiting_docs', execution: null } }), 66: seed(66, { houseId: 999 }), 67: seed(67, { expiresAt: '2020-01-01T00:00:00Z', qrValid: false }), 68: seed(68, { kind: 'family', status: 'approved', familyCarId: 901 }), 69: seed(69, { houseId: -1 }) };
w.__failures ||= {};
w.__waitFor ||= [];
async function record(o: any) { w.__calls.push(structuredClone(o)); const key = `${o.method || 'GET'} ${o.url}`; if (w.__waitFor.includes(key)) await new Promise<void>(r => { w.__holds[key] = r; }); if (w.__failures[key]) throw Error(w.__failures[key]); }
export async function request(o: any): Promise<any> {
  await record(o);
  const d = o.data || {};
  if (o.url === '/business/rules') return [{ id: 90, communityId: 1, serviceType: 'parking_monthly', name: '住户车-1', enabled: true, unitPriceCents: 15000, config: { priceMode: 'monthly', monthlyPriceCents: 15000, vehicleClass: '住户车-1', parkingTargets: ['phase1'], tiers: [{ months: 1, amountCents: 15000 }] } }];
  if (o.url === '/business/parking-targets') return targets;
  if (o.url === '/business/household-parking') return { room: '合成', roomTerm: '198/8/901', targets, localDatabases: [], deliyun: [] };
  if (o.url === '/business/plate-tags/list') return { counts: {} };
  if (o.url === '/business/plate-tags') return {};
  if (o.url === '/business/search') throw Error('深链不应模糊查询或猜业主');
  if (o.url === '/fees/mis/bills') return { rows: [] };
  if (o.url === '/business/transactions') return [];
  if (o.url === '/vehicle-intakes') {
    if (o.method === 'POST') { const item = seed(71, { kind: d.kind, houseId: d.houseId }); w.__intakes[71] = item; return item; }
    return Object.values(w.__intakes).filter((i: any) => (!o.query?.houseId || i.houseId === o.query.houseId) && (!o.query?.open || i.status !== 'void') && (!o.query?.status || o.query.status.split(',').includes(i.status)) && (!w.__listIds || w.__listIds.includes(i.id)));
  }
  const match = o.url.match(/^\/vehicle-intakes\/(\d+)(?:\/(.*))?$/);
  if (match) {
    const item = w.__intakes[Number(match[1])];
    if (!item) throw Error('登记不存在或不在当前租户授权范围');
    if (match[2] === 'review') { if (d.decision !== 'void' || !d.note?.trim()) throw Error('必须确认撤销原因'); item.status = 'void'; item.qrValid = false; return { ...item }; }
    if (match[2] === 'class') item.vehicleClass = d.vehicleClass;
    if (match[2] === 'garages') { item.garages = d.garages; item.garageNumbers = d.garageNumbers; }
    if (!match[2] || ['show-qr', 'class', 'garages'].includes(match[2])) return { ...item };
  }
  if (o.url === '/business/estimate') return { unitPriceCents: 15000, quantity: d.months, amountCents: 15000, startDate: '2026-11-11', endDate: '2026-12-10', summary: '合成收费标准', breakdown: '合成服务端试算' };
  if (o.url === '/business/complete') { const item = w.__intakes[d.intakeId]; if (!item || item.kind !== 'paid' || item.transaction || item.status === 'void') throw Error('登记状态不允许重复收款'); item.transaction = { id: 801, txnNo: 'MOCK-801', amountCents: 15000, startDate: '2026-11-11', endDate: '2026-12-10', externalSyncStatus: 'awaiting_docs', execution: null }; return item.transaction; }
  throw Error('隔离 fixture 未声明接口：' + o.url);
}
export const address = { tree: async () => { await record({ url: '/address/tree' }); return tree; } };
export const accessCardIssuance = { createParkingQuery: async (term: string) => { await record({ url: '/mock/parking-query', term }); return { id: 1, status: 'completed', rows: [] }; }, parkingQuery: async () => ({ id: 1, status: 'completed', rows: [] }), parkingFeeRates: async () => ({ owner: { 1: 150 }, tenant: { 1: 260 } }) };
export const repairs = {};
