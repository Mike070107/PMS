import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { VehicleIntakeService } from './vehicle-intake.service';
import { BusinessService } from './business.service';
import { BusinessLog, BusinessTransaction, FamilyCar, VehicleIntake } from '../../entities';
import { BusinessServiceType } from '../../common/enums';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { VehicleIntakeController } from './vehicle-intake.controller';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// Isolated fake repositories execute the real services; no datasource/config/network.
function fixture() {
  const tables = new Map<any, any[]>([[VehicleIntake, []], [BusinessTransaction, []], [BusinessLog, []]]);
  let tail = Promise.resolve(); let locks = 0; let familyCreates = 0; let failAttach = false;
  const committedPayments = new Set<number>();
  const clone = <T>(v: T): T => structuredClone(v);
  const matches = (r: any, w: any): boolean => Array.isArray(w) ? w.some(item => matches(r, item)) : Object.entries(w || {}).every(([k, v]: [string, any]) => v?._type === 'like' ? String(r[k] ?? '').startsWith(v._value.slice(0, -1)) : r[k] === v);
  const repository = (entity: any, manager: any): any => ({
    manager, create: (v: any) => clone(v),
    findOne: async ({ where, lock }: any) => { if (lock) { assert.equal(lock.mode, 'pessimistic_write'); locks++; } return clone(tables.get(entity)!.find(r => matches(r, where)) ?? null); },
    save: async (v: any): Promise<any> => {
      if (Array.isArray(v)) return Promise.all(v.map(x => repository(entity, manager).save(x)));
      if (entity === VehicleIntake && failAttach && v.transactionId) throw Error('fixture attach failure');
      const rows = tables.get(entity)!; const value = clone(v);
      if (!value.id) { value.id = Math.max(0, ...rows.map(r => r.id)) + 1; value.createdAt = new Date(); }
      value.updatedAt = new Date(); const i = rows.findIndex(r => r.id === value.id);
      if (i < 0) rows.push(value); else rows[i] = value; return clone(value);
    },
    update: async (where: any, patch: any) => { const rows = tables.get(entity)!; rows.filter(r => matches(r, where)).forEach(r => Object.assign(r, clone(patch))); return { affected: 1 }; },
    createQueryBuilder: () => {
      let params: any, patch: any; const qb: any = { update: () => qb, set: (v: any) => { patch = v; return qb; }, where: (_s: string, p: any) => { params = p; return qb; }, execute: async () => {
        const row = tables.get(entity)!.find(r => r.id === params.id && (!params.st || (Array.isArray(params.st) ? params.st.includes(r.status) : r.externalSyncStatus === params.st)));
        if (!row) return { affected: 0 }; Object.assign(row, clone(patch)); return { affected: 1 };
      }}; return qb;
    },
  });
  const manager: any = { getRepository: (e: any) => { if (!tables.has(e)) tables.set(e, []); return repository(e, manager); }, save: async () => {}, create: (_e: any, v: any) => v };
  manager.transaction = async (work: any) => {
    const previous = tail; let done!: () => void; tail = new Promise<void>(r => { done = r; }); await previous;
    const backup = new Map([...tables].map(([e, rows]) => [e, clone(rows)]));
    try { const result = await work(manager); tables.get(BusinessTransaction)!.forEach(r => committedPayments.add(r.id)); return result; } catch (e) { for (const [entity, rows] of backup) tables.set(entity, rows); throw e; } finally { done(); }
  };
  const intakes = manager.getRepository(VehicleIntake), txns = manager.getRepository(BusinessTransaction), logs = manager.getRepository(BusinessLog);
  const user = { id: 8, tenantId: 1 } as any;
  const family = { createFromIntake: async (input: any, files: any[]) => { familyCreates++; assert.ok(input.duplicateCheckQueryId); assert.ok(files.length); await Promise.resolve(); return { id: 77 }; } };
  const kicked: number[] = [];
  const execution = { initialFor: () => ({ status: 'queued', execution: { attempts: 0 } }), kick: (id: number) => { assert.ok(committedPayments.has(id), 'execution cannot start before payment commit'); kicked.push(id); } };
  const communityRepo = { findOne: async () => ({ id: 3, name: '枫桦景苑二期' }) } as any;
  const houseRepo = { findOne: async () => ({ id: 5, tenantId: 1, buildingId: 2, roomNo: '502' }) } as any;
  const buildingRepo = { findOne: async () => ({ communityId: 3 }) } as any;
  const service = new VehicleIntakeService(intakes, txns, logs, houseRepo, buildingRepo, communityRepo,
    { findOne: async () => ({ id: 8, name: '合成前台' }) } as any,
    { putBuffer: async () => ({ objectKey: 'isolated/new.jpg' }) } as any, family as any, execution as any, { get: () => 'local-secret' } as any);
  const token = 'synthetic-token-1234567890123456';
  const initial: any = { id: 1, tenantId: 1, houseId: 5, communityId: 3, houseLabel: '合成房号', ownerName: '合成业主', ownerPhone: '13800000000', kind: 'paid', status: 'approved', plate: '沪TEST01', contactName: '合成车主', contactPhone: '13900000000', relation: '', vehicleClass: '住户车-1', garages: ['local:phase2_parking'], garageNumbers: { main: 'OLD' }, files: [{ objectKey: 'isolated/old.jpg', fileName: 'old.jpg', contentType: 'image/jpeg', uploadedAt: new Date().toISOString() }], tokenHash: createHash('sha256').update(token).digest('hex'), tokenNonce: 'synthetic', expiresAt: new Date(Date.now() + 3600000), openedAt: null, submittedAt: new Date(), reviewedAt: new Date(), reviewedBy: 8, reviewNote: '旧审核', transactionId: null, familyCarId: null, log: [{ action: '旧审核', at: new Date().toISOString(), userId: 8, userName: '合成前台' }], createdBy: 8, updatedBy: 8 };
  tables.get(VehicleIntake)!.push(initial);
  const business: any = Object.create(BusinessService.prototype);
  Object.assign(business, { txnRepo: txns, logRepo: logs, intakes: service, houseRepo, buildingRepo, communityRepo, execution, tagRepo: { findOne: async () => null }, estimate: async () => ({ quantity: 1, startDate: '2026-11-11', endDate: '2026-12-31', amountCents: 10000 }), findRule: async () => ({ id: 2, name: '合成规则', config: {} }), notifyReviewers: async () => {} });
  const pay = () => business.complete({ serviceType: BusinessServiceType.PARKING_MONTHLY, intakeId: 1, houseId: 5, ruleId: 2, paymentMethod: 'cash' }, user);
  return { service: service as any, business, pay, user, token, txns, tables, row: () => tables.get(VehicleIntake)![0], transactions: () => tables.get(BusinessTransaction)!, audit: () => tables.get(BusinessLog)!, familyCreates: () => familyCreates, locks: () => locks, kicked, failAttach: () => { failAttach = true; } };
}

