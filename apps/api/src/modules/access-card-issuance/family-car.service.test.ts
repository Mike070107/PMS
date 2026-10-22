import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FamilyCarService } from './family-car.service';
import { ParkingProofService } from './parking-proof.service';
import { shanghaiDate, familyValidity } from './family-car.util';

/** 极简内存仓库：支持 where 等值 / In / Not、order id 倒序、create/save/delete */
function memRepo<T extends { id?: number }>(rows: any[] = []) {
  let seq = rows.reduce((max, row) => Math.max(max, row.id || 0), 0);
  const match = (row: any, where: any) => !where || Object.entries(where).every(([key, cond]: [string, any]) => {
    if (cond && typeof cond === 'object' && '_type' in cond) {
      if (cond._type === 'in') return cond._value.includes(row[key]);
      if (cond._type === 'not') return row[key] !== cond._value;
    }
    return row[key] === cond;
  });
  const sort = (list: any[], order: any) => order ? [...list].sort((a, b) => (b.id || 0) - (a.id || 0)) : list;
  const repo: any = {
    rows,
    create: (data: any) => ({ ...data }),
    save: async (data: any) => {
      if (!data.id) { data.id = ++seq; data.createdAt = new Date(Date.now() + seq); }
      data.updatedAt = new Date();
      const index = rows.findIndex((row) => row.id === data.id);
      if (index >= 0) { if (rows[index] !== data) Object.assign(rows[index], data); } else rows.push(data);
      return index >= 0 ? rows[index] : data;
    },
    findOne: async ({ where, order }: any = {}) => sort(rows.filter((row) => match(row, where)), order)[0] ?? null,
    find: async ({ where }: any = {}) => rows.filter((row) => match(row, where)),
    delete: async (where: any) => { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) rows.splice(i, 1); },
    upsert: async () => undefined,
  };
  repo.manager = { transaction: async (fn: any) => fn({ getRepository: () => repo }) };
  return repo as typeof repo & { rows: T[] };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const office = { id: 10, tenantId: 1 } as any;
const manager = { id: 20, tenantId: 1 } as any;

function setup(legacyRows: any[] = []) {
  const repos = {
    car: memRepo(),
    house: memRepo([{ id: 502, tenantId: 1, buildingId: 6, roomNo: '502' }]),
    building: memRepo([{ id: 6, tenantId: 1, communityId: 3, lane: '228', buildingNo: '6' }]),
    community: memRepo([{ id: 3, tenantId: 1, name: '枫桦景苑' }]),
    user: memRepo([{ id: 77, tenantId: 1, houseId: 502, role: 'owner', status: 'active', name: '王业主', phone: '13900000000' }, { id: 10, name: '办公室小李' }, { id: 20, name: '张经理' }]),
    query: memRepo(),
    op: memRepo(),
    proof: memRepo(),
  };
  const operations: any[] = [];
  const notices: any[] = [];
  const parking = {
    createParkingOperation: async (dto: any) => {
      const existing = repos.op.rows.find((row: any) => row.idempotencyKey === dto.idempotencyKey);
      if (existing) return existing;
      const saved = await repos.op.save({ tenantId: 1, kind: dto.kind, database: dto.database, idempotencyKey: dto.idempotencyKey, payload: dto.payload, status: 'pending', attempt: 0 });
      operations.push(saved);
      return saved;
    },
    setDeliyunCivilDefenseAuthorization: async () => ({ id: 999, status: 'pending' }),
  };
  const storage = { putBuffer: async (_b: Buffer, _t: string, folder: string, name: string) => ({ objectKey: `${folder}/${name}` }) };
  let family: FamilyCarService;
  const proofs = new ParkingProofService(
    repos.proof as any, storage as any, { get: () => 'https://prsznh.cn' } as any, memRepo() as any,
    { get: () => family } as any,
  );
  family = new FamilyCarService(
    repos.car as any, repos.house as any, repos.building as any, repos.community as any, repos.user as any,
    repos.query as any, repos.op as any, repos.proof as any, parking as any, proofs, storage as any,
    {
      // 办公室走网页那一格；经理只有小程序那一格也应该收到待审提醒
      userIdsWithPermission: async (_t: number, key: string) =>
        key === 'family-cars' ? [10] : key === 'app:family-car-approve' ? [30] : [],
    } as any,
    { notifyUser: async (input: any) => { notices.push(input); } } as any,
  );
  const check = async (plate: string) => repos.query.save({ tenantId: 1, queryKind: 'vehicle', term: plate, status: 'completed', completedAt: new Date(), rows: legacyRows });
  const complete = (id: number | null) => { const op = repos.op.rows.find((row: any) => row.id === id); assert.ok(op, `任务 ${id} 不存在`); op.status = 'completed'; op.completedAt = new Date(); };
  return { repos, operations, notices, family, proofs, check, complete };
}

