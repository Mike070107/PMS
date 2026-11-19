import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FamilyCarService } from './family-car.service';
import { ParkingProofService } from './parking-proof.service';
import { FamilyCar, House, Building, Community, User, ParkingQuery, ParkingOperation, ParkingProofUpload, TenantConfig } from '../../entities';
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
    createQueryBuilder: () => {
      let where: any;
      const builder: any = { setLock: () => builder, where: (_sql: string, values: any) => { where = values; return builder; }, getOne: async () => rows.find(row => match(row, where)) ?? null };
      return builder;
    },
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
  const configRepo = memRepo();
  const byEntity = new Map<any, any>([[FamilyCar, repos.car], [House, repos.house], [Building, repos.building], [Community, repos.community], [User, repos.user], [ParkingQuery, repos.query], [ParkingOperation, repos.op], [ParkingProofUpload, repos.proof], [TenantConfig, configRepo]]);
  // Workflow-only fake. Ownership SQL/rollback are covered by the isolated persistence suite.
  const transactionManager: any = { queryRunner: { isTransactionActive: true }, getRepository: (entity: any) => byEntity.get(entity), query: async () => [], transaction: async (work: any) => work(transactionManager) };
  for (const repo of byEntity.values()) repo.manager = transactionManager;
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
    createParkingQuery: async (dto: any) => repos.query.save({ tenantId: 1, queryKind: 'vehicle', term: dto.term, status: 'pending', completedAt: null, rows: [] }),
    setDeliyunCivilDefenseAuthorization: async (dto: any, _user: any, retryFailed = false) => {
      const existing = repos.op.rows.find((row: any) => row.idempotencyKey === dto.idempotencyKey);
      if (existing) { if (retryFailed && existing.status === 'failed') existing.status = 'pending'; return existing; }
      const saved = await repos.op.save({ tenantId: 1, kind: 'update_garages', database: 'deliyun', idempotencyKey: dto.idempotencyKey, payload: dto, status: 'pending' });
      operations.push(saved);
      return saved;
    },
  };
  const storage = { putBuffer: async (_b: Buffer, _t: string, folder: string, name: string) => ({ objectKey: `${folder}/${name}` }) };
  let family: FamilyCarService;
  const proofs = new ParkingProofService(
    repos.proof as any, storage as any, { get: () => 'https://prsznh.cn' } as any, configRepo as any,
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
  return { repos, operations, notices, family, proofs, check, complete, manager: transactionManager };
}

const tokenOf = (url: string) => url.split('/parking-proof/')[1];

