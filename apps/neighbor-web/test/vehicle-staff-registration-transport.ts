// Synthetic browser-only transport. Never calls production or devices.
const w = window as any;
export const targets = [
  { key: 'local:phase2_parking', label: '枫桦景苑二期 地面', short: '二期地面', system: 'local', database: 'parking2', billing: 'vehicle', communities: ['枫桦景苑二期'] },
  { key: 'local:phase2_main_garage', label: '枫桦景苑二期 大车库', short: '大车库', system: 'local', database: 'parking2', billing: 'space', communities: ['枫桦景苑二期'] },
];
export const seed: any = { id: 71, kind: 'paid', status: 'waiting', houseId: 5, communityId: 3, houseLabel: '枫桦景苑二期/228弄3号502', ownerName: '合成业主', ownerPhone: '13900000000', plate: '', contactName: '', contactPhone: '', relation: '', vehicleClass: '住户车-1', garages: [], garageNumbers: {}, expiresAt: '2099-11-11T23:59:00+08:00', qrValid: true, submittedAt: null, openedAt: null, reviewedAt: null, reviewNote: '', files: [], transaction: null, familyCarId: null, createdAt: '2026-11-17T08:00:00+08:00', qr: { url: 'https://mock.invalid/fixture-only', dataUrl: '/sample.png' }, log: [] };
let current = structuredClone(seed);
w.__calls = []; w.__current = () => structuredClone(current); w.__failGarage = false; w.__failReview = false; w.__holdSubmit = false;
export const accessCardIssuance = {};
export const address = {};
export async function request(o: any): Promise<any> {
  w.__calls.push(structuredClone(o)); const d = o.data || {};
  if (o.url === '/vehicle-intakes' && o.query?.q) return w.__reversedIntake ? [{ ...seed, id: 70, plate: o.query.q, status: 'approved', canReleaseReversed: true }] : [];
  if (o.url === '/vehicle-intakes/70/release-reversed' && d.parkingChecked === true) {
    w.__existingPlate = false;
    return { ...seed, id: 70, status: 'void' };
  }
  if (o.url === '/business/parking-targets') return targets;
  if (o.url.endsWith('/parking-spaces')) return { rows: [
    { id: 1, garage: 'main', spaceNo: 'B12' },
    { id: 4, garage: 'main', spaceNo: 'B123456', unavailableReason: '车位档案需先核对' },
    { id: 3, garage: 'civil', spaceNo: 'R01' },
  ] };
  if (o.url.endsWith('/class')) current = { ...current, vehicleClass: d.vehicleClass };
  if (o.url.endsWith('/kind')) current = { ...current, ...d, status: 'waiting', vehicleClass: d.kind === 'family' ? '' : d.vehicleClass, garages: d.kind === 'family' ? ['phase2'] : [], garageNumbers: {} };
  if (o.url.endsWith('/staff-submit')) {
    if (w.__existingPlate) throw Error('该车牌已有登记，请核对原登记及收款流水，不可重复新办');
    if (w.__holdSubmit) await new Promise(r => { w.__releaseSubmit = r; });
    current = { ...current, ...d, status: 'submitted', submittedAt: '2026-11-17T09:00:00+08:00' };
  }
  if (o.url.endsWith('/garages')) {
    if (w.__failGarage) throw Error('合成：授权保存失败，输入已保留');
    current = { ...current, ...d };
  }
  if (o.url.endsWith('/review')) {
    if (w.__failReview) throw Error('合成：车位已关联其他车辆或房号，不能抢占');
    current = { ...current, ...d, status: 'approved', reviewedAt: '2026-11-17T09:01:00+08:00', log: [...current.log, { at: '2026-11-17T09:01:00+08:00', userId: 1, userName: '合成工作人员', action: '关联车位档案', note: 'main/B12' }] };
  }
  if (o.url === '/business/estimate') return { quantity: d.months, amountCents: d.months * 10000, startDate: '2026-11-17', endDate: new Date(Date.UTC(2026, 10 + d.months, 16)).toISOString().slice(0, 10) };
  return structuredClone(current);
}
export async function uploadBlobTo(file: File, endpoint: string) {
  w.__calls.push({ url: endpoint, method: 'POST', file: file.name });
  current.files.push({ index: current.files.length, fileName: file.name, contentType: file.type, fileUrl: '/sample.png', uploadedAt: '' });
  return structuredClone(current);
}
