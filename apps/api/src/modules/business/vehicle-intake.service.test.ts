import assert from 'node:assert/strict';
import test from 'node:test';
import { VehicleIntakeService } from './vehicle-intake.service';
import { VehicleIntake, BusinessTransaction, BusinessLog } from '../../entities';

/** 极简内存仓库：支持 findOne/save/create、update().set().where(id + 状态).execute() */
function repo<T extends { id?: number }>(rows: T[]) {
  let seq = rows.length;
  const match = (row: any, where: any) => Object.entries(where || {}).every(([k, v]: [string, any]) => v?._type === 'in' ? v._value.includes(row[k]) : v?._type === 'isNull' ? row[k] == null : row[k] === v);
  const selected = (where: any, order?: any) => {
    const matches = rows.filter((row) => match(row, where));
    return order?.id === 'DESC' ? matches.sort((a, b) => Number(b.id) - Number(a.id)) : matches;
  };
  const r: any = {
    rows,
    create: (x: any) => ({ ...x }),
    findOne: async ({ where, order }: any) => selected(where, order)[0] ?? null,
    find: async ({ where, order }: any) => selected(where, order),
    save: async (x: any) => {
      if (Array.isArray(x)) return Promise.all(x.map(r.save));
      if (!x.id) { x.id = ++seq; x.createdAt = new Date(); x.updatedAt = new Date(); rows.push(x); }
      else { const i = rows.findIndex((row) => row.id === x.id); if (i >= 0) rows[i] = x; else rows.push(x); }
      return x;
    },
    update: async (where: any, patch: any) => { rows.filter((row) => match(row, where)).forEach((row) => Object.assign(row, patch)); },
    createQueryBuilder: () => {
      let patch: any; let cond: any;
      const qb: any = {
        update: () => qb, set: (p: any) => { patch = p; return qb; },
        where: (_sql: string, params: any) => { cond = params; return qb; },
        getOne: async () => rows.find((x: any) => x.tenantId === cond.tenantId && x.plate === cond.plate && x.id !== cond.id && x.status !== cond.status) ?? null,
        execute: async () => {
          const allowed = cond.st ? (Array.isArray(cond.st) ? cond.st : [cond.st]) : cond.ss;
          const row: any = rows.find((x: any) => x.id === cond.id && (allowed.includes(x.status ?? x.externalSyncStatus)));
          if (!row) return { affected: 0 };
          Object.assign(row, patch); return { affected: 1 };
        },
      };
      return qb;
    },
    manager: { save: async () => undefined, create: (_e: any, x: any) => x },
  };
  return r;
}

