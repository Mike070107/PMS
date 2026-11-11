// Explicit local synthetic transport: no production, MIS, SQL, or device access.
const params = new URLSearchParams(location.search);
export const targets = [{ key: 'local:sample-surface', label: '示例小区 地面车库', short: '地面车库', system: 'local', billing: 'vehicle', communities: ['示例小区'] }, { key: 'local:sample-main', label: '示例小区 大车库', short: '付费大车库', system: 'local', billing: 'space', communities: ['示例小区'] }];
const kind = params.get('kind') || 'paid';
const status = params.get('status') || 'submitted';
export const seed = { id: 61, kind, status, houseId: 1, houseLabel: '示例小区/198弄/示例室', ownerName: '合成业主', ownerPhone: '', plate: '示例TEST61', contactName: '合成联系人', contactPhone: '13800000000', relation: kind === 'family' ? '父母' : '', vehicleClass: '原价格分类', garages: kind === 'paid' ? ['local:sample-main'] : ['phase1', 'main', 'phase2'], garageNumbers: { main: '旧号A01' }, expiresAt: '2099-11-11T23:59:00+08:00', qrValid: true, openedAt: null, submittedAt: status === 'waiting' ? null : '2026-11-11T09:05:00+08:00', reviewedAt: status === 'approved' ? '2026-11-11T09:10:00+08:00' : null, reviewNote: '', files: [{ index: 0, fileName: '合成资料.svg', contentType: 'image/svg+xml', fileUrl: '/sample.svg', uploadedAt: '' }], transaction: params.has('txn') ? { id: 710, txnNo: 'SYNTHETIC-710', amountCents: 10000, startDate: '2026-11-11', endDate: '2027-01-11', externalSyncStatus: params.get('txn'), execution: null } : null, familyCarId: params.has('linked') ? 888 : null, createdAt: '2026-11-11T09:00:00+08:00', qr: { url: location.origin + '/vehicle-intake-form/synthetic-token', dataUrl: '/sample.svg', expiresAt: '2099-11-11T23:59:00+08:00' }, log: [{ at: '2026-11-11T09:00:00+08:00', userName: '合成办公室', action: '创建合成登记' }] };
let current: any = structuredClone(seed);
const w = window as any;
w.__calls = []; w.__failKind = false; w.__failGarage = false; w.__holdKind = false; w.__holdPoll = false; w.__failQuery = false; w.__rejectVoid = '';
w.__current = () => structuredClone(current);
const record = (url: string, method: string, data: any) => w.__calls.push({ url, method, data });
export const accessCardIssuance = {
  async createParkingQuery(plate: string) { record('/access-card-issuance/parking-queries', 'POST', { plate }); if (w.__failQuery) throw Error('合成：旧库查重失败，不能通过'); return { id: 901, status: 'completed' }; },
  async parkingQuery(id: number) { record('/access-card-issuance/parking-queries/' + id, 'GET', {}); return { id, status: 'completed' }; },
};
export async function request({ url, method = 'GET', data = {} }: any) {
  record(url, method, data);
  if (url === '/business/parking-targets') return targets;
  if (url.startsWith('/vehicle-intake-form/')) { if (current.status === 'void') throw Error('登记已撤销作废，二维码已失效'); return structuredClone(current); }
  if (method === 'GET' && w.__holdPoll) { const stale = structuredClone(current); await new Promise(resolve => { w.__releasePoll = resolve; }); return stale; }
  if (url.endsWith('/kind')) {
    if (w.__holdKind) await new Promise(resolve => { w.__releaseKind = resolve; });
    if (w.__failKind) throw Error('合成：登记转换失败，请保留输入重试');
    if (current.transaction || current.familyCarId) throw Error('合成：已关联财务或办理，不能转换');
    if (current.kind === 'family' && current.status === 'approved') throw Error('合成：已进入亲情车办理，请到亲情车管理核对');
    current = { ...current, kind: data.kind, status: current.status === 'approved' ? 'submitted' : current.status, relation: data.relation ?? '', vehicleClass: data.kind === 'paid' ? (data.vehicleClass || '') : '', garages: data.garages || [], garageNumbers: data.garageNumbers || {}, reviewedAt: null, log: [...current.log, { at: '2026-11-11T10:00:00+08:00', userName: '合成办公室', action: '转换登记类型，须重新审核', note: data.note }] };
  }
  if (url.endsWith('/garages')) { if (w.__failGarage) throw Error('合成：授权保存失败'); current = { ...current, ...data }; }
  if (url.endsWith('/review')) {
    if (data.decision === 'void' && w.__rejectVoid) throw Error(w.__rejectVoid);
    if (data.decision === 'approve' && current.kind === 'family' && (!data.relation || !data.duplicateCheckQueryId)) throw Error('关系及旧库查重必填');
    current = { ...current, ...(data.decision === 'approve' ? data : {}), status: data.decision === 'approve' ? 'approved' : data.decision, ...(data.decision === 'void' ? { qr: undefined, qrValid: false, expiresAt: '2026-11-11T00:00:00+08:00', transaction: current.transaction ? { ...current.transaction, externalSyncStatus: 'manual' } : null } : {}), familyCarId: data.decision === 'approve' && current.kind === 'family' ? 888 : current.familyCarId, log: [...current.log, { at: '2026-11-11T10:01:00+08:00', userName: '合成办公室', action: data.decision === 'void' ? '作废' : '资料审核通过，待经理审核', note: data.note }] };
  }
  if (url.endsWith('/class')) current = { ...current, vehicleClass: data.vehicleClass };
  return structuredClone(current);
}
// The test probes public-token refusal through the same isolated transport only.
w.__probeQr = () => request({ url: '/vehicle-intake-form/synthetic-token' }).then(() => 'valid', (e: Error) => e.message);
