import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DataSource } from 'typeorm';
import { ParkingSpace } from '../../entities/parking-space.entity';
import { BusinessService } from './business.service';
import { ParkingSpaceCategory1796100000000 } from '../../migrations/1796100000000-ParkingSpaceCategory';

// 真正执行 TypeORM 生成的 PostgreSQL SQL；仅使用内存 WASM 数据库，不初始化 pg 连接。
test('A01/A02 SQL复核：租户/小区隔离、空归属、自然排序与档案更新回读', async () => {
  const db = new PGlite();
  const source = new DataSource({ type: 'postgres', entities: [ParkingSpace] });
  await (source as any).buildMetadatas();
  const realRepo = source.getRepository(ParkingSpace);
  const metadata = realRepo.metadata;
  try {
    await db.exec(`CREATE TABLE parking_spaces (
      id serial PRIMARY KEY, tenant_id int NOT NULL, community_id int,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), created_by int, updated_by int,
      garage varchar(20), space_no varchar(20), house_no varchar(60), area_sqm numeric(7,2),
      plate varchar(20), owner_name varchar(60), owner_tel varchar(30), end_date date,
      note varchar(60), source varchar(60)
    );
    INSERT INTO parking_spaces(id, tenant_id, community_id, garage, space_no, plate) VALUES
      (1,1,10,'main','1','沪A12345'), (2,1,10,'main','10',null), (3,1,10,'main','2',null),
      (4,1,20,'main','3',null), (5,2,10,'main','4',null), (6,1,null,'civil','5',null);
    UPDATE parking_spaces SET note=CASE id WHEN 1 THEN '产权' WHEN 2 THEN '租赁车位' ELSE '空置' END,
      source='旧档案来源', house_no='228/6/502', owner_name='旧业主', owner_tel='13800000000',
      area_sqm=12.50, end_date='2028-02-29';`);
    const legacyRows = (await db.query('SELECT * FROM parking_spaces ORDER BY id')).rows;
    const migration = new ParkingSpaceCategory1796100000000();
    const migrationSql: string[] = [];
    const runner: any = { query: async (sql: string) => { migrationSql.push(sql); return db.query(sql); } };
    await migration.up(runner);
    await migration.up(runner); // IF NOT EXISTS：重跑仍无额外数据操作。
    assert.deepEqual(migrationSql, Array(2).fill('ALTER TABLE parking_spaces ADD COLUMN IF NOT EXISTS category varchar(20)'));
    const column = (await db.query(`SELECT data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns WHERE table_name='parking_spaces' AND column_name='category'`)).rows[0];
    assert.deepEqual(column, { data_type: 'character varying', character_maximum_length: 20, is_nullable: 'YES', column_default: null });
    const migratedRows: any[] = (await db.query('SELECT * FROM parking_spaces ORDER BY id')).rows;
    assert.ok(migratedRows.every(row => row.category === null), '旧备注/车牌不批量推断类别');
    assert.deepEqual(migratedRows.map(({ category, ...row }) => row), legacyRows, '迁移不改变任一旧字段');
    const execute = async (qb: any) => {
      const [sql, params] = qb.getQueryAndParameters();
      const result = await db.query(sql, params);
      return result.rows.map((raw: any) => Object.fromEntries(metadata.columns.map(col =>
        [col.propertyName, raw['s_' + col.databaseName]])));
    };
    const service: any = Object.create(BusinessService.prototype);
    service.spaceRepo = {
      createQueryBuilder: () => {
        const qb = realRepo.createQueryBuilder('s');
        qb.getMany = () => execute(qb) as any;
        return qb;
      },
      findOne: async (options: any) => {
        const qb = realRepo.createQueryBuilder('s').setFindOptions(options);
        return (await execute(qb))[0] ?? null;
      },
      save: async (row: any) => {
        const values = ['plate','houseNo','ownerName','ownerTel','note','areaSqm','endDate','category','updatedBy'];
        const columns = values.map(key => metadata.findColumnWithPropertyName(key)!.databaseName);
        await db.query('UPDATE parking_spaces SET ' + columns.map((col, i) => col + '=$' + (i + 1)).join(',') +
          ` WHERE id=$${values.length + 1} AND tenant_id=$${values.length + 2}`, [...values.map(key => row[key] ?? null), row.id, row.tenantId]);
        return row;
      },
    };
    const user = { id: 7, tenantId: 1, role: 'staff' };
    const access = { scopeAll: false, communityIds: [10] };
    const scoped = await service.listParkingSpaces('main', undefined, user, access);
    assert.deepEqual(scoped.rows.map((r: any) => r.spaceNo), ['1','2','10']);
    assert.equal(scoped.total, 3);
    assert.equal(scoped.bound, 1);
    assert.deepEqual((await service.listParkingSpaces(undefined, undefined, user, { scopeAll: true })).rows.map((r: any) => r.id).sort(), [1,2,3,4,6]);
    assert.equal((await service.listParkingSpaces(undefined, undefined, user, { scopeAll: false, communityIds: [] })).total, 0);
    for (const id of [4,5,6,999]) {
      await assert.rejects(() => service.updateParkingSpace(id, { ownerName: '越权' }, user, access), { status: 404 });
    }
    const before = await db.query('SELECT owner_name FROM parking_spaces WHERE id IN (4,5,6)');
    assert.ok(before.rows.every((r: any) => r.owner_name === '旧业主'));
    const categoryBefore: any = (await db.query('SELECT * FROM parking_spaces WHERE id=1')).rows[0];
    for (const category of ['property', 'rental', 'vacant', null]) {
      const patched = await service.updateParkingSpace(1, { category }, user, access);
      assert.equal(patched.category, category);
      assert.equal(patched.communityId, 10);
      const sqlRow: any = (await db.query('SELECT * FROM parking_spaces WHERE id=1')).rows[0];
      assert.equal(sqlRow.category, category);
      for (const key of Object.keys(categoryBefore).filter(key => !['category', 'updated_by'].includes(key))) {
        assert.deepEqual(sqlRow[key], categoryBefore[key], key + '类别更新不可改变');
      }
      const readback = (await service.listParkingSpaces('main', '沪A12345', user, access)).rows[0];
      assert.equal(readback.category, category);
      assert.equal(readback.communityId, 10);
      await service.updateParkingSpace(1, { ownerName: '临时名字' }, user, access);
      assert.equal((await db.query<any>('SELECT category FROM parking_spaces WHERE id=1')).rows[0].category, category, '省略类别保持');
      await service.updateParkingSpace(1, { ownerName: '旧业主' }, user, access);
    }
    const allBefore = (await db.query('SELECT * FROM parking_spaces ORDER BY id')).rows;
    for (const id of [4,5,6,999]) {
      await assert.rejects(() => service.updateParkingSpace(id, { category: 'vacant' }, user, access), { status: 404 });
    }
    await assert.rejects(() => service.updateParkingSpace(1, { category: null }, user, { scopeAll: false, communityIds: [] }), { status: 404 });
    for (const category of ['', ' property', 'PROPERTY', 123, {}, []]) {
      await assert.rejects(() => service.updateParkingSpace(1, { category }, user, access), { status: 400 });
    }
    assert.deepEqual((await db.query('SELECT * FROM parking_spaces ORDER BY id')).rows, allBefore, '非法/越权不写任何旧字段');
    await service.updateParkingSpace(1, { ownerName: '张三', areaSqm: '12.50', endDate: '2028-02-29' }, user, access);
    const readback = (await service.listParkingSpaces('main', '沪A12345', user, access)).rows;
    assert.equal(readback.length, 1);
    assert.equal(readback[0].ownerName, '张三');
    assert.equal(readback[0].areaSqm, '12.50');
    assert.equal(readback[0].endDate.toISOString().slice(0,10), '2028-02-29');
    assert.equal((await db.query<{ updated_by: number }>('SELECT updated_by FROM parking_spaces WHERE id=1')).rows[0].updated_by, 7);
  } finally { await db.close(); }
});
