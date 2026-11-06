/// <reference lib="dom" />
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RepairsController } from './repairs.controller';
import { AccessService } from '../access/access.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
import { CreateRepairRequestDto } from './dto';

import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { RepairRequest } from '../../entities/repair-request.entity';
import { WorkOrder } from '../../entities/work-order.entity';
import { WorkOrderLog } from '../../entities/work-order-log.entity';
import { Community } from '../../entities/community.entity';
import { RepairsService } from './repairs.service';
import { UserRole, WorkOrderStatus } from '../../common/enums';
import * as repairsClient from '../../../../../packages/api-client/src/endpoints/repairs';
import { configure } from '../../../../../packages/api-client/src/request';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

test('api-client位置查询合同与create独立字段透传', async t => {
  assert.equal(typeof (repairsClient as any).locationSuggestions, 'function', '缺少api-client位置查询');
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: any[] = [];
  configure({ baseURL: 'https://fixture.invalid/api/v1', getToken: () => undefined });
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ items: [{ text: '大门', count: 3 }] }), { status: 200 });
  }) as any;
  assert.deepEqual(await (repairsClient as any).locationSuggestions(10), { items: [{ text: '大门', count: 3 }] });
  assert.equal(calls[0].url, 'https://fixture.invalid/api/v1/repair-location-suggestions?communityId=10');
  await repairsClient.create({ communityId: 10, content: '灯坏了', locationText: '大门' });
  assert.equal(JSON.parse(calls[1].init.body).locationText, '大门');
});

test('新增迁移可被CLI glob发现，幂等增列保留旧报修，不回填猜测位置', async t => {
  const path = join(__dirname, '../../migrations/1793900000000-RepairLocationText.ts');
  assert.ok(existsSync(path), '缺少新增location_text迁移');
  const { RepairLocationText1793900000000 } = require(path);
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec("CREATE TABLE repair_requests(id int primary key,address_text text);INSERT INTO repair_requests VALUES(1,'小区 大门')");
  const migration = new RepairLocationText1793900000000();
  const runner = { query: (sql: string) => pg.query(sql) };
  await migration.up(runner); await migration.up(runner);
  assert.deepEqual((await pg.query('SELECT * FROM repair_requests')).rows, [{ id: 1, address_text: '小区 大门', location_text: null }]);
  await assert.rejects(pg.query('INSERT INTO repair_requests VALUES(2,$1,$2)', ['地址', '地'.repeat(61)]));
});

const pipe = new ValidationPipe({ transform: true, whitelist: true });
const body = { communityId: 10, content: '灯坏了' };
const user = { id: 7, tenantId: 1, role: UserRole.STAFF };
const access = { scopeAll: false, communityIds: [10], pages: { 'work-orders': { view: true } } };

