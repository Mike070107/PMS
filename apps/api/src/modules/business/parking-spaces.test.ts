import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Reflector, NestFactory } from '@nestjs/core';
import { Module, ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccessService } from '../access/access.service';
import { PermissionsGuard } from '../access/permissions.guard';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';

const user = { id: 7, tenantId: 1, role: 'staff' };
const scoped = { scopeAll: false, communityIds: [10], pages: { business: { view: true, edit: true, delete: false } } };
const all = { ...scoped, scopeAll: true };
const fixtures = [
  { id: 1, tenantId: 1, communityId: 10, garage: 'main', spaceNo: '1', plate: '沪A12345', category: null,
    note: '产权（历史备注不推断）', source: '历史导入', endDate: '2028-02-29', houseNo: '228/6/502' },
  { id: 2, tenantId: 1, communityId: 20, garage: 'main', spaceNo: '2' },
  { id: 3, tenantId: 2, communityId: 10, garage: 'main', spaceNo: '3' },
  { id: 4, tenantId: 1, communityId: null, garage: 'civil', spaceNo: '4' },
];
function harness() {
  const rows: any[] = structuredClone(fixtures);
  let saves = 0;
  const matches = (r: any, where: any) => Object.entries(where).every(([k, v]: any) =>
    v && v._type === 'in' ? v._value.includes(r[k]) : r[k] === v);
  const repo: any = {
    findOne: async ({ where }: any) => rows.find(r => matches(r, where)) ?? null,
    save: async (r: any) => { saves++; return r; },
    createQueryBuilder: () => {
      const predicates: Array<(r: any) => boolean> = [];
      const qb: any = {
        where: (sql: string, p: any) => { predicates.length = 0; return qb.andWhere(sql, p); },
        andWhere: (sql: string, p: any = {}) => {
          if (/tenant_?id/i.test(sql)) predicates.push(r => r.tenantId === p.tenantId);
          else if (/community_?id/i.test(sql)) predicates.push(r => (p.scope ?? p.communityIds).includes(r.communityId));
          else if (/garage/.test(sql)) predicates.push(r => r.garage === p.g);
          else if (/ILIKE/.test(sql)) predicates.push(r => [r.spaceNo, r.plate, r.houseNo].some(v => v?.includes(p.kw.slice(1, -1))));
          else throw new Error('Unhandled fixture predicate: ' + sql);
          return qb;
        },
        orderBy: () => qb, addOrderBy: () => qb,
        getMany: async () => rows.filter(r => predicates.every(fn => fn(r))),
      };
      return qb;
    },
  };
  const service: any = Object.create(BusinessService.prototype);
  service.spaceRepo = repo;
  return { service, rows, saves: () => saves };
}
async function guard(method: 'parkingSpaces' | 'updateParkingSpace', access: any) {
  const req = { user, access };
  const ctx: any = { getHandler: () => BusinessController.prototype[method], getClass: () => BusinessController,
    switchToHttp: () => ({ getRequest: () => req }) };
  return new PermissionsGuard(new Reflector(), Object.create(AccessService.prototype)).canActivate(ctx);
}

test('A01: 无页面权限不能读取车位', async () => {
  await assert.rejects(() => guard('parkingSpaces', { ...scoped, pages: {} }), { status: 403 });
});
test('A01: 只读用户可读取但不能编辑车位', async () => {
  const read = { ...scoped, pages: { business: { view: true, edit: false } } };
  assert.equal(await guard('parkingSpaces', read), true);
  await assert.rejects(() => guard('updateParkingSpace', read), { status: 403 });
});
test('A01: 列表按租户与小区范围过滤，未归属记录不向受限用户开放', async () => {
  const { service } = harness();
  const result = await service.listParkingSpaces(undefined, undefined, user, scoped);
  assert.deepEqual(result.rows.map((r: any) => r.id), [1]);
  assert.equal(result.total, 1);
  assert.equal(result.bound, 1);
});
test('A01: 全公司仍不能跨租户，零范围返回空', async () => {
  const { service } = harness();
  assert.deepEqual((await service.listParkingSpaces(undefined, undefined, user, all)).rows.map((r: any) => r.id), [1, 2, 4]);
  assert.equal((await service.listParkingSpaces(undefined, undefined, user, { ...scoped, communityIds: [] })).total, 0);
});
test('A01: PATCH 拒绝跨租户、跨管理处、未归属、零范围且不写入', async () => {
  const { service, saves } = harness();
  for (const id of [2, 3, 4, 999]) {
    await assert.rejects(() => service.updateParkingSpace(id, { ownerName: '非法修改' }, user, scoped), { status: 404 });
  }
  await assert.rejects(() => service.updateParkingSpace(1, { ownerName: '非法修改' }, user, { ...scoped, communityIds: [] }), { status: 404 });
  assert.equal(saves(), 0);
});
test('A01: 范围内 PATCH 保存操作者且 GET 可回读', async () => {
  const { service, rows } = harness();
  await service.updateParkingSpace(1, { ownerName: '张三' }, user, scoped);
  assert.equal(rows[0].updatedBy, 7);
  assert.equal((await service.listParkingSpaces('main', '1', user, scoped)).rows[0].ownerName, '张三');
});
test('A01: 缺失 access 或租户不得退化为全量', async () => {
  const { service, saves } = harness();
  await assert.rejects(() => service.listParkingSpaces(undefined, undefined, user), { status: 403 });
  await assert.rejects(() => service.updateParkingSpace(1, {}, user), { status: 403 });
  await assert.rejects(() => service.listParkingSpaces(undefined, undefined, { ...user, tenantId: null }, all), { status: 403 });
  assert.equal(saves(), 0);
});
test('A01: controller 必须向两个 service 方法传递 user/access', async () => {
  const calls: any[] = [];
  const controller: any = new BusinessController({
    listParkingSpaces: (...args: any[]) => calls.push(args),
    updateParkingSpace: (...args: any[]) => calls.push(args),
  } as any, {} as any);
  controller.parkingSpaces('main', '1', user, scoped);
  controller.updateParkingSpace(1, { ownerName: '张三' }, user, scoped);
  assert.deepEqual(calls, [['main', '1', user, scoped], [1, { ownerName: '张三' }, user, scoped]]);
});