test('conversion preserves documents/contact/audit but invalidates approval and never inherits incompatible garages', async () => {
  const h = fixture(); const before = structuredClone(h.row());
  const result = await h.service.setKind(1, { kind: 'family' }, h.user);
  assert.equal(result.kind, 'family'); assert.equal(result.status, 'submitted'); assert.equal(result.reviewedAt, null);
  assert.deepEqual(h.row().files, before.files); assert.equal(result.contactName, before.contactName); assert.equal(result.contactPhone, before.contactPhone);
  assert.deepEqual(result.garages, []); assert.deepEqual(result.garageNumbers, {}); assert.equal(result.relation, '');
  assert.equal(h.row().log[0].action, '旧审核'); assert.ok(h.row().log.length > 1);
  await assert.rejects(h.service.review(1, { decision: 'approve' }, h.user), /关系/);
  await assert.rejects(h.service.review(1, { decision: 'approve', relation: '父亲' }, h.user), /车库|查重/);
  await assert.rejects(h.service.review(1, { decision: 'approve', relation: '父亲', garages: ['phase2'] }, h.user), /查重/);
  await Promise.allSettled([1, 2].map(() => h.service.review(1, { decision: 'approve', relation: '父亲', garages: ['phase2'], duplicateCheckQueryId: 10 }, h.user)));
  assert.equal(h.familyCreates(), 1); assert.equal(h.row().familyCarId, 77);
});

