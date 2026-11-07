import {resolveAddressForTenant} from '../../common/address-lookup';
import {BadRequestException,ForbiddenException,Injectable} from '@nestjs/common';import {InjectRepository} from '@nestjs/typeorm';import {Repository} from 'typeorm';import {BusinessTransaction} from '../../entities/business-transaction.entity';import {AuthUser} from '../../common/current-user.decorator';import {ResolvedAccess} from '../access/access.service';import {scopeCommunityIds} from '../access/scope.util';
const PAYMENT_LABELS:Record<string,string>={cash:'现金',wechat:'微信',alipay:'支付宝',bank:'银行',pos:'刷卡',transfer:'转账',other:'其他'};
const SERVICE_LABELS:Record<string,string>={parking_monthly:'停车续期',access_card:'门禁卡',mis_property:'物业费',mis_berth:'泊位费'};
function text(value:unknown){const s=String(value??'').trim();return s||null}
function isoText(value:unknown){if(value instanceof Date)return value.toISOString();const s=text(value);if(!s)return null;const d=new Date(s);return Number.isFinite(d.getTime())?d.toISOString():s}
function dateText(value:unknown){if(value instanceof Date)return value.toISOString().slice(0,10);const s=text(value);return s?s.slice(0,10):null}
/** 单行明细：只依赖本行 snapshot/start_date/end_date/created_at/用户，不额外查库。 */
function detailOf(row:any){
 const snapshot=(row.snapshot&&typeof row.snapshot==='object')?row.snapshot as Record<string,any>:{};
 const parking=(snapshot.parking&&typeof snapshot.parking==='object')?snapshot.parking as Record<string,any>:{};
 const vehicle=(snapshot.vehicle&&typeof snapshot.vehicle==='object')?snapshot.vehicle as Record<string,any>:{};
 const estimate=(snapshot.estimate&&typeof snapshot.estimate==='object')?snapshot.estimate as Record<string,any>:{};
 const systems=Array.isArray(parking.systems)?parking.systems as Array<Record<string,any>>:[];
 const previousEnds=systems.map(s=>text(s.previousEndDate)).filter(Boolean) as string[];
 const extra:Record<string,unknown>={};
 if(systems.length)extra.parkingSystems=systems.map(s=>({label:text(s.label),database:text(s.database),previousEndDate:text(s.previousEndDate),target:text(s.target),sourceRecordId:text(s.sourceRecordId)}));
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
  periodTo:row.serviceType==='parking_monthly'?(dateText(row.endDate)||dateText(vehicle.validUntil)):null,
  amountCents:Number(row.amountCents)||0,
  paidAt:isoText(row.createdAt),
  operatorName:text(row.cashier),
  paymentMethod:PAYMENT_LABELS[String(row.paymentMethod??'').toLowerCase()]||text(row.paymentMethod),
  serviceType:SERVICE_LABELS[String(row.serviceType??'')]||text(row.serviceType)||'其他业务',
  extra,
 };
}
export interface BusinessLedgerQuery{page?:number;pageSize?:number;from?:string;to?:string;communityId?:number;q?:string;serviceType?:string;status?:string;kind?:string;}
@Injectable()
export class BusinessLedgerService{
 constructor(@InjectRepository(BusinessTransaction) private readonly repo:Repository<BusinessTransaction>){}
 async list(q:BusinessLedgerQuery,user:AuthUser,access?:ResolvedAccess){
  if(!user.tenantId||!access)throw new ForbiddenException('缺少公司或数据范围授权');
  const requested=q.page??1,pageSize=q.pageSize??20;if(!Number.isInteger(requested)||requested<1||requested>1000000||![20,50,100].includes(pageSize))throw new BadRequestException('分页仅支持20、50、100条');
  for(const d of[q.from,q.to])if(d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))throw new BadRequestException('收款日期不合法');if(q.from&&q.to&&q.from>q.to)throw new BadRequestException('开始日期不能晚于结束日期');
  if(q.serviceType&&!['parking_monthly','access_card','mis_property','mis_berth'].includes(q.serviceType))throw new BadRequestException('业务类型不合法');if(q.status&&!['paid','refunded','cancelled'].includes(q.status))throw new BadRequestException('收款状态不合法');if(q.kind&&q.kind!=='free')throw new BadRequestException('金额筛选不合法');if(q.q&&q.q.length>120)throw new BadRequestException('查询词过长');
  const scope=scopeCommunityIds(access);if(q.communityId&&(!Number.isSafeInteger(q.communityId)||q.communityId<1||scope&&!scope.includes(q.communityId)))throw new ForbiddenException('该小区不在当前数据范围');
  const empty={rows:[] as any[],total:0,page:1,pageSize,summary:{paidCents:0,refundedCents:0,netCents:0,freeCount:0,syncedCount:0,paidCount:0,byService:[] as Array<{serviceType:string;paidCents:number;paidCount:number}>}};if(scope&&!scope.length)return empty;
  const address="COALESCE(NULLIF(t.snapshot->'house'->>'address',''),CONCAT_WS('/',NULLIF(c.name,''),NULLIF(b.lane,''),NULLIF(b.building_no,''),NULLIF(h.room_no,'')))";
  const plate="COALESCE(NULLIF(t.snapshot->'vehicle'->>'plateNo',''),t.snapshot->'parking'->>'plate','')";
  const base=this.repo.createQueryBuilder('t').leftJoin('houses','h','h.id=t.house_id AND h.tenant_id=t.tenant_id').leftJoin('buildings','b','b.id=h.building_id AND b.tenant_id=t.tenant_id').leftJoin('communities','c','c.id=t.community_id AND c.tenant_id=t.tenant_id').leftJoin('users','u','u.id=t.created_by AND u.tenant_id=t.tenant_id').where('t.tenant_id=:tenant',{tenant:user.tenantId});
  if(scope)base.andWhere('t.community_id IN (:...scope)',{scope});if(q.communityId)base.andWhere('t.community_id=:community',{community:q.communityId});
  if(q.serviceType)base.andWhere('t.service_type=:service',{service:q.serviceType});if(q.status)base.andWhere('t.status=:status',{status:q.status});if(q.kind==='free')base.andWhere('t.amount_cents=0');
  if(q.from)base.andWhere("t.created_at >= (CAST(:from AS date) AT TIME ZONE 'Asia/Shanghai')",{from:q.from});if(q.to)base.andWhere("t.created_at < ((CAST(:to AS date)+1) AT TIME ZONE 'Asia/Shanghai')",{to:q.to});
  if(q.q?.trim()){
   const match=await resolveAddressForTenant(this.repo.manager.connection,user.tenantId!,q.q);
   if(match)base.andWhere(match.allHouseIds.length?'t.house_id IN (:...addressHouseIds)':'1=0',{addressHouseIds:match.allHouseIds});
   else base.andWhere(`(t.txn_no ILIKE :term OR ${address} ILIKE :term OR ${plate} ILIKE :term OR u.name ILIKE :term)`,{term:'%'+q.q.trim().replace(/[\\%_]/g,c=>'\\'+c)+'%'});
  }
  const paid="COALESCE(SUM(CASE WHEN t.status='paid' THEN t.amount_cents::bigint ELSE 0 END),0)",refunded="COALESCE(SUM(CASE WHEN t.status='refunded' THEN ABS(t.amount_cents::bigint) ELSE 0 END),0)";
  const totals=await base.clone().select('COUNT(*)','total').addSelect(paid,'paidCents').addSelect(refunded,'refundedCents').addSelect(`(${paid})-(${refunded})`,'netCents').addSelect("COALESCE(SUM(CASE WHEN t.status='paid' AND t.amount_cents=0 THEN 1 ELSE 0 END),0)",'freeCount').addSelect("COALESCE(SUM(CASE WHEN t.status='paid' THEN 1 ELSE 0 END),0)",'paidCount').addSelect("COALESCE(SUM(CASE WHEN t.external_sync_status='synced' THEN 1 ELSE 0 END),0)",'syncedCount').getRawOne<Record<string,string>>();
  const safe=(v:unknown)=>{const n=Number(v??0);if(!Number.isSafeInteger(n))throw new BadRequestException('汇总超出安全范围，请缩小筛选');return n};const total=safe(totals?.total),page=Math.min(requested,Math.max(1,Math.ceil(total/pageSize)));
  const rows=await base.clone().select(['t.id AS id','t.txn_no AS "txnNo"','t.service_type AS "serviceType"','t.status AS status','t.amount_cents AS "amountCents"','t.payment_method AS "paymentMethod"','t.external_sync_status AS "externalSyncStatus"','t.created_at AS "createdAt"','t.community_id AS "communityId"','t.house_id AS "houseId"','t.quantity AS quantity','t.snapshot AS snapshot','t.start_date AS "startDate"','t.end_date AS "endDate"','u.name AS cashier',`${address} AS address`,`${plate} AS "plateNo"`]).orderBy('t.created_at','DESC').addOrderBy('t.id','DESC').offset((page-1)*pageSize).limit(pageSize).getRawMany();
  const byService=(await base.clone().select('t.service_type','serviceType').addSelect(paid,'paidCents').addSelect("COALESCE(SUM(CASE WHEN t.status='paid' THEN 1 ELSE 0 END),0)",'paidCount').groupBy('t.service_type').orderBy('t.service_type','ASC').getRawMany()).map(r=>({serviceType:String(r.serviceType),paidCents:safe(r.paidCents),paidCount:safe(r.paidCount)}));
  return{rows:rows.map(r=>({...r,detail:detailOf(r)})),total,page,pageSize,summary:{paidCents:safe(totals?.paidCents),refundedCents:safe(totals?.refundedCents),netCents:safe(totals?.netCents),freeCount:safe(totals?.freeCount),syncedCount:safe(totals?.syncedCount),paidCount:safe(totals?.paidCount),byService}};
 }
}
