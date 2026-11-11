import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { MisMirrorService } from './mis-mirror.service';

/**
 * 每日对账（reconcile）新增维度核对回归：金额/记录一致但楼/室/业主维度过期时不能报“一致”，
 * 并把镜像内房号/地址空白规模写进日志详情，便于判断“房号没同步”还是页面取值问题。
 * 仅本地 PGlite 合成夹具，不连 MIS/生产。
 */

async function fixture(source: { total: number; amount: string; buildings: number; rooms: number; owners: number }) {
  const pg = new PGlite();
  const runner = { query: (sql: string) => pg.query(sql) } as any;
  await new MisMirror1794500000000().up(runner);
  await new MisMirrorBillNature1795300000000().up(runner);
  await pg.query(`CREATE TABLE system_logs(
    id serial PRIMARY KEY, tenant_id int, category varchar(20), level varchar(20), source varchar(40),
    action varchar(60), success boolean, message text, detail jsonb, created_at timestamptz, updated_at timestamptz)`);
  const dataSource = { query: async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows } as any;
  const service: any = new MisMirrorService(dataSource, {
    mirrorRead: async (sql: string) => {
      if (sql.includes('COUNT_BIG(*) AS total')) return { recordsets: [[{ total: String(source.total), amount: source.amount }]] };
      if (sql.includes('FROM dbo.楼表) AS buildings')) {
        return { recordsets: [[{ buildings: String(source.buildings), rooms: String(source.rooms), owners: String(source.owners) }]] };
      }
      throw new Error(`unexpected source SQL: ${sql.slice(0, 80)}`);
    },
  } as any, { findOne: async () => null, save: async (value: unknown) => value, create: (value: unknown) => value } as any);
  return { pg, service };
}

function seedMirror(pg: PGlite, input: { bills: number; amountCents: number; buildings: number; rooms: number; owners: number; roomNo?: string | null; address?: string | null }) {
  return (async () => {
    for (let index = 1; index <= input.buildings; index++) {
      await pg.query(`INSERT INTO mis_mirror_building(l_id,office_code,road,building_no) VALUES($1,'02','合成路',$2)`, [index, String(index)]);
    }
    for (let index = 1; index <= input.rooms; index++) {
      await pg.query(`INSERT INTO mis_mirror_room(s_id,l_id,room_no,nature,area_sqm) VALUES($1,1,$2,'01',88.5)`,
        [index, index === 1 && input.roomNo !== undefined ? input.roomNo : `${100 + index}`]);
    }
    for (let index = 1; index <= input.owners; index++) {
      await pg.query(`INSERT INTO mis_mirror_owner(zh_id,s_id,name) VALUES($1,1,'合成住户')`, [index]);
    }
    for (let index = 1; index <= input.bills; index++) {
      await pg.query(
        `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,period,amount_cents,address,nature_code)
         VALUES($1,'02',1,'202610',$2,$3,'01')`,
        [index, Math.round(input.amountCents / input.bills), index === 1 && input.address !== undefined ? input.address : '合成路1号101'],
      );
    }
  })();
}

test('每日对账：金额/记录/维度全一致才 ok，并记录房号与地址空白规模', async () => {
  const { pg, service } = await fixture({ total: 2, amount: '20000.00', buildings: 2, rooms: 3, owners: 4 });
  try {
    await seedMirror(pg, { bills: 2, amountCents: 20000, buildings: 2, rooms: 3, owners: 4, roomNo: '', address: '' });
    const result = await service.reconcile(1);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.dimensionDiff, { buildings: 0, rooms: 0, owners: 0 });
    assert.deepEqual(result.quality, { roomsWithoutNo: 1, billsWithoutAddress: 1 });
    const logs = (await pg.query(`SELECT level,success,message,detail FROM system_logs ORDER BY id DESC LIMIT 1`)).rows as any[];
    assert.equal(logs[0].level, 'info');
    assert.equal(logs[0].success, true);
    assert.equal(logs[0].message, 'MIS 镜像对账一致');
    assert.equal(Number(logs[0].detail.quality.roomsWithoutNo), 1, '日志里要能看出房号空白规模');
  } finally {
    await pg.close();
  }
});

test('每日对账：金额一致但室/业主维度差 → 不报一致，提示需要手工重灌', async () => {
  const { pg, service } = await fixture({ total: 2, amount: '20000.00', buildings: 2, rooms: 5, owners: 6 });
  try {
    await seedMirror(pg, { bills: 2, amountCents: 20000, buildings: 2, rooms: 3, owners: 4 });
    const result = await service.reconcile(1);
    assert.equal(result.ok, false);
    assert.equal(result.totalDiff, 0);
    assert.equal(result.amountDiff, 0);
    assert.deepEqual(result.dimensionDiff, { buildings: 0, rooms: -2, owners: -2 });
    const logs = (await pg.query(`SELECT level,success,message,detail FROM system_logs ORDER BY id DESC LIMIT 1`)).rows as any[];
    assert.equal(logs[0].level, 'warning');
    assert.equal(logs[0].success, false);
    assert.match(logs[0].message, /维度差/);
    assert.match(logs[0].message, /重灌/);
    assert.equal(Number(logs[0].detail.dimensionDiff.rooms), -2);
  } finally {
    await pg.close();
  }
});