test('conversion supports all uncompleted states and explicit paid/family garage schemas', async () => {
  for (const status of ['waiting', 'submitted', 'reupload', 'approved']) {
    const h = fixture(); h.row().status = status;
    await h.service.setKind(1, { kind: 'family', garages: ['phase2'], relation: '父亲' }, h.user);
    assert.equal(h.row().status, status === 'approved' ? 'submitted' : status); assert.deepEqual(h.row().garages, ['phase2']);
    await h.service.setKind(1, { kind: 'paid', garages: ['local:phase1_parking'], vehicleClass: '住户车-1' }, h.user);
    assert.deepEqual(h.row().garages, ['local:phase1_parking']); assert.equal(h.row().relation, '');
  }
  const h = fixture();
  await assert.rejects(h.service.setKind(1, { kind: 'family', garages: ['local:phase2_parking'] }, h.user), /车库/);
  h.row().kind = 'family'; h.row().status = 'submitted';
  await assert.rejects(h.service.setKind(1, { kind: 'paid', garages: ['phase2'] }, h.user), /车库/);
  await assert.rejects(h.service.setKind(1, { kind: 'paid', garages: ['deliyun:上海永南小区'] }, h.user), /车库|小区/);
});

test('conversion enforces tenant/community scope and refuses any completed/linked transaction', async () => {
  const h = fixture();
  await assert.rejects(h.service.setKind(1, { kind: 'family' }, { ...h.user, tenantId: 2 }), /不存在/);
  await assert.rejects(h.service.setKind(1, { kind: 'family' }, h.user, { scopeAll: false, communityIds: [99] }), /管理范围/);
  for (const patch of [{ transactionId: 20 }, { familyCarId: 77 }, { kind: 'family', status: 'approved' }, { status: 'void' }]) {
    const x = fixture(); Object.assign(x.row(), patch); await assert.rejects(x.service.setKind(1, { kind: patch.kind === 'family' ? 'paid' : 'family' }, x.user), /收款|流水|亲情车|作废|办理/);
  }
  await h.txns.save({ id: 20, tenantId: 1, targetType: 'vehicle_intake', targetId: 1, externalSyncStatus: 'awaiting_docs' });
  await assert.rejects(h.service.setKind(1, { kind: 'family' }, h.user), /流水|收款/);
});

test('void cancels uncompleted registrations without deleting audit; old QR cannot submit/open', async () => {
  for (const status of ['waiting', 'submitted', 'approved']) {
    const h = fixture(); h.row().status = status;
    await h.service.review(1, { decision: 'void', note: '合成撤销' }, h.user);
    assert.equal(h.row().status, 'void'); assert.ok(h.row().log.some((l: any) => l.action === '作废'));
    await assert.rejects(h.service.publicSession(h.token), /作废|失效|撤销/);
    await assert.rejects(h.service.publicSubmit(h.token, [], {}), /作废|失效|撤销/);
  }
});

test('void of paid awaiting-docs keeps paid money and manual audit, but execution/completion cannot be cancelled here', async () => {
  const h = fixture(); h.row().status = 'submitted'; h.row().transactionId = 20;
  await h.txns.save({ id: 20, tenantId: 1, targetType: 'vehicle_intake', targetId: 1, status: 'paid', amountCents: 10000, externalSyncStatus: 'awaiting_docs', snapshot: {} });
  await h.service.review(1, { decision: 'void', note: '合成撤销' }, h.user);
  assert.equal(h.transactions()[0].status, 'paid'); assert.equal(h.transactions()[0].amountCents, 10000); assert.equal(h.transactions()[0].externalSyncStatus, 'manual'); assert.ok(h.audit().some(l => l.action === 'docs_voided'));
  for (const externalSyncStatus of ['queued', 'processing', 'running', 'retry', 'synced', 'manual', 'failed', 'dry_run', 'rejected']) {
    const x = fixture(); x.row().status = 'submitted'; x.row().transactionId = 20;
    await x.txns.save({ id: 20, tenantId: 1, status: 'paid', externalSyncStatus, snapshot: {} });
    await assert.rejects(x.service.review(1, { decision: 'void', note: '不能伪取消' }, x.user), /注销|待处理/);
    assert.equal(x.row().status, 'submitted');
  }
});