test('本地代填亲情车无附件仍可经理审批，经理退回后办公室不再强制补附件', async () => {
  const { family, check, repos, manager: txManager } = setup(); const q = await check('沪A12345');
  const car = await family.createFromIntake({ houseId: 502, plate: '沪A12345', duplicateCheckQueryId: q.id, carOwnerName: '本车联系人', carOwnerPhone: '13711112222', relation: '子女', garages: ['phase2'] }, [], '现场已核验关系，附件选填', office, undefined, { manager: txManager, intakeId: 9001 }, true);
  assert.equal(car.files.length, 0); assert.equal(car.status, 'manager', '办公室确认后直接进入经理审核，审批前不写旧库');
  let read = await family.get(car.id, office); assert.equal(read.status, 'manager');
  await family.managerReview(car.id, 'return', '请复核关系', manager);
  await family.officeReview(car.id, 'approve', '已复核', office);
  read = await family.get(car.id, office); assert.equal(read.status, 'manager');
  const approved = await family.managerReview(car.id, 'approve', '同意', manager);
  assert.equal(approved.status, 'opening'); assert.notEqual(approved.status, 'active');
  assert.equal(repos.user.rows.find((row: any) => row.id === 77).phone, '13900000000');
});

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
  assert.equal(operations.length, 0, '登记只存 PMS，审批前连零授权暂存都不能创建');

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

  await assert.rejects(family.officeReview(created.id, 'unknown' as any, '', office), /审核决定无效/);
  assert.equal(operations.length, 0, '业主提交不产生旧库任务');
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
  assert.equal(operations.length, 0, '办公室确认和经理退回均不产生旧库任务');
  await assert.rejects(family.managerReview(created.id, 'unknown' as any, '', manager), /审批决定无效/);
  const approved = await family.managerReview(created.id, 'approve', '同意', manager);
  assert.equal(operations.length, 1, '经理通过后只创建第一步登记');
  assert.equal(operations[0].kind, 'add_vehicle');
  assert.equal(operations[0].payload.identity, '亲情车');
  assert.equal(operations[0].payload.amount, 0);
  assert.equal(operations[0].payload.duplicateCheckQueryId, q.id);
  await family.get(created.id, office);
  assert.equal(operations.length, 1, '登记未完成不提前授权或续期');
  complete(approved.operations.registration);
  await family.get(created.id, office);
  assert.equal(operations.length, 2, '登记读回成功后才创建授权');
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
  await assert.rejects(family.create({ houseId: 502, plate: '豫GQ3N07', duplicateCheckQueryId: q2.id, carOwnerName: 'x', carOwnerPhone: '13800001111', relation: '子女', garages: ['phase2'] }, office), /该车牌已有不兼容的登记/);
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
  await assert.rejects(other.family.create({ houseId: 502, plate: '豫GZ9999', duplicateCheckQueryId: q.id, ownerFill: true, garages: ['phase2'] }, office), (error: Error) => { assert.match(error.message, /已有不兼容/); assert.doesNotMatch(error.message, /228|101|9\/101/); return true; });
  const resident = setup([{ database: 'parking2', fields: { pPlate: '豫GZ9999', OwnerName: '228/6/502', CarBrand: '住户车' } }]);
  const q2 = await resident.check('豫GZ9999');
  await assert.rejects(resident.family.create({ houseId: 502, plate: '豫GZ9999', duplicateCheckQueryId: q2.id, ownerFill: true, garages: ['phase2'] }, office), (error: Error) => { assert.match(error.message, /已有不兼容/); assert.doesNotMatch(error.message, /228|住户车/); return true; });
  const same = setup([{ database: 'parking2', fields: { pPlate: '豫GZ9999', OwnerName: '228/6/502', CarBrand: '亲情车' } }]);
  const q3 = await same.check('豫GZ9999');
  const renewed = await same.family.create({ houseId: 502, plate: '豫GZ9999', duplicateCheckQueryId: q3.id, ownerFill: true, garages: ['phase2'] }, office);
  assert.equal(renewed.mode, 'existing', '旧库已是本户亲情车：续登，不再新增');
  assert.equal(same.operations.length, 0);
  const stale = setup();
  const q4 = await stale.check('豫GA1234');
  q4.completedAt = new Date(Date.now() - 6 * 60_000);
  await assert.rejects(stale.family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q4.id, ownerFill: true, garages: ['phase2'] }, office), /超过 5 分钟/);
  q4.completedAt = new Date(Date.now() + 60_000);
  await assert.rejects(stale.family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q4.id, ownerFill: true, garages: ['phase2'] }, office), /时间无效/);
  assert.equal(stale.operations.length, 0);
});

test('审批时查重已过期：先等新的只读查询，冲突时保持原单且不创建写任务', async () => {
  const { family, repos, operations, check } = setup();
  const q = await check('豫GA1234');
  const car = await family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q.id, carOwnerName: '李四', carOwnerPhone: '13800002222', relation: '父母', garages: ['phase2'] }, office);
  await family.addFiles(car.id, [{ buffer: PNG, originalname: 'a.png' } as any], office);
  await family.submit(car.id, office);
  await family.officeReview(car.id, 'approve', '', office);
  q.completedAt = new Date(Date.now() - 6 * 60_000);
  const approved = await family.managerReview(car.id, 'approve', '', manager);
  assert.equal(approved.status, 'opening');
  assert.equal(approved.startDate, null, '尚未释放写任务不提前起算期限');
  assert.equal(operations.length, 0);
  assert.equal(repos.query.rows.length, 2, '只创建一次新只读查询');
  await family.get(car.id, office);
  assert.equal(repos.query.rows.length, 2, '轮询不重复创建正在等待的查询');
  repos.query.rows[1].createdAt = new Date(Date.now() - 6 * 60_000);
  await family.get(car.id, office);
  assert.equal(repos.query.rows.length, 3, '无回执查询超时后允许重新发起只读查询');
  assert.equal(operations.length, 0);
  const refreshed = repos.query.rows[2];
  Object.assign(refreshed, { status: 'completed', completedAt: new Date(), rows: [{ database: 'parking2', fields: { pPlate: '豫GA1234', OwnerName: '228/9/101', CarBrand: '亲情车' } }] });
  const conflict = (await family.get(car.id, office)).lastError!;
  assert.match(conflict, /已有不兼容/);
  assert.doesNotMatch(conflict, /228|9\/101|亲情车/);
  assert.equal(operations.length, 0, '执行前查重出现冲突必须等待处理');
  refreshed.rows = [];
  await family.retry(car.id, office);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].payload.duplicateCheckQueryId, refreshed.id);
});