const tokenOf = (url: string) => url.split('/parking-proof/')[1];

test('完整流程：登记 → 业主扫码填信息上传 → 办公室审核 → 经理审核 → 开通 → 续期一年 → 已生效', async () => {
  const { repos, operations, notices, family, proofs, check, complete } = setup();
  const q = await check('豫GQ3N07');
  const created = await family.create({ houseId: 502, plate: '豫G·Q3N07', duplicateCheckQueryId: q.id, ownerFill: true, garages: ['phase2'] }, office);
  assert.equal(created.plate, '豫GQ3N07', '车牌去点');
  assert.equal(created.status, 'upload');
  assert.equal(created.mode, 'new');
  assert.equal(created.roomKey, '228/6/502');
  assert.equal(created.ownerName, '王业主');
  assert.ok(created.qr.url.startsWith('https://prsznh.cn/parking-proof/'));
  const ttl = new Date(created.qr.expiresAt).getTime() - Date.now();
  assert.ok(ttl > 59 * 60_000 && ttl <= 60 * 60_000, '二维码 1 小时有效');
  // 新车牌先在旧库暂存（零授权）
  assert.equal(operations[0].kind, 'add_vehicle');
  assert.equal(operations[0].payload.identity, '亲情车');
  assert.equal(operations[0].payload.amount, 0);

  // 业主扫码：看到地址和车牌，填写车主信息并上传
  const token = tokenOf(created.qr.url);
  const session = await proofs.session(token);
  assert.equal(session.status, 'opened');
  assert.equal(session.family?.plate, '豫GQ3N07');
  assert.equal(session.family?.needsInfo, true);
  await assert.rejects(proofs.submit(token, [{ buffer: PNG, originalname: 'a.png' } as any], { carOwnerName: '王小明' }), /请填写车主姓名/);
  await assert.rejects(proofs.submit(token, [{ buffer: PNG, originalname: 'a.png' } as any], { carOwnerName: '王小明', carOwnerPhone: '123', relation: '子女' }), /手机号格式/);
  await proofs.submit(token, [{ buffer: PNG, originalname: '户口本.png' } as any, { buffer: PNG, originalname: '行驶证.png' } as any], { carOwnerName: '王小明', carOwnerPhone: '13800001111', relation: '子女' });
  await assert.rejects(proofs.submit(token, [{ buffer: PNG, originalname: 'b.png' } as any], {}), /已经上传/, '提交后链接失效');

  let car = await family.get(created.id, office);
  assert.equal(car.status, 'office', '业主提交后自动进入办公室审核');
  assert.equal(car.carOwnerName, '王小明');
  assert.equal(car.relation, '子女');
  assert.equal(car.files.length, 2);
  assert.equal(car.files[0].source, 'owner');
  assert.equal(car.upload?.status, 'submitted');
  assert.ok(notices.some((n) => n.receiverId === 10 && n.eventKey === 'family_car_update'), '办公室收到提醒');

  // 旧库暂存没完成前不能通过
  await assert.rejects(family.officeReview(created.id, 'approve', '', office), /旧库暂存还在执行/);
  complete(car.operations.registration);
  await family.officeReview(created.id, 'approve', '户口本可证明父子关系', office);
  car = await family.get(created.id, office);
  assert.equal(car.status, 'manager');
  const managerNotice = notices.find((n) => n.eventKey === 'family_car_pending_manager');
  assert.ok(managerNotice, '经理收到待审提醒');
  assert.equal(managerNotice.receiverId, 30, '只勾了小程序「亲情车经理审批」也能收到提醒');
  assert.equal(managerNotice.page, '/pages/approvals/approvals?section=family', '通知点开直达亲情车审批');
  assert.equal((await family.pendingManager(manager)).length, 1);

  // 经理退回 → 办公室重新提交 → 经理通过
  await assert.rejects(family.managerReview(created.id, 'return', '', manager), /退回原因/);
  await family.managerReview(created.id, 'return', '关系证明不清楚', manager);
  assert.equal((await family.get(created.id, office)).status, 'returned');
  await family.officeReview(created.id, 'approve', '已补充说明', office);
  const approved = await family.managerReview(created.id, 'approve', '同意', manager);
  assert.equal(approved.status, 'opening');
  const today = shanghaiDate();
  assert.equal(approved.startDate, today, '有效期从经理通过、开通当天起算');
  assert.equal(approved.endDate, familyValidity(today).endDate);

  // 开通凭证：最新一份证明已标为审核通过，车库授权带 familyReviewId
  const proof = repos.proof.rows.find((row: any) => row.id === approved.proofUploadId);
  assert.equal(proof.reviewStatus, 'approved');
  const open = operations.find((op) => op.kind === 'update_garages');
  assert.deepEqual(open.payload.garages, ['phase2']);
  assert.equal(open.payload.familyReviewId, proof.id);
  assert.equal(open.payload.ownerRoom, '228/6/502');

  // 车库授权完成 → 自动续期一年 → 已生效
  complete(open.id);
  car = await family.get(created.id, office);
  assert.equal(car.status, 'opening');
  const renew = operations.find((op) => op.kind === 'renew_vehicle');
  assert.ok(renew, '授权完成后调用续期');
  assert.equal(renew.payload.endDate, approved.endDate);
  assert.equal(renew.payload.amount, 0);
  complete(renew.id);
  car = await family.get(created.id, office);
  assert.equal(car.status, 'active');
  assert.equal(car.daysLeft! >= 364, true);

  // 同一车牌不能再登记
  const q2 = await check('豫GQ3N07');
  await assert.rejects(family.create({ houseId: 502, plate: '豫GQ3N07', duplicateCheckQueryId: q2.id, carOwnerName: 'x', carOwnerPhone: '13800001111', relation: '子女', garages: ['phase2'] }, office), /已有亲情车登记/);
});

