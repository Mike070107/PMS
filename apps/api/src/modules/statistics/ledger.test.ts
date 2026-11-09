import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { LedgerStatisticsService, ledgerKeywordPatterns } from './ledger.service';
import {
  BuildingLedgerQueryDto,
  OwnerLedgerQueryDto,
  PropertySummaryQueryDto,
} from './dto';
import { StatisticsController } from './statistics.controller';

const tenantId = 1;
const user = { id: 7, tenantId } as never;
const scopeAll = { scopeAll: true } as never;
const scopeCommunityTwo = { scopeAll: false, communityIds: [2] } as never;

const communities = [
  { id: 1, name: '枫桦景苑一期' },
  { id: 2, name: '枫桦景苑二期' },
  { id: 16, name: '上海新家' },
];

/** 与生产只读实测对齐的分布（2026-11-10）：楼 207 / 房 2,346 / 业主 2,080。 */
/** 生产实测：有业主的房屋面积（distinct room）按管理处。 */
const OWNER_ROOM_AREA: Record<string, number> = {
  '01': 65_002.05, '02': 57_837.64, '03': 72_415.52, '04': 9_248, '05': 0,
};

const OFFICES: Array<{
  officeCode: string;
  road: string;
  lane: string;
  buildings: number;
  rooms: number;
  owners: number;
  areaTotal: number;
  natureRanges: Array<[string | null, number]>;
}> = [
  { officeCode: '01', road: '剑川路', lane: '198', buildings: 89, rooms: 548, owners: 539, areaTotal: 68_054.22, natureRanges: [['01', 502], ['04', 33], ['05', 10], ['06', 2], [null, 1]] },
  { officeCode: '02', road: '永德路', lane: '228', buildings: 38, rooms: 526, owners: 527, areaTotal: 57_837.64, natureRanges: [['01', 505], ['04', 11], ['05', 5], ['06', 5]] },
  { officeCode: '03', road: '永德路', lane: '228', buildings: 57, rooms: 589, owners: 589, areaTotal: 72_415.52, natureRanges: [['01', 556], ['04', 30], ['06', 3]] },
  { officeCode: '04', road: '通海路', lane: '328', buildings: 18, rooms: 425, owners: 425, areaTotal: 9_248, natureRanges: [['01', 412], ['07', 5], ['08', 8]] },
  { officeCode: '05', road: '沪闵路', lane: '1675', buildings: 5, rooms: 258, owners: 0, areaTotal: 0, natureRanges: [['07', 258]] },
];

function natureCase(ranges: Array<[string | null, number]>): string {
  let sql = 'NULL';
  let boundary = 0;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const [nature] = ranges[index];
    boundary = ranges.slice(0, index + 1).reduce((sum, item) => sum + item[1], 0);
    sql = `CASE WHEN idx <= ${boundary} THEN ${nature == null ? 'NULL' : `'${nature}'`} ELSE ${sql} END`;
  }
  return sql;
}

async function makeDatabase() {
  const pg = new PGlite();
  const migration = new MisMirror1794500000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  return pg;
}

function serviceFor(pg: PGlite) {
  const communityRepo = { find: async () => communities } as any;
  return new LedgerStatisticsService(
    { query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows } as any,
    communityRepo,
  );
}

