import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorP4Extras1795500000000 } from '../../migrations/1795500000000-MisMirrorP4Extras';
import { MiscReportService } from './misc-report.service';
import { ReliefQueryDto, SignoffQueryDto } from './dto';
import { StatisticsController } from './statistics.controller';

const tenantId = 1;
const user = { id: 7, tenantId } as never;
const scopeAll = { scopeAll: true } as never;
const scopeCommunityTwo = { scopeAll: false, communityIds: [2] } as never;

const communities = [
  { id: 1, name: '枫桦景苑一期' },
  { id: 2, name: '枫桦景苑二期' },
];

async function makeDatabase() {
  const pg = new PGlite();
  await new MisMirror1794500000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new MisMirrorP4Extras1795500000000().up({ query: (sql: string) => pg.query(sql) } as any);
  return pg;
}

function serviceFor(pg: PGlite) {
  const communityRepo = { find: async () => communities } as any;
  return new MiscReportService(
    { query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows } as any,
    communityRepo,
  );
}

async function seed(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at) VALUES($1,'relief',$2,now())`,
    [tenantId, '2026-11-10T01:00:00+08:00'],
  );
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at) VALUES($1,'signoff',$2,now())`,
    [tenantId, '2026-11-10T01:00:00+08:00'],
  );
  await pg.query(`INSERT INTO mis_mirror_building(l_id,office_code,road,lane,building_no) VALUES(1,'02','永德路','228','50'),(2,'01','剑川路','198','1')`);
  await pg.query(`INSERT INTO mis_mirror_room(s_id,l_id,room_no,nature,area_sqm) VALUES(1,1,'202','01',88.5),(2,2,'101','01',90)`);
  await pg.query(`INSERT INTO mis_mirror_owner(zh_id,s_id,name,mobile,phone2) VALUES(133,1,'袁明森','13900001111',NULL),(134,2,'诸钟尧','13900002222',NULL)`);
  await pg.query(
    `INSERT INTO mis_mirror_signoff(id,doc_no,title,type,detail,office_code,reason,zh_id,draft_date,approve_date,result,voided,ended,adjust_amount_cents,fee_code,nature,source_updated_at)
     VALUES
       (23,'2026-00000022','通海路328弄16号103减免','减免签报','一次性减免','02','2026年11-12月租金5000元，经公司批准减免。',133,'2026-08-21','2026-08-31',NULL,false,true,123450,NULL,NULL,'2026-08-31T00:00:00'),
       (22,'2026-00000021','旧欠减免作废','减免签报','一次性减免','02','已作废',134,'2026-07-15',NULL,NULL,true,false,100000,NULL,NULL,'2026-07-16T00:00:00'),
       (21,'2026-00000020','在办签报','其他签报',NULL,'01','流程中',NULL,'2026-09-01',NULL,NULL,false,false,NULL,NULL,NULL,'2026-09-02T00:00:00')`,
  );
  await pg.query(
    `INSERT INTO mis_mirror_relief(id,doc_no,zh_id,fee_code,fee_name,old_receivable_cents,receivable_cents,relief_cents,relief_start_date,relief_end_date,relief_date,method)
     VALUES
       (19,'2026-00000022',133,'02','租金',500000,0,500000,'2026-11-21','2026-12-21','2026-08-21',NULL),
       (18,'2026-00000021',134,'01','管理费',100000,50000,50000,'2026-07-15','2026-12-31','2026-08-11','一次性'),
       (17,'NO-SIGNOFF',134,'01','管理费',20000,0,20000,'2026-07-01','2026-07-31','2026-07-01',NULL)`,
  );
}

