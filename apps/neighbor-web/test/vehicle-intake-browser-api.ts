// Isolated browser fixture: no HTTP client, tokens, production endpoints or real vehicle writes.
const w = window as any;
w.__intakeCalls = [];
const target = { key: 'local:phase2_parking', label: '合成测试车库', short: '测试车库', system: 'local', billing: 'vehicle' };
const read = () => JSON.parse(localStorage.getItem('synthetic-intakes') || '[]');
const save = (rows: any[]) => localStorage.setItem('synthetic-intakes', JSON.stringify(rows));
const family = { id: 901, houseId: 5, lane: '228', buildingNo: '3', roomNo: '502', roomKey: '228/3/502', ownerName: '合成业主', carOwnerName: '合成车主', carOwnerPhone: '13900000000', relation: '父母', plate: '沪A合成01', status: 'office', statusLabel: '待办公室审核', mode: 'new', startDate: null, endDate: null, daysLeft: null, expiringSoon: false, garages: ['phase2'], garageNumbers: {}, fileCount: 0, files: [], log: [], officeNote: '', managerNote: '', lastError: null, registrationTerm: { mode: 'months', months: 12 }, createdAt: '2026-11-18T12:00:00Z' };
const familyCopy = () => JSON.parse(JSON.stringify(family));
export const address = { tree: async () => [{ id: 3, name: '合成验收小区', buildings: [{ id: 2, lane: '228', buildingNo: '3', houses: [{ id: 5, roomNo: '502', ownerName: '合成联系人', ownerPhone: '13900000000' }] }] }] };
export async function request(o: any): Promise<any> {
  if(o.url === '/business/estimate') return {quantity:o.data.months, amountCents:o.data.months * 10000, startDate:'2026-12-01', endDate:'2027-02-28'};
  if(o.url === '/vehicle-intake-form/synthetic-token') return {...read().find((row:any)=>row.homeUpload), requiresFiles:true,relations:[],fileCount:0};
  w.__intakeCalls.push(o);
  if (o.url === '/family-cars') return { rows: [familyCopy()], total: 1, page: 1, pageSize: o.query?.pageSize ?? 20, today: '2026-11-19' };
  if (o.url === '/family-cars/901' && o.method === 'PATCH') {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (w.__failFamily) { w.__failFamily = false; throw Error('合成保存失败，请保留输入重试'); }
    family.registrationTerm = o.data.registrationTerm;
    return familyCopy();
  }
  if (o.url === '/family-cars/901/office-review') { family.status = 'manager'; family.statusLabel = '待经理审核'; return familyCopy(); }
  if (o.url === '/family-cars/901') return familyCopy();
  if (o.url === '/owners-mgmt/business-contacts') return [];
  if (o.url === '/business/parking-targets') return [target];
  if (o.url === '/business/household-parking') return { room: '228/3/502', targets: [target], localDatabases: [], deliyun: [] };
  if (o.url === '/vehicle-intakes' && o.method !== 'POST') return read();
  if (o.url === '/vehicle-intakes' && o.method === 'POST') {
    await new Promise(resolve => setTimeout(resolve, 300));
    const rows = read(); const keys = JSON.parse(localStorage.getItem('synthetic-intake-keys') || '{}');
    let row = rows.find((r: any) => r.id === keys[o.data.operationKey]);
    const reused = !o.data.anotherVehicle && !row;
    row ??= !o.data.anotherVehicle ? rows.filter((r: any) => r.kind === o.data.kind && r.houseId === o.data.houseId).at(-1) : null;
    if (!row) {
      row = { id: rows.length + 1, tenantId: 1, houseId: 5, houseLabel: '合成验收小区/228弄3号502', kind: o.data.kind,
        status: 'waiting', plate: '', contactName: '', contactPhone: '', relation: '', ownerName: '合成联系人', ownerPhone: '13900000000',
        files: [], log: [], garages: [], garageNumbers: {}, qrValid: true, expiresAt: '2099-01-01T00:00:00Z',
        openedAt: null, submittedAt: null, reviewedAt: null, reviewNote: '', transaction: null, familyCarId: null,
        inputSource: 'owner', dataVersion: 1, officeConfirmedVersion: null, registrationTerm: null,
        qr: { dataUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="%23eee"/><text x="25" y="120">SYNTHETIC QR</text></svg>', url: 'https://invalid.test/synthetic-only', expiresAt: '2099-01-01T00:00:00Z' } };
      rows.push(row); save(rows);
    }
    keys[o.data.operationKey] = row.id;
    localStorage.setItem('synthetic-intake-keys', JSON.stringify(keys));
    if (w.__failNext) { w.__failNext = false; throw Error('合成超时：已提交，重试继续原操作'); }
    return { ...row, reused, otherDraftIds: rows.filter((r: any) => r.id !== row.id && r.kind === row.kind).map((r: any) => r.id) };
  }
  const match = o.url.match(/^\/vehicle-intakes\/(\d+)(?:\/(show-qr|garages|class|home-upload))?$/);
  if (match) { const rows = read(); const row = rows.find((r: any) => r.id === +match[1]); if (!row) throw Error('不存在'); if(match[2] === 'home-upload') {row.plate=o.data.plate;row.homeUpload=true;save(rows);} if (match[2] === 'class' || match[2] === 'garages') { Object.assign(row, o.data); save(rows); } return row; }
  throw Error(`Isolated fixture refused unknown API: ${o.url}`);
}
export const accessCardIssuance = { createParkingQuery: async () => ({ id: 1, status: 'completed', rows: [] }), parkingQuery: async () => ({ id: 1, status: 'completed', rows: [] }) };
export const uploadBlobTo = async () => ({ objectKey: 'synthetic', publicUrl: 'synthetic', displayUrl: 'synthetic', bucket: 'synthetic' });
export const repairs = { locationSuggestions: async () => [], create: async () => ({ id: 1 }) };

// 办公室代填走 multipart fetch，不是 request()；这里用合成响应验证真实组件接线，不写生产。
const realFetch = window.fetch.bind(window);
window.fetch = async (input: any, init: any = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if(url.endsWith('/vehicle-intake-form/synthetic-token') && init.method === 'POST') {
    const rows = read(); const row = rows.find((item:any) => item.homeUpload);
    if(init.body.get('plate') !== row.plate || !init.body.get('file')) throw Error('资料不完整');
    Object.assign(row,{status:'submitted', submittedAt:new Date().toISOString(),contactPhone:init.body.get('contactPhone')});
    save(rows); return Response.json(row);
  }
  const match = url.match(/\/vehicle-intakes\/(\d+)\/office$/);
  if (match && init.method === 'POST') {
    await new Promise(resolve => setTimeout(resolve, 120));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (w.__failOffice) { w.__failOffice = false; return json(400, { message: '合成保存失败，已填写内容和资料都还在' }); }
    const data = JSON.parse(String(init.body.get('data')));
    const rows = read(); const row = rows.find((r: any) => r.id === +match[1]);
    if (!row) return json(404, { message: '登记不存在' });
    if (data.expectedVersion !== row.dataVersion) return json(400, { message: '登记资料已更新，请刷新后核对，未覆盖他人修改' });
    const nextVersion = row.dataVersion + 1;
    Object.assign(row, {
      plate: data.plate ?? row.plate, contactName: data.contactName ?? row.contactName,
      contactPhone: data.contactPhone ?? row.contactPhone, relation: data.relation ?? row.relation,
      registrationTerm: data.registrationTerm ?? row.registrationTerm, inputSource: 'office', dataVersion: nextVersion,
      officeConfirmedVersion: data.confirm ? nextVersion : null,
      status: data.confirm ? 'submitted' : 'waiting',
      submittedAt: data.confirm ? '2026-11-19T01:00:00Z' : null,
    });
    save(rows);
    return json(200, row);
  }
  return realFetch(input, init);
};
