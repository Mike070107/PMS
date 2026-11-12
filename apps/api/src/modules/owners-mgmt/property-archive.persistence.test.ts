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
import { PropertyArchiveDetails1796000000000 } from '../../migrations/1796000000000-PropertyArchiveDetails';
import { PropertiesService } from '../properties/properties.service';
import { UserRole } from '../../common/enums';
import { Module, ValidationPipe, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OwnersMgmtController } from './owners-mgmt.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { AccessService } from '../access/access.service';

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
  await new PropertyArchiveDetails1796000000000().up({ query: (sql: string) => pg.query(sql) } as any);
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

test('A档案：原子替换当前非主关联，保留其他房产、主关联和历史；过期关联拒绝并回滚姓名', async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`INSERT INTO houses(id,tenant_id,building_id,room_no) VALUES(3,1,1,'103')`);
    const a = (await f.service.create({ name: '甲', phone: '13800000001', houseId: 1 }, f.user))!;
    await f.service.linkProperty(a.id, { houseId: 2 }, f.user);
    await f.service.update(a.id, { currentHouseId:2,houseId:2,moveInDate:'2020-01-02',billingStartDate:'2020-02-01' }, f.user);
    await f.service.update(a.id, { currentHouseId:1,houseId:1,moveInDate:'2022-03-04',billingStartDate:'2022-04-01' }, f.user);
    await f.service.update(a.id, { name: '甲更新', currentHouseId: 2, houseId: 3, ownerBuildingId: null } as any, f.user);
    const next = (await f.service.list({ id: a.id }, f.user))[0];
    assert.deepEqual(next.properties.map((p: any) => Number(p.house_id)).sort(), [1, 3]);
    assert.equal((await f.pg.query<any>('SELECT house_id FROM users WHERE id=$1', [a.id])).rows[0].house_id, 1);
    assert.equal(next.name, '甲更新');
    assert.ok((await f.pg.query<any>(`SELECT COUNT(*)::int AS n FROM parking_history WHERE pms_user_id=$1`, [a.id])).rows[0].n);
    await assert.rejects(() => f.service.update(a.id, { name: '不得保存', currentHouseId: 2, houseId: 1, ownerBuildingId: null } as any, f.user), /关联.*变化|当前关联/);
    assert.equal((await f.service.list({ id: a.id }, f.user))[0].name, '甲更新');
    await assert.rejects(() => f.service.update(a.id, { currentHouseId: 3, houseId: 2, ownerBuildingId: null } as any, f.user, { scopeAll: false, communityIds: [1] } as any), /授权范围|not found/);
    const moved = next.properties.find((p:any)=>Number(p.house_id)===3)!;
    assert.equal(moved.move_in_date,'2020-01-02'); assert.equal(moved.billing_start_date,'2020-02-01');
    // Replacing with an already-linked target keeps its dates rather than overwriting with the source dates.
    await f.service.update(a.id,{currentHouseId:3,houseId:1,ownerBuildingId:null},f.user);
    const merged = (await f.service.list({id:a.id},f.user))[0].properties;
    assert.equal(merged.length,1); assert.equal(Number(merged[0].house_id),1);
    assert.equal(merged[0].move_in_date,'2022-03-04'); assert.equal(merged[0].billing_start_date,'2022-04-01');
  } finally { await f.pg.close(); }
});

