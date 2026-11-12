import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { Controller, Get, Module, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import * as E from '../../entities';
import { UserRole } from '../../common/enums';
import { CurrentUser, AuthUser } from '../../common/current-user.decorator';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { QrLoginService } from '../auth/qr-login.service';
import { AccessService } from '../access/access.service';
import { PermissionsGuard } from '../access/permissions.guard';
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
import { PropertiesService } from '../properties/properties.service';
import { PropertiesController } from '../properties/properties.controller';
import { OwnersMgmtService } from './owners-mgmt.service';
import { OwnersMgmtController } from './owners-mgmt.controller';
import { OfficesService } from '../offices/offices.service';
import { OfficesController } from '../offices/offices.controller';
import { PropertyArchiveHierarchy1795900000000 } from '../../migrations/1795900000000-PropertyArchiveHierarchy';
import { PropertyArchiveDetails1796000000000 } from '../../migrations/1796000000000-PropertyArchiveDetails';

// Isolated test infrastructure ONLY. No injected req.user/req.access and no guard overrides:
// Passport verifies signed/expired JWT; JwtStrategy reads SQL users/tenants; real getAccess
// resolves SQL role permissions, staff assignments and acting-office scope on each request.
// SQL runs in PGlite (PostgreSQL WASM), NOT a native/server PostgreSQL concurrency test.
const SECRET = 'isolated-property-archive-integration-not-a-production-secret';
export async function startArchiveIntegration() {
  const pg = new PGlite();
  const ds = new DataSource({ type: 'postgres', entities: E.entities, synchronize: false });
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
  const tables = [E.Tenant, E.Community, E.Building, E.House, E.Unit, E.CommunitySpot, E.User, E.RepairRequest, E.ParkingHistory,
    E.ManagementOffice, E.Role, E.RolePermission, E.RoleTemplate, E.RoleTemplatePermission, E.RoleScope, E.RoleWarehouse,
    E.UserRoleAssignment, E.StaffProfile, E.Warehouse, E.StaffAssignment];
  // Start with pre-179590/179600 schema: the new house columns MUST come from migration.
  const added = new Set(['community_type', 'building_type', 'owner_building_id', 'contact_phones']);
  for (const entity of tables) {
    const meta = ds.getMetadata(entity);
    const cols = meta.columns.filter(c => !added.has(c.databaseName) && !(entity === E.House && ['floor','property_nature','room_layout','remark'].includes(c.databaseName))).map(c => {
      let type = ds.driver.normalizeType(c);
      if (c.length) type += `(${c.length})`;
      if (c.isArray) type += '[]';
      const raw = typeof c.default === 'function' ? c.default() : c.default;
      const def = raw === undefined ? (c.databaseName.endsWith('_at') && !c.isNullable ? 'now()' : undefined) : typeof raw === 'string' && typeof c.default !== 'function' ? `'${raw.replaceAll("'", "''")}'` : raw;
      return `"${c.databaseName}" ${c.isPrimary ? 'serial PRIMARY KEY' : type}${def === undefined ? '' : ' DEFAULT ' + def}`;
    });
    await pg.exec(`CREATE TABLE "${meta.tableName}"(${cols.join(',')})`);
  }
  await new PropertyArchiveHierarchy1795900000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new PropertyArchiveDetails1796000000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await pg.exec(`
    INSERT INTO tenants(id,name,enabled) VALUES (1,'隔离测试物业',true),(2,'另一物业',true);
    INSERT INTO management_offices(id,tenant_id,name,enabled) VALUES (1,1,'测试管理处',true),(2,1,'另一管理处',true),(3,2,'外公司管理处',true);
    INSERT INTO communities(id,tenant_id,name,office_id,parent_id,community_type) VALUES
      (10,1,'测试小区',1,null,'community'),(1,1,'测试一期',null,10,'community'),(2,1,'另一小区',2,null,'community'),(3,2,'外公司小区',3,null,'community');
    INSERT INTO buildings(id,tenant_id,community_id,building_no,lane,building_type) VALUES
      (1,1,1,'3','198弄','residential'),(2,1,1,'4','198弄','residential'),(3,1,2,'5','228弄','residential'),(4,2,3,'6',null,'residential');
    INSERT INTO houses(id,tenant_id,building_id,room_no,area_sqm,floor,property_nature,room_layout,remark) VALUES
      (1,1,1,'101',89.50,'1','公房','两室一厅','初始备注'),(2,1,2,'201',70,'2',null,null,null),(3,1,3,'301',80,null,null,null,null),(4,2,4,'401',90,null,null,null,null);
    INSERT INTO users(id,tenant_id,name,role,status) VALUES
      (100,1,'可编辑','staff','active'),(101,1,'只读','staff','active'),(102,1,'无权限','staff','active'),
      (103,2,'外公司','staff','active'),(104,1,'另一处','staff','active'),(105,1,'全公司','staff','active');
    INSERT INTO roles(id,tenant_id,name,enabled,built_in,data_scope) VALUES
      (1,1,'编辑角色',true,false,'offices'),(2,1,'只读角色',true,false,'offices'),(3,2,'外公司角色',true,false,'offices');
    INSERT INTO user_roles(tenant_id,user_id,role_id) VALUES(1,100,1),(1,101,2),(2,103,3),(1,104,1),(1,105,1);
    INSERT INTO staff_assignments(tenant_id,user_id,office_id) VALUES(1,100,1),(1,101,1),(1,102,1),(2,103,3),(1,104,2),(1,105,null);
  `);
  for (const role of [1,2,3]) for (const page of ['properties','owners','business','fees']) {
    await pg.query(`INSERT INTO role_permissions(tenant_id,role_id,page_key,can_view,can_edit,can_delete) VALUES($1,$2,$3,true,$4,$4)`, [role === 3 ? 2 : 1,role,page,role !== 2]);
  }
  const repo = <T extends import('typeorm').ObjectLiteral>(entity: import('typeorm').EntityTarget<T>) => ds.getRepository<T>(entity);
  const access = new AccessService(repo(E.Tenant),repo(E.Role),repo(E.RolePermission),repo(E.RoleTemplatePermission),repo(E.RoleTemplate),repo(E.RoleScope),repo(E.RoleWarehouse),repo(E.UserRoleAssignment),repo(E.Community),repo(E.ManagementOffice),repo(E.StaffProfile),repo(E.Warehouse),repo(E.StaffAssignment));
  const owners = new OwnersMgmtService(repo(E.User),repo(E.House),ds);
  const properties = new PropertiesService(repo(E.Community),repo(E.Building),repo(E.Unit),repo(E.House),repo(E.User),repo(E.WorkOrder),repo(E.ManagementOffice),repo(E.CommunitySpot),{} as any);
  const offices = new OfficesService(repo(E.ManagementOffice),repo(E.RepairTypeRule),repo(E.Warehouse),repo(E.Community),repo(E.RoleScope),repo(E.StaffAssignment));
  const first = (await owners.create({name:'已有业主甲',phone:'13800000001',contactPhones:['021-12345678'],houseId:1},{id:100,tenantId:1,role:UserRole.STAFF}))!;
  await owners.linkProperty(first.id,{houseId:2},{id:100,tenantId:1,role:UserRole.STAFF});
  await owners.create({name:'已有业主乙',phone:'13800000002',houseId:1},{id:100,tenantId:1,role:UserRole.STAFF});
  const jwt = new JwtService({secret:SECRET});
  // Real auth/me and preferences service. Wechat/settings/RBAC/QR are deliberately unconfigured,
  // outside these read paths; invoking login/device features must not silently fake a success.
  const authService = new AuthService(repo(E.User),repo(E.Tenant),repo(E.Community),repo(E.Building),repo(E.House),
    repo(E.UserAudit),repo(E.UserReportCommunity),repo(E.UserRoleAssignment),repo(E.Role),repo(E.ExternalAccessApp),
    jwt,new ConfigService({JWT_SECRET:SECRET}),{} as any,{} as any,access,{} as any);
  const token = (id=100, overrides:Record<string,any>={}) => jwt.sign({sub:id,tenantId:999,role:'superadmin',credentialVersion:0,exp:Math.floor(Date.now()/1000)+600,...overrides});
  // Test-only session issuance bootstraps browser auth. Its token snapshot is deliberately WRONG:
  // successful scoped requests prove JwtStrategy uses SQL truth, not the token tenant/role claims.
  @Controller()
  class TestSessionController {
    @Get('__test-session')
    async session(@Query('actor') actor?:string) {
      const id = Number(actor || 100);
      if (![100,101,102,103,104,105].includes(id)) throw Error('unknown test actor');
      const user = await repo(E.User).findOneByOrFail({id});
      return {accessToken:token(id),user:{id,tenantId:user.tenantId,role:user.role,name:user.name},access:await access.getAccess({id,tenantId:user.tenantId,role:user.role})};
    }
  }
  class FixtureModule {}
  Module({imports:[PassportModule.register({defaultStrategy:'jwt'})],controllers:[TestSessionController,AuthController,PropertiesController,OwnersMgmtController,OfficesController],providers:[
    {provide:PropertiesService,useValue:properties},{provide:OwnersMgmtService,useValue:owners},{provide:OfficesService,useValue:offices},
    {provide:AuthService,useValue:authService},{provide:QrLoginService,useValue:{}},
    {provide:AccessService,useValue:access},{provide:JwtStrategy,useValue:new JwtStrategy(new ConfigService({JWT_SECRET:SECRET}),repo(E.User),repo(E.Tenant))},
    JwtAuthGuard,PermissionsGuard,RolesOrPermissionGuard,
  ]})(FixtureModule);
  const app = await NestFactory.create(FixtureModule,{logger:false});
  app.enableCors(); app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));
  await app.listen(0,'127.0.0.1');
  const base = await app.getUrl();
  const http = (path:string,id:number=100,data?:any,headers:Record<string,string>={}) => fetch(base+path,{method:data===undefined?'GET':'PATCH',headers:{Authorization:`Bearer ${token(id)}`,'content-type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {app,base,pg,ds,first,token,http,close:async()=>{await app.close();await pg.close();}};
}

if (process.argv.includes('--serve')) {
  const output = process.argv[process.argv.indexOf('--serve')+1];
  startArchiveIntegration().then(f=>{
    writeFileSync(output,JSON.stringify({base:f.base,ownerId:f.first.id,engine:'PGlite; real JWT + SQL-backed AccessService'}));
    const stop = async()=>{await f.close();process.exit(0);}; process.on('SIGTERM',stop);process.on('SIGINT',stop);
  }).catch(error=>{console.error(error);process.exitCode=1;});
} else {
  test('JWT签名/时效/数据库身份 + SQL角色范围：匿名401、无权限403、只读和跨租户/管理处拒绝',async()=>{
    const f=await startArchiveIntegration();
    try {
      assert.equal((await fetch(f.base+'/owners-mgmt')).status,401);
      assert.equal((await fetch(f.base+'/owners-mgmt',{headers:{Authorization:`Bearer ${f.token().slice(0,-6)}abcdef`}})).status,401);
      assert.equal((await fetch(f.base+'/owners-mgmt',{headers:{Authorization:`Bearer ${f.token(100,{exp:1})}`}})).status,401);
      assert.equal((await f.http('/owners-mgmt',102)).status,403);
      assert.equal((await f.http('/owners-mgmt',100)).status,200);
      assert.equal((await f.http('/owners-mgmt',101)).status,200);
      const path=`/owners-mgmt/${f.first.id}/business-contact`;
      const data={name:'禁止更新',confirmedPhones:[],source:'cashier'};
      const snapshot = async () => Promise.all(['users','houses','owner_property_links','owner_phone_activity','owner_phone_events'].map(async table =>
        (await f.pg.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`)).rows));
      const beforeDenied = await snapshot();
      assert.equal((await f.http(path,101,data)).status,403);
      assert.equal((await f.http(path,104,data)).status,403);
      assert.equal((await f.http(path,103,data)).status,404);
      assert.deepEqual(await (await f.http('/houses?buildingId=1',104)).json(),[]);
      assert.deepEqual(await (await f.http('/houses?buildingId=1',100,undefined,{'x-acting-tenant-id':'2'})).json(),await (await f.http('/houses?buildingId=1')).json());
      assert.deepEqual(await (await f.http('/houses?buildingId=1',105,undefined,{'x-acting-office-id':'2'})).json(),[]);
      assert.equal((await f.http('/houses/1',105,{floor:'越处'},{'x-acting-office-id':'2'})).status,403);
      assert.deepEqual(await snapshot(),beforeDenied,'拒绝读写不得改变业主、房产、关联、号码活动或事件');
      await f.pg.exec('UPDATE users SET credential_version=1 WHERE id=100');
      assert.equal((await f.http('/owners-mgmt')).status,401);
      await f.pg.exec('UPDATE users SET credential_version=0,status=\'disabled\' WHERE id=100');
      assert.equal((await f.http('/owners-mgmt')).status,401);
    } finally {await f.close();}
  });
  test('真JWT→controller/DTO→SQL保存重读：房产清空、替换当前关联保留另一处、逐号码显式确认',async()=>{
    const f=await startArchiveIntegration();
    try {
      assert.equal((await f.http('/houses/1',100,{floor:'3',areaSqm:'88.25',propertyNature:'商品房',roomLayout:'两室',remark:'真实联调'})).status,200);
      let house:any=((await (await f.http('/houses?id=1&buildingId=1')).json()) as any)[0];
      assert.equal(house.floor,'3');assert.equal(Number(house.areaSqm),88.25);assert.equal(house.remark,'真实联调');
      assert.equal((await f.http('/houses/1',100,{floor:null,areaSqm:null,propertyNature:null,roomLayout:null,remark:null})).status,200);
      house=((await (await f.http('/houses?id=1&buildingId=1')).json()) as any)[0];
      for(const key of ['floor','areaSqm','propertyNature','roomLayout','remark']) assert.equal(house[key],null,key);
      const ownerUrl=`/owners-mgmt/${f.first.id}`;
      assert.equal((await f.http(ownerUrl,100,{currentHouseId:1,houseId:1,moveInDate:'2026-02-30'})).status,400);
      assert.equal((await f.http(ownerUrl,100,{currentHouseId:1,houseId:1,moveInDate:'2026-11-01',billingStartDate:'2026-11-12'})).status,200);
      // Swap only the current link; existing other link (house2) must remain.
      await f.pg.exec(`INSERT INTO houses(id,tenant_id,building_id,room_no) VALUES(5,1,1,'102')`);
      assert.equal((await f.http(ownerUrl,100,{currentHouseId:1,houseId:5})).status,200);
      let row:any=((await (await f.http(`/owners-mgmt?id=${f.first.id}`)).json()) as any)[0];
      assert.deepEqual(row.properties.map((p:any)=>p.house_id).sort(),[2,5]);
      const url=ownerUrl+'/business-contact';
      assert.equal((await f.http(url,100,{name:'保存但未确认',confirmedPhones:[],source:'cashier'})).status,200);
      row=((await (await f.http('/owners-mgmt/business-contacts?houseId=5')).json()) as any)[0];
      assert.ok(row.phoneActivity.every((p:any)=>!p.last_confirmed_at));
      assert.equal((await f.http(url,100,{confirmedPhones:['021-12345678'],source:'cashier'})).status,200);
      row=((await (await f.http('/owners-mgmt/business-contacts?houseId=5')).json()) as any)[0];
      assert.ok(row.phoneActivity.find((p:any)=>p.phone==='021-12345678').last_confirmed_at);
      assert.deepEqual([...new Set([row.phone,...row.contactPhones])].sort(),['021-12345678','13800000001'].sort());
      const primaryActivity=row.phoneActivity.find((p:any)=>p.phone==='13800000001');
      assert.ok(primaryActivity,'主号活动记录必须保留');assert.ok(primaryActivity.last_confirmed_at==null,'主号未显式核实，不能有确认日期');
      const saved=await f.pg.query(`SELECT name FROM users WHERE id=$1`,[f.first.id]);
      assert.equal((saved.rows[0] as any).name,'保存但未确认');
      const businessSnapshot = () => Promise.all(['users','houses','owner_property_links','owner_phone_activity','owner_phone_events'].map(async table =>
        (await f.pg.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`)).rows));
      const beforeRejected = await businessSnapshot();
      assert.equal((await f.http(url,100,{name:'非法号码预校验不写',confirmedPhones:['021-12345678','13999999999'],source:'cashier'})).status,400);
      assert.deepEqual(await businessSnapshot(),beforeRejected,'有效+未登记号码必须整批拒绝且全行不写');
      // Real SQL fault AFTER owner UPDATE and activity UPSERT, not an early DTO rejection.
      // Proves this PGlite transaction rollback, not native-PG concurrency/sequence rollback.
      await f.pg.exec(`CREATE FUNCTION __test_reject_confirmation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated event insert failure'; END $$;
        CREATE TRIGGER __test_confirmation_event_fault BEFORE INSERT ON owner_phone_events FOR EACH ROW EXECUTE FUNCTION __test_reject_confirmation_event()`);
      try {
        assert.equal((await f.http(url,100,{name:'写后故障必须回滚',confirmedPhones:['13800000001'],source:'cashier'})).status,500);
        assert.deepEqual(await businessSnapshot(),beforeRejected,'事件插入失败必须回滚已保存姓名及主号确认活动');
      } finally { await f.pg.exec('DROP TRIGGER __test_confirmation_event_fault ON owner_phone_events; DROP FUNCTION __test_reject_confirmation_event()'); }
    } finally {await f.close();}
  });
}
