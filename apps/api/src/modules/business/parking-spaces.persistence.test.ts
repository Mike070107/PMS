import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DataSource } from 'typeorm';
import { ParkingSpace } from '../../entities/parking-space.entity';
import { BusinessService } from './business.service';

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
      (4,1,20,'main','3',null), (5,2,10,'main','4',null), (6,1,null,'civil','5',null);`);
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
        const values = ['plate','houseNo','ownerName','ownerTel','note','areaSqm','endDate','updatedBy'];
        const columns = values.map(key => metadata.findColumnWithPropertyName(key)!.databaseName);
        await db.query('UPDATE parking_spaces SET ' + columns.map((col, i) => col + '=$' + (i + 1)).join(',') +
          ' WHERE id=$9 AND tenant_id=$10', [...values.map(key => row[key] ?? null), row.id, row.tenantId]);
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
    assert.ok(before.rows.every((r: any) => r.owner_name === null));
    await service.updateParkingSpace(1, { ownerName: '张三', areaSqm: '12.50', endDate: '2028-02-29' }, user, access);
    const readback = (await service.listParkingSpaces('main', '沪A12345', user, access)).rows;
    assert.equal(readback.length, 1);
    assert.equal(readback[0].ownerName, '张三');
    assert.equal(readback[0].areaSqm, '12.50');
    assert.equal(readback[0].endDate.toISOString().slice(0,10), '2028-02-29');
    assert.equal((await db.query<{ updated_by: number }>('SELECT updated_by FROM parking_spaces WHERE id=1')).rows[0].updated_by, 7);
  } finally { await db.close(); }
});