test('房产详情：真实 SQL 保存/重读、性质过滤、稳定 ID 查询和去重楼栋人数', async () => {
  const f = await fixture();
  try {
    const properties = Object.create(PropertiesService.prototype) as any;
    Object.assign(properties, { buildingRepo:f.ds.getRepository(Building), houseRepo:f.ds.getRepository(House), communityRepo:f.ds.getRepository(Community), userRepo:f.ds.getRepository(User), dataSource:f.ds });
    await properties.updateHouse(1,{floor:'3',areaSqm:'89.50',propertyNature:'公房',roomLayout:'两室一厅',remark:'实测档案'},f.user);
    const house = (await properties.listHouses({id:1,buildingId:1,propertyNature:'公房',page:1,pageSize:10},f.user)).rows[0];
    assert.equal(house.floor,'3'); assert.equal(house.propertyNature,'公房'); assert.equal(house.roomLayout,'两室一厅'); assert.equal(house.remark,'实测档案');
    assert.equal(Number(house.areaSqm),89.5);
    assert.equal((await properties.listHouses({id:1,buildingId:2},f.user)).length,0);
    assert.equal((await properties.listHouses({id:1,buildingId:1,propertyNature:'商品房'},f.user)).length,0);
    const a = (await f.service.create({name:'甲',phone:'13800000001',houseId:1},f.user))!;
    await f.service.create({name:'乙',phone:'13800000002',houseId:1},f.user);
    await f.service.update(a.id,{currentHouseId:1,houseId:1,moveInDate:'2026-11-01',billingStartDate:'2026-11-12'},f.user);
    const link = (await f.service.list({houseId:1},f.user)).find(o=>o.id===a.id)!.properties[0];
    assert.equal(link.move_in_date,'2026-11-01'); assert.equal(link.billing_start_date,'2026-11-12');
    await f.service.update(a.id,{currentHouseId:1,houseId:1,moveInDate:null},f.user);
    const cleared = (await f.service.list({id:a.id},f.user))[0].properties[0];
    assert.equal(cleared.move_in_date,null); assert.equal(cleared.billing_start_date,'2026-11-12');
    const counts = await properties.listBuildings({communityId:1,archiveDetails:'1'},f.user);
    assert.equal(counts.find((b:any)=>b.id===1).houseCount,1); assert.equal(counts.find((b:any)=>b.id===1).ownerCount,2);
    assert.equal(counts.find((b:any)=>b.id===3).houseCount,0);
    // List queries hide out-of-scope rows instead of returning a write-style 403.
    assert.deepEqual(await properties.listHouses({id:1,buildingId:1},f.user,{scopeAll:false,communityIds:[2]}),[]);
    const hidden = await properties.listHouses({id:1,buildingId:1,page:1,pageSize:10},f.user,{scopeAll:false,communityIds:[2]});
    assert.equal(hidden.total,0); assert.deepEqual(hidden.rows,[]);
    assert.deepEqual(await properties.listHouses({id:1,buildingId:1},{...f.user,tenantId:2}),[]);
    await properties.updateHouse(1,{floor:null,propertyNature:null,roomLayout:null,remark:null},f.user);
    assert.equal((await properties.listHouses({id:1,buildingId:1},f.user))[0].propertyNature,null);
  } finally { await f.pg.close(); }
});

