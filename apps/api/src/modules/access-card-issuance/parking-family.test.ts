import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { prepareFamilyRegistration, normalizeParkingRates, validateRegistrationGarageNumbers, supportsFamilyActivation } from './parking-family';

test('新增车牌各车库号独立必填，取消选择不提交对应号码', () => {
  assert.throws(() => validateRegistrationGarageNumbers({ garages: ['main'], garageNumbers: {} }), /二期大车库/);
  assert.throws(() => validateRegistrationGarageNumbers({ garages: ['civil'], garageNumbers: {} }), /二期人防车库/);
  const payload: any = { garages: ['main', 'civil'], garageNumbers: { main: ' A12 ', civil: ' B08 ' } };
  validateRegistrationGarageNumbers(payload);
  assert.deepEqual(payload.garageNumbers, { main: 'A12', civil: 'B08' });
  assert.equal(payload.spaces, 'A12');
  payload.garages = ['phase2'];
  validateRegistrationGarageNumbers(payload);
  assert.deepEqual(payload.garageNumbers, {});
  assert.equal(payload.spaces, '');
});
import { AccessCardIssuanceService } from './access-card-issuance.service';
import { ParkingProofService } from './parking-proof.service';
import { ParkingOperation, ParkingProofUpload } from '../../entities';

function fixture() {
  const proof: any = { id: 7, tenantId: 1, plate: '沪TEST01', registrationId: null, reviewStatus: 'pending', submittedAt: null };
  const tasks: any[] = [];
  const find = (rows: any[], where: any) => rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null;
  const operations: any = { findOne: async ({ where }: any) => find(tasks, where), create: (value: any) => value,
    save: async (value: any) => { if (!value.id) { value.id = tasks.length + 1; tasks.push(value); } return value; } };
  const proofs = { findOne: async ({ where }: any) => find([proof], where), save: async (row: any) => row };
  const manager: any = { getRepository: (entity: any) => entity === ParkingProofUpload ? proofs : operations, transaction: async (fn: any) => fn(manager) };
  operations.manager = manager;
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  Object.assign(service, { parkingOperationRepo: operations,
    agentRepo: { find: async () => [{ status: 'online', lastSeenAt: new Date(), version: '2.5.40', capabilities: { parkingDbWrite: true } }] },
    parkingQueryRepo: { findOne: async () => ({ term: '沪TEST01', status: 'completed', completedAt: new Date(), rows: [] }) },
  });
  const user = { id: 8, tenantId: 1 } as any;
  const register = () => service.createParkingOperation({ kind: 'add_vehicle', database: 'parking2', idempotencyKey: 'family-register-001',
    payload: { plate: '沪TEST01', identity: '亲情车', ownerName: '测试住户', ownerAddress: '228/3/102', endDate: '2026-12-31', startDate: '2026-10-11', garages: ['phase2'], proofUploadId: 7, effective: '1'.repeat(256), state: 1, amount: 180, duplicateCheckQueryId: 1 } }, user);
  return { service, proof, tasks, user, register };
}

test('真实服务链登记持久关联、待审核禁止授权；审核通过稳定复用同一授权任务', async () => {
  const f = fixture();
  const registered = await f.register();
  assert.equal(registered.payload.state, 0); assert.equal(f.proof.registrationId, registered.id);
  assert.equal(registered.payload.effective, '0'.repeat(256));
  assert.equal(registered.payload.amount, 0);
  await assert.rejects(f.service.createParkingOperation({ kind: 'update_garages', database: 'parking2', idempotencyKey: 'bypass-pending-01', payload: { plate: '沪TEST01', ownerRoom: '228/3/102', garages: ['phase2'] } }, f.user), /尚未审核通过/);
  f.tasks[0].status = 'completed';
  await assert.rejects(f.service.reviewParkingProof(7, 'approved', undefined, f.user), /尚未上传/);
  f.proof.submittedAt = new Date();
  const first = await f.service.reviewParkingProof(7, 'approved', undefined, f.user);
  const second = await f.service.reviewParkingProof(7, 'approved', undefined, f.user);
  assert.equal(first.operation!.id, second.operation!.id); assert.equal(f.tasks.length, 2);
  assert.equal(first.operation!.payload.state, 1); assert.equal(first.operation!.payload.ownerRoom, '228/3/102');
  assert.deepEqual(first.operation!.payload.garages, ['phase2']);
  assert.equal(f.proof.reviewedBy, f.user.id); assert.equal(f.proof.reviewStatus, 'approved');
});

