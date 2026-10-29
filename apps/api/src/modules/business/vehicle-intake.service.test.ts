import assert from 'node:assert/strict';
import test from 'node:test';
import { VehicleIntakeService } from './vehicle-intake.service';

/** 极简内存仓库：支持 findOne/save/create、update().set().where(id + 状态).execute() */
function repo<T extends { id?: number }>(rows: T[]) {
  let seq = rows.length;
  const match = (row: any, where: any) => Object.entries(where || {}).every(([k, v]) => row[k] === v);
  const r: any = {
    rows,
    create: (x: any) => ({ ...x }),
    findOne: async ({ where }: any) => rows.find((row) => match(row, where)) ?? null,
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
  const created = await service.create({ houseId: 5, kind: 'paid', formBase: 'https://prsznh.cn/beta/m/plate' }, user);
  assert.equal(created.status, 'waiting');
  assert.match(created.qr.url, /^https:\/\/prsznh\.cn\/beta\/m\/plate\/[A-Za-z0-9_-]{20,}$/);
  assert.equal(created.houseLabel, '枫桦景苑二期/228弄3号502');
  const token = tokenOf(created.qr.url);

  // 先收款：资料未齐 → 流水挂「待业主资料」
  const claim = await service.claimForPayment(created.id, 5, user);
  assert.equal(claim.approved, false);
  const txn = await txns.save({ tenantId: 1, txnNo: 'P1', amountCents: 45000, externalSyncStatus: 'awaiting_docs', snapshot: { parking: { newVehicle: true } } });
  await service.attachPayment(claim.row, txn, user);
  await assert.rejects(() => service.claimForPayment(created.id, 5, user), /已经收过款/);

  const opened = await service.publicSession(token);
  assert.equal(opened.ownerName, '张**');
  await assert.rejects(() => service.publicSubmit(token, [file()], { plate: '豫G·QN07', contactName: '李四', contactPhone: '13900000000' }), /车牌格式/);
  await assert.rejects(() => service.publicSubmit(token, [], { plate: '豫GQ3N07', contactName: '李四', contactPhone: '13900000000' }), /上传资料/);
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
  const created = await service.create({ houseId: 5, kind: 'paid', formBase: 'https://prsznh.cn/beta/m/plate' }, user);
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
  intakes.rows[0].expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(() => service.publicSession(tokenOf(created.qr.url)), /已过期/);
});

test('family intake: relation required, needs duplicate check, converts to a family-car registration', async () => {
  const { service, intakes, user } = setup();
  const created = await service.create({ houseId: 5, kind: 'family', garages: ['phase2'], formBase: 'https://prsznh.cn/beta/m/plate' }, user);
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

test('voiding a paid intake after payment hands the money to manual handling', async () => {
  const { service, txns, user } = setup();
  const created = await service.create({ houseId: 5, kind: 'paid', formBase: 'https://prsznh.cn/beta/m/plate' }, user);
  const claim = await service.claimForPayment(created.id, 5, user);
  const txn = await txns.save({ tenantId: 1, txnNo: 'P2', amountCents: 15000, externalSyncStatus: 'awaiting_docs', snapshot: {} });
  await service.attachPayment(claim.row, txn, user);
  await assert.rejects(() => service.review(created.id, { decision: 'void' }, user), /原因/);
  await service.review(created.id, { decision: 'void', note: '业主不办了' }, user);
  assert.equal(txns.rows[0].externalSyncStatus, 'manual');
  assert.match(txns.rows[0].snapshot.execution.lastError, /业主不办了.*退款/);
});