/** 按生产分布生成楼/房/业主夹具（金额/面积为生产实测口径）。 */
async function seed(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at)
     VALUES($1,'bill',$2,now())`,
    [tenantId, '2026-11-10T01:00:00+08:00'],
  );
  for (let officeIndex = 0; officeIndex < OFFICES.length; officeIndex += 1) {
    const office = OFFICES[officeIndex];
    const buildingBase = officeIndex * 1000;
    const roomBase = officeIndex * 100_000;
    const ownerBase = officeIndex * 100_000;
    await pg.query(
      `INSERT INTO mis_mirror_building(l_id,office_code,road,lane,building_no)
       SELECT $1+idx, $2, $3, $4, idx::text FROM generate_series(1,$5) idx`,
      [buildingBase, office.officeCode, office.road, office.lane, office.buildings],
    );
    // 每栋楼房间号 101.. 叠在 idx 上便于自然排序。
    // 面积：有业主的房屋面积合计对齐生产实测（distinct room），剩余面积由无业主房屋承载。
    const ownerRooms = Math.min(office.owners, office.rooms);
    const ownerArea = OWNER_ROOM_AREA[office.officeCode] ?? 0;
    const ownerFirst = ownerRooms > 0 ? ownerArea - (ownerRooms - 1) * 10 : 0;
    const nonOwnerCount = office.rooms - ownerRooms;
    const nonOwnerSum = office.areaTotal - ownerArea;
    const nonOwnerRest = nonOwnerCount > 1 && nonOwnerSum - (nonOwnerCount - 1) * 10 >= 0 ? 10 : 0;
    const nonOwnerFirst = nonOwnerCount > 0 ? nonOwnerSum - (nonOwnerCount - 1) * nonOwnerRest : 0;
    await pg.query(
      `INSERT INTO mis_mirror_room(s_id,l_id,room_no,nature,area_sqm)
       SELECT $1+idx, $2 + ((idx-1) % $3) + 1, (100+idx)::text,
              ${natureCase(office.natureRanges)},
              CASE
                WHEN idx <= $4 THEN CASE WHEN idx = 1 THEN $5::numeric ELSE 10 END
                ELSE CASE WHEN idx = $4 + 1 THEN $6::numeric ELSE $7::numeric END
              END
         FROM generate_series(1,$8) idx`,
      [roomBase, buildingBase, office.buildings, ownerRooms, ownerFirst, nonOwnerFirst, nonOwnerRest, office.rooms],
    );
    if (office.owners > 0) {
      await pg.query(
        `INSERT INTO mis_mirror_owner(zh_id,s_id,name,mobile,phone2)
         SELECT $1+idx, $2 + ((idx-1) % $3) + 1,
                '业主' || $4::text || '-' || lpad(idx::text,4,'0'),
                '138' || lpad(($1+idx)::text, 8, '0'),
                NULL
           FROM generate_series(1,$5) idx`,
        [ownerBase, roomBase, office.rooms, office.officeCode, office.owners],
      );
    }
  }
}

test('房产汇总：生产基准 楼207/房2346/业主2080 与各管理处分布一致', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.propertySummary({} as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.rows.length, 5);
    assert.deepEqual(
      result.rows.map((row: any) => [
        row.officeCode, row.buildingCount, row.roomCount, row.ownerCount, row.totalAreaSqm,
      ]),
      [
        ['01', 89, 548, 539, 68_054.22],
        ['02', 38, 526, 527, 57_837.64],
        ['03', 57, 589, 589, 72_415.52],
        ['04', 18, 425, 425, 9_248],
        ['05', 5, 258, 0, 0],
      ],
    );
    assert.deepEqual(result.total, {
      buildingCount: 207, roomCount: 2_346, ownerCount: 2_080, totalAreaSqm: 207_555.38,
    });
    assert.equal(result.natures.length, 13);
    const office02 = result.rows.find((row: any) => row.officeCode === '02');
    assert.equal(office02.officeName, '枫桦景苑二期A');
    assert.deepEqual(office02.natureCounts, { '01': 505, '04': 11, '05': 5, '06': 5 });
    const office01 = result.rows.find((row: any) => row.officeCode === '01');
    // nature 为空的那 1 间房：不计入 natureCounts，但已在 roomCount 中。
    assert.equal(office01.natureCounts['01'], 502);
    assert.equal(Object.values(office01.natureCounts).reduce((sum: number, value: any) => sum + value, 0), 547);
    // 管理处过滤。
    const only02: any = await service.propertySummary({ officeCodes: ['02'] } as never, user, scopeAll);
    assert.deepEqual(only02.rows.map((row: any) => row.officeCode), ['02']);
    assert.equal(only02.total.roomCount, 526);
    // 数据范围收敛：二期账号只有 02/03。
    const scoped: any = await service.propertySummary({} as never, user, scopeCommunityTwo);
    assert.deepEqual(scoped.rows.map((row: any) => row.officeCode), ['02', '03']);
  } finally {
    await pg.close();
  }
});

test('住户台账：一行=一条业主记录，总数 2080；分页 totals 不变、自然排序', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.ownerLedger({} as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.count, 2_080);
    assert.equal(result.rows.length, 200);
    assert.deepEqual(result.totals, { rows: 2_080, roomCount: 2_079, totalAreaSqm: 204_503.21 });
    const first = result.rows[0];
    assert.equal(first.officeCode, '01');
    assert.equal(first.officeName, '枫桦景苑一期');
    assert.equal(first.road, '剑川路');
    assert.equal(first.lane, '198');
    assert.equal(first.buildingNo, '1');
    assert.equal(first.roomNo, '101');
    assert.equal(first.address, '剑川路198弄1号101');
    assert.equal(first.natureCode, '01');
    assert.equal(first.natureName, '商品房');
    assert.equal(first.areaSqm, 59_622.05);
    assert.match(first.ownerName, /^业主01-/);
    // 自然排序：楼栋 1,2,3… 而不是 1,10,11…
    const buildingNos = result.rows.slice(0, 6).map((row: any) => row.buildingNo);
    assert.deepEqual(buildingNos, ['1', '1', '1', '1', '1', '1']);
    // 分页：count/totals 不分页。
    const page: any = await service.ownerLedger({ limit: 5, offset: 10 } as never, user, scopeAll);
    assert.equal(page.rows.length, 5);
    assert.equal(page.count, 2_080);
    assert.deepEqual(page.totals, result.totals);
    const beyond: any = await service.ownerLedger({ limit: 5, offset: 3000 } as never, user, scopeAll);
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.count, 2_080);
    // 管理处过滤。
    const office02: any = await service.ownerLedger({ officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(office02.count, 527);
    assert.ok(office02.rows.every((row: any) => row.officeCode === '02'));
  } finally {
    await pg.close();
  }
});

test('住户台账：keyword / 房屋性质过滤，totals 随之收敛', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    // 姓名（单 token，无分隔符）保持整串模糊匹配：01 管理处共 539 条业主记录。
    const byName: any = await service.ownerLedger({ keyword: '业主01' } as never, user, scopeAll);
    assert.equal(byName.count, 539);
    assert.ok(byName.rows.every((row: any) => row.ownerName.startsWith('业主01-')));
    const byMobile: any = await service.ownerLedger({ keyword: '13800000001' } as never, user, scopeAll);
    assert.equal(byMobile.count, 1);
    // 房屋性质 07：04 管理处 5 间 + 05 无业主 → 5 条。
    const nature07: any = await service.ownerLedger({ natures: ['07'] } as never, user, scopeAll);
    assert.equal(nature07.count, 5);
    assert.ok(nature07.rows.every((row: any) => row.natureCode === '07'));
    assert.equal(nature07.totals.roomCount, 5);
    // 地址 keyword（道路+弄+楼+室）：按 /、号、弄 切 token，每个 token 都命中。
    const byAddress: any = await service.ownerLedger({ keyword: '剑川路198弄1号101' } as never, user, scopeAll);
    assert.ok(byAddress.count >= 1);
    assert.equal(byAddress.rows[0].buildingNo, '1');
    assert.equal(byAddress.rows[0].roomNo, '101');
    assert.equal(byAddress.rows[0].address, '剑川路198弄1号101');
  } finally {
    await pg.close();
  }
});

test('楼房台账：楼 207 行、房间/面积/业主合计 = 生产基准；分页与 keyword', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.buildingLedger({} as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.count, 207);
    assert.equal(result.rows.length, 200);
    assert.deepEqual(result.totals, {
      buildingCount: 207, roomCount: 2_346, totalAreaSqm: 207_555.38, ownerCount: 2_080,
    });
    const first = result.rows[0];
    assert.equal(first.officeCode, '01');
    assert.equal(first.officeName, '枫桦景苑一期');
    assert.equal(first.buildingNo, '1');
    assert.equal(first.roomCount, 7);
    assert.equal(first.areaSqm, 59_682.05);
    assert.ok(first.ownerCount > 0);
    // 分页：count/totals 不分页。
    const page: any = await service.buildingLedger({ limit: 10, offset: 5 } as never, user, scopeAll);
    assert.equal(page.rows.length, 10);
    assert.equal(page.count, 207);
    assert.deepEqual(page.totals, result.totals);
    // keyword 楼栋号 / 道路。
    const byKeyword: any = await service.buildingLedger({ keyword: '38' } as never, user, scopeAll);
    assert.ok(byKeyword.count > 0);
    assert.ok(byKeyword.rows.some((row: any) => row.officeCode === '02' && row.buildingNo === '38'));
    const byRoad: any = await service.buildingLedger({ keyword: '剑川路' } as never, user, scopeAll);
    assert.equal(byRoad.count, 89);
    // 管理处过滤。
    const only04: any = await service.buildingLedger({ officeCodes: ['04'] } as never, user, scopeAll);
    assert.equal(only04.count, 18);
    assert.equal(only04.totals.roomCount, 425);
    assert.equal(only04.totals.totalAreaSqm, 9_248);
  } finally {
    await pg.close();
  }
});

test('P3-A：权限范围、未镜像、DTO 校验、路由/权限', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    // 范围收敛 + 越权 office 不出行。
    const scopedLedger: any = await service.ownerLedger({} as never, user, scopeCommunityTwo);
    assert.ok(scopedLedger.rows.every((row: any) => ['02', '03'].includes(row.officeCode)));
    const outOfScope: any = await service.buildingLedger({ officeCodes: ['01'] } as never, user, scopeCommunityTwo);
    assert.deepEqual(outOfScope.rows, []);
    assert.equal(outOfScope.count, 0);
    await assert.rejects(
      service.propertySummary({} as never, { id: 7 } as never, scopeAll),
      /tenant scope is required/,
    );

    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const transform = (value: Record<string, unknown>, metatype: any) =>
      pipe.transform(value, { type: 'query', metatype });
    await assert.rejects(transform({ limit: '501' }, OwnerLedgerQueryDto), BadRequestException);
    await assert.rejects(transform({ limit: '0' }, OwnerLedgerQueryDto), BadRequestException);
    await assert.rejects(transform({ keyword: 'x'.repeat(51) }, BuildingLedgerQueryDto), BadRequestException);
    await assert.rejects(transform({ officeCodes: '1' }, PropertySummaryQueryDto), BadRequestException);
    await assert.rejects(transform({ natures: '01,99!' }, OwnerLedgerQueryDto), BadRequestException);
    const parsed = (await transform(
      { officeCodes: '01,02', natures: '01,04', keyword: ' 剑川路 ', limit: '50', offset: '10' },
      OwnerLedgerQueryDto,
    )) as OwnerLedgerQueryDto;
    assert.deepEqual(parsed.officeCodes, ['01', '02']);
    assert.deepEqual(parsed.natures, ['01', '04']);
    assert.equal(parsed.keyword, '剑川路');
    assert.equal(parsed.limit, 50);
    assert.equal(parsed.offset, 10);

    const handlers = StatisticsController.prototype as unknown as Record<string, any>;
    for (const key of ['propertySummary', 'ownerLedger', 'buildingLedger']) {
      assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]), {
        items: [{ pageKey: 'business', action: 'view' }],
      });
      assert.equal(Reflect.getMetadata(METHOD_METADATA, handlers[key]), RequestMethod.GET, key);
    }
    assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.propertySummary), 'property-summary');
    assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.ownerLedger), 'owner-ledger');
    assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.buildingLedger), 'building-ledger');
  } finally {
    await pg.close();
  }
});

test('未镜像：三张台账 available:false + message，不伪造 0', async () => {
  const pg = await makeDatabase();
  try {
    const service = serviceFor(pg);
    for (const call of [
      service.propertySummary({} as never, user, scopeAll),
      service.ownerLedger({} as never, user, scopeAll),
      service.buildingLedger({} as never, user, scopeAll),
    ]) {
      const result: any = await call;
      assert.equal(result.available, false);
      assert.deepEqual(result.rows, []);
      assert.match(result.message, /镜像/);
    }
    const property: any = await service.propertySummary({} as never, user, scopeAll);
    assert.equal(property.total, null);
    const owners: any = await service.ownerLedger({} as never, user, scopeAll);
    assert.equal(owners.totals, null);
    const buildings: any = await service.buildingLedger({} as never, user, scopeAll);
    assert.equal(buildings.totals, null);
  } finally {
    await pg.close();
  }
});

async function seedKeywordSample(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at)
     VALUES($1,'bill',$2,now())`,
    [tenantId, '2026-11-10T01:00:00+08:00'],
  );
  await pg.query(`INSERT INTO mis_mirror_building(l_id,office_code,road,lane,building_no) VALUES(1,'02','永德路','228','50')`);
  await pg.query(`INSERT INTO mis_mirror_room(s_id,l_id,room_no,nature,area_sqm) VALUES(1,1,'202','01',88.5)`);
  await pg.query(`INSERT INTO mis_mirror_owner(zh_id,s_id,name,mobile,phone2) VALUES(1,1,'王测试','13900001111','02112345678')`);
}