test('驳回必须填写原因且不生成授权任务；其他租户不能审核', async () => {
  const f = fixture(); await f.register(); f.tasks[0].status = 'completed';
  await assert.rejects(f.service.reviewParkingProof(7, 'rejected', ' ', f.user), /驳回原因/);
  await assert.rejects(f.service.reviewParkingProof(7, 'rejected', '材料缺失', { ...f.user, tenantId: 2 }), /不存在/);
  await f.service.reviewParkingProof(7, 'rejected', '材料缺失', f.user);
  assert.equal(f.proof.reviewReason, '材料缺失'); assert.equal(f.proof.reviewStatus, 'rejected'); assert.equal(f.tasks.length, 1);
});

test('审核授权失败重试只恢复原任务；待审核不能绕过开通人防', async () => {
  const f = fixture(); await f.register(); f.tasks[0].status = 'completed';
  await assert.rejects(f.service.setDeliyunCivilDefenseAuthorization({ plate: '沪TEST01', authorized: true, idempotencyKey: 'bypass-cloud-001' }, f.user), /尚未审核通过/);
  f.proof.submittedAt = new Date();
  const first = await f.service.reviewParkingProof(7, 'approved', undefined, f.user);
  f.tasks[1].status = 'failed'; f.tasks[1].attempt = 3; f.tasks[1].lastError = 'offline';
  const retried = await f.service.reviewParkingProof(7, 'approved', undefined, f.user);
  assert.equal(retried.operation!.id, first.operation!.id); assert.equal(retried.operation!.status, 'pending');
  assert.equal(f.tasks.length, 2); assert.equal(f.tasks[1].attempt, 0);
});

test('亲情车启用协议必须具备2.5.40完整版本号', () => {
  for (const version of [undefined, '', '2.5.39', 'invalid', '2.5']) assert.equal(supportsFamilyActivation(version), false);
  for (const version of ['2.5.40', '2.6.0', '3.0.0']) assert.equal(supportsFamilyActivation(version), true);
});

test('亲情车多材料上传保存全部文件；重复和过期上传不覆盖原资料', async () => {
  const row: any = { id: 7, plate: '沪TEST01', expiresAt: new Date(Date.now() + 3600000), submittedAt: null, reviewStatus: 'pending', files: [] };
  let stored = 0;
  const repo: any = { findOne: async () => row, save: async (value: any) => value };
  repo.manager = { transaction: async (fn: any) => fn({ getRepository: () => repo }) };
  const service = Object.create(ParkingProofService.prototype) as ParkingProofService;
  Object.assign(service, { repo, storage: { putBuffer: async () => ({ objectKey: `test-${++stored}` }) } });
  const file = (name: string) => ({ originalname: name, buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }) as Express.Multer.File;
  const result = await service.submit('test_token_01234567890123456789', [file('one.png'), file('two.png')]);
  assert.equal(result.files.length, 2); assert.equal(result.status, 'submitted'); assert.equal(row.reviewStatus, 'pending');
  await assert.rejects(service.submit('test_token_01234567890123456789', [file('three.png')]), /已经上传/);
  assert.equal(stored, 2);
  row.submittedAt = null; row.expiresAt = new Date(Date.now() - 1);
  await assert.rejects(service.submit('test_token_01234567890123456789', [file('late.png')]), /过期/);
  assert.equal(stored, 2);
});

test('费率写入租户配置并重新读取，不能串物业公司', async () => {
  const rows: any[] = [];
  const service = Object.create(ParkingProofService.prototype) as ParkingProofService;
  Object.assign(service, { configRepo: { findOne: async ({ where }: any) => rows.find((r) => r.tenantId === where.tenantId && r.key === where.key),
    upsert: async (value: any) => { rows.splice(0, rows.length, value); } } });
  const rates = { owner: { 1: 199, 2: 398, 3: 597, 6: 1194, 12: 1990 }, tenant: { 1: 299, 2: 598, 3: 897, 6: 1794, 12: 2990 } };
  await service.saveRates(rates, { id: 8, tenantId: 1 } as any);
  assert.deepEqual(await service.rates({ tenantId: 1 } as any), rates);
  assert.notDeepEqual(await service.rates({ tenantId: 2 } as any), rates);
});