test('办公室本地上传、要求补资料重新生成二维码、作废', async () => {
  const { family, proofs, check, repos } = setup();
  const q = await check('豫GB8E60');
  const car = await family.create({ houseId: 502, plate: '豫GB8E60', duplicateCheckQueryId: q.id, carOwnerName: '李四', carOwnerPhone: '13800002222', relation: '父母', garages: ['phase2', 'main'], garageNumbers: { main: 'A-12' } }, office);
  await assert.rejects(family.submit(car.id, office), /请先上传资料/);
  await family.addFiles(car.id, [{ buffer: PNG, originalname: '身份证.png' } as any], office);
  await assert.rejects(family.addFiles(car.id, [{ buffer: Buffer.from('hello'), originalname: 'x.txt' } as any], office), /只支持/);
  const submitted = await family.submit(car.id, office);
  assert.equal(submitted.status, 'office');
  const back = await family.officeReview(car.id, 'reupload', '身份证看不清', office);
  assert.equal(back.status, 'upload');
  assert.ok('qr' in back && back.qr, '补资料生成新二维码');
  // 旧二维码立即失效
  await assert.rejects(proofs.session(tokenOf(car.qr.url)), /过期/);
  await assert.rejects(family.officeReview(car.id, 'void', '', office), /作废原因/);
  const voided = await family.officeReview(car.id, 'void', '业主放弃', office);
  assert.equal(voided.status, 'void');
  // 作废后同车牌可重新登记
  const q2 = await check('豫GB8E60');
  await family.create({ houseId: 502, plate: '豫GB8E60', duplicateCheckQueryId: q2.id, ownerFill: true, garages: ['phase2'] }, office);
  assert.equal(repos.car.rows.length, 2);
});