test('a family write surviving intake rollback blocks conversion, duplicate payment and cancellation by original audit marker', async () => {
  for (const remark of ['收银台扫码登记 #1', '收银台扫码登记 #1 · 关系：表哥']) {
    const h = fixture(); h.row().status = 'submitted';
    h.tables.set(FamilyCar, [{ id: 77, tenantId: 1, remark }]);
    await assert.rejects(h.service.setKind(1, { kind: 'family' }, h.user), /已生成亲情车/);
    await assert.rejects(h.pay(), /已生成亲情车/);
    await assert.rejects(h.service.review(1, { decision: 'void', note: '中断后重试' }, h.user), /已生成亲情车/);
    assert.equal(h.transactions().length, 0); assert.equal(h.row().status, 'submitted');
  }
  const x = fixture(); x.tables.set(FamilyCar, [{ id: 77, tenantId: 1, remark: '收银台扫码登记 #10' }, { id: 78, tenantId: 2, remark: '收银台扫码登记 #1' }]);
  await x.service.setKind(1, { kind: 'family' }, x.user); assert.equal(x.row().kind, 'family');
});

test('execution traces forbid cancellation even when a legacy transaction claims awaiting-docs', async () => {
  const h = fixture(); h.row().status = 'submitted'; h.row().transactionId = 20;
  await h.txns.save({ id: 20, tenantId: 1, externalSyncStatus: 'awaiting_docs', snapshot: { execution: { attempts: 1, steps: [{ status: 'completed' }] } } });
  await assert.rejects(h.service.review(1, { decision: 'void', note: '已有执行痕迹' }, h.user), /待处理|车辆管理/);
  assert.equal(h.row().status, 'submitted');
});

test('payment vs conversion and double payment serialize; attach failure rolls back money and audit', async () => {
  const h = fixture();
  const results = await Promise.allSettled([h.pay(), h.service.setKind(1, { kind: 'family' }, h.user), h.pay()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(h.transactions().length, 1); assert.equal(h.row().kind, 'paid'); assert.equal(h.row().transactionId, h.transactions()[0].id); assert.ok(h.locks() >= 3);
  const x = fixture(); x.failAttach(); await assert.rejects(x.pay(), /attach failure/); assert.equal(x.transactions().length, 0); assert.equal(x.audit().length, 0); assert.equal(x.row().transactionId, null); assert.deepEqual(x.kicked, []);
});

test('conversion winning before payment leaves zero money; void vs payment never overwrites either record', async () => {
  const h = fixture();
  await h.service.setKind(1, { kind: 'family', garages: ['phase2'], relation: '父亲' }, h.user);
  await assert.rejects(h.pay(), /亲情车|付费车/); assert.equal(h.transactions().length, 0);
  const x = fixture(); x.row().status = 'waiting';
  const result = await Promise.allSettled([x.service.review(1, { decision: 'void', note: '抢先撤销' }, x.user), x.pay()]);
  assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].status, 'rejected'); assert.equal(x.row().status, 'void'); assert.equal(x.transactions().length, 0);
  const y = fixture(); y.row().status = 'waiting';
  await y.pay(); await y.service.review(1, { decision: 'void', note: '收款后撤销' }, y.user);
  assert.equal(y.transactions().length, 1); assert.equal(y.transactions()[0].status, 'paid'); assert.equal(y.transactions()[0].externalSyncStatus, 'manual');
});

