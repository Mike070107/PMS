import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { entities, User, House, Building, Community, RepairRequest, ParkingHistory } from '../../entities';
import { OwnersMgmtService } from './owners-mgmt.service';
import { PropertyArchiveHierarchy1795900000000 } from '../../migrations/1795900000000-PropertyArchiveHierarchy';
import { recordOwnerPhoneUsage } from '../../common/owner-phone-activity';
import { PropertiesService } from '../properties/properties.service';
import { UserRole } from '../../common/enums';

async function fixture() {
  const pg = new PGlite();
  const ds = new DataSource({ type: 'postgres', entities, synchronize: false });
  await (ds as any).buildMetadatas();
  const runner = (connection: any): any => {
    const qr: any = { connection: ds, isReleased: false, isTransactionActive: true, data: {}, connect: async () => {}, release: async () => {},
      query: async (sql: string, params: any[] = [], structured = false) => {
        const out = await connection.query(sql, params);
        if (!structured) return out.rows;
        const result = new QueryResult(); result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows; return result;
      } };
    qr.broadcaster = new Broadcaster(qr); qr.manager = ds.createEntityManager(qr); return qr;
  };
  (ds as any).isInitialized = true;
  ds.createQueryRunner = () => runner(pg);
  ds.transaction = ((callback: any) => pg.transaction((tx: any) => callback(runner(tx).manager))) as any;
  for (const entity of [Community, Building, House, User, RepairRequest, ParkingHistory]) {
    const meta = ds.getMetadata(entity);
    const cols = meta.columns.filter(c => !['community_type', 'building_type', 'owner_building_id', 'contact_phones'].includes(c.databaseName)).map(c => {
      const type = ds.driver.normalizeType(c);
      const raw = typeof c.default === 'function' ? c.default() : c.default;
      const def = raw === undefined ? (c.databaseName.endsWith('_at') && !c.isNullable ? 'now()' : undefined) : typeof raw === 'string' && typeof c.default !== 'function' ? `'${raw.replaceAll("'", "''")}'` : raw;
      return `"${c.databaseName}" ${c.isPrimary ? 'serial PRIMARY KEY' : type}${def === undefined ? '' : ' DEFAULT ' + def}`;
    });
    await pg.exec(`CREATE TABLE ${meta.tableName}(${cols.join(',')})`);
  }
  await new PropertyArchiveHierarchy1795900000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await pg.exec(`INSERT INTO communities(id,tenant_id,name,community_type) VALUES(1,1,'公寓A','apartment'),(2,1,'住宅B','community'),(3,2,'外公司','apartment');
    INSERT INTO buildings(id,tenant_id,community_id,building_no,building_type) VALUES(1,1,1,'A','residential'),(2,1,2,'B','residential'),(3,1,1,'商铺C','shop'),(4,2,3,'D','shop');
    INSERT INTO houses(id,tenant_id,building_id,room_no) VALUES(1,1,1,'101'),(2,1,2,'202');`);
  const service = new OwnersMgmtService(ds.getRepository(User), ds.getRepository(House), ds);
  const user = { id: 7, tenantId: 1, role: UserRole.STAFF } as any;
  return { pg, ds, service, user };
}

