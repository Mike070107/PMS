import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { entities, AccessCardIssueBatch, AccessCardIssueItem, AccessCardLegacyCardCheck } from '../../entities';
import { LocalIntegration, LocalIntegrationTask } from '../../entities/local-integration.entity';
import { AccessCardIssuance1789261200000 } from '../../migrations/1789261200000-AccessCardIssuance';
import { AccessCardLegacyDuplicateCheck1789347600000 } from '../../migrations/1789347600000-AccessCardLegacyDuplicateCheck';
import { AccessCardIcNoReservation1792018800000 } from '../../migrations/1792018800000-AccessCardIcNoReservation';
import { LocalIntegrations1796200000000 } from '../../migrations/1796200000000-LocalIntegrations';
import { LocalIntegrationsService } from './local-integrations.service';
const user = {id:7, tenantId:1, role:'tenant_admin'};
const resources: any = [{id:'fenghua.main', label:'合成写卡工作站', capabilities:[{operation:'card.inspect',revision:1},{operation:'card.write',revision:1}]}];
async function fixture() {
  const { StandardCardIssuanceService } = require('./standard-card-issuance.service');
  const { StandardCardIssuance1796200100000 } = require('../../migrations/1796200100000-StandardCardIssuance');
  const pg = new PGlite();
  const ds = new DataSource({type:'postgres', entities, synchronize:false});
  await (ds as any).buildMetadatas();
  const runner = (connection:any, active=false):any => {
    const qr:any = {connection:ds,isReleased:false,isTransactionActive:active,data:{},connect:async()=>{},release:async()=>{},startTransaction:async()=>{},commitTransaction:async()=>{},rollbackTransaction:async()=>{},
      query:async(sql:string,params:any[]=[],structured=false)=>{const out=await connection.query(sql,params); if(!structured)return out.rows; const r=new QueryResult();r.records=out.rows;r.raw=out.rows;r.affected=out.affectedRows;return r;}};
    qr.broadcaster=new Broadcaster(qr);qr.manager=ds.createEntityManager(qr);return qr;
  };
  (ds as any).isInitialized=true;ds.createQueryRunner=()=>runner(pg);
  ds.manager.transaction=((cb:any)=>pg.transaction((tx:any)=>cb(runner(tx,true).manager))) as any;
  await pg.exec('CREATE TABLE houses(id integer PRIMARY KEY); INSERT INTO houses VALUES(1)');
  const qr:any={query:(sql:string)=>pg.query(sql)};
  for(const migration of [new AccessCardIssuance1789261200000(),new AccessCardLegacyDuplicateCheck1789347600000(),new AccessCardIcNoReservation1792018800000(),new LocalIntegrations1796200000000(),new StandardCardIssuance1796200100000()]) {await migration.up(qr);await migration.up(qr);}
  const cards = new StandardCardIssuanceService(ds.getRepository(LocalIntegrationTask));
  const service:any = new (LocalIntegrationsService as any)(ds.getRepository(LocalIntegration),ds.getRepository(LocalIntegrationTask),cards);
  return {pg,ds,cards,service};
}
async function batch(ds:DataSource, key:string, quantity=2) {
  const b=await ds.getRepository(AccessCardIssueBatch).save({tenantId:1,houseId:1,communityId:1,buildingId:1,legacyRoomKey:'228/01/101',addressSnapshot:'228/01/101',projectPhase:'phase2',accessSystem:'iccard',quantity,targetBuildingIds:[1],workstationId:key,status:'waiting_for_card',currentSequence:1,idempotencyKey:'fixture-'+Math.random()});
  const items=await ds.getRepository(AccessCardIssueItem).save(Array.from({length:quantity},(_,i)=>({tenantId:1,batchId:b.id,sequence:i+1,cardStatus:'waiting_for_card' as const,accessStatus:'pending' as const,legacySyncStatus:'pending' as const})));
  return {b,items};
}
test('formal batch → standard inspection → real reserved allocation binding → UID/number readback → canonical persisted item; no fake completion', async()=>{
  const {pg,ds,cards,service}=await fixture();
  try {
    const enrolled=await service.enroll({name:'合成工作站',kind:'workstation',resources},user);
    await service.heartbeat(enrolled.key,enrolled.token,{protocolVersion:'1.0',version:'1.0',ready:resources});
    await assert.rejects(cards.resolveRoute(2,enrolled.key,'fenghua.main'), /工作站/);
    await assert.rejects(cards.resolveRoute(1,enrolled.key,'not-registered'), /资源/);
    const route=await cards.resolveRoute(1,enrolled.key,'fenghua.main');
    const {AccessCardIssuanceService}=require('../access-card-issuance/access-card-issuance.service');
    const legacy:any=Object.assign(Object.create(AccessCardIssuanceService.prototype),{
      batchRepo:ds.getRepository(AccessCardIssueBatch),itemRepo:ds.getRepository(AccessCardIssueItem),legacyCardCheckRepo:ds.getRepository(AccessCardLegacyCardCheck),standardCards:cards,
      resolveHouse:async()=>({house:{id:1},community:{id:1},building:{id:1,buildingNo:'04'},phase:'phase2',accessSystem:'iccard',legacyStorageRoomKey:'228/04/101',roomKey:'228/4/101'}),
      authenticateAgent:async()=>({kind:'legacy_sync',tenantId:1,agentKey:'legacy-synthetic'})});
    const dto={houseId:1,quantity:2,workstationId:enrolled.key,standardResourceId:route.resourceId,idempotencyKey:'formal-synthetic'};
    const created=await legacy.create(dto,user);const b=created,items=created.items;
    assert.equal((await legacy.create(dto,user)).id,b.id,'formal entry replays original batch');
    await assert.rejects(legacy.create({...dto,quantity:1},user), /幂等键/);
    await assert.rejects(legacy.create({...dto,houseId:2},user), /幂等键/);
    await assert.rejects(legacy.create({...dto,workstationId:'other'},user), /幂等键/);
    await assert.rejects(legacy.create({...dto,standardResourceId:'other.profile'},user), /幂等键/);
    assert.equal(await ds.getRepository(LocalIntegrationTask).count(),1,'only first card is queued');
    let task=(await service.claim(enrolled.key,enrolled.token)).task;
    assert.equal(task.operation,'card.inspect');
    await service.report(enrolled.key,enrolled.token,task.id,{leaseToken:task.leaseToken,result:{outcome:'succeeded',evidence:'observed',records:[{cardUid:'01AB23CD'}]}});
    let check=await ds.getRepository(AccessCardLegacyCardCheck).findOneByOrFail({itemId:items[0].id});
    assert.equal(check.status,'pending');assert.equal(check.allocatedIcNo,null);
    await cards.advanceAllocation(1,items[0].id);
    assert.equal(await ds.getRepository(LocalIntegrationTask).count(),1,'no write without real allocation');
    // Exercise the EXISTING .80 report method and persisted allocation ledger, not a supplied task number.
    check.leaseAgentKey='legacy-synthetic';await ds.getRepository(AccessCardLegacyCardCheck).save(check);
    await legacy.reportLegacyCardCheck('legacy-synthetic','synthetic',{checkId:check.id,result:'success',matches:[],allocatedIcNo:511});
    task=(await service.claim(enrolled.key,enrolled.token)).task;
    assert.equal(task.operation,'card.write');
    assert.deepEqual(task.command.card,{uid:'01AB23CD',number:'511',profileId:'fenghua.main',allocationId:String(check.id)});
    await cards.advanceAllocation(1,items[0].id);
    assert.equal(await ds.getRepository(LocalIntegrationTask).count(),2,'allocation replay cannot duplicate write');
    const report=(records:any)=>service.report(enrolled.key,enrolled.token,task.id,{leaseToken:task.leaseToken,result:{outcome:'succeeded',evidence:'card_readback',records}});
    await assert.rejects(report([{cardUid:'DEADBEEF',cardNumber:'511'}]),/回读/);
    await assert.rejects(report([{cardUid:'01AB23CD',cardNumber:'999'}]),/回读/);
    assert.equal((await ds.getRepository(AccessCardIssueItem).findOneByOrFail({id:items[0].id})).cardStatus,'writing');
    await report([{cardUid:'01AB23CD',cardNumber:'511'}]);
    await report([{cardUid:'01AB23CD',cardNumber:'511'}]);
    const stored=await ds.getRepository(AccessCardIssueItem).findOneByOrFail({id:items[0].id});
    assert.equal(stored.cardStatus,'card_completed');assert.equal(stored.icCardNo,'01AB23CD');assert.ok(stored.cardCompletedAt);
    assert.equal(stored.accessStatus,'pending');assert.equal(stored.legacySyncStatus,'pending');
    assert.notEqual((await ds.getRepository(AccessCardIssueBatch).findOneByOrFail({id:b.id})).status,'completed','physical writing is NOT legacy/controller completion');
    assert.equal(await ds.getRepository(LocalIntegrationTask).count(),3,'second card starts once only');
    await assert.rejects(service.createTask(enrolled.key,{resourceId:'fenghua.main',operation:'card.write',revision:1,idempotencyKey:'forged',command:{card:{uid:'01AB23CD',number:'999',profileId:'fenghua.main',allocationId:String(check.id)}}},user),/真实卡号分配|正式/);
    const next=(await service.claim(enrolled.key,enrolled.token)).task;
    await service.report(enrolled.key,enrolled.token,next.id,{leaseToken:next.leaseToken,result:{outcome:'unknown',code:'CARD_REMOVED'}});
    assert.equal((await ds.getRepository(AccessCardIssueBatch).findOneByOrFail({id:b.id})).status,'needs_operator');
    await legacy.refreshBatchStatus(await ds.getRepository(AccessCardIssueBatch).findOneByOrFail({id:b.id}),1);
    assert.equal((await ds.getRepository(AccessCardIssueBatch).findOneByOrFail({id:b.id})).status,'needs_operator','later legacy/controller refresh cannot erase an unknown standard-card stop');
    // A later controller-stage failure must not let its retry endpoint erase the physical-operation stop.
    await ds.getRepository(AccessCardIssueItem).update({id:items[1].id},{accessStatus:'needs_operator'});
    await assert.rejects(legacy.retryAccessUpload(b.id, items[1].id, user), /标准写卡|人工核对/);
    assert.equal((await ds.getRepository(AccessCardIssueItem).findOneByOrFail({id:items[1].id})).lastErrorRef,'STD_CARD','controller retry must not erase the physical-operation stop');
    assert.equal((await service.claim(enrolled.key,enrolled.token)).task,null,'uncertain physical tasks are not repeated');
  } finally {await pg.close();}
});
test('phase-one replay normalizes ignored extra buildings exactly like the original canonical create', async () => {
  const { AccessCardIssuanceService } = require('../access-card-issuance/access-card-issuance.service');
  const existing = { id:91, tenantId:1, houseId:1, quantity:1, buildingId:2, projectPhase:'phase1', targetBuildingIds:[], workstationId:null };
  const legacy:any = Object.assign(Object.create(AccessCardIssuanceService.prototype), {
    batchRepo:{ findOne:async()=>existing }, resolveHouse:async()=>({phase:'phase1'}), getBatch:async(id:number)=>({id}),
  });
  assert.deepEqual(await legacy.create({houseId:1,quantity:1,idempotencyKey:'same-original',extraBuildingIds:[9,2,9]},user), {id:91});
});
test('duplicate UID, changed reservation and expired lease never create another physical write', async()=>{
  const {pg,ds,cards,service}=await fixture();
  try {
    const enrolled=await service.enroll({name:'异常合成工作站',kind:'workstation',resources},user);
    await service.heartbeat(enrolled.key,enrolled.token,{protocolVersion:'1.0',version:'1.0',ready:resources});
    const route=await cards.resolveRoute(1,enrolled.key,'fenghua.main');
    const first=await batch(ds,enrolled.key,1);await ds.manager.transaction(m=>cards.startBatch(m,first.b,first.items,route));
    const inspect=(await service.claim(enrolled.key,enrolled.token)).task;
    await service.report(enrolled.key,enrolled.token,inspect.id,{leaseToken:inspect.leaseToken,result:{outcome:'succeeded',evidence:'observed',records:[{cardUid:'01AB23CD'}]}});
    const second=await batch(ds,enrolled.key,1);await ds.manager.transaction(m=>cards.startBatch(m,second.b,second.items,route));
    const duplicate=(await service.claim(enrolled.key,enrolled.token)).task;
    await service.report(enrolled.key,enrolled.token,duplicate.id,{leaseToken:duplicate.leaseToken,result:{outcome:'succeeded',evidence:'observed',records:[{cardUid:'01AB23CD'}]}});
    assert.equal((await ds.getRepository(AccessCardIssueItem).findOneByOrFail({id:second.items[0].id})).cardStatus,'duplicate_card');
    const check=await ds.getRepository(AccessCardLegacyCardCheck).findOneByOrFail({itemId:first.items[0].id});check.status='clear';check.allocatedIcNo=511;await ds.getRepository(AccessCardLegacyCardCheck).save(check);
    await cards.advanceAllocation(1,first.items[0].id);
    const write=(await service.claim(enrolled.key,enrolled.token)).task;
    check.allocatedIcNo=512;await ds.getRepository(AccessCardLegacyCardCheck).save(check);
    await assert.rejects(service.report(enrolled.key,enrolled.token,write.id,{leaseToken:write.leaseToken,result:{outcome:'succeeded',evidence:'card_readback',records:[{cardUid:'01AB23CD',cardNumber:'511'}]}}),/分配|绑定/);
    await ds.getRepository(LocalIntegrationTask).update(write.id,{leaseExpiresAt:new Date(Date.now()-1000)});
    assert.equal((await service.claim(enrolled.key,enrolled.token)).task,null);
    assert.equal((await ds.getRepository(LocalIntegrationTask).findOneByOrFail({id:write.id})).status,'unknown');
    assert.equal((await ds.getRepository(AccessCardIssueBatch).findOneByOrFail({id:first.b.id})).status,'needs_operator');
  } finally {await pg.close();}
});