test('登记失败重试原步骤，固定期限；晚到的业主回调不可改已执行资料', async () => {
  const { family, repos, operations, check } = setup();
  const q = await check('豫GA1234');
  const car = await family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q.id, carOwnerName: '李四', carOwnerPhone: '13800002222', relation: '父母', garages: ['phase2'] }, office);
  await family.addFiles(car.id, [{ buffer: PNG, originalname: 'a.png' } as any], office);
  await family.submit(car.id, office);
  await family.officeReview(car.id, 'approve', '', office);
  const approved = await family.managerReview(car.id, 'approve', '', manager);
  const row = repos.car.rows[0];
  row.startDate = '2026-01-10'; row.endDate = '2027-01-09';
  operations[0].status = 'failed'; operations[0].lastError = 'synthetic failure';
  await family.retry(car.id, office);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].id, approved.operations.registration);
  assert.equal(operations[0].status, 'pending');
  assert.equal(row.startDate, '2026-01-10'); assert.equal(row.endDate, '2027-01-09');
  const before = JSON.stringify({ files: row.files, carOwnerName: row.carOwnerName });
  await assert.rejects(family.ownerSubmitted(car.id, [{ objectKey: 'late', fileName: 'late.png', contentType: 'image/png', source: 'owner', uploadedAt: new Date().toISOString() }], { carOwnerName: 'late', carOwnerPhone: '13800000000', relation: '父母' }), /不能再通过旧二维码修改/);
  assert.equal(JSON.stringify({ files: row.files, carOwnerName: row.carOwnerName }), before);
});

test('资料版本变化后原办公室确认与经理审批失效，执行前必须重新逐级确认', async () => {
  const { family, repos, operations, check } = setup();
  const q = await check('豫GA1234');
  const car = await family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q.id, carOwnerName: '李四', carOwnerPhone: '13800002222', relation: '父母', garages: ['phase2'] }, office);
  await family.addFiles(car.id, [{ buffer: PNG, originalname: 'a.png' } as any], office);
  await family.submit(car.id, office);
  const row = () => repos.car.rows[0];
  assert.ok(row().dataVersion >= 1, 'new registrations always carry an explicit material version');
  await assert.rejects(() => family.officeReview(car.id, 'approve', '', office, undefined, row().dataVersion + 99), /资料已更新/);
  await family.officeReview(car.id, 'approve', '', office, undefined, row().dataVersion);
  assert.equal(row().officeConfirmedVersion, row().dataVersion, '办公室确认绑定当前版本');
  assert.equal(operations.length, 0, '办公室确认不创建任何旧库写任务');
  // 经理审批时必须仍对应当前资料版本：确认过期则拒绝，不静默放行
  const version = row().dataVersion;
  row().officeConfirmedVersion = version - 1;
  await assert.rejects(() => family.managerReview(car.id, 'approve', '', manager), /办公室确认已失效/);
  row().officeConfirmedVersion = version;
  await family.managerReview(car.id, 'approve', '', manager, undefined, version);
  assert.equal(row().managerApprovedVersion, version);
  assert.equal(operations.length, 1, '经理通过才创建旧库写任务');
  // 迁移前历史记录（版本 0）沿用时间戳证明；迁移后任何资料变更都会清空确认，不能借历史规则绕过
  row().dataVersion = version;
  row().officeConfirmedVersion = null;
  row().managerApprovedVersion = null;
  row().status = 'opening';
  await assert.rejects(() => family.retry(car.id, office), /原办公室确认和经理审批已失效/);
});

test('人防待执行或失败不能提前标为已生效，原人防任务完成后才生效', async () => {
  const { family, operations, check, complete } = setup([{ database: 'parking2', fields: { pPlate: '豫GA1234', OwnerName: '228/6/502', CarBrand: '亲情车' } }]);
  const q = await check('豫GA1234');
  const car = await family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q.id, carOwnerName: '李四', carOwnerPhone: '13800002222', relation: '父母', garages: ['phase2', 'civil'], garageNumbers: { civil: 'C12' } }, office);
  await family.addFiles(car.id, [{ buffer: PNG, originalname: 'a.png' } as any], office);
  await family.submit(car.id, office);
  await family.officeReview(car.id, 'approve', '', office);
  assert.equal(operations.length, 0);
  await family.managerReview(car.id, 'approve', '', manager);
  assert.ok(!operations.some(op => op.kind === 'add_vehicle'), '本户已有合规车不新增');
  const local = operations.find(op => op.database !== 'deliyun' && op.kind === 'update_garages');
  const civil = operations.find(op => op.database === 'deliyun');
  complete(local.id);
  await family.get(car.id, office);
  complete(operations.find(op => op.kind === 'renew_vehicle').id);
  assert.equal((await family.get(car.id, office)).status, 'opening', '人防 pending 不得提前生效');
  civil.status = 'failed'; civil.lastError = 'synthetic failure';
  assert.equal((await family.get(car.id, office)).status, 'opening');
  await family.retry(car.id, office);
  assert.equal(operations.filter(op => op.database === 'deliyun').length, 1);
  complete(civil.id);
  assert.equal((await family.get(car.id, office)).status, 'active');
});