test('真实SQL：多对多关联、重复关联幂等、解除一处保留其他房产和电话', async () => {
  const f = await fixture();
  try {
    const a = await f.service.create({ name: '甲', phone: '13800000001', contactPhones: ['021-12345678'], houseId: 1 }, f.user);
    const b = await f.service.create({ name: '乙', phone: '13800000002', houseId: 1 }, f.user);
    assert.ok(a && b);
    await f.service.linkProperty(a!.id, { houseId: 2 }, f.user);
    await f.service.linkProperty(a!.id, { houseId: 2 }, f.user);
    await f.service.linkProperty(a!.id, { ownerBuildingId: 3 }, f.user);
    assert.equal((await f.service.list({ houseId: 1 }, f.user)).length, 2);
    assert.equal((await f.service.list({ houseId: 2 }, f.user))[0].properties.length, 3);
    await f.service.unlinkProperty(a!.id, { houseId: 1 }, f.user);
    assert.equal((await f.service.list({ houseId: 1 }, f.user)).length, 1);
    assert.equal((await f.service.list({ houseId: 2 }, f.user)).length, 1);
    assert.equal((await f.service.list({ buildingId: 3 }, f.user)).length, 1);
    assert.deepEqual((await f.service.list({ q: '12345678' }, f.user))[0].contactPhones, ['13800000001', '021-12345678']);
    await assert.rejects(() => f.service.linkProperty(a!.id, { ownerBuildingId: 4 }, f.user), /本公司/);
    await assert.rejects(() => f.service.linkProperty(a!.id, { ownerBuildingId: 1 }, f.user), /商铺/);
    await assert.rejects(() => f.service.linkProperty(a!.id, { houseId: 1, ownerBuildingId: 3 }, f.user), /一个房号/);
    const restricted = { scopeAll: false, communityIds: [2] } as any;
    assert.equal((await f.service.list({ houseId: 2 }, f.user, restricted)).length, 1);
    await assert.rejects(() => f.service.linkProperty(a!.id, { ownerBuildingId: 3 }, f.user, restricted), /授权范围/);
    await assert.rejects(() => f.service.remove(a!.id, f.user, restricted), /授权范围外/);
    const properties = Object.create(PropertiesService.prototype) as any;
    properties.buildingRepo=f.ds.getRepository(Building); properties.houseRepo=f.ds.getRepository(House);
    properties.communityRepo=f.ds.getRepository(Community); properties.userRepo=f.ds.getRepository(User);
    await assert.rejects(() => properties.updateBuilding(1, {buildingType:'shop'}, f.user), /已有房号/);
    await assert.rejects(() => properties.updateBuilding(3, {buildingType:'residential'}, f.user), /已关联业主/);
    await assert.rejects(() => properties.deleteBuilding(3, f.user), /已关联业主/);
    await assert.rejects(() => properties.createHouse({buildingId:3,roomNo:'虚构房号'}, f.user), /不建立房号/);
    const houses = await properties.listHouses({buildingId:2,page:1,pageSize:30},f.user);
    assert.equal(houses.rows[0].owners[0].id,a!.id);
    await new PropertyArchiveHierarchy1795900000000().up({query:(sql:string)=>f.pg.query(sql)} as any);
    assert.equal((await f.service.list({houseId:2},f.user))[0].properties.length,2);
  } finally { await f.pg.close(); }
});

test('迁移保留历史孤立房号原值，只为真实同租户房屋回填关联且可重跑', async()=>{
  const f=await fixture();try{
    await f.pg.exec(`INSERT INTO users(id,tenant_id,role,name,phone,house_id) VALUES
      (901,1,'owner','历史孤立档案','13800000901',999999),
      (902,1,'owner','历史有效档案','13800000902',1)`);
    const migration=new PropertyArchiveHierarchy1795900000000();
    await migration.up({query:(sql:string)=>f.pg.query(sql)} as any);
    assert.equal((await f.pg.query<any>('SELECT house_id FROM users WHERE id=901')).rows[0].house_id,999999);
    assert.equal((await f.pg.query<any>('SELECT COUNT(*)::int AS n FROM owner_property_links WHERE owner_id=901')).rows[0].n,0);
    assert.equal((await f.pg.query<any>('SELECT COUNT(*)::int AS n FROM owner_property_links WHERE owner_id=902')).rows[0].n,1);
    await migration.up({query:(sql:string)=>f.pg.query(sql)} as any);
    assert.equal((await f.pg.query<any>('SELECT COUNT(*)::int AS n FROM owner_property_links WHERE owner_id=902')).rows[0].n,1);
  }finally{await f.pg.close();}
});

test('真实SQL：业务使用不伪造接通时间，失败不覆盖上次成功，按号码分别留痕', async () => {
  const f = await fixture();
  try {
    const a = await f.service.create({ name: '甲', phone: '13800000001', contactPhones: ['021-12345678'], houseId: 1 }, f.user);
    await recordOwnerPhoneUsage(f.ds, 1, '13800000001');
    let rows = await f.service.list({ id: a!.id }, f.user);
    assert.ok(rows[0].phoneActivity[0].last_used_at);
    assert.equal(rows[0].phoneActivity[0].last_contacted_at, null);
    await f.service.recordPhoneContact(a!.id, { phone: '021-12345678', result: 'connected' }, f.user);
    rows = await f.service.list({ id: a!.id }, f.user);
    const success = rows[0].phoneActivity.find((p: any) => p.phone === '021-12345678').last_contacted_at;
    assert.ok(success);
    await f.service.recordPhoneContact(a!.id, { phone: '021-12345678', result: 'no_answer' }, f.user);
    rows = await f.service.list({ id: a!.id }, f.user);
    assert.equal(String(rows[0].phoneActivity.find((p: any) => p.phone === '021-12345678').last_contacted_at), String(success));
    await assert.rejects(() => f.service.recordPhoneContact(a!.id, { phone: '13999999999', result: 'connected' }, f.user), /不在此业主/);
    assert.equal((await f.pg.query<any>('SELECT COUNT(*)::int AS n FROM owner_phone_events')).rows[0].n, 2);
  } finally { await f.pg.close(); }
});