test('车牌已是别户亲情车或住户车时禁止登记；查重过期必须重查', async () => {
  const other = setup([{ database: 'parking2', fields: { pPlate: '豫GZ9999', OwnerName: '228/9/101', CarBrand: '亲情车' } }]);
  const q = await other.check('豫GZ9999');
  await assert.rejects(other.family.create({ houseId: 502, plate: '豫GZ9999', duplicateCheckQueryId: q.id, ownerFill: true, garages: ['phase2'] }, office), /228\/9\/101/);
  const resident = setup([{ database: 'parking2', fields: { pPlate: '豫GZ9999', OwnerName: '228/6/502', CarBrand: '住户车' } }]);
  const q2 = await resident.check('豫GZ9999');
  await assert.rejects(resident.family.create({ houseId: 502, plate: '豫GZ9999', duplicateCheckQueryId: q2.id, ownerFill: true, garages: ['phase2'] }, office), /住户车/);
  const same = setup([{ database: 'parking2', fields: { pPlate: '豫GZ9999', OwnerName: '228/6/502', CarBrand: '亲情车' } }]);
  const q3 = await same.check('豫GZ9999');
  const renewed = await same.family.create({ houseId: 502, plate: '豫GZ9999', duplicateCheckQueryId: q3.id, ownerFill: true, garages: ['phase2'] }, office);
  assert.equal(renewed.mode, 'existing', '旧库已是本户亲情车：续登，不再新增');
  assert.equal(same.operations.length, 0);
  const stale = setup();
  const q4 = await stale.check('豫GA1234');
  q4.completedAt = new Date(Date.now() - 6 * 60_000);
  await assert.rejects(stale.family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q4.id, ownerFill: true, garages: ['phase2'] }, office), /超过 5 分钟/);
});

test('到期前 30 天提醒一次，到期后自动停用并撤销车库授权', async () => {
  const { family, repos, operations, notices } = setup();
  const today = shanghaiDate();
  const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
  const base = { tenantId: 1, houseId: 502, lane: '228', buildingNo: '6', roomNo: '502', ownerName: '王业主', ownerPhone: '', ownerUserId: 77, carOwnerName: '王小明', carOwnerPhone: '13800001111', relation: '子女', remark: '', database: 'parking2', garages: ['phase2'], garageNumbers: {}, mode: 'existing', status: 'active', ownerFill: false, files: [], log: [], remindedAt: null, previousId: null, createdBy: 10 };
  const soon = await repos.car.save({ ...base, plate: '豫GS0001', startDate: plus(-340), endDate: plus(20), proofUploadId: 1 });
  const past = await repos.car.save({ ...base, plate: '豫GP0002', startDate: plus(-366), endDate: plus(-1), proofUploadId: 2 });
  await family.tick();
  await family.tick();
  assert.equal(notices.filter((n) => n.title.includes('豫GS0001')).length, 1, '提醒只发一次');
  assert.equal(soon.status, 'active');
  assert.equal(past.status, 'expired');
  const off = operations.find((op) => op.kind === 'update_garages');
  assert.deepEqual(off.payload.garages, [], '到期撤销所有车库授权');
  assert.equal(off.payload.plate, '豫GP0002');
});