test('1个月登记按月末钳制期限执行，自定义未来起始日等待且不平移', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-30T16:30:00Z') });
  const h = setup();
  const q = await h.check('豫GA1234');
  const car = await h.family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q.id, carOwnerName: '李四', carOwnerPhone: '13800002222', relation: '父母', garages: ['phase2'], registrationTerm: { mode: 'months', months: 1 } }, office);
  await h.family.addFiles(car.id, [{ buffer: PNG, originalname: 'a.png' } as any], office);
  await h.family.submit(car.id, office);
  await h.family.officeReview(car.id, 'approve', '', office);
  const approved = await h.family.managerReview(car.id, 'approve', '', manager);
  assert.equal(approved.startDate, '2026-01-31'); assert.equal(approved.endDate, '2026-02-27');
  assert.equal(h.operations[0].payload.months, 1);
  h.complete(approved.operations.registration);
  await h.family.get(car.id, office);
  h.complete(h.operations.find(op => op.kind === 'update_garages').id);
  await h.family.get(car.id, office);
  const renew = h.operations.find(op => op.kind === 'renew_vehicle');
  assert.equal(renew.payload.months, 1); assert.equal(renew.payload.endDate, '2026-02-27');

  const custom = setup();
  const cq = await custom.check('豫GA1234');
  const cc = await custom.family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: cq.id, carOwnerName: '李四', carOwnerPhone: '13800002222', relation: '父母', garages: ['phase2'], registrationTerm: { mode: 'dates', startDate: '2026-02-01', endDate: '2026-02-15', reason: '临时安排' } }, office);
  await custom.family.addFiles(cc.id, [{ buffer: PNG, originalname: 'a.png' } as any], office);
  await custom.family.submit(cc.id, office);
  await custom.family.officeReview(cc.id, 'approve', '', office);
  const ca = await custom.family.managerReview(cc.id, 'approve', '', manager);
  assert.equal(ca.startDate, '2026-02-01'); assert.equal(ca.endDate, '2026-02-15');
  assert.equal(custom.operations.length, 0, '未来起始日连登记任务也不能释放');
  await custom.family.retry(cc.id, office);
  assert.equal(custom.operations.length, 0);
  t.mock.timers.tick(24 * 60 * 60_000);
  const fresh = await custom.check('豫GA1234');
  custom.repos.car.rows[0].duplicateCheckQueryId = fresh.id;
  await custom.family.get(cc.id, office);
  assert.equal(custom.operations.length, 1);
  assert.equal(custom.operations[0].payload.startDate, '2026-02-01');
  assert.equal(custom.operations[0].payload.endDate, '2026-02-15');
  assert.ok(!('months' in custom.operations[0].payload), '自定义日期不伪装成12个月');
});

test('退回原单可修改期限并清除旧确认，审批中不可改；过期或非法期限不保存', async () => {
  const { family, repos, operations, check } = setup();
  const q = await check('豫GA1234');
  const car = await family.create({ houseId: 502, plate: '豫GA1234', duplicateCheckQueryId: q.id, carOwnerName: '李四', carOwnerPhone: '13800002222', relation: '父母', garages: ['phase2'] }, office);
  await family.addFiles(car.id, [{ buffer: PNG, originalname: 'a.png' } as any], office);
  await family.submit(car.id, office);
  await family.officeReview(car.id, 'approve', '', office);
  await assert.rejects(family.update(car.id, { registrationTerm: { mode: 'months', months: 1 } }, office), /当前状态不能修改/);
  await family.managerReview(car.id, 'return', '请核对申请期限', manager);
  const changed = await family.update(car.id, { registrationTerm: { mode: 'months', months: 1 } }, office);
  assert.equal(changed.id, car.id, '退回仍在原单修改');
  assert.deepEqual(changed.registrationTerm, { mode: 'months', months: 1 });
  const saved = repos.car.rows[0];
  assert.equal(saved.officeReviewedBy, null); assert.equal(saved.officeReviewedAt, null);
  assert.equal(saved.managerReviewedBy, null); assert.equal(saved.managerReviewedAt, null);
  assert.ok(changed.log.some((entry: any) => entry.action.includes('原确认与审批失效')));
  await assert.rejects(family.update(car.id, { registrationTerm: { mode: 'months', months: 0 } }, office), /月数/);
  await assert.rejects(family.update(car.id, { registrationTerm: { mode: 'dates', startDate: '2000-01-01', endDate: '2000-01-31', reason: '已过期' } }, office), /已经结束/);
  assert.deepEqual(saved.registrationTerm, { mode: 'months', months: 1 });
  assert.equal(operations.length, 0, '退回、修改与重新确认前均没有旧库写任务');
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