test('真实 HTTP + 实际权限守卫/DTO + SQL：只读403、跨租户/范围、非法日期/号码400和显式确认刷新', async () => {
  const f = await fixture();
  const originalAuth = JwtAuthGuard.prototype.canActivate;
  let app: any;
  // JWT identity verification is stubbed and req.access is injected by the fixture (not AccessService scope resolution).
  // Controller, PermissionsGuard, AccessService permission predicates, ValidationPipe, service transactions and SQL
  // all execute normally; no production identity or endpoint is used.
  JwtAuthGuard.prototype.canActivate = function(context:any):any { if(!context.switchToHttp().getRequest().user) throw new UnauthorizedException(); return true; };
  try {
    const a = (await f.service.create({name:'甲',phone:'13800000001',contactPhones:['021-12345678'],houseId:1},f.user))!;
    class HttpFixture {}
    Module({controllers:[OwnersMgmtController],providers:[{provide:OwnersMgmtService,useValue:f.service},{provide:AccessService,useValue:{hasPermission:AccessService.prototype.hasPermission,hasAnyPermission:AccessService.prototype.hasAnyPermission}},PermissionsGuard]})(HttpFixture);
    app = await NestFactory.create(HttpFixture,{logger:false});
    app.use((req:any,_res:any,next:any)=>{
      const mode=req.headers['x-test-mode']; if(mode==='anonymous')return next();
      req.user={...f.user,tenantId:mode==='otherTenant'?2:1};
      req.access={scopeAll:mode!=='scope',communityIds:mode==='scope'?[2]:null,pages:mode==='none'?{}:{[mode==='archive'?'properties':mode==='parking'?'business':'fees']:{view:true,edit:mode!=='read',delete:false}}}; next();
    });
    app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));
    await app.listen(0,'127.0.0.1'); const base=await app.getUrl();
    const http = (path:string,mode='edit',data?:any)=>fetch(base+path,{method:data?'PATCH':'GET',headers:{'x-test-mode':mode,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
    const url=`/owners-mgmt/${a.id}/business-contact`, get='/owners-mgmt/business-contacts?houseId=1';
    assert.equal((await http(get,'anonymous')).status,401); assert.equal((await http(get,'none')).status,403);
    assert.equal((await http(get,'archive')).status,403); // Archive edit is not business contact permission.
    assert.equal((await http(get,'read')).status,200);
    assert.equal((await http(url,'read',{name:'不得变更',confirmedPhones:[],source:'cashier'})).status,403);
    assert.equal((await http(get,'scope')).status,403); assert.equal((await http(get,'otherTenant')).status,404);
    assert.equal((await http(url,'scope',{name:'越范围不得保存',confirmedPhones:[],source:'cashier'})).status,403);
    assert.equal((await http(url,'otherTenant',{name:'跨租户不得保存',confirmedPhones:[],source:'cashier'})).status,404);
    for(const query of ['', '?houseId=1&buildingId=3', '?houseId=-1', '?buildingId=1']) assert.equal((await http('/owners-mgmt/business-contacts'+query)).status,400);
    assert.deepEqual(await (await http('/owners-mgmt/business-contacts?buildingId=3')).json(),[]);
    for(const data of [{name:'   ',confirmedPhones:[],source:'cashier'},{confirmedPhones:['invalid'],source:'cashier'},{confirmedPhones:[],source:'guess'},{source:'cashier'},{confirmedPhones:[],source:'cashier',contactPhones:Array(11).fill('13800000001')}]) assert.equal((await http(url,'edit',data)).status,400);
    for(const key of ['moveInDate','billingStartDate']) for(const date of ['2026-02-30','2026-11-01T00:00:00.000Z','2026-1-1']) assert.equal((await http(`/owners-mgmt/${a.id}`,'archive',{currentHouseId:1,houseId:1,[key]:date})).status,400);
    assert.equal((await http(url,'edit',{confirmedPhones:[],source:'parking',pages:{business:{edit:true}}})).status,403);
    assert.equal((await http(url,'edit',{confirmedPhones:[],source:'cashier',last_confirmed_at:'2099-01-01',confirmation_source:'parking'})).status,200);
    const unconfirmed:any=await (await http(get)).json();
    assert.ok(unconfirmed[0].phoneActivity.every((p:any)=>!p.last_confirmed_at));
    assert.equal((await http(url,'edit',{name:'HTTP更新',confirmedPhones:['021-12345678'],source:'cashier'})).status,200);
    const rows:any=await (await http(get)).json(); assert.equal(rows[0].name,'HTTP更新');
    assert.ok(rows[0].phoneActivity.find((p:any)=>p.phone==='021-12345678').last_confirmed_at);
    assert.ok(!rows[0].phoneActivity.find((p:any)=>p.phone===a.phone)?.last_confirmed_at);
    assert.equal((await http(url,'parking',{confirmedPhones:[a.phone],source:'parking'})).status,200);
    const parked:any=await (await http(get)).json();
    assert.equal(parked[0].phoneActivity.find((p:any)=>p.phone===a.phone).confirmation_source,'parking');
    assert.equal(parked[0].phoneActivity.find((p:any)=>p.phone==='021-12345678').confirmation_source,'cashier');
    assert.equal((await http(url,'edit',{name:'不应保存',confirmedPhones:['13999999999'],source:'cashier'})).status,400);
    assert.equal((await (await http(get)).json() as any)[0].name,'HTTP更新');
  } finally { JwtAuthGuard.prototype.canActivate=originalAuth;if(app)await app.close();await f.pg.close(); }
});

test('业务电话：读/使用/接通不等于显式确认；逐号码确认、来源隔离、失败事务回滚', async () => {
  const f = await fixture();
  const access = { scopeAll: true, pages: { fees: { view: true, edit: true } } } as any;
  try {
    const other = (await f.service.create({ name:'另一个登录身份',phone:'13800000002',houseId:2 },f.user))!;
    const a = (await f.service.create({ name: '甲', phone: '13800000001', contactPhones: ['021-12345678'], houseId: 1 }, f.user))!;
    await recordOwnerPhoneUsage(f.ds, 1, a.phone);
    await f.service.recordPhoneContact(a.id, { phone: '021-12345678', result: 'connected' }, f.user);
    let rows = await (f.service as any).businessContacts({ houseId: 1 }, f.user, access);
    assert.ok(rows[0].phoneActivity.every((p: any) => !p.last_confirmed_at));
    await (f.service as any).updateBusinessContact(a.id, { name: '甲确认', confirmedPhones: ['021-12345678'], source: 'cashier' }, f.user, access);
    rows = await (f.service as any).businessContacts({ houseId: 1 }, f.user, access);
    assert.equal(rows[0].name, '甲确认');
    assert.ok(rows[0].phoneActivity.find((p: any) => p.phone === '021-12345678').last_confirmed_at);
    assert.equal(rows[0].phoneActivity.find((p: any) => p.phone === '021-12345678').confirmation_source, 'cashier');
    assert.ok(!rows[0].phoneActivity.find((p: any) => p.phone === a.phone).last_confirmed_at);
    await assert.rejects(() => (f.service as any).updateBusinessContact(a.id, { name: '不能串来源', confirmedPhones: [], source: 'parking' }, f.user, access), /权限/);
    const before = (await f.service.list({id:a.id},f.user))[0];
    const eventCount = (await f.pg.query<any>('SELECT COUNT(*)::int AS n FROM owner_phone_events')).rows[0].n;
    await assert.rejects(() => (f.service as any).updateBusinessContact(a.id, { name: '必须回滚', phone:'13800000003',contactPhones:['021-87654321'],confirmedPhones: ['13999999999'], source: 'cashier' }, f.user, access), /号码|电话/);
    await assert.rejects(() => f.service.updateBusinessContact(a.id,{name:'重复号码不得保存',phone:other.phone,confirmedPhones:['021-12345678'],source:'cashier'},f.user,access),/已存在/);
    const after = (await f.service.list({id:a.id},f.user))[0];
    assert.equal(after.name,before.name); assert.equal(after.phone,before.phone);
    assert.deepEqual(after.contactPhones,before.contactPhones); assert.deepEqual(after.phoneActivity,before.phoneActivity);
    assert.equal((await f.pg.query<any>('SELECT COUNT(*)::int AS n FROM owner_phone_events')).rows[0].n,eventCount);
    await assert.rejects(() => (f.service as any).businessContacts({ houseId: 1, buildingId: 3 }, f.user, access), /一个|二选一/);
    await assert.rejects(() => (f.service as any).businessContacts({ houseId: 2 }, f.user, { ...access, scopeAll: false, communityIds: [1] }), /授权范围|not found/);
    await new PropertyArchiveDetails1796000000000().up({ query: (sql: string) => f.pg.query(sql) } as any);
    assert.ok((await f.service.list({ id: a.id }, f.user))[0].phoneActivity.find((p: any) => p.phone === '021-12345678')!.last_confirmed_at);
  } finally { await f.pg.close(); }
});