// 不加载 AppModule/.env，不初始化 pg 网络连接。所有 save/query/事务执行真实 TypeORM SQL。
async function fixture(t: any) {
  const pg = new PGlite();
  t.after(() => pg.close());
  const ds = new DataSource({ type: 'postgres', entities: [RepairRequest, WorkOrder, WorkOrderLog, Community] });
  await (ds as any).buildMetadatas();
  const statements: string[] = [];
  const runner = (connection: any, active = false): any => {
    const qr: any = {
      connection: ds, isReleased: false, isTransactionActive: active, data: {},
      connect: async () => undefined, release: async () => undefined,
      query: async (sql: string, params: any[] = [], structured = false) => {
        statements.push(sql);
        const out = await connection.query(sql, params);
        if (!structured) return out.rows;
        const result = new QueryResult();
        result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows;
        return result;
      },
    };
    qr.broadcaster = new Broadcaster(qr); qr.manager = ds.createEntityManager(qr);
    return qr;
  };
  (ds as any).isInitialized = true;
  ds.createQueryRunner = () => runner(pg);
  ds.transaction = ((callback: any) => pg.transaction((tx: any) => callback(runner(tx, true).manager))) as any;
  // 由实体元数据建隔离表，显式保留旧表尚无 location_text 的迁移起点。
  for (const entity of [RepairRequest, WorkOrder, WorkOrderLog, Community]) {
    const meta = ds.getMetadata(entity);
    const columns = meta.columns.filter(c => c.databaseName !== 'location_text').map(c => {
      const type = c.isGenerated ? 'serial' : ds.driver.normalizeType(c);
      const length = c.length ? '(' + c.length + ')' : '';
      const defaultValue = ds.driver.normalizeDefault(c);
      return '"' + c.databaseName + '" ' + type + length +
        (c.isPrimary ? ' PRIMARY KEY' : '') + (c.isNullable ? '' : ' NOT NULL') +
        (!c.isGenerated && defaultValue !== undefined ? ' DEFAULT ' + defaultValue : '');
    });
    await pg.exec('CREATE TABLE "' + meta.tableName + '" (' + columns.join(',') + ')');
  }
  const migration = new (require('../../migrations/1793900000000-RepairLocationText').RepairLocationText1793900000000)();
  await migration.up({ query: (sql: string) => pg.query(sql) });
  await pg.exec(`INSERT INTO communities(id,tenant_id,name,enabled,office_id) VALUES
    (10,1,'本处小区',true,1),(20,1,'其他管理处',true,2),(30,2,'其他公司',true,3)`);
  const service: any = Object.create(RepairsService.prototype);
  service.dataSource = ds; service.repairRequestRepo = ds.getRepository(RepairRequest);
  service.communityRepo = ds.getRepository(Community);
  // 外部类型识别/通讯与业主资料学习隔离，建报修事务与持久化/授权仍用真实实现。
  service.guessRepairType = async () => null;
  service.findTypeRule = async () => null;
  service.ruleCandidates = async () => [];
  service.resolveContact = async () => ({ name: null, phone: null });
  service.rememberContactAsOwner = async () => undefined;
  service.notifyCandidatesOnCreate = async () => undefined;
  service.recordRepairAiFeedback = async () => undefined;
  service.logger = { warn() {}, error() {} };
  service.accessService = { getAccess: async () => access };
  const create = async (data: Record<string, unknown> = {}) => {
    const dto = await pipe.transform({ ...body, ...data }, { type: 'body', metatype: CreateRepairRequestDto });
    return service.submitOfficeRepair(dto, user, access);
  };
  return { pg, ds, service, create, statements };
}

test('成功事务写入独立具体位置，旧端不传不从地址猜；工单/日志失败整笔回滚', async t => {
  const { pg, service, create } = await fixture(t);
  const created = await create({ locationText: '  地下室　 水泵房  ', addressText: '某小区 某楼 水泵房' });
  const row: any = (await pg.query('SELECT * FROM repair_requests WHERE id=$1', [created.request.id])).rows[0];
  assert.equal(row.location_text, '地下室 水泵房');
  assert.equal(row.address_text, '某小区 某楼 水泵房');
  await create({ addressText: '某小区 大门', contactName: '联系人不是位置' });
  assert.equal((await pg.query<any>('SELECT location_text FROM repair_requests ORDER BY id DESC LIMIT 1')).rows[0].location_text, null);
  await pg.exec("ALTER TABLE work_order_logs ADD CONSTRAINT reject_create CHECK (action <> 'create') NOT VALID");
  await assert.rejects(create({ locationText: '失败位置' }));
  assert.equal((await pg.query<any>('SELECT count(*)::int n FROM repair_requests')).rows[0].n, 2);
  assert.equal((await pg.query<any>("SELECT count(*)::int n FROM repair_requests WHERE location_text='失败位置'")).rows[0].n, 0);
  assert.deepEqual(await service.locationSuggestions(10, user, access), { items: [{ text: '地下室 水泵房', count: 1 }] });
  await pg.exec('ALTER TABLE work_order_logs DROP CONSTRAINT reject_create');
  const ownerCreated = await service.submitOwnerRepair(body, { ...user, role: UserRole.OWNER }, undefined);
  assert.equal(ownerCreated.request.locationText, null);
  assert.equal((await pg.query<any>('SELECT count(*)::int n FROM repair_requests')).rows[0].n, 3);
});

