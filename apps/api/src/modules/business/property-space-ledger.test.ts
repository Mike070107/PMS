import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mainSpaceFromQuery, type PropertySpaceRef } from './property-space-ledger';
import { PropertySpaceVehicles1796900000000 } from '../../migrations/1796900000000-PropertySpaceVehicles';
import { BusinessService } from './business.service';
import { BusinessExecutionService } from './business-execution.service';

const main: PropertySpaceRef = {id:1,communityId:10,garage:'main',spaceNo:'A021'};
const civil: PropertySpaceRef = {id:2,communityId:10,garage:'civil',spaceNo:'R012'};
const plate = '沪A1C678';
const legacy = {database:'parking2',fields:{P_id:42,P_plate:plate,P_spaces:'A021',P_effective:'0'.repeat(14)+'1'}};

test('现场查询到的车牌可匹配导入卡片与多车绑定，隔离其他小区与租户', async()=>{
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE parking_spaces(tenant_id int,community_id int,garage text,space_no text,plate text,vehicle_bindings jsonb);
      INSERT INTO parking_spaces VALUES
      (1,10,'main','A021','沪B12345、沪a·TEST01','{}'),(1,10,'civil','R012',NULL,'{"沪ATEST01":{}}'),
      (1,11,'main','B999','沪ATEST01','{}'),(2,10,'main','C999','沪ATEST01','{}'),
      (1,10,'main','A999','沪ATEST012','{}');`);
    const service=Object.assign(Object.create(BusinessService.prototype),{
      houseRepo:{ manager:{connection:{query:async(sql:string,args:unknown[])=>(await db.query(sql,args)).rows}}}
    });
    const rows=await service.boundPropertySpaces(1,99,[10],['沪ATEST01']);
    assert.deepEqual(rows.map((r:{spaceNo:string})=>r.spaceNo).sort(),['A021','R012']);
  } finally { await db.close(); }
});

test('产权费按选定车库解析新办和续费的真实车位，二期地面不冒充大车库',async()=>{
  const svc:any=Object.create(BusinessService.prototype);
  svc.communityRepo={findOneBy:async()=>({name:'枫桦景苑二期'}),findBy:async()=>[{id:10}]};
  svc.spaceRepo={findBy:async(where:any)=>[main,civil].filter(r=>r.garage===where.garage && r.spaceNo===where.spaceNo && where.communityId.value.includes(10))};
  svc.houseRepo={manager:{getRepository:()=>({findOne:async()=>({rows:[legacy]})})}};
  svc.deliyun={findVehiclesByPlate:async()=>({rows:[{plate,civilDefenseAuthorized:true,cardNo:'R012'}]})};
  const dto={plateNo:plate,parkingSystems:[{kind:'local',database:'parking2',sourceRecordId:'42',queryId:12},{kind:'deliyun',park:'枫桦景苑'}]};
  assert.deepEqual(await svc.propertySpaceRefs(dto,1,10,[10]),[main,civil]);
  assert.deepEqual(await svc.propertySpaceRefs(dto,1,10,[10],{garages:['deliyun:枫桦景苑'],garageNumbers:{civil:'R012',main:'A021'}}),[civil]);
  await assert.rejects(svc.propertySpaceRefs(dto,1,10,[11]),/管理范围/);
  assert.equal(mainSpaceFromQuery([{...legacy,fields:{...legacy.fields,P_effective:'0'.repeat(8)+'1'}}],plate,'42'),null);
  assert.throws(()=>mainSpaceFromQuery([legacy],'沪B1C678','42'),/已变化/);
});

test('现场成功后同步 PMS 台账，可重试，不改其他库和共用主车牌；档案变化回滚整笔',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE parking_spaces(id int,tenant_id int,community_id int,garage text,space_no text,plate text,end_date date,updated_by int,updated_at timestamptz);
      INSERT INTO parking_spaces VALUES(1,1,10,'main','A021','原主车牌','2027-01-01'),(2,1,10,'civil','R012',null,null),(3,2,10,'main','A021',null,null)`);
    await db.exec('ALTER TABLE parking_spaces ADD house_no text, ADD owner_name text, ADD owner_tel text');
    await new PropertySpaceVehicles1796900000000().up({query:(sql:string)=>db.exec(sql)} as any);
    const svc:any=Object.create(BusinessExecutionService.prototype);
    const status:string[]=[];
    svc.txnRepo={update:async(_:any,data:any)=>status.push(data.externalSyncStatus),manager:{transaction:async(fn:any)=>db.transaction(async tr=>fn({
      query:async(sql:string,params:any[])=>(await tr.query(sql,params)).rows,update:async(_:any,__:any,data:any)=>status.push(data.externalSyncStatus)
    }))}};
    svc.log=async()=>{};
    const txn:any={id:1,tenantId:1,houseId:902,createdBy:8,endDate:'2027-05-01',snapshot:{propertyContact:{houseId:902,houseNo:'53/902',ownerName:'示例业主',ownerPhone:'13800001234',contactPhone:'13900001234'},vehicle:{plateNo:plate},propertySpaces:[main,civil]}};
    const read=async()=>(await db.query<{plate:string|null;day:string|null}>('SELECT plate,end_date::text AS day FROM parking_spaces ORDER BY id')).rows;
    for(const state of ['dry_run','queued','manual','failed'])await svc.finish(txn,state,{});
    assert.equal((await read())[1].plate,null);
    await svc.finish(txn,'synced',{});
    assert.deepEqual(await read(),[{plate:'原主车牌',day:'2027-05-01'},{plate,day:'2027-05-01'},{plate:null,day:null}]);
    const details=await db.query<{house_no:string;owner_tel:string;vehicle_bindings:Record<string,any>}>('SELECT house_no,owner_tel,vehicle_bindings FROM parking_spaces WHERE id=2');
    assert.equal(details.rows[0].house_no,'53/902');
    assert.equal(details.rows[0].owner_tel,'13800001234');
    assert.equal(details.rows[0].vehicle_bindings[plate].contactPhone,'13900001234');
    await svc.finish({...txn,id:2,houseId:501,snapshot:{...txn.snapshot,propertyContact:{...txn.snapshot.propertyContact,houseId:501,houseNo:'2/501'},vehicle:{plateNo:'沪B2C678'}}},'synced',{});
    const shared=await db.query<{house_no:string;vehicle_bindings:Record<string,any>}>('SELECT house_no,vehicle_bindings FROM parking_spaces WHERE id=2');
    assert.equal(shared.rows[0].house_no,'53/902');
    assert.equal(shared.rows[0].vehicle_bindings['沪B2C678'].houseNo,'2/501');
    assert.equal(shared.rows[0].vehicle_bindings[plate].houseNo,'53/902');
    await db.exec('CREATE TABLE parking_vehicles(tenant_id int,house_id int,plate_no text,status text)');
    const service:any=Object.create(BusinessService.prototype);
    service.houseRepo={manager:{connection:{query:async(sql:string,params:any[])=>(await db.query(sql,params)).rows}}};
    const recovered=await service.boundPropertySpaces(1,902,[10],[plate]);
    assert.deepEqual(recovered.map((r:any)=>[r.plate,r.spaceNo]).sort(),[[plate,'A021'],[plate,'R012']]);
    assert.deepEqual(await service.boundPropertySpaces(2,902,[10],[plate]),[]);
    await svc.finish({...txn,endDate:'2027-01-01'},'synced',{});
    assert.equal((await read())[0].day,'2027-05-01');
    const changed={...txn,endDate:'2028-01-01',snapshot:{...txn.snapshot,propertySpaces:[main,{...civil,spaceNo:'已换号'}]}};
    await svc.finish(changed,'synced',{});
    assert.equal(status.at(-1),'manual');
    assert.equal((await read())[0].day,'2027-05-01');
  } finally {await db.close();}
});