function setup(mode: 'queued' | 'mocked' = 'queued') {
  const intakes = repo<any>([]);
  const txns = repo<any>([]);
  const logs = repo<any>([]);
  // Existing sequential workflow fixture now exposes the transaction-scoped repositories.
  // Lock/race/rollback semantics are covered by vehicle-intake-kind-safety.test.ts.
  const repositories = new Map<any, any>([[VehicleIntake, intakes], [BusinessTransaction, txns], [BusinessLog, logs]]);
  const operations: any[] = [];
  const manager: any = {
    queryRunner: { isTransactionActive: true },
    save: async () => undefined, create: (_entity: any, value: any) => value,
    getRepository: (entity: any) => { if (!repositories.has(entity)) repositories.set(entity, repo<any>([])); return repositories.get(entity); },
    transaction: async (work: any) => work(manager),
    query: async (sql: string, params: any[]) => {
      if (/SELECT id FROM houses .* FOR UPDATE/.test(sql)) { assert.deepEqual(params, [5, 1]); return [{ id: 5 }]; }
      if (/^INSERT INTO vehicle_intake_operations/.test(sql)) {
        operations.push({ tenant_id: params[0], operation_key: params[1], house_id: params[2], request_hash: params[3], intake_id: params[4] });
        return [];
      }
      if (/FROM vehicle_intake_operations/.test(sql)) {
        return operations.filter((row) => row.tenant_id === params[0] && row.operation_key === params[1]);
      }
      // Dedicated persistence tests execute these statements against isolated PostgreSQL.
      assert.match(sql, /pg_advisory_xact_lock|FROM vehicle_intakes i|FROM family_cars f|vehicle_registration_claims/);
      return [];
    },
  };
  for (const repository of repositories.values()) repository.manager = manager;
  const house = { id: 5, buildingId: 2, roomNo: '502', tenantId: 1 };
  const kicked: number[] = [];
  const service = new VehicleIntakeService(
    intakes, txns, logs,
    { findOne: async () => house } as any,
    { findOne: async () => ({ id: 2, communityId: 3, lane: '228', buildingNo: '3' }) } as any,
    { findOne: async () => ({ id: 3, name: '枫桦景苑二期' }) } as any,
    { findOne: async ({ where }: any) => (where.role ? { id: 9, name: '张三', phone: '13800000000' } : { id: where.id, name: '前台' }) } as any,
    { putBuffer: async (_b: Buffer, _t: string, _f: string, name: string) => ({ objectKey: `k/${name}` }) } as any,
    { createFromIntake: async () => ({ id: 77 }) } as any,
    { initialFor: () => ({ status: mode, execution: mode === 'queued' ? { connector: 'deliyun', mode: 'dry-run', attempts: 0 } : null }), kick: (id: number) => kicked.push(id) } as any,
    { get: () => 'https://prsznh.cn' } as any,
  );
  const user = { id: 1, tenantId: 1 } as any;
  return { service, intakes, txns, user, kicked };
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const file = (name = 'xsz.jpg') => ({ buffer: jpeg, originalname: name }) as any;
const tokenOf = (url: string) => url.split('/').pop()!;

test('paid intake: owner fills plate on phone, payment waits for docs, approval releases it into execution', async () => {
  const { service, intakes, txns, user, kicked } = setup();
  const created = await service.create({ houseId: 5, kind: 'paid', garages: ['local:phase2_parking'], formBase: 'https://prsznh.cn/beta/m/plate' }, user);
  assert.ok(created.qr, 'new unexpired draft returns its QR');
  assert.equal(created.status, 'waiting');
  assert.match(created.qr.url, /^https:\/\/prsznh\.cn\/beta\/m\/plate\/[A-Za-z0-9_-]{20,}$/);
  assert.equal(created.houseLabel, '枫桦景苑二期/228弄3号502');
  const token = tokenOf(created.qr.url);

  // 新版create必须先审核；显式模拟上线前无版本标记的历史单以复核待资料兼容。
  await assert.rejects(() => service.claimForPayment(created.id, 5, user), /须先提交/);
  intakes.rows[0].log.forEach((entry: any) => delete entry.registrationVersion);
  // 历史先收款：资料未齐 → 流水挂「待业主资料」
  const claim = await service.claimForPayment(created.id, 5, user);
  assert.equal(claim.approved, false);
  const txn = await txns.save({ tenantId: 1, txnNo: 'P1', amountCents: 45000, externalSyncStatus: 'awaiting_docs', snapshot: { parking: { newVehicle: true } } });
  await service.attachPayment(claim.row, txn, user);
  await assert.rejects(() => service.claimForPayment(created.id, 5, user), /已关联办理或收款流水/);

  const opened = await service.publicSession(token);
  assert.equal(opened.ownerName, '张**');
  await assert.rejects(() => service.publicSubmit(token, [file()], { plate: '豫G·QN07', contactName: '李四', contactPhone: '13900000000' }), /车牌格式/);
  await assert.rejects(() => service.publicSubmit(token, [], { plate: '豫GQ3N07', contactName: '李四', contactPhone: '123' }), /手机号/);
  const sent = await service.publicSubmit(token, [file()], { plate: '豫g q3n07', contactName: '李四', contactPhone: '139-0000-0000' });
  assert.equal(sent.status, 'submitted');
  assert.equal(sent.contactPhone, '139****0000');
  await assert.rejects(() => service.publicSubmit(token, [file()], { plate: '豫GQ3N07', contactName: '李四', contactPhone: '13900000000' }), /已经提交/);

  const approved = await service.review(created.id, { decision: 'approve' }, user);
  assert.equal(approved.status, 'approved');
  assert.equal(txns.rows[0].externalSyncStatus, 'queued');
  assert.equal(txns.rows[0].snapshot.vehicle.plateNo, '豫GQ3N07');
  assert.deepEqual(kicked, [txn.id]);
  const log = intakes.rows[0].log.map((x: any) => x.action);
  assert.deepEqual(log.slice(0, 2), ['生成新办车牌扫码登记', '已收款 ¥450.00']);
  assert.ok(log.includes('业主提交车牌和资料') && log.includes('资料审核通过'));
});

test('reupload keeps the same QR usable; regenerating invalidates the old one', async () => {
  const { service, user } = setup();
  const created = await service.create({ houseId: 5, kind: 'paid', garages: ['local:phase2_parking'], formBase: 'https://prsznh.cn/beta/m/plate' }, user);
  assert.ok(created.qr, 'new unexpired draft returns its QR');
  const token = tokenOf(created.qr.url);
  await service.publicSubmit(token, [file()], { plate: '豫GQ3N07', contactName: '李四', contactPhone: '13900000000' });
  await assert.rejects(() => service.review(created.id, { decision: 'reupload' }, user), /补什么/);
  await service.review(created.id, { decision: 'reupload', note: '行驶证看不清' }, user);
  const again = await service.publicSession(token);
  assert.equal(again.reviewNote, '行驶证看不清');
  // 刷新页面后再显示：同一个码
  const again2 = await service.showQr(created.id, 'https://prsznh.cn/beta/m/plate', user);
  assert.equal(again2.qr.url, created.qr.url);
  const fresh = await service.regenerate(created.id, 'https://prsznh.cn/beta/m/plate', user);
  assert.notEqual(fresh.qr.url, created.qr.url);
  assert.equal((await service.showQr(created.id, 'https://prsznh.cn/beta/m/plate', user)).qr.url, fresh.qr.url);
  await assert.rejects(() => service.publicSession(token), /链接无效/);
  const kept = await service.publicSubmit(tokenOf(fresh.qr.url), [], { plate: '豫GQ3N07', contactName: '李四', contactPhone: '13900000000', keepFiles: '1' });
  assert.equal(kept.fileCount, 1);
});

test('expired QR is refused; foreign form hosts are refused', async () => {
  const { service, intakes, user } = setup();
  await assert.rejects(() => service.create({ houseId: 5, kind: 'paid', formBase: 'https://evil.example.com/m' }, user), /不属于本系统/);
  const created = await service.create({ houseId: 5, kind: 'family', formBase: 'https://prsznh.cn/beta/m/plate' }, user);
  assert.ok(created.qr, 'new unexpired draft returns its QR');
  const token = tokenOf(created.qr.url);
  intakes.rows[0].expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(() => service.publicSession(token), /已过期/);
  const base = 'https://prsznh.cn/beta/m/plate';
  const resumed = await service.regenerate(created.id, base, user, undefined, true);
  assert.equal(resumed.id, created.id);
  assert.notEqual(tokenOf(resumed.qr.url), token);
  assert.equal((await service.regenerate(created.id, base, user, undefined, true)).qr.url, resumed.qr.url);
  await assert.rejects(() => service.publicSession(token), /链接无效/);
  await service.publicSubmit(tokenOf(resumed.qr.url), [file()], { plate: '沪A12345', relation: '父母', contactPhone: '13900000000' });
  await assert.rejects(() => service.regenerate(created.id, base, user, undefined, true), /资料已提交/);
  assert.equal((await service.get(created.id, user)).status, 'submitted');
  assert.equal(intakes.rows.length, 1);
});

test('family intake: relation required, needs duplicate check, converts to a family-car registration', async () => {
  const { service, intakes, user } = setup();
  const created = await service.create({ houseId: 5, kind: 'family', garages: ['phase2'], formBase: 'https://prsznh.cn/beta/m/plate' }, user);
  assert.ok(created.qr, 'new unexpired draft returns its QR');
  const token = tokenOf(created.qr.url);
  await assert.rejects(() => service.publicSubmit(token, [file()], { plate: '豫GQ3N07', contactName: '李四', contactPhone: '13900000000' }), /关系/);
  await assert.rejects(() => service.publicSubmit(token, [file()], { plate: '豫GQ3N07', contactPhone: '13900000000', relation: '其他亲属' }), /写明/);
  // 不填车主姓名、关系选「其他」自己写
  await service.publicSubmit(token, [file()], { plate: '豫GQ3N07', contactPhone: '13900000000', relation: '表哥' });
  await assert.rejects(() => service.review(created.id, { decision: 'approve' }, user), /查重/);
  const done = await service.review(created.id, { decision: 'approve', duplicateCheckQueryId: 12 }, user);
  assert.equal(done.familyCarId, 77);
  assert.equal(intakes.rows[0].status, 'approved');
});

test('office fills and confirms intake material itself, with version guard and provenance', async () => {
  const { service, intakes, txns, user } = setup();
  const created = await service.create({ houseId: 5, kind: 'paid', garages: ['local:phase2_parking'], formBase: 'https://prsznh.cn/beta/m/plate' }, user);
  const key = (n: number) => `office-op-${String(n).padStart(8, '0')}`;
  const v0 = created.dataVersion;
  await assert.rejects(() => service.saveOffice(created.id, { operationKey: 'short', expectedVersion: v0, confirm: false }, [], user), /操作编号/);
  await assert.rejects(() => service.saveOffice(created.id, { operationKey: key(1), expectedVersion: v0, confirm: true }, [], user), /上传资料|车库|手机号|车牌/);
  const saved = await service.saveOffice(created.id, {
    operationKey: key(1), expectedVersion: v0, confirm: false,
    plate: '豫GQ3N07', contactName: '李四', contactPhone: '13900000000',
    garages: ['local:phase2_parking'], garageNumbers: { 'local:phase2_parking': '' },
  }, [], user);
  assert.equal(saved.status, 'waiting');
  assert.equal(saved.inputSource, 'office');
  assert.equal(saved.dataVersion, v0 + 1);
  assert.equal(intakes.rows[0].inputSource, 'office');
  // 版本过期不能覆盖他人修改
  await assert.rejects(() => service.saveOffice(created.id, { operationKey: key(2), expectedVersion: v0, confirm: false, plate: '豫GQ3N07' }, [], user), /已更新/);
  // 同一操作编号可安全重放，且不重复计版本
  const replay = await service.saveOffice(created.id, {
    operationKey: key(1), expectedVersion: v0, confirm: false,
    plate: '豫GQ3N07', contactName: '李四', contactPhone: '13900000000',
    garages: ['local:phase2_parking'], garageNumbers: { 'local:phase2_parking': '' },
  }, [], user);
  assert.equal(replay.dataVersion, v0 + 1);
  const confirmed = await service.saveOffice(created.id, { operationKey: key(3), expectedVersion: v0 + 1, confirm: true }, [file('office-xsz.jpg')], user);
  assert.equal(confirmed.status, 'submitted');
  assert.equal(intakes.rows[0].files[0].source, 'office', 'office upload keeps its own provenance');
  // 办公室确认后资料版本再次变化，审批绑定失效
  const revised = await service.saveOffice(created.id, { operationKey: key(4), expectedVersion: v0 + 2, confirm: false, contactName: '李四四' }, [], user);
  assert.equal(revised.dataVersion, v0 + 3);
  assert.equal(intakes.rows[0].officeConfirmedVersion, null);
  await assert.rejects(() => service.review(created.id, { decision: 'approve', expectedVersion: v0 + 1, duplicateCheckQueryId: 12 }, user), /已更新/);
  // 收款前必须重新提交并审核通过（新版顺序：资料确认 → 办公室审核 → 收款）
  await service.saveOffice(created.id, { operationKey: key(5), expectedVersion: v0 + 3, confirm: true }, [], user);
  await service.review(created.id, { decision: 'approve', expectedVersion: v0 + 3 }, user);
  // 收款后禁止修改车牌/车库/期限等执行依据
  const claim = await service.claimForPayment(created.id, 5, user);
  const txn = await txns.save({ tenantId: 1, txnNo: 'P3', amountCents: 45000, externalSyncStatus: 'awaiting_docs', snapshot: {} });
  await service.attachPayment(claim.row, txn, user);
  await assert.rejects(() => service.saveOffice(created.id, { operationKey: key(6), expectedVersion: v0 + 3, confirm: false, plate: '豫GA1234' }, [], user), /已经进入办理|已收款/);
  const noteOnly = await service.saveOffice(created.id, { operationKey: key(7), expectedVersion: v0 + 3, confirm: false, contactName: '王五' }, [], user);
  assert.equal(noteOnly.plate, '豫GQ3N07', 'non-execution fields can still be corrected after payment');
});

test('voiding a paid intake after payment hands the money to manual handling', async () => {
  const { service, intakes, txns, user } = setup();
  const created = await service.create({ houseId: 5, kind: 'paid', garages: ['local:phase2_parking'], formBase: 'https://prsznh.cn/beta/m/plate' }, user);
  assert.ok(created.qr, 'new unexpired draft returns its QR');
  intakes.rows[0].log.forEach((entry: any) => delete entry.registrationVersion); // 历史已收费待资料单
  const claim = await service.claimForPayment(created.id, 5, user);
  const txn = await txns.save({ tenantId: 1, txnNo: 'P2', amountCents: 15000, externalSyncStatus: 'awaiting_docs', snapshot: {} });
  await service.attachPayment(claim.row, txn, user);
  await assert.rejects(() => service.review(created.id, { decision: 'void' }, user), /原因/);
  await service.review(created.id, { decision: 'void', note: '业主不办了' }, user);
  assert.equal(txns.rows[0].externalSyncStatus, 'manual');
  assert.match(txns.rows[0].snapshot.execution.lastError, /业主不办了.*退款/);
});