test('SQL常用位置：真实报修次数降序/并列按首次成功ID稳定、租户小区隔离、作废排除、GET纯只读', async t => {
  const { pg, service, create, statements } = await fixture(t);
  assert.equal(typeof service.locationSuggestions, 'function', '缺少服务端位置统计');
  await create({ locationText: '后门' });
  await create({ locationText: '大堂' });
  await create({ locationText: ' 大堂 ' });
  await create({ locationText: '  后门  ' });
  await create({ locationText: ' 水泵房\n机房 ' });
  await create({ locationText: '水泵房　 机房' });
  await create({ locationText: '水泵房 机房' });
  const voided = await create({ locationText: '大堂' });
  // 与 voidWorkOrder 一致：仅工单状态作废，原报修仍保留 deleted_at=null。
  await service.dataSource.getRepository(WorkOrder).update({ requestId: voided.request.id }, { status: WorkOrderStatus.VOIDED });
  assert.equal((await pg.query<any>('SELECT deleted_at FROM repair_requests WHERE id=$1', [voided.request.id])).rows[0].deleted_at, null);
  await create({ locationText: ' 　' });
  await service.submitOfficeRepair({ ...body, communityId: 20, locationText: '其他处秘密' }, user, { ...access, scopeAll: true });
  await service.submitOfficeRepair({ ...body, communityId: 30, locationText: '其他公司秘密' }, { ...user, tenantId: 2 }, { ...access, scopeAll: true });
  statements.length = 0;
  const expected = { items: [{ text: '水泵房 机房', count: 3 }, { text: '后门', count: 2 }, { text: '大堂', count: 2 }] };
  assert.deepEqual(await service.locationSuggestions(10, user, access), expected);
  assert.deepEqual(await service.locationSuggestions(10, user, access), expected);
  assert.ok(statements.length > 0);
  assert.ok(statements.every(sql => /^SELECT\b/i.test(sql)), statements.join('\n'));
  assert.ok(!statements.some(sql => /\b(UPDATE|INSERT|DELETE)\b/i.test(sql)), '不能通过工单list触发自动验收');
  await assert.rejects(service.locationSuggestions(20, user, access), { status: 403 });
  await assert.rejects(service.locationSuggestions(30, user, { ...access, scopeAll: true }), { status: 404 });
  for (const denied of [{ ...access, communityIds: [] }, { ...access, pages: {} }, null]) {
    service.accessService.getAccess = async () => denied;
    await assert.rejects(service.locationSuggestions(10, user, denied), { status: 403 });
  }
  await assert.rejects(service.locationSuggestions(10, { ...user, tenantId: null }, access));
  for (const communityId of [0, -1, 1.5, NaN, 2147483648]) await assert.rejects(service.locationSuggestions(communityId, user, access), { status: 400 });
});

test('统计最多100项，作废位置从频次和前100移除，有效位置补位', async t => {
  const { pg, service } = await fixture(t);
  await pg.exec(`INSERT INTO repair_requests(tenant_id,source,community_id,content,location_text)
    SELECT 1,'office_web',10,'测试','位置' || n FROM generate_series(1,105) n;
    INSERT INTO repair_requests(tenant_id,source,community_id,content,location_text)
    SELECT 1,'office_web',10,'测试','位置105' FROM generate_series(1,3);
    INSERT INTO work_orders(tenant_id,request_id,community_id,order_no)
    SELECT tenant_id,id,community_id,'fixture-' || id FROM repair_requests`);
  const before = await service.locationSuggestions(10, user, access);
  assert.deepEqual(before.items[0], { text: '位置105', count: 4 });
  await pg.query('UPDATE work_orders SET status=$1 WHERE request_id IN (SELECT id FROM repair_requests WHERE location_text=$2)', [WorkOrderStatus.VOIDED, '位置105']);
  assert.equal((await pg.query<any>('SELECT count(*)::int n FROM repair_requests WHERE deleted_at IS NOT NULL')).rows[0].n, 0);
  const result = await service.locationSuggestions(10, user, access);
  assert.equal(result.items.length, 100);
  assert.ok(!result.items.some((item: any) => item.text === '位置105'));
  assert.deepEqual(result.items[0], { text: '位置1', count: 1 });
  assert.deepEqual(result.items[99], { text: '位置100', count: 1 });
});