test('re-review paid conversion requires explicit garages; uploads keep audit and latest workflow under lock', async () => {
  const h = fixture(); h.row().kind = 'family'; h.row().status = 'submitted';
  await h.service.setKind(1, { kind: 'paid', vehicleClass: '住户车-1' }, h.user);
  await assert.rejects(h.service.review(1, { decision: 'approve' }, h.user), /车库/);
  await h.service.setGarages(1, ['local:phase2_parking'], {}, h.user);
  await h.service.review(1, { decision: 'approve' }, h.user);
  assert.equal(h.row().status, 'approved'); assert.equal(h.row().files.length, 1); assert.equal(h.row().log[0].action, '旧审核');
  const x = fixture(); x.row().status = 'reupload';
  await x.service.setKind(1, { kind: 'family', garages: ['phase2'], relation: '父亲' }, x.user);
  await x.service.publicSubmit(x.token, [], { plate: '沪TEST01', contactPhone: '13900000000', contactName: '新车主', relation: '父亲', keepFiles: '1' });
  assert.equal(x.row().status, 'submitted'); assert.equal(x.row().kind, 'family'); assert.equal(x.row().files.length, 1); assert.ok(x.row().log.some((l: any) => l.action.includes('转为亲情车')));
  const y = fixture(); y.row().status = 'waiting';
  const races = await Promise.allSettled([y.service.review(1, { decision: 'void', note: '撤销旧码' }, y.user), y.service.publicSubmit(y.token, [], { plate: '沪TEST01', contactPhone: '13900000000' })]);
  assert.equal(races[0].status, 'fulfilled'); assert.equal(races[1].status, 'rejected'); assert.equal(y.row().status, 'void');
});

test('payment enforces scope, house and tenant; stale attach cannot revive void/family registrations', async () => {
  const h = fixture();
  await assert.rejects(h.business.complete({ serviceType: BusinessServiceType.PARKING_MONTHLY, intakeId: 1, houseId: 5 }, h.user, { scopeAll: false, communityIds: [99] }), /管理范围/);
  await assert.rejects(h.service.claimForPayment(1, 99, h.user), /这一户/);
  await assert.rejects(h.service.claimForPayment(1, 5, { ...h.user, tenantId: 99 }), /不存在/);
  assert.equal(h.transactions().length, 0);
  const claim = await h.service.claimForPayment(1, 5, h.user);
  await h.service.setKind(1, { kind: 'family' }, h.user);
  await assert.rejects(h.service.attachPayment(claim.row, { id: 99, tenantId: 1, amountCents: 10000, snapshot: {} }, h.user), /改变|收款/);
  assert.equal(h.row().kind, 'family'); assert.equal(h.row().transactionId, null);
});

test('all office routes keep JWT + permissions; kind requires business edit, manager review alternatives remain', async () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, VehicleIntakeController), [JwtAuthGuard, PermissionsGuard]);
  const proto: any = VehicleIntakeController.prototype;
  for (const key of Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor')) {
    assert.ok(Reflect.hasMetadata(METHOD_METADATA, proto[key]), key); assert.ok(Reflect.hasMetadata(PERMISSION_KEY, proto[key]), key);
  }
  assert.equal(Reflect.getMetadata(PATH_METADATA, proto.setKind), ':id/kind');
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, proto.setKind).items, [{ pageKey: 'business', action: 'edit' }]);
  const review = Reflect.getMetadata(PERMISSION_KEY, proto.review).items;
  for (const pageKey of ['business', 'family-cars', 'app:approve-business-manager', 'app:approve-manager']) assert.ok(review.some((p: any) => p.pageKey === pageKey && p.action === 'edit'));
  const access = { pages: { business: { view: true, edit: false } } };
  const guard = new PermissionsGuard(new Reflector(), { hasAnyPermission: (a: any, items: any[]) => items.some(p => a.pages[p.pageKey]?.[p.action]) } as any);
  const context: any = { getHandler: () => proto.setKind, getClass: () => VehicleIntakeController, switchToHttp: () => ({ getRequest: () => ({ user: { id: 8 }, access }) }) };
  await assert.rejects(async () => guard.canActivate(context), /权限不足/);
  access.pages.business.edit = true; assert.equal(await guard.canActivate(context), true);
});