test('住户台账 keyword 地址 token：228/50/202 命中、228/50/999 为空，单 token 行为不变', async () => {
  const pg = await makeDatabase();
  try {
    await seedKeywordSample(pg);
    const service = serviceFor(pg);
    // 切分规则：/、-、空白、号/弄/楼/室；单 token 保留整串。
    assert.deepEqual(ledgerKeywordPatterns('228/50/202'), ['228', '50', '202']);
    assert.deepEqual(ledgerKeywordPatterns('228-50-202'), ['228', '50', '202']);
    assert.deepEqual(ledgerKeywordPatterns('228 50 202'), ['228', '50', '202']);
    assert.deepEqual(ledgerKeywordPatterns('永德路228弄50号202'), ['永德路228', '50', '202']);
    assert.deepEqual(ledgerKeywordPatterns('王测试'), ['王测试']);
    assert.deepEqual(ledgerKeywordPatterns('13900001111'), ['13900001111']);

    const hit: any = await service.ownerLedger({ keyword: '228/50/202' } as never, user, scopeAll);
    assert.ok(hit.count >= 1);
    assert.equal(hit.count, 1);
    assert.equal(hit.rows[0].address, '永德路228弄50号202');
    assert.equal(hit.rows[0].road, '永德路');
    assert.equal(hit.rows[0].lane, '228');
    assert.equal(hit.rows[0].buildingNo, '50');
    assert.equal(hit.rows[0].roomNo, '202');
    // 中文分隔符/空格/连字符同样命中。
    assert.equal((await service.ownerLedger({ keyword: '228 50 202' } as never, user, scopeAll)).count, 1);
    assert.equal((await service.ownerLedger({ keyword: '228-50-202' } as never, user, scopeAll)).count, 1);
    assert.equal((await service.ownerLedger({ keyword: '永德路228弄50号202' } as never, user, scopeAll)).count, 1);
    // 不存在的房号 → 0（token AND 语义）。
    assert.equal((await service.ownerLedger({ keyword: '228/50/999' } as never, user, scopeAll)).count, 0);
    // 单 token：姓名 / 手机 / 电话前缀保持整串模糊匹配。
    assert.equal((await service.ownerLedger({ keyword: '王测试' } as never, user, scopeAll)).count, 1);
    assert.equal((await service.ownerLedger({ keyword: '13900001111' } as never, user, scopeAll)).count, 1);
    assert.equal((await service.ownerLedger({ keyword: '021123' } as never, user, scopeAll)).count, 1);
    assert.equal((await service.ownerLedger({ keyword: '228/50' } as never, user, scopeAll)).count, 1);
    // 楼房台账同样 token 化：228/50 命中，228/999 为空。
    const buildingHit: any = await service.buildingLedger({ keyword: '228/50' } as never, user, scopeAll);
    assert.equal(buildingHit.count, 1);
    assert.equal(buildingHit.rows[0].buildingNo, '50');
    assert.equal(buildingHit.rows[0].lane, '228');
    assert.equal((await service.buildingLedger({ keyword: '228/999' } as never, user, scopeAll)).count, 0);
    assert.equal((await service.buildingLedger({ keyword: '永德路' } as never, user, scopeAll)).count, 1);
  } finally {
    await pg.close();
  }
});