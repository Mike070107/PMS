import {resolveAddressForTenant} from '../../common/address-lookup';
import {BadRequestException,ForbiddenException,Injectable,NotFoundException} from '@nestjs/common';import {InjectRepository} from '@nestjs/typeorm';import {Repository} from 'typeorm';import {BusinessTransaction} from '../../entities/business-transaction.entity';import {AuthUser} from '../../common/current-user.decorator';import {ResolvedAccess} from '../access/access.service';import {scopeCommunityIds} from '../access/scope.util';
import {BusinessLog} from '../../entities/business-log.entity';
import {BusinessServiceType,BusinessTransactionStatus} from '../../common/enums';
import {parkingTimelinePage} from './parking-timeline';
import {collectionDaySql} from './collection-date';
const PAYMENT_LABELS:Record<string,string>={cash:'现金',wechat:'微信',alipay:'支付宝',bank:'银行',pos:'刷卡',transfer:'转账',other:'其他'};
const SERVICE_LABELS:Record<string,string>={parking_monthly:'停车续期',access_card:'门禁卡',mis_property:'物业费',mis_berth:'泊位费'};
function text(value:unknown){const s=String(value??'').trim();return s||null}
function isoText(value:unknown){if(value instanceof Date)return value.toISOString();const s=text(value);if(!s)return null;const d=new Date(s);return Number.isFinite(d.getTime())?d.toISOString():s}
function dateText(value:unknown){if(value instanceof Date)return value.toISOString().slice(0,10);const s=text(value);return s?s.slice(0,10):null}
import {findParkingTarget} from './parking-targets';
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const objects=(v:unknown):Array<Record<string,any>>=>Array.isArray(v)?v.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)):[];
/** 本单保存的执行快照，不查询/重放任务，也不由总状态推断各系统成功。 */
function parkingOperations(parking:Record<string,any>,execution:Record<string,any>,targetEndDate:string|null,spaces:Array<Record<string,any>>){
 const steps=objects(execution.steps),seen=new Set<string>(),register=parking.newVehicle===true;
 const operation=(step:Record<string,any>,sys:Record<string,any>={},key:string|null=null)=>({
  key:key||text(step.key),
  spaceNo:sys.targetKey==='local:phase2_main_garage'?text(spaces.find(s=>s.garage==='main')?.spaceNo):
    sys.kind==='deliyun'?text(spaces.find(s=>s.garage==='civil')?.spaceNo):null,
  systemLabel:text(sys.label)||text(step.label)||findParkingTarget(parking.target||execution.target)?.label||'停车系统（名称未记录）',
  action:step.key==='registration:check'?'check':text(step.key)?.startsWith('reversal:')?'restore':register?'register':'renew',
  previousEndDate:text(step.previousEndDate)||text(sys.previousEndDate),
  targetEndDate:text(step.key)?.startsWith('reversal:')?text(step.targetEndDate):step.key==='registration:check'?null:targetEndDate,
  plannedPreviousEndDate:key==='legacy'?text(object(execution.planned).previousEndDate):null,
  plannedTargetEndDate:key==='legacy'?text(object(execution.planned).endDate):null,
  status:text(step.status)||'unrecorded',operationId:Number.isSafeInteger(step.operationId)&&step.operationId>0?step.operationId:null,note:text(step.note),
 });
 const out=objects(parking.systems).map(sys=>{
  const key=register?(sys.database?`registration:${sys.database}`:sys.park?`registration:deliyun:${sys.park}`:null)
   :sys.database&&sys.sourceRecordId?`local:${sys.database}:${sys.sourceRecordId}`:sys.park?`deliyun:${sys.park}`:null;
  const step=key?steps.find(s=>s.key===key):undefined;if(step&&key)seen.add(key);
  return operation(step||{},sys,key);
 });
 for(const step of steps)if(!seen.has(step.key))out.push(operation(step));
 if(!out.length&&(parking.target||execution.target||execution.operationId))out.push(operation({}, {},'legacy'));
 return out;
}
/** 单行明细：只依赖本行 snapshot/start_date/end_date/created_at/用户，不额外查库。 */
function detailOf(row:any){
 const snapshot=(row.snapshot&&typeof row.snapshot==='object')?row.snapshot as Record<string,any>:{};
 const parking=(snapshot.parking&&typeof snapshot.parking==='object')?snapshot.parking as Record<string,any>:{};
 const vehicle=(snapshot.vehicle&&typeof snapshot.vehicle==='object')?snapshot.vehicle as Record<string,any>:{};
 const estimate=(snapshot.estimate&&typeof snapshot.estimate==='object')?snapshot.estimate as Record<string,any>:{};
 const systems=objects(parking.systems);
 const execution=object(snapshot.execution),manualDone=object(execution.manualDone);
 const targetEndDate=dateText(row.endDate)||dateText(vehicle.validUntil);
 const previousEnds=systems.map(s=>text(s.previousEndDate)).filter(Boolean) as string[];
 const extra:Record<string,unknown>={};
 const spaces=objects(snapshot.propertySpaces).filter(s=>text(s.spaceNo));
 if(spaces.length)extra.spaceNo=spaces.map(s=>(s.garage==='main'?'大车库':s.garage==='civil'?'人防车库':'车位')+' '+s.spaceNo+'号').join('、');
 const quote=object(snapshot.quote),review=object(snapshot.review);
 for(const key of ['quantity','unitPriceCents','standardAmountCents'])if((quote[key]??estimate[key])!=null)extra[key]=quote[key]??estimate[key];
 if(review.manualAmountCents!=null)Object.assign(extra,{manualAmountCents:review.manualAmountCents,reason:review.reason,
   requestedBy:row.requester||review.requestedBy,decidedBy:row.decider||review.decidedBy,requestedAt:review.requestedAt,decidedAt:review.decidedAt,
   decision:review.decision==='approved'?'通过':review.decision==='rejected'?'驳回':undefined});
 if(systems.length)extra.parkingSystems=systems.map(s=>({label:text(s.label),database:text(s.database),previousEndDate:text(s.previousEndDate),target:text(s.target),sourceRecordId:text(s.sourceRecordId)}));
 if(text(parking.previousVehicleClass))extra.previousVehicleClass=text(parking.previousVehicleClass);
 if(text(parking.vehicleClass))extra.chargedVehicleClass=text(parking.vehicleClass);
 if(text(parking.legacyStartDate))extra.legacyStartDate=text(parking.legacyStartDate);
 if(text(parking.target))extra.parkingTarget=text(parking.target);
 if(text(estimate.vehicleClass))extra.vehicleClass=text(estimate.vehicleClass);
 if(text(snapshot.ruleName))extra.ruleName=text(snapshot.ruleName);
 if(Array.isArray(snapshot.cards))extra.cards=(snapshot.cards as Array<Record<string,any>>).map(c=>({cardNo:text(c.cardNo)}));
 if(estimate.startDate)extra.periodStart=text(estimate.startDate);
 if(estimate.endDate)extra.periodEnd=text(estimate.endDate);
 if(parking.newVehicle)extra.newVehicle=true;
 return {
  plateNo:text(parking.plate)||text(vehicle.plateNo)||text(row.plateNo),
  // 续期场景的原到期日：snapshot.parking.systems[].previousEndDate；多系统时取最早值，完整清单见 extra.parkingSystems
  periodFrom:row.serviceType==='parking_monthly'?(previousEnds.sort()[0]||null):null,
  periodTo:row.serviceType==='parking_monthly'?targetEndDate:null,
   ...(row.serviceType==='parking_monthly'?{
    parkingOperations:parkingOperations(parking,execution,targetEndDate,spaces),
    execution:{status:text(row.externalSyncStatus),mode:text(execution.mode),finishedAt:isoText(execution.finishedAt),lastError:text(execution.lastError),
     operationId:Number.isSafeInteger(execution.operationId)&&execution.operationId>0?execution.operationId:null,
     manualDone:text(manualDone.note)?{at:isoText(manualDone.at),note:text(manualDone.note)}:null},
   }:{}),
  amountCents:Number(row.amountCents)||0,
  paidAt:isoText(row.createdAt),
  operatorName:text(row.cashier),
  paymentMethod:PAYMENT_LABELS[String(row.paymentMethod??'').toLowerCase()]||text(row.paymentMethod),
  serviceType:SERVICE_LABELS[String(row.serviceType??'')]||text(row.serviceType)||'其他业务',
  extra,
 };
}
export interface BusinessLedgerQuery{includeOperations?:number;page?:number;pageSize?:number;from?:string;to?:string;communityId?:number;q?:string;serviceType?:string;status?:string;kind?:string;}
@Injectable()
export class BusinessLedgerService{
 constructor(@InjectRepository(BusinessTransaction) private readonly repo:Repository<BusinessTransaction>){}

