/// <reference lib="dom" />
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { AiExtractSample } from '../../entities/ai-extract-sample.entity';
import { ExtractSamplesService } from './extract-samples.service';
import { RepairTextAiService } from './repair-text.ai';
import { AiController } from './ai.controller';
import { LlmService } from './llm.service';
import { AiFeedbackService } from './ai-feedback.service';
import { RepairFeeRulesService } from './repair-fee-rules.service';
import { AiUsageService } from './ai-usage.service';
import { SettingsService } from '../settings/settings.service';
import { AccessService } from '../access/access.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';

// 真TypeORM SQL→隔离PGlite PostgreSQL；不加载AppModule/.env，不连外部数据库。
async function fixture(t: any) {
  const pg = new PGlite(); t.after(() => pg.close());
  const ds = new DataSource({ type: 'postgres', entities: [AiExtractSample] });
  await (ds as any).buildMetadatas();
  const runner = (connection: any, active = false): any => {
    const qr: any = {
      connection: ds, isReleased: false, isTransactionActive: active, data: {},
      connect: async () => undefined, release: async () => undefined,
      startTransaction: async () => { await connection.exec('BEGIN'); qr.isTransactionActive = true; },
      commitTransaction: async () => { await connection.exec('COMMIT'); qr.isTransactionActive = false; },
      rollbackTransaction: async () => { await connection.exec('ROLLBACK'); qr.isTransactionActive = false; },
      query: async (sql: string, params: any[] = [], structured = false) => {
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
  const meta = ds.getMetadata(AiExtractSample);
  const columns = meta.columns.map((column) => {
    const type = column.isGenerated ? 'serial' : ds.driver.normalizeType(column);
    const length = column.length ? `(${column.length})` : '';
    const defaultValue = ds.driver.normalizeDefault(column);
    return `"${column.databaseName}" ${type}${length}` + (column.isPrimary ? ' PRIMARY KEY' : '')
      + (column.isNullable ? '' : ' NOT NULL')
      + (!column.isGenerated && defaultValue !== undefined ? ` DEFAULT ${defaultValue}` : '');
  });
  await pg.exec(`CREATE TABLE "${meta.tableName}" (${columns.join(',')})`);
  const repo = ds.getRepository(AiExtractSample);
  return { pg, repo, samples: new ExtractSamplesService(repo) };
}

const types = [
  { repairType: 'intercom', label: '楼宇对讲', keywords: [] },
  { repairType: 'electric', label: '电气', keywords: [] },
];

test('PostgreSQL JSON scope先于take；201条其它处样例不挤掉本处；禁用/删除/重启不残留', async t => {
  const { repo, samples } = await fixture(t);
  const learned = await samples.rememberRepairType(7, 8, 10, 99, '家里话机没信号', 'electric');
  await repo.save(Array.from({ length: 201 }, (_, index) => repo.create({ tenantId: 7, kind: 'repair',
    text: `其它处样例${index}`, expected: { repairType: 'intercom', _classificationOnly: true, _officeId: 20 },
    enabled: true, createdBy: 8, updatedBy: 8 })));
  assert.ok((await samples.forPrompt(7, 'repair', '家里话机没信号', 10)).some(row => row.id === learned!.id));
  assert.equal((await samples.findExact(7, '家里话机没信号', 'repair', 10))?.id, learned!.id);
  assert.equal(await samples.findExact(7, '家里话机没信号', 'repair', 20), null);
  assert.equal(await samples.findExact(7, '家里话机没信号', 'repair'), null);
  assert.equal(await samples.findExact(8, '家里话机没信号', 'repair', 10), null);
  await samples.update(7, 8, learned!.id, { expected: { repairType: 'intercom', _officeId: 20 } });
  assert.equal((await repo.findOneByOrFail({ id: learned!.id })).expected._officeId, 10);
  await samples.update(7, 8, learned!.id, { enabled: false });
  assert.equal(await samples.findExact(7, '家里话机没信号', 'repair', 10), null);
  for (const row of await samples.list(7)) await samples.remove(7, row.id);
  const restarted = new ExtractSamplesService(repo);
  assert.deepEqual(await restarted.list(7), []);
  const marker = await repo.findOneByOrFail({ tenantId: 7, kind: 'repair_seeded' });
  await assert.rejects(restarted.remove(7, marker.id), /样例不存在/);
  await assert.rejects(restarted.update(7, 8, marker.id, { enabled: true }), /样例不存在/);
  assert.deepEqual(await restarted.forPrompt(7, 'repair', '家里话机没信号', 10), []);
});

test('真实AI样例HTTP列表/PATCH/DELETE→PostgreSQL读取→删除后下次恢复AI；权限/租户边界', async t => {
  const { repo, samples } = await fixture(t);
  const learned = await samples.rememberRepairType(7, 8, 10, 99, '家里话机没信号', 'electric');
  const auth = { canActivate(context: any) {
    const req = context.switchToHttp().getRequest();
    req.user = { id: 8, tenantId: Number(req.headers['x-fixture-tenant'] || 7) };
    const allowed = req.headers['x-fixture-permission'] === 'edit';
    req.access = { pages: { settings: { view: true, edit: allowed } }, scopeAll: true, communityIds: [] };
    return true;
  } };
  const access = { hasAnyPermission: AccessService.prototype.hasAnyPermission, hasPermission: AccessService.prototype.hasPermission };
  @Module({ controllers: [AiController], providers: [
    PermissionsGuard, JwtAuthGuard, { provide: AccessService, useValue: access },
    { provide: ExtractSamplesService, useValue: samples },
    ...[LlmService, AiFeedbackService, RepairFeeRulesService, AiUsageService, SettingsService].map(provide => ({ provide, useValue: {} })),
  ] }) class FixtureModule {}
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.get(JwtAuthGuard).canActivate = auth.canActivate;
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const url = await app.getUrl();
  const edit = { 'x-fixture-permission': 'edit' };
  const listing = await fetch(`${url}/settings/ai/samples`);
  const listed = await listing.json() as any[];
  assert.equal(listing.status, 200, JSON.stringify(listed));
  assert.ok(listed.some(row => row.id === learned!.id && row.note.includes('管理处 #10')));
  assert.ok(listed.every(row => row.kind === 'repair'));
  assert.equal((await fetch(`${url}/settings/ai/samples/${learned!.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(`${url}/settings/ai/samples/${learned!.id}`, { method: 'DELETE', headers: { ...edit, 'x-fixture-tenant': '8' } })).status, 404);
  assert.equal((await fetch(`${url}/settings/ai/samples/${learned!.id}`, { method: 'PATCH', headers: { ...edit, 'content-type': 'application/json' },
    body: JSON.stringify({ expected: { repairType: 'electric', _officeId: 20 } }) })).status, 200);
  assert.equal((await repo.findOneByOrFail({ id: learned!.id })).expected._officeId, 10);
  let calls = 0;
  const ai = new RepairTextAiService({ askJson: async () => { calls++; return { repairType: 'intercom', description: '家里话机没信号' }; } } as any, samples);
  assert.equal((await ai.parse(7, '家里话机没信号', types, 10))?.repairType, 'electric');
  assert.equal((await fetch(`${url}/settings/ai/samples/${learned!.id}`, { method: 'DELETE', headers: edit })).status, 200);
  assert.equal(await repo.findOneBy({ id: learned!.id }), null);
  calls = 0;
  assert.equal((await ai.parse(7, '家里话机没信号', types, 10))?.repairType, 'intercom');
  assert.equal(calls, 1);
  assert.ok(!(await samples.forPrompt(7, 'repair', '家里话机没信号', 10)).some(row => row.id === learned!.id));
});