test('已生成二维码的亲情车无论是否上传，登记只能待审核且没有有效授权', () => {
  for (const submitted of [false, true]) {
    const p: any = { identity: '亲情车', plate: '沪TEST01', proofUploadId: 7, garages: ['phase2'], effective: '111', state: 1, amount: 99, submitted };
    prepareFamilyRegistration(p, { id: 7, plate: '沪TEST01', registrationId: null } as any);
    assert.equal(p.requiresProofReview, true); assert.equal(p.state, 0); assert.equal(p.amount, 0);
    assert.equal(p.effective, '0'.repeat(256)); assert.deepEqual(p.garages, ['phase2']);
  }
});
test('不能用其他车牌二维码或已绑定二维码登记亲情车', () => {
  assert.throws(() => prepareFamilyRegistration({ identity: '亲情车', plate: '沪TEST01' }, null), /二维码/);
  assert.throws(() => prepareFamilyRegistration({ identity: '亲情车', plate: '沪TEST01' }, { plate: '沪OTHER1' } as any), /二维码/);
});
test('费率按完整周期保存，非法金额或缺少周期拒绝而非静默回退', () => {
  const rates = { owner: { 1: 180, 2: 360, 3: 540, 6: 1080, 12: 1800 }, tenant: { 1: 260, 2: 520, 3: 780, 6: 1560, 12: 2760 } };
  assert.deepEqual(normalizeParkingRates(rates), rates);
  assert.throws(() => normalizeParkingRates({ ...rates, owner: { ...rates.owner, 1: -1 } }), /金额/);
  assert.throws(() => normalizeParkingRates({ owner: { 1: 180 } }), /金额/);
});

// 显式本机 UI 验收入口，无数据库配置、不转发生产/现场请求。
if (process.env.PMS_FAMILY_BROWSER_PORT) {
  let rates: any = normalizeParkingRates({ owner: { 1: 180, 2: 360, 3: 540, 6: 1080, 12: 1800 }, tenant: { 1: 260, 2: 520, 3: 780, 6: 1560, 12: 2760 } });
  const submissions: any[] = [];
  let browserReview: 'pending' | 'approved' | 'rejected' = 'pending';
  let browserReason = '';
  const image = (label: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#dce9f5"/><text x="80" y="260" font-size="48">${label}</text></svg>`)}`;
  createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (data: unknown) => res.end(JSON.stringify({ code: 0, data }));
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let body = ''; for await (const chunk of req) body += chunk;
      const input = body ? JSON.parse(body) : {};
      if (url.pathname === '/__test/status') return send({ submissions, rates });
      if (url.pathname.endsWith('/auth/config')) return send({});
      if (url.pathname.endsWith('/parking/fee-rates')) {
        if (req.method === 'POST') rates = normalizeParkingRates(input.rates);
        return send(rates);
      }
      if (url.pathname.endsWith('/parking/proof-uploads/by-plate') || /proof-uploads\/\d+$/.test(url.pathname)) return send({ id: 7, plate: url.searchParams.get('plate') || '沪B67890', status: 'submitted', reviewStatus: browserReview, reviewReason: browserReason, registrationId: 1,
        expiresAt: new Date(Date.now() + 3600000).toISOString(), files: [1, 2].map((n) => ({ fileName: `测试材料${n}`, contentType: 'image/png', fileUrl: image(`TEST ${n}`) })) });
      if (url.pathname.endsWith('/parking/proof-uploads')) return send({ id: 7, plate: input.plate, status: 'waiting', qrDataUrl: image('QR TEST'), expiresAt: new Date(Date.now() + 3600000).toISOString(), reviewStatus: 'pending' });
      if (url.pathname.endsWith('/parking/queries') || /parking\/queries\/\d+$/.test(url.pathname)) return send({ id: 1, status: 'completed', rows: [], term: input.term });
      if (url.pathname.includes('/deliyun')) return send({ rows: [], status: 'completed' });
      if (url.pathname.endsWith('/parking/operations')) {
        submissions.push(input); return send({ id: 1, ...input, status: 'completed', result: { verified: true }, requestedAt: new Date().toISOString() });
      }
      if (url.pathname.endsWith('/review')) { submissions.push(input); browserReview = input.decision; browserReason = input.decision === 'rejected' ? input.reason || '' : ''; return send({ reviewStatus: input.decision, operation: null, cloudOperation: null }); }
      res.statusCode = 404; res.end(JSON.stringify({ message: '隔离验收不代理此请求' }));
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) })); }
  }).listen(Number(process.env.PMS_FAMILY_BROWSER_PORT), '127.0.0.1', () => console.log('Parking family isolated browser API: no database connection'));
}