// 隔离 HTTP 应用：只有真实 controller/guard/service 与内存仓储，无 AppModule、dotenv 或数据库连接。
import { BusinessExecutionService } from './business-execution.service';
async function httpHarness(httpAccess: any = scoped) {
  const h = harness();
  @Module({
    controllers: [BusinessController],
    providers: [
      { provide: BusinessService, useValue: h.service },
      { provide: BusinessExecutionService, useValue: {} },
      { provide: AccessService, useValue: { hasAnyPermission: AccessService.prototype.hasAnyPermission.bind(Object.create(AccessService.prototype)) } },
      JwtAuthGuard,
      PermissionsGuard,
    ],
  })
  class IsolatedParkingModule {}
  const app = await NestFactory.create(IsolatedParkingModule, { logger: ['error'] });
  // 仅替换此隔离应用的认证实例，不修改生产类/原型；页面权限守卫仍执行真实逻辑。
  app.get(JwtAuthGuard).canActivate = (ctx: any) => {
    const req = ctx.switchToHttp().getRequest();
    req.user = user; req.access = httpAccess; return true;
  };
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return { ...h, app, get: async () => {
    const res = await fetch(url + '/business/parking-spaces');
    return { status: res.status, body: await res.json() as any };
  }, patch: async (body: any, id: string = '1') => {
    const res = await fetch(url + '/business/parking-spaces/' + id, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  } };
}

test('T75 HTTP: category严格拒绝非法值，且原档案完全不变', async () => {
  const h = await httpHarness();
  try {
    const before = structuredClone(h.rows);
    for (const category of ['', ' property', 'rental ', 'PROPERTY', '产权', 'unknown', 0, 1, true, false, {}, [], ['property']]) {
      const result = await h.patch({ category, note: '非法类别不能附带覆盖备注', plate: '' });
      assert.equal(result.status, 400, JSON.stringify({ category, result }));
    }
    assert.equal(h.saves(), 0);
    assert.deepEqual(h.rows, before);
  } finally { await h.app.close(); }
});

test('T75 HTTP: GET/PATCH回category和communityId，枚举/省略/null清空独立于旧字段', async () => {
  const h = await httpHarness();
  try {
    const preserved = Object.fromEntries(['plate', 'note', 'source', 'endDate', 'houseNo'].map(key => [key, h.rows[0][key]]));
    const initial = await h.get();
    assert.equal(initial.status, 200);
    assert.equal(initial.body.rows[0].category, null, '旧备注不推断类别');
    assert.equal(initial.body.rows[0].communityId, 10);
    for (const category of ['property', 'rental', 'vacant', null]) {
      const result = await h.patch({ category });
      assert.equal(result.status, 200);
      assert.equal(result.body.category, category);
      assert.equal(result.body.communityId, 10);
      const readback = (await h.get()).body.rows[0];
      assert.equal(readback.category, category);
      assert.equal(readback.communityId, 10);
      for (const [key, value] of Object.entries(preserved)) {
        assert.equal(h.rows[0][key], value, key + '必须保持');
        assert.equal(readback[key], value, key + 'GET必须保持');
      }
      const omitted = await h.patch({ ownerName: '独立编辑' });
      assert.equal(omitted.status, 200);
      assert.equal(omitted.body.category, category, '省略category保持原值');
    }
  } finally { await h.app.close(); }
});

test('T75 HTTP: 类别更新不绕过只读/跨租户/跨小区/未归属/空scope权限', async () => {
  const readonly = await httpHarness({ ...scoped, pages: { business: { view: true, edit: false } } });
  try {
    assert.equal((await readonly.get()).status, 200);
    assert.equal((await readonly.patch({ category: 'property' })).status, 403);
    assert.equal(readonly.saves(), 0);
  } finally { await readonly.app.close(); }
  for (const access of [scoped, { ...scoped, communityIds: [] }]) {
    const h = await httpHarness(access);
    try {
      const before = structuredClone(h.rows);
      const expectedIds = access.communityIds.length ? [1] : [];
      assert.deepEqual((await h.get()).body.rows.map((row: any) => row.id), expectedIds);
      for (const id of (access.communityIds.length ? ['2', '3', '4', '999'] : ['1', '2', '3', '4'])) {
        assert.equal((await h.patch({ category: null }, id)).status, 404);
      }
      assert.equal(h.saves(), 0);
      assert.deepEqual(h.rows, before);
    } finally { await h.app.close(); }
  }
  const full = await httpHarness(all);
  try {
    const rows = (await full.get()).body.rows;
    assert.deepEqual(rows.map((row: any) => row.id), [1, 2, 4], '全scope仍不跨租户');
    const unassigned = rows.find((row: any) => row.id === 4);
    assert.equal(unassigned.category, null);
    assert.equal(unassigned.communityId, null, '不按civil车库猜小区');
    const patched = await full.patch({ category: 'rental' }, '4');
    assert.equal(patched.status, 200);
    assert.equal(patched.body.category, 'rental');
    assert.equal(patched.body.communityId, null);
  } finally { await full.app.close(); }
});

test('T75 service: 非HTTP调用非法category仍400且不修改旧行', async () => {
  const h = harness();
  const before = structuredClone(h.rows);
  for (const category of ['', 'PROPERTY', ' rental ', 1, {}, []]) {
    await assert.rejects(() => h.service.updateParkingSpace(1, { category }, user, scoped), { status: 400 });
  }
  assert.equal(h.saves(), 0);
  assert.deepEqual(h.rows, before);
});

test('A02: 非字符串/超长字段经真实 ValidationPipe 返回400且不保存', async () => {
  const h = await httpHarness();
  try {
    for (const field of ['plate', 'houseNo', 'ownerName', 'ownerTel', 'note', 'areaSqm', 'endDate']) {
      for (const value of [null, 123, {}, [], true]) {
        const result = await h.patch({ [field]: value });
        assert.equal(result.status, 400, JSON.stringify({ field, value, result }));
      }
    }
    for (const [field, length] of [['plate', 21], ['houseNo', 61], ['ownerName', 61], ['ownerTel', 31], ['note', 61]] as const) {
      assert.equal((await h.patch({ [field]: '一'.repeat(length) })).status, 400, field);
    }
    assert.equal(h.saves(), 0);
  } finally { await h.app.close(); }
});
test('A02: 面积、日期、车牌业务值非法返回400', async () => {
  const h = await httpHarness();
  try {
    for (const body of [
      ...['-1', '100000', '1.234', 'NaN', '1e3', 'abc'].map(areaSqm => ({ areaSqm })),
      ...['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-1', '2026-11-04T00:00:00Z', 'tomorrow'].map(endDate => ({ endDate })),
      ...['NOT-A-PLATE', '沪A123', '1234567'].map(plate => ({ plate })),
    ]) assert.equal((await h.patch(body)).status, 400, JSON.stringify(body));
    assert.equal(h.saves(), 0);
  } finally { await h.app.close(); }
});
test('A02: 非法路径id返回400而不是500/错误写入', async () => {
  const h = await httpHarness();
  try {
    for (const id of ['abc', '1.5', '1e0', '0', '-1', '2147483648', '9007199254740993']) {
      assert.equal((await h.patch({ ownerName: '测试' }, id)).status, 400, id);
    }
    assert.equal(h.saves(), 0);
  } finally { await h.app.close(); }
});
test('A02: 合法部分更新、空字符串清空、归一化与只允许白名单字段', async () => {
  const h = await httpHarness();
  try {
    const result = await h.patch({ plate: ' 沪a 12345 ', houseNo: ' 228/6/502 ', ownerName: ' 张三 ',
      ownerTel: '13800000000，13900000000', areaSqm: ' 99999.99 ', endDate: '2028-02-29', note: ' 产权 ',
      tenantId: 2, communityId: 20, garage: 'civil', spaceNo: '999', source: '不得覆写来源', updatedBy: 888 });
    assert.equal(result.status, 200);
    assert.equal(result.body.plate, '沪A12345');
    assert.equal(result.body.ownerTel, '13800000000/13900000000');
    assert.equal(result.body.houseNo, '228/6/502');
    assert.equal(result.body.areaSqm, '99999.99');
    assert.equal(result.body.endDate, '2028-02-29');
    assert.equal(h.rows[0].tenantId, 1);
    assert.equal(h.rows[0].communityId, 10);
    assert.equal(h.rows[0].garage, 'main');
    assert.equal(h.rows[0].spaceNo, '1');
    assert.equal(h.rows[0].source, '历史导入');
    assert.equal(h.rows[0].updatedBy, 7);
    assert.equal((await h.patch({ plate: '', areaSqm: '', endDate: '', ownerName: '   ' })).status, 200);
    assert.equal(h.rows[0].plate, null);
    assert.equal(h.rows[0].areaSqm, null);
    assert.equal(h.rows[0].endDate, null);
    assert.equal(h.rows[0].ownerName, null);
    assert.equal(h.rows[0].houseNo, '228/6/502');
  } finally { await h.app.close(); }
});