test('有效关联工单须同租户且未软删：孤立报修不计，多工单只计一次，旧端null不猜位置', async t => {
  const { pg, ds, service, create } = await fixture(t);
  const valid = await create({ locationText: '有效位置' });
  const softDeleted = await create({ locationText: '工单软删位置' });
  const foreign = await create({ locationText: '跨租户位置' });
  const orphan = await create({ locationText: '孤立位置' });
  const requestDeleted = await create({ locationText: '报修软删位置' });
  await create({ addressText: '旧端大门', locationText: null });
  await ds.getRepository(WorkOrder).update({ requestId: softDeleted.request.id }, { deletedAt: new Date() });
  await ds.getRepository(WorkOrder).update({ requestId: foreign.request.id }, { tenantId: 2 });
  await ds.getRepository(WorkOrder).delete({ requestId: orphan.request.id });
  await ds.getRepository(RepairRequest).softDelete(requestDeleted.request.id);
  // 同一request挂多个有效/作废/软删工单，不得JOIN放大使用次数。
  await pg.query(`INSERT INTO work_orders(tenant_id,request_id,community_id,order_no,status,deleted_at)
    VALUES (1,$1,10,'duplicate-valid',$2,null), (1,$1,10,'duplicate-void',$3,null),
      (1,$1,10,'duplicate-deleted',$2,now())`, [valid.request.id, WorkOrderStatus.CREATED, WorkOrderStatus.VOIDED]);
  assert.deepEqual(await service.locationSuggestions(10, user, access), { items: [{ text: '有效位置', count: 1 }] });
});

test('真实Nest HTTP：work-orders view守卫、小区必选/规范正整数、越权管理处和租户拒绝', async t => {
  const { service, create } = await fixture(t);
  await create({ locationText: '大门' });
  const authz: any = {
    hasAnyPermission: AccessService.prototype.hasAnyPermission,
    hasPermission: AccessService.prototype.hasPermission,
  };
  let currentAccess: any = access;
  authz.getAccess = async () => currentAccess;
  // 仅注册本控制器和目标真实方法，避免 Service 生命周期及 AppModule 连接外部系统。
  const target = { locationSuggestions: service.locationSuggestions.bind(service) };
  @Module({ controllers: [RepairsController], providers: [
    { provide: RepairsService, useValue: target },
    { provide: AccessService, useValue: authz }, JwtAuthGuard, RolesOrPermissionGuard,
  ] })
  class IsolatedModule {}
  const app = await NestFactory.create(IsolatedModule, { logger: false });
  app.get(JwtAuthGuard).canActivate = (ctx: any) => {
    const req = ctx.switchToHttp().getRequest();
    req.user = user;
    return true;
  };
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();
  const get = (q: string) => fetch(base + '/repair-location-suggestions' + q);
  const ok = await get('?communityId=10');
  assert.equal(ok.status, 200, '缺少位置建议HTTP路由');
  assert.deepEqual(await ok.json(), { items: [{ text: '大门', count: 1 }] });
  for (const raw of ['', '0', '-1', '1.1', '1e1', '010', '+10', ' 10', '10 ', '2147483648', 'Infinity', 'NaN', '10x']) {
    assert.equal((await get('?communityId=' + encodeURIComponent(raw))).status, 400, raw);
  }
  assert.equal((await get('')).status, 400);
  assert.equal((await get('?communityId=10&communityId=20')).status, 400);
  assert.equal((await get('?communityId=20')).status, 403);
  currentAccess = { ...access, pages: {} };
  assert.equal((await get('?communityId=10')).status, 403);
});

test('具体位置独立字段：归一首尾与连续空白，非法类型/超长拒绝，旧端不传兼容', async () => {
  const dto = await pipe.transform({ ...body, locationText: ' \t地下室　 水泵房\n ' }, { type: 'body', metatype: CreateRepairRequestDto });
  assert.equal(dto.locationText, '地下室 水泵房');
  for (const locationText of [123, [], {}, true, '地'.repeat(61)]) {
    await assert.rejects(pipe.transform({ ...body, locationText }, { type: 'body', metatype: CreateRepairRequestDto }));
  }
  assert.equal((await pipe.transform(body, { type: 'body', metatype: CreateRepairRequestDto })).locationText, undefined);
  assert.equal((await pipe.transform({ ...body, locationText: '　 \n' }, { type: 'body', metatype: CreateRepairRequestDto })).locationText, '');
});