test('减免情况统计：默认排序/合计/地址业主/日期与费项过滤', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.relief({} as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.count, 3);
    assert.deepEqual(result.rows.map((row: any) => row.id), [19, 18, 17]);
    const first = result.rows[0];
    assert.equal(first.docNo, '2026-00000022');
    assert.equal(first.officeCode, '02');
    assert.equal(first.officeName, '枫桦景苑二期A');
    assert.equal(first.zhId, 133);
    assert.equal(first.address, '永德路228弄50号202');
    assert.equal(first.ownerName, '袁明森');
    assert.equal(first.feeCode, '02');
    assert.equal(first.feeName, '租金');
    assert.equal(first.oldReceivableCents, 500000);
    assert.equal(first.receivableCents, 0);
    assert.equal(first.reliefCents, 500000);
    assert.equal(first.reliefStartDate, '2026-11-21');
    assert.equal(first.reliefEndDate, '2026-12-21');
    assert.equal(first.reliefDate, '2026-08-21');
    assert.deepEqual(result.totals, { count: 3, oldReceivableCents: 620000, receivableCents: 50000, reliefCents: 570000 });
    // 无签报记录的减免：office 从房屋楼栋回退，地址/业主仍可出。
    const orphan = result.rows.find((row: any) => row.id === 17);
    assert.equal(orphan.officeCode, '01');
    assert.equal(orphan.address, '剑川路198弄1号101');
    assert.equal(orphan.ownerName, '诸钟尧');

    const office02: any = await service.relief({ officeCodes: ['02'] } as never, user, scopeAll);
    assert.deepEqual(office02.rows.map((row: any) => row.id), [19, 18]);
    assert.equal(office02.totals.count, 2);
    const august: any = await service.relief({ dateFrom: '2026-08-01', dateTo: '2026-08-31' } as never, user, scopeAll);
    assert.deepEqual(august.rows.map((row: any) => row.id), [19, 18]);
    const fee02: any = await service.relief({ feeCodes: ['02'] } as never, user, scopeAll);
    assert.deepEqual(fee02.rows.map((row: any) => row.id), [19]);
    // keyword：业主 / 费项名 / 文号。
    assert.deepEqual(((await service.relief({ keyword: '袁明森' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [19]);
    assert.deepEqual(((await service.relief({ keyword: '租金' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [19]);
    assert.deepEqual(((await service.relief({ keyword: '2026-00000021' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [18]);
    // 分页不影响 totals。
    const page: any = await service.relief({ limit: 1, offset: 1 } as never, user, scopeAll);
    assert.deepEqual(page.rows.map((row: any) => row.id), [18]);
    assert.equal(page.count, 3);
    assert.deepEqual(page.totals, result.totals);
    // 数据范围收敛：二期账号只看到 02/03 的减免。
    const scoped: any = await service.relief({} as never, user, scopeCommunityTwo);
    assert.deepEqual(scoped.rows.map((row: any) => row.id), [19, 18]);
  } finally {
    await pg.close();
  }
});

test('签报情况统计：草稿日期降序、status 四态、类型/日期/管理处/关键词过滤', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.signoffs({} as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.count, 3);
    assert.deepEqual(result.rows.map((row: any) => row.id), [21, 23, 22]);
    const effective = result.rows.find((row: any) => row.id === 23);
    assert.equal(effective.docNo, '2026-00000022');
    assert.equal(effective.officeName, '枫桦景苑二期A');
    assert.equal(effective.address, '永德路228弄50号202');
    assert.equal(effective.ownerName, '袁明森');
    assert.equal(effective.draftDate, '2026-08-21');
    assert.equal(effective.approveDate, '2026-08-31');
    assert.equal(effective.voided, false);
    assert.equal(effective.ended, true);
    assert.equal(effective.adjustAmountCents, 123450);
    assert.deepEqual(result.totals, { count: 3, voidedCount: 1, endedCount: 1, adjustAmountCents: 223450 });

    assert.deepEqual(((await service.signoffs({ status: 'effective' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [23]);
    assert.deepEqual(((await service.signoffs({ status: 'voided' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [22]);
    assert.deepEqual(((await service.signoffs({ status: 'open' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [21]);
    assert.deepEqual(((await service.signoffs({ types: ['减免签报'] } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [23, 22]);
    assert.deepEqual(((await service.signoffs({ officeCodes: ['02'] } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [23, 22]);
    assert.deepEqual(((await service.signoffs({ dateFrom: '2026-08-01', dateTo: '2026-08-31' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [23]);
    assert.deepEqual(((await service.signoffs({ keyword: '减免签报' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [23, 22]);
    assert.deepEqual(((await service.signoffs({ keyword: '袁明森' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [23]);
    // 分页不影响 totals。
    const page: any = await service.signoffs({ limit: 1, offset: 0 } as never, user, scopeAll);
    assert.equal(page.rows.length, 1);
    assert.deepEqual(page.totals, result.totals);
    assert.equal(page.count, 3);
  } finally {
    await pg.close();
  }
});

test('P4-A：权限范围、未镜像、DTO/日期校验、路由权限', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const scopedSignoff: any = await service.signoffs({} as never, user, scopeCommunityTwo);
    assert.deepEqual(scopedSignoff.rows.map((row: any) => row.officeCode), ['02', '02']);
    await assert.rejects(
      service.relief({} as never, { id: 7 } as never, scopeAll),
      /tenant scope is required/,
    );
    await assert.rejects(
      service.relief({ dateFrom: '2026-09-01', dateTo: '2026-08-01' } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );

    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const transform = (value: Record<string, unknown>, metatype: any) =>
      pipe.transform(value, { type: 'query', metatype });
    await assert.rejects(transform({ dateFrom: '2026/08/01' }, ReliefQueryDto), BadRequestException);
    await assert.rejects(transform({ limit: '501' }, ReliefQueryDto), BadRequestException);
    await assert.rejects(transform({ keyword: 'x'.repeat(51) }, SignoffQueryDto), BadRequestException);
    await assert.rejects(transform({ status: 'bogus' }, SignoffQueryDto), BadRequestException);
    const parsed = (await transform(
      { officeCodes: '02,03', types: '减免签报,其他签报', status: 'effective', keyword: ' 租金 ' },
      SignoffQueryDto,
    )) as SignoffQueryDto;
    assert.deepEqual(parsed.officeCodes, ['02', '03']);
    assert.deepEqual(parsed.types, ['减免签报', '其他签报']);
    assert.equal(parsed.status, 'effective');
    assert.equal(parsed.keyword, '租金');

    const handlers = StatisticsController.prototype as unknown as Record<string, any>;
    for (const key of ['relief', 'signoffs']) {
      assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]), {
        items: [{ pageKey: 'business', action: 'view' }],
      });
      assert.equal(Reflect.getMetadata(METHOD_METADATA, handlers[key]), RequestMethod.GET, key);
    }
    assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.relief), 'relief');
    assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.signoffs), 'signoffs');
  } finally {
    await pg.close();
  }
});

test('未镜像：两报表 available:false + message，聚合 null', async () => {
  const pg = await makeDatabase();
  try {
    const service = serviceFor(pg);
    const relief: any = await service.relief({} as never, user, scopeAll);
    assert.equal(relief.available, false);
    assert.equal(relief.totals, null);
    assert.deepEqual(relief.rows, []);
    assert.match(relief.message, /镜像/);
    const signoffs: any = await service.signoffs({} as never, user, scopeAll);
    assert.equal(signoffs.available, false);
    assert.equal(signoffs.totals, null);
    assert.match(signoffs.message, /镜像/);
  } finally {
    await pg.close();
  }
});