 async reverseParkingPayment(id:number, reason:string, user:AuthUser, access?:ResolvedAccess){
  const tenantId=user.tenantId;
  if(!tenantId||!access)throw new ForbiddenException('缺少公司或数据范围授权');
  const note=reason?.trim();
  if(!note||note.length>300)throw new BadRequestException('请填写红冲原因，最多 300 字');
  const scope=scopeCommunityIds(access);
  return this.repo.manager.transaction(async manager=>{
   const repo=manager.getRepository(BusinessTransaction);
   const original=await repo.findOne({where:{id,tenantId},lock:{mode:'pessimistic_write'}});
   if(!original||scope&&(original.communityId==null||!scope.includes(original.communityId)))
    throw new NotFoundException('原流水不存在或不在当前数据范围');
   const linkedTxnNo=text(original.snapshot?.reversedByTxnNo);
   if(linkedTxnNo)return {reversalTxnNo:linkedTxnNo,amountCents:-original.amountCents};
   if(!canReverseParkingPayment(original))throw new BadRequestException('仅可红冲已办结或审批驳回的停车收款正数原单');
   const snapshot=original.snapshot||{};
   const plate=text(object(snapshot.vehicle).plateNo)||text(object(snapshot.parking).plate);
   const parking=object(snapshot.parking);
   const reviewValidity=!!plate&&original.externalSyncStatus==='synced'&&parking.newVehicle!==true;
   const reversal=await repo.save(repo.create({
    tenantId,txnNo:`PKR-${original.id}`,serviceType:BusinessServiceType.PARKING_MONTHLY,
    status:BusinessTransactionStatus.REFUNDED,ruleId:original.ruleId,communityId:original.communityId,
    houseId:original.houseId,ownerId:original.ownerId,targetType:'parking_reversal',targetId:original.id,quantity:original.quantity,
    startDate:original.startDate,endDate:original.endDate,amountCents:-original.amountCents,
    paymentMethod:original.paymentMethod,externalSyncStatus:reviewValidity?'queued':'not_applicable',invoiceStatus:'not_required',
    remark:`红冲 ${original.txnNo}；${note}`,
    snapshot:{vehicle:{plateNo:plate},estimate:snapshot.estimate,ruleName:snapshot.ruleName,
     intake:{propertyLabel:object(snapshot.intake).propertyLabel},
     reversal:{originalTxnNo:original.txnNo,reason:note,...(reviewValidity?{reviewValidity:true}:{})}},
    createdBy:user.id,updatedBy:user.id,
   }));
   original.snapshot={...snapshot,reversedByTxnNo:reversal.txnNo};
   original.updatedBy=user.id;
   await repo.save(original);
   await manager.save(BusinessLog,manager.create(BusinessLog,{
    tenantId,transactionId:original.id,action:'parking_payment_reversed',
    detail:{reason:note,reversalId:reversal.id,reversalTxnNo:reversal.txnNo,amountCents:reversal.amountCents},
    createdBy:user.id,updatedBy:user.id,
   }));
   return {reversalTxnNo:reversal.txnNo,amountCents:reversal.amountCents};
  });
 }
 async list(q:BusinessLedgerQuery,user:AuthUser,access?:ResolvedAccess){
  if(!user.tenantId||!access)throw new ForbiddenException('缺少公司或数据范围授权');
  const requested=q.page??1,pageSize=q.pageSize??20;if(!Number.isInteger(requested)||requested<1||requested>1000000||![20,50,100].includes(pageSize))throw new BadRequestException('分页仅支持20、50、100条');
  for(const d of[q.from,q.to])if(d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))throw new BadRequestException('收款日期不合法');if(q.from&&q.to&&q.from>q.to)throw new BadRequestException('开始日期不能晚于结束日期');
  if(q.serviceType&&!['parking_monthly','access_card','mis_property','mis_berth'].includes(q.serviceType))throw new BadRequestException('业务类型不合法');if(q.status&&!['paid','refunded','cancelled'].includes(q.status))throw new BadRequestException('收款状态不合法');if(q.kind&&q.kind!=='free')throw new BadRequestException('金额筛选不合法');if(q.q&&q.q.length>120)throw new BadRequestException('查询词过长');
  const scope=scopeCommunityIds(access);if(q.communityId&&(!Number.isSafeInteger(q.communityId)||q.communityId<1||scope&&!scope.includes(q.communityId)))throw new ForbiddenException('该小区不在当前数据范围');
  const empty={rows:[] as any[],total:0,page:1,pageSize,summary:{paidCents:0,refundedCents:0,netCents:0,freeCount:0,syncedCount:0,paidCount:0,byService:[] as Array<{serviceType:string;paidCents:number;paidCount:number}>}};if(scope&&!scope.length)return empty;
  const address="COALESCE(NULLIF(t.snapshot->'intake'->>'propertyLabel',''),NULLIF(t.snapshot->'house'->>'address',''),CONCAT_WS('/',NULLIF(c.name,''),NULLIF(b.lane,''),NULLIF(b.building_no,''),NULLIF(h.room_no,'')))";
  const plate="COALESCE(NULLIF(t.snapshot->'vehicle'->>'plateNo',''),t.snapshot->'parking'->>'plate','')";
  const base=this.repo.createQueryBuilder('t').leftJoin('houses','h','h.id=t.house_id AND h.tenant_id=t.tenant_id').leftJoin('buildings','b','b.id=h.building_id AND b.tenant_id=t.tenant_id').leftJoin('communities','c','c.id=t.community_id AND c.tenant_id=t.tenant_id').leftJoin('users','u','u.id=t.created_by AND u.tenant_id=t.tenant_id').where('t.tenant_id=:tenant',{tenant:user.tenantId});
  if(scope)base.andWhere('t.community_id IN (:...scope)',{scope});if(q.communityId)base.andWhere('t.community_id=:community',{community:q.communityId});
  if(q.serviceType)base.andWhere('t.service_type=:service',{service:q.serviceType});if(q.status)base.andWhere('t.status=:status',{status:q.status});if(q.kind==='free')base.andWhere('t.amount_cents=0');
  const collectionDay=collectionDaySql('t');
  if(q.from)base.andWhere(`${collectionDay} >= :from`,{from:q.from});if(q.to)base.andWhere(`${collectionDay} <= :to`,{to:q.to});
  if(q.q?.trim()){
   const match=await resolveAddressForTenant(this.repo.manager.connection,user.tenantId!,q.q);
   if(match)base.andWhere(match.allHouseIds.length?'t.house_id IN (:...addressHouseIds)':'1=0',{addressHouseIds:match.allHouseIds});
   else base.andWhere(`(t.txn_no ILIKE :term OR t.snapshot->>'reversedByTxnNo' ILIKE :term OR t.snapshot#>>'{reversal,originalTxnNo}' ILIKE :term
    OR ${address} ILIKE :term OR ${plate} ILIKE :term OR u.name ILIKE :term)`,{term:'%'+q.q.trim().replace(/[\\%_]/g,c=>'\\'+c)+'%'});
  }
  const paid="COALESCE(SUM(CASE WHEN t.status='paid' THEN t.amount_cents::bigint ELSE 0 END),0)",refunded="COALESCE(SUM(CASE WHEN t.status='refunded' THEN ABS(t.amount_cents::bigint) ELSE 0 END),0)";
  const totals=await base.clone().select('COUNT(*)','total').addSelect(paid,'paidCents').addSelect(refunded,'refundedCents').addSelect(`(${paid})-(${refunded})`,'netCents').addSelect("COALESCE(SUM(CASE WHEN t.status='paid' AND t.amount_cents=0 THEN 1 ELSE 0 END),0)",'freeCount').addSelect("COALESCE(SUM(CASE WHEN t.status='paid' THEN 1 ELSE 0 END),0)",'paidCount').addSelect("COALESCE(SUM(CASE WHEN t.external_sync_status='synced' THEN 1 ELSE 0 END),0)",'syncedCount').getRawOne<Record<string,string>>();
  const safe=(v:unknown)=>{const n=Number(v??0);if(!Number.isSafeInteger(n))throw new BadRequestException('汇总超出安全范围，请缩小筛选');return n};let total=safe(totals?.total),page=Math.min(requested,Math.max(1,Math.ceil(total/pageSize)));
  const detailQuery=base.clone().select(['t.id AS id','t.txn_no AS "txnNo"','t.service_type AS "serviceType"','t.status AS status','t.amount_cents AS "amountCents"','t.payment_method AS "paymentMethod"','t.external_sync_status AS "externalSyncStatus"','t.created_at AS "createdAt"','t.community_id AS "communityId"','t.house_id AS "houseId"','t.quantity AS quantity','t.snapshot AS snapshot',"(SELECT u1.name FROM users u1 WHERE u1.tenant_id=t.tenant_id AND u1.id::text=t.snapshot#>>'{review,requestedBy}') AS requester","(SELECT u2.name FROM users u2 WHERE u2.tenant_id=t.tenant_id AND u2.id::text=t.snapshot#>>'{review,decidedBy}') AS decider",'t.start_date::text AS "startDate"','t.end_date::text AS "endDate"','u.name AS cashier',`${address} AS address`,`${plate} AS "plateNo"`,`${collectionDay} AS "collectionDate"`]);
  let timeline:Awaited<ReturnType<typeof parkingTimelinePage>>|undefined;
  if(q.includeOperations===1 && !q.kind && !q.status && (!q.serviceType||q.serviceType==='parking_monthly')){
    const paymentKeys=base.clone().select(['t.id AS id','t.created_at AS at',`${collectionDay} AS day`]);
    timeline=await parkingTimelinePage((sql,params)=>this.repo.manager.connection.query(sql,params),paymentKeys.getQueryAndParameters(),
      user.tenantId,q.communityId?[q.communityId]:scope,q,requested,pageSize);
    total=timeline.total;page=Math.min(requested,Math.max(1,Math.ceil(total/pageSize)));
    const ids=timeline.entries.filter(e=>!e.event).map(e=>e.id);
    detailQuery.andWhere(ids.length?'t.id IN (:...pageIds)':'1=0',{pageIds:ids});
  }else detailQuery.offset((page-1)*pageSize).limit(pageSize);
  const rows=await detailQuery.orderBy('"collectionDate"','DESC').addOrderBy('t.created_at','DESC').addOrderBy('t.id','DESC').getRawMany();
  const byService=(await base.clone().select('t.service_type','serviceType').addSelect(paid,'paidCents').addSelect("COALESCE(SUM(CASE WHEN t.status='paid' THEN 1 ELSE 0 END),0)",'paidCount').groupBy('t.service_type').orderBy('t.service_type','ASC').getRawMany()).map(r=>({serviceType:String(r.serviceType),paidCents:safe(r.paidCents),paidCount:safe(r.paidCount)}));
  const payments=rows.map(r=>({...r,detail:detailOf(r),canReverse:canReverseParkingPayment(r),
   reversedByTxnNo:text(r.snapshot?.reversedByTxnNo),
   reversal:object(r.snapshot?.reversal).originalTxnNo ? r.snapshot.reversal : null,
  }));
  if(timeline && payments.length){
   const tasks=await this.repo.manager.connection.query(`SELECT o.payload->>'businessTxnNo' AS txn,o.id AS "taskId",o.kind,o.database,o.status,
    o.completed_at AS "completedAt",o.result->>'deviceVerification' AS "deviceVerification",o.result->'retryChannels' AS "retryChannels"
    FROM parking_operations o WHERE o.tenant_id=$1 AND o.payload->>'businessTxnNo'=ANY($2::text[]) ORDER BY o.id`,[user.tenantId,payments.map(p=>p.txnNo)]);
   for(const payment of payments)Object.assign(payment.detail,{tasks:tasks.filter((task:any)=>task.txn===payment.txnNo)});
  }
  const indexed=new Map(payments.map(row=>[Number(row.id),row]));
  const entries=timeline?timeline.entries.map(e=>e.event?{id:e.id,serviceType:'parking_operation',operation:e.event,createdAt:e.at,
    plateNo:e.event.plate||e.event.newPlate,cashier:e.event.operator,canReverse:false}:indexed.get(e.id)).filter(Boolean):payments;
  return{rows:entries,total,page,pageSize,summary:{paidCents:safe(totals?.paidCents),refundedCents:safe(totals?.refundedCents),netCents:safe(totals?.netCents),freeCount:safe(totals?.freeCount),syncedCount:safe(totals?.syncedCount),paidCount:safe(totals?.paidCount),byService}};
 }
}

function canReverseParkingPayment(row:Pick<BusinessTransaction,'serviceType'|'status'|'amountCents'|'externalSyncStatus'|'snapshot'>){
 return row.serviceType===BusinessServiceType.PARKING_MONTHLY&&row.status===BusinessTransactionStatus.PAID&&
  Number.isSafeInteger(row.amountCents)&&row.amountCents>0&&!row.snapshot?.reversedByTxnNo&&
  ['synced','rejected'].includes(row.externalSyncStatus);
}
