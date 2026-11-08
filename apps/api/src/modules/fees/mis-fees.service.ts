import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { collectionEffects as calculateCollectionEffects, effectDay, promiseProgress } from './mis-collection-effect';
import { validateMisFeeRange } from './mis-fees.query';
import { CollectionSmsService } from '../settings/collection-sms.service';
import { DEFAULT_FOLLOWUP_RULE } from '../settings/collection-followup.service';
import { TenantConfig } from '../../entities/tenant-config.entity';
import { MisCollectionBatch } from '../../entities/mis-collection-batch.entity';
import type { MisCollectionPreviewDto } from './mis-fees.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MisCollectionPromise, MisCollectionHold, MisCollectionEvent, MisCollectionPrint } from '../../entities/mis-collection-followup.entity';
import { Building, Community, House, User } from '../../entities';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { naturalNumberSql } from '../../common/natural-order';
import {buildMisLedgerQuery,MisLedgerQuery,MisLedgerAddress} from './mis-ledger.query';
import {resolveAddressForTenant} from '../../common/address-lookup';
import { buildMisFeeFilter, buildMisFeeQuery, buildMisResidentialQuery, MisResidentialQuery, MisFeeQuery, MisHouseFilter, misFeeStatus, misMoneyToCents } from './mis-fees.query';
import { MIS_FEE_CATEGORY_LABELS, isMisFeeCategory, misFeeCategoryLabel, misFeeCategoryOfText, misFeeCategorySql, type MisFeeCategory } from './mis-fee-category';

/** 模块级日志器：不参与依赖注入，避免改动构造函数（历史事故：注入新服务导致 API 启动失败）。 */
const logger=new Logger('MisFeesService');

/** 对账 CSV：单次最多 2 万户，按 5000 户一页循环取数；口径固定为待缴责任对象。 */
const EXPORT_ROW_CAP=20000,EXPORT_PAGE_SIZE=5000,EXPORT_STATUS_CHUNK=1000;
/** MIS 短时缓存：30 秒，足够挡住大屏/多标签/翻页重复查询，又不影响“刷新后尽快看到新数据”。 */
const MIS_CACHE_TTL_MS=30_000,MIS_CACHE_MAX_ENTRIES=400;
/** 大屏待缴金额分档固定四档，与前端现有分档文案一致；SQL 直接按户聚合，避免前端翻多页。 */
const AMOUNT_BRACKETS=[{key:'le500',label:'≤¥500'},{key:'500to2000',label:'¥500–2000'},{key:'2000to5000',label:'¥2000–5000'},{key:'gt5000',label:'>¥5000'}] as const;
/**
 * 重复催收抑制口径（task-10）：近 30 天次数 = 打印登记数 + 短信条数，直接相加，不按户去重，
 * 同一批既有打印又有短信算 2 次；阈值 2、窗口 30 天先写死为常量，后续从设置页配置化（不加表/字段）。
 */
const NOTIFY_COUNT_WINDOW_DAYS=30,NOTIFY_SUPPRESS_MIN=2;
const EXPORT_CSV_HEADER='小区,房号,业主,电话(脱敏),待缴金额(元),账期起,账期止,笔数,通知状态';
/** 文本单元格：含逗号/引号/换行时按 RFC4180 转义；OWASP 建议对 = + - @ 以及前导 Tab/CR 加单引号，避免 Excel 当成公式执行。 */
function csvText(value:unknown){
 let text=String(value??'');
 if(/^[=+\-@\t\r]/.test(text))text="'"+text;
 return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
}
function exportFileName(now:Date){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const get=(type:string)=>parts.find(part=>part.type===type)?.value||'';
 return `待缴对账_${get('year')}${get('month')}${get('day')}_${get('hour')}${get('minute')}.csv`;
}
/** 通知状态取最近一次通知：打印登记与短信发送谁更晚取谁；同刻优先打印。 */
function exportNoticeStatus(status?:{printedAt:string|null;printedPaper:'A5'|'A4'|null;smsAt:string|null;smsStatus:'submitted'|'delivered'|null}){
 if(!status)return '未通知';
 const printed=status.printedAt?Date.parse(status.printedAt):-1,sms=status.smsAt?Date.parse(status.smsAt):-1;
 if(sms>printed)return '短信已发';
 if(printed>=0)return (status.printedPaper==='A4'?'A4':'A5')+'已打印';
 return '未通知';
}
function exportCsvLine(row:any,communities:any[],status?:{printedAt:string|null;printedPaper:'A5'|'A4'|null;smsAt:string|null;smsStatus:'submitted'|'delivered'|null}){
 const community=communities.find((one:any)=>Number(one.id)===Number(row.communityId))?.name||'';
 const amount=((Number(row.amountCents)||0)/100).toFixed(2);
 return [csvText(community),csvText(row.address),csvText(row.ownerName),csvText(row.phoneMasked),amount,csvText(row.periodFrom),csvText(row.periodTo),String(Number(row.billCount)||0),exportNoticeStatus(status)].join(',');
}

// 与用户确认的映射；公寓收费台、北桥和颛桥均不参与物业费查询。
export const MIS_PROPERTY_OFFICES:Record<string,string[]>={
 '枫桦景苑一期':['01'],'枫桦景苑二期':['02','03'],'上海新家':['04'],
};
@Injectable()
export class MisFeesService implements OnModuleDestroy {
 private poolPromise:Promise<any>|null=null;
 private responseCache:Map<string,{expiresAt:number;value:any}>|undefined=new Map();
 constructor(@InjectRepository(Community) private readonly communities:Repository<Community>,@InjectRepository(House) private readonly houses:Repository<House>,@InjectRepository(MisCollectionBatch) private readonly batches?:Repository<MisCollectionBatch>, private readonly smsSettings?:CollectionSmsService){}
 /** 缓存键包含租户、数据范围与完整参数签名，避免不同权限/筛选串数据。 */
 private cacheKey(kind:string,q:unknown,user:AuthUser,access?:ResolvedAccess){
  const normalize=(value:any):any=>{
   if(Array.isArray(value))return value.map(normalize);
   if(value&&typeof value==='object'){const out:Record<string,unknown>={};for(const key of Object.keys(value).sort())if(value[key]!==undefined)out[key]=normalize(value[key]);return out;}
   return value;
  };
  const scope=scopeCommunityIds(access);
  return JSON.stringify([kind,user.tenantId,scope===null?'all':scope.slice().sort((a,b)=>a-b),user.actingOfficeId??null,this.canEditFees(access)?'edit':'view',normalize(q)]);
 }
 private cacheGet(key:string){
  const cache=this.responseCache??(this.responseCache=new Map());
  const hit=cache.get(key);
  if(!hit)return undefined;
  if(hit.expiresAt<=Date.now()){cache.delete(key);return undefined;}
  return hit.value;
 }
 private cacheSet(key:string,value:any,ttl=MIS_CACHE_TTL_MS){
  const cache=this.responseCache??(this.responseCache=new Map());
  if(cache.size>=MIS_CACHE_MAX_ENTRIES){
   for(const [k,v] of cache)if(v.expiresAt<=Date.now())cache.delete(k);
   if(cache.size>=MIS_CACHE_MAX_ENTRIES)cache.clear();
  }
  cache.set(key,{expiresAt:Date.now()+ttl,value});
 }
 private configured(){return !!(process.env.MIS_FEES_TENANT_ID&&process.env.MIS_FEES_USER&&process.env.MIS_FEES_PASSWORD);}
 private async scope(user:AuthUser,access?:ResolvedAccess){
  if(!user.tenantId)throw new ForbiddenException('请选择公司后查询');
  if(!access)throw new ForbiddenException('缺少数据范围授权');
  if(user.tenantId!==Number(process.env.MIS_FEES_TENANT_ID))return [];
  const allowed=scopeCommunityIds(access);
  if(allowed?.length===0)return [];
  return (await this.communities.find({where:{tenantId:user.tenantId}})).filter(c=>MIS_PROPERTY_OFFICES[c.name]&&(!allowed||allowed.includes(c.id))).map(c=>({id:c.id,name:c.name,offices:MIS_PROPERTY_OFFICES[c.name]}));
 }
 private async pool(){
  if(!this.configured())throw new ServiceUnavailableException('一通MIS查询连接尚未配置');
  if(!this.poolPromise){
   const sql=require('mssql');
   const legacy=process.env.MIS_FEES_LEGACY_TLS==='true';
   const pool=new sql.ConnectionPool({server:process.env.MIS_FEES_SERVER||'wjwy.mis.shxwit.com',port:Number(process.env.MIS_FEES_PORT||1533),database:process.env.MIS_FEES_DATABASE||'MIS吴泾物业',user:process.env.MIS_FEES_USER,password:process.env.MIS_FEES_PASSWORD,connectionTimeout:8000,requestTimeout:15000,pool:{min:0,max:2,idleTimeoutMillis:30000,acquireTimeoutMillis:8000},options:{encrypt:true,trustServerCertificate:process.env.MIS_FEES_TRUST_CERTIFICATE==='true',tdsVersion:'7_3_B',appName:'PMS-MIS-ReadOnly',...(legacy?{cryptoCredentialsDetails:{minVersion:'TLSv1',ciphers:'DEFAULT@SECLEVEL=0'}}:{})}});
   pool.on('error',()=>{this.poolPromise=null;void pool.close().catch(()=>{});});
   this.poolPromise=pool.connect().catch(async()=>{this.poolPromise=null;await pool.close().catch(()=>{});throw new ServiceUnavailableException('一通MIS连接失败，请检查服务端连接配置');});
  }
  return this.poolPromise;
 }
 /** 仅接受内部生成的SELECT；无SQL参数入口，不提供任何源库写操作。 */
 private async read(text:string,params:Record<string,string|number>={},timeoutMs=15000){
  if(!/^\s*(SELECT|WITH)\b/i.test(text)||/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|ALTER|DROP|TRUNCATE)\b/i.test(text))throw new Error('MIS只读查询校验失败');
  const sql=require('mssql'),pool=await this.pool(),req=pool.request();
  req.requestTimeout=Math.max(1000,Math.min(timeoutMs,15000));
  for(const [key,value] of Object.entries(params))req.input(key,typeof value==='number'?sql.Int:sql.NVarChar(4000),value);
  try{return await req.query(text);}catch{throw new ServiceUnavailableException('一通MIS查询未完成，请稍后重试；未使用旧数据替代');}
 }
 /** 镜像同步专用：强制短超时，避免定时任务卡住 MIS；仍走同一只读校验。 */
 async mirrorRead(text:string,params:Record<string,string|number>={},timeoutMs=5000){return this.read(text,params,timeoutMs);}
 async ledger(q:MisLedgerQuery,user:AuthUser,access?:ResolvedAccess){
  let communities=await this.scope(user,access);if(q.communityId){if(!communities.some(c=>c.id===q.communityId))throw new ForbiddenException('该小区不在MIS流水查询范围');communities=communities.filter(c=>c.id===q.communityId)}if(!communities.length)throw new ForbiddenException('当前范围没有已映射的MIS小区');
  const count=(v:unknown)=>{const n=Number(v??0);if(!Number.isSafeInteger(n)||n<0)throw new ServiceUnavailableException('MIS流水计数无法确认，请缩小范围重试');return n};
  let addresses:MisLedgerAddress[]|undefined;
  if(q.q?.trim()){const hit=await resolveAddressForTenant(this.communities.manager.connection,user.tenantId!,q.q);if(hit){
   if(hit.level==='community'){const selected=communities.filter(c=>hit.communityIds.includes(c.id));if(selected.length){communities=selected;q={...q,q:undefined}}else addresses=[]}
   else{addresses=[];if(hit.allHouseIds.length){const houses=await this.houses.createQueryBuilder('h').innerJoin(Building,'b','b.id=h.building_id AND b.tenant_id=h.tenant_id').where('h.tenant_id=:tenantId',{tenantId:user.tenantId}).andWhere('h.id IN (:...houseIds)',{houseIds:hit.allHouseIds}).andWhere('b.community_id IN (:...communityIds)',{communityIds:communities.map(c=>c.id)}).select(['h.room_no AS "roomNo"','h.road_name AS "road"','b.road_name AS "buildingRoad"','b.community_id AS "communityId"','b.lane AS lane','b.building_no AS "buildingNo"']).getRawMany<any>();const unique=new Map<string,MisLedgerAddress>();for(const h of houses){const community=communities.find(c=>c.id===Number(h.communityId));if(!community)continue;const buildingOnly=hit.level==='building'&&h.roomNo!=='商铺',address={road:h.road||h.buildingRoad,lane:h.lane||'',buildingNo:h.buildingNo,roomNo:buildingOnly?'':h.roomNo,shop:h.roomNo==='商铺',offices:community.offices,buildingOnly};unique.set(JSON.stringify(address),address)}addresses=[...unique.values()]}}
  }}
  let built=buildMisLedgerQuery(q,communities.flatMap(c=>c.offices),addresses),result=await this.read(built.sql,built.params),sets=result.recordsets||[],total=count(sets[0]?.[0]?.total);
  const page=Math.min(built.page,Math.max(1,Math.ceil(total/built.pageSize)));if(q.view!=='stats'&&page!==built.page){built=buildMisLedgerQuery({...q,page},communities.flatMap(c=>c.offices),addresses);result=await this.read(built.sql,built.params);sets=result.recordsets||[];total=count(sets[0]?.[0]?.total)}
  const raw=sets[0]?.[0]||{},meta={sourceLabel:'一通MIS',readOnly:true,queriedAt:new Date().toISOString(),total,page:built.page,pageSize:built.pageSize,summary:{paidNetCents:misMoneyToCents(raw.paidNetAmount),adjustmentCents:misMoneyToCents(raw.adjustmentAmount),refundedOriginalCents:misMoneyToCents(raw.refundedOriginalAmount)}};
  if(q.view==='stats'){const project=(rows:any[])=>rows.map(r=>({key:String(r.key??''),name:String(r.name||'未记录'),count:count(r.count),amountCents:misMoneyToCents(r.amount),adjustmentCents:misMoneyToCents(r.adjustmentAmount)}));return{...meta,rows:[],byFee:project(sets[1]||[]),byMethod:project(sets[2]||[]),byCashier:project(sets[3]||[]),byDay:project(sets[4]||[])}}
  const rows=(sets[1]||[]).map((r:any)=>{const community=communities.find(c=>c.offices.includes(r.officeCode));if(!community)throw new ServiceUnavailableException('MIS返回范围无法确认，未显示数据');const {amount,...safe}=r,amountCents=misMoneyToCents(amount);return{...safe,id:String(r.id),amountCents,status:misFeeStatus({...r,amountCents}),communityId:community.id,communityName:community.name}});
  return{...meta,rows};
 }
 async metadata(user:AuthUser,access?:ResolvedAccess){
  const key=this.cacheKey('options',{},user,access),hit=this.cacheGet(key);
  if(hit!==undefined)return hit;
  const value=await this.metadataUncached(user,access);
  this.cacheSet(key,value,60_000);
  return value;
 }
 private async metadataUncached(user:AuthUser,access?:ResolvedAccess){
  const communities=await this.scope(user,access);
  const smsReadiness=this.smsSettings?await this.smsSettings.readiness(user.tenantId!):{configured:false,enabled:false,canSend:false,reason:'短信配置状态尚未取得，请刷新或联系管理员'};
  if(!this.configured()||!communities.length)return {available:false,readOnly:true,communities,feeItems:[],message:!this.configured()?'一通MIS查询连接尚未配置':'当前公司或管理处没有已映射的物业费数据'};
  const result=await this.read('SELECT DH AS code,XM AS name FROM dbo.SETUPSFXM ORDER BY DH');
  return {available:true,readOnly:true,communities,smsReadiness,feeItems:result.recordset,sourceLabel:'一通MIS',message:'查询MIS账单明细，不登记收款，不合并公寓收费流水'};
 }
 async searchHouses(communityId:number,q:string|undefined,user:AuthUser,access?:ResolvedAccess){
  const allowed=await this.scope(user,access);
  if(!allowed.some(c=>c.id===communityId))throw new ForbiddenException('该小区不在MIS查询授权范围');
  const qb=this.houses.createQueryBuilder('h').innerJoin(Building,'b','b.id=h.building_id AND b.tenant_id=h.tenant_id')
   .leftJoin(User,'u',"u.house_id=h.id AND u.tenant_id=h.tenant_id AND u.role='owner' AND u.status='active'")
   .where('h.tenant_id=:tenantId AND b.community_id=:communityId',{tenantId:user.tenantId,communityId})
   .select(['h.id AS id','h.room_no AS "roomNo"','COALESCE(h.road_name,b.road_name) AS road','b.lane AS lane','b.building_no AS "buildingNo"','MAX(u.name) AS "ownerName"'])
   // 楼号/房号是 varchar，直接 ASC 会排成 1号 → 10号 → 2号；
   // 这里按数字前缀排，GROUP BY 里同样补上表达式（PostgreSQL 要求 ORDER BY 表达式出现在 GROUP BY 中）。
   .groupBy('h.id,b.road_name,b.lane,b.building_no')
   .addGroupBy(naturalNumberSql('b.lane')).addGroupBy(naturalNumberSql('b.building_no')).addGroupBy(naturalNumberSql('h.room_no'))
   .addOrderBy(naturalNumberSql('b.lane'),'ASC','NULLS LAST').addOrderBy('b.lane','ASC','NULLS LAST')
   .addOrderBy(naturalNumberSql('b.building_no'),'ASC','NULLS LAST').addOrderBy('b.building_no','ASC','NULLS LAST')
   .addOrderBy(naturalNumberSql('h.room_no'),'ASC','NULLS LAST').addOrderBy('h.room_no','ASC','NULLS LAST')
   .limit(50);
  if(q?.trim()){
   const term='%'+q.trim().replace(/[\\%_]/g,c=>'\\'+c)+'%';
   qb.andWhere("(CONCAT(COALESCE(h.road_name,b.road_name),CASE WHEN b.lane IS NOT NULL AND b.lane<>'' THEN b.lane||'弄' ELSE '' END,b.building_no,'号',h.room_no) ILIKE :term OR u.name ILIKE :term OR u.phone ILIKE :term OR u.contact_note ILIKE :term)",{term});
  }
  return {rows:(await qb.getRawMany<any>()).map(h=>({...h,id:Number(h.id),label:`${h.road||''}${h.lane?h.lane+'弄':''}${h.buildingNo}号${h.roomNo}${h.roomNo==='商铺'?'':'室'}${h.ownerName?' · '+h.ownerName:''}`})),limit:50};
 }
 async list(query:MisFeeQuery,user:AuthUser,access?:ResolvedAccess){
  let communities=await this.scope(user,access);
  if(query.communityId){if(!communities.some(c=>c.id===query.communityId))throw new ForbiddenException('该小区不在MIS查询授权范围');communities=communities.filter(c=>c.id===query.communityId);}
  if(!communities.length)throw new ForbiddenException('当前范围没有可查询的一通MIS物业数据');
  let houseFilter:MisHouseFilter|undefined;
  if(query.houseId){
   const h=await this.houses.createQueryBuilder('h').innerJoin(Building,'b','b.id=h.building_id AND b.tenant_id=h.tenant_id').where('h.id=:id AND h.tenant_id=:tenantId',{id:query.houseId,tenantId:user.tenantId}).select(['h.room_no AS "roomNo"','h.road_name AS "road"','b.road_name AS "buildingRoad"','b.community_id AS "communityId"','b.lane AS lane','b.building_no AS "buildingNo"']).getRawOne<any>();
   if(!h||!communities.some(c=>c.id===Number(h.communityId)))throw new ForbiddenException('该房号不在查询范围');
   communities=communities.filter(c=>c.id===Number(h.communityId));
   houseFilter={road:h.road||h.buildingRoad,lane:h.lane||'',buildingNo:h.buildingNo,roomNo:h.roomNo,shop:h.roomNo==='商铺'};
   if(!houseFilter.road)throw new BadRequestException('房号缺少路名，无法安全匹配MIS地址');
  }
  const built=buildMisFeeQuery(query,communities.flatMap(c=>c.offices),houseFilter);
  const result=await this.read(built.sql,built.params),summary=result.recordsets[0]?.[0]||{};
  const rows=(result.recordsets[1]||[]).map((r:any)=>{const amountCents=misMoneyToCents(r.amount);return {...r,communityId:communities.find(c=>c.offices.includes(r.officeCode))!.id,communityName:communities.find(c=>c.offices.includes(r.officeCode))!.name,amount:undefined,amountCents,status:misFeeStatus({...r,amountCents})};});
  return {rows,total:Number(summary.total||0),page:built.page,pageSize:built.pageSize,readOnly:true,queriedAt:new Date().toISOString(),sourceLabel:'一通MIS',summary:{receivableCents:misMoneyToCents(summary.receivableAmount),unpaidCents:misMoneyToCents(summary.unpaidAmount),paidCents:misMoneyToCents(summary.paidAmount),refundedCount:Number(summary.refundedCount||0),latestUpdatedAt:summary.latestUpdatedAt||null}};
 }
 async residentialScope(q:MisResidentialQuery,user:AuthUser,access?:ResolvedAccess){
  let communities=await this.scope(user,access);
  if(q.houseId)throw new BadRequestException('住宅总览请使用范围与住户查询，不接受内部房号ID');
  if(q.communityId){if(!communities.some(c=>c.id===q.communityId))throw new ForbiddenException('该小区不在MIS查询授权范围');communities=communities.filter(c=>c.id===q.communityId);}
  if(!communities.length)throw new ForbiddenException('当前范围没有可查询的一通MIS物业数据');
  return communities;
 }
 /** 只读短信统计复用住宅授权范围：不查 MIS、不依赖 MIS 连接，空范围由调用方返回 0。 */
 async collectionCommunities(communityId:number|undefined,user:AuthUser,access?:ResolvedAccess){
  if(!user.tenantId)throw new ForbiddenException('请选择公司后查询');
  if(!access)throw new ForbiddenException('缺少数据范围授权');
  let communities=await this.scope(user,access);
  if(communityId!==undefined){if(!communities.some(c=>c.id===communityId))throw new ForbiddenException('该小区不在MIS查询授权范围');communities=communities.filter(c=>c.id===communityId);}
  return communities;
 }
 /**
  * 今日工作页 MIS 实收：只读 WYZJ 当日已缴/退款，口径与 recent-payments 一致（ZJ_SKRQ 当日、TKRQ 空、JE>0）。
  * byFee 按现有收费分类口径归并为物业费/泊位费/停车/其他四类。
  */
 async today(q:{date?:string},user:AuthUser,access?:ResolvedAccess){
  const date=q.date??new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const key=this.cacheKey('today',{date},user,access),hit=this.cacheGet(key);
  if(hit!==undefined)return hit;
  const value=await this.todayUncached({date},user,access);
  this.cacheSet(key,value);
  return value;
 }
 private async todayUncached(q:{date?:string},user:AuthUser,access?:ResolvedAccess){
  const date=q.date??new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(`${date}T00:00:00+08:00`))||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(`${date}T00:00:00+08:00`))!==date)throw new BadRequestException('日期不合法');
  const communities=await this.collectionCommunities(undefined,user,access);
  if(!communities.length)return {paidCents:0,paidCount:0,refundedCents:0,paidHouses:0,byFee:[],byChannel:[]};
  const offices=[...new Set(communities.flatMap(c=>c.offices))];
  const filter=buildMisFeeFilter({} as MisFeeQuery,offices);
  filter.params.date=date;
  const paidWhere=`w.ZJ_SKRQ>=CONVERT(datetime,@date,120) AND w.ZJ_SKRQ<DATEADD(day,1,CONVERT(datetime,@date,120)) AND w.ZJ_TKRQ IS NULL AND w.ZJ_JE>0`;
  const refundWhere=`w.ZJ_TKRQ>=CONVERT(datetime,@date,120) AND w.ZJ_TKRQ<DATEADD(day,1,CONVERT(datetime,@date,120)) AND w.ZJ_JE>=0`;
  const feeCategoryCode=misFeeCategorySql('f.XM',{nPrefix:true});
  const channelExpr=`COALESCE(NULLIF(LTRIM(RTRIM(w.收款方式)),N''),N'未记录')`;
  const sql=`SELECT COUNT(*) AS paidCount,COALESCE(SUM(w.ZJ_JE),0) AS paidAmount,COUNT(DISTINCT CONVERT(varchar(10),l.管理处)+':'+CONVERT(varchar(30),s.S_ID)) AS paidHouses ${filter.from} AND ${paidWhere};
   SELECT COUNT(*) AS refundCount,COALESCE(SUM(-w.ZJ_JE),0) AS refundAmount ${filter.from} AND ${refundWhere};
   SELECT ${feeCategoryCode} AS feeCode,COUNT(*) AS billCount,COUNT(DISTINCT CONVERT(varchar(10),l.管理处)+':'+CONVERT(varchar(30),s.S_ID)) AS houseCount,COALESCE(SUM(w.ZJ_JE),0) AS paidAmount ${filter.from} AND ${paidWhere} GROUP BY ${feeCategoryCode} ORDER BY paidAmount DESC,feeCode;
   SELECT ${channelExpr} AS channel,COUNT(*) AS billCount,COUNT(DISTINCT CONVERT(varchar(10),l.管理处)+':'+CONVERT(varchar(30),s.S_ID)) AS houseCount,COALESCE(SUM(w.ZJ_JE),0) AS paidAmount ${filter.from} AND ${paidWhere} GROUP BY ${channelExpr} ORDER BY paidAmount DESC,channel;`;
  const result=await this.read(sql,filter.params),sets=(result.recordsets||[]) as any[][],summary=sets[0]?.[0]||{},refund=sets[1]?.[0]||{};
  return {
   paidCents:misMoneyToCents(summary.paidAmount),
   paidCount:Number(summary.paidCount||0),
   refundedCents:misMoneyToCents(refund.refundAmount),
   paidHouses:Number(summary.paidHouses||0),
   byFee:(sets[2]||[]).map((r:any)=>{const feeCode=isMisFeeCategory(r.feeCode)?r.feeCode:misFeeCategoryOfText(r.feeName);return {feeCode,feeName:misFeeCategoryLabel(feeCode),paidCents:misMoneyToCents(r.paidAmount),billCount:Number(r.billCount||0),houseCount:Number(r.houseCount||0)}}),
   byChannel:(sets[3]||[]).map((r:any)=>({channel:String(r.channel||'未记录'),paidCents:misMoneyToCents(r.paidAmount),billCount:Number(r.billCount||0),houseCount:Number(r.houseCount||0)})),
  };
 }
 /**
  * 大屏「近期已缴」：MIS WYZJ 的 paid 记录按房号+收款日聚合（同户同日多笔账单合并为一次播报），
  * ZJ_SKRQ 在源库是 smalldatetime 但实际只存日期（全库时分秒均为 0），故 paidAt 返回日期，
  * 另给 recordedAt（updatedate，真实到分钟，仅作 MIS 记录更新时间，非收款时间）。
  */
 /** 今日分项收入明细：按房号+收款日聚合，和 recent-payments 同口径；category 过滤分类。 */
 async todayDetails(q: { date?: string; category?: string; page?: number; pageSize?: number }, user: AuthUser, access?: ResolvedAccess) {
  const date = q.date ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00+08:00`)) || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(`${date}T00:00:00+08:00`)) !== date) throw new BadRequestException('日期不合法');
  if (q.category !== undefined && !isMisFeeCategory(q.category)) throw new BadRequestException('分类不合法');
  const page = q.page ?? 1, pageSize = q.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1) throw new BadRequestException('page 须为正整数');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new BadRequestException('pageSize 须为1-50的整数');
  const communities = await this.collectionCommunities(undefined, user, access);
  if (!communities.length) return { total: 0, page, pageSize, rows: [] };
  const offices = [...new Set(communities.flatMap((c) => c.offices))];
  const filter = buildMisFeeFilter({ status: 'paid' } as MisFeeQuery, offices);
  filter.params.date = date;
  filter.params.firstRow = (page - 1) * pageSize + 1;
  filter.params.lastRow = page * pageSize;
  const paidDate = `CONVERT(varchar(10),w.ZJ_SKRQ,23)`;
  const houseAndDate = `l.管理处,${filter.address},z.姓名,${paidDate}`;
  const categoryExpr = misFeeCategorySql('f.XM', { nPrefix: true });
  const categoryFilter = q.category ? `AND (${categoryExpr})=@category` : '';
  if (q.category) filter.params.category = q.category;
  const scope = `${filter.from} AND w.ZJ_SKRQ>=CONVERT(datetime,@date,120) AND w.ZJ_SKRQ<DATEADD(day,1,CONVERT(datetime,@date,120)) AND w.ZJ_JE>0 ${categoryFilter}`;
  const sql = `SELECT COUNT(*) AS total FROM (SELECT COUNT(*) ${scope} GROUP BY ${houseAndDate}) g;
   WITH grouped AS (
     SELECT l.管理处 AS officeCode,${filter.address} AS address,z.姓名 AS ownerName,${paidDate} AS paidDate,
            CONVERT(varchar(50),SUM(w.ZJ_JE),2) AS amount,COUNT_BIG(*) AS billCount,
            COALESCE(NULLIF(LTRIM(RTRIM(MAX(w.收款方式))),N''),N'未记录') AS channel,
            CONVERT(varchar(19),MAX(w.updatedate),120) AS recordedAt,
            ROW_NUMBER() OVER(ORDER BY MAX(w.updatedate) DESC,MAX(w.ZJ_ID) DESC) AS rowNo
       ${scope} GROUP BY ${houseAndDate}
   ) SELECT * FROM grouped WHERE rowNo BETWEEN @firstRow AND @lastRow ORDER BY rowNo;`;
  const result = await this.read(sql, filter.params), sets = (result.recordsets || []) as any[][];
  return {
   total: Number(sets[0]?.[0]?.total || 0), page, pageSize,
   rows: (sets[1] || []).map((r: any) => ({
    recordedAt: r.recordedAt ? `${String(r.recordedAt).replace(' ', 'T')}+08:00` : null,
    paidDate: String(r.paidDate ?? ''), address: String(r.address ?? ''), ownerName: String(r.ownerName ?? ''),
    channel: String(r.channel || '未记录'), amountCents: misMoneyToCents(r.amount), billCount: Number(r.billCount || 0),
   })),
  };
 }
 async recentPayments(q:{date?:string;page?:number;pageSize?:number;communityId?:number},user:AuthUser,access?:ResolvedAccess){
  const date=q.date??new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const key=this.cacheKey('recent-payments',{...q,date},user,access),hit=this.cacheGet(key);
  if(hit!==undefined)return hit;
  const value=await this.recentPaymentsUncached({...q,date},user,access);
  this.cacheSet(key,value);
  return value;
 }
 private async recentPaymentsUncached(q:{date?:string;page?:number;pageSize?:number;communityId?:number},user:AuthUser,access?:ResolvedAccess){
  const page=q.page??1,pageSize=q.pageSize??10;
  if(!Number.isInteger(page)||page<1)throw new BadRequestException('page 须为正整数');
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>50)throw new BadRequestException('pageSize 须为1-50的整数');
  const date=q.date??new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(`${date}T00:00:00+08:00`))||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(`${date}T00:00:00+08:00`))!==date)throw new BadRequestException('日期不合法');
  const communities=await this.collectionCommunities(q.communityId,user,access);
  if(!communities.length)return {total:0,totalBills:0,totalHouses:0,page,pageSize,rows:[]};
  const offices=[...new Set(communities.flatMap(c=>c.offices))];
  const filter=buildMisFeeFilter({status:'paid'} as MisFeeQuery,offices);
  filter.params.date=date;filter.params.firstRow=(page-1)*pageSize+1;filter.params.lastRow=page*pageSize;
  const paidDate=`CONVERT(varchar(10),w.ZJ_SKRQ,23)`;
  const houseAndDate=`l.管理处,${filter.address},z.姓名,${paidDate}`;
  const scope=`${filter.from} AND w.ZJ_SKRQ>=CONVERT(datetime,@date,120) AND w.ZJ_SKRQ<DATEADD(day,1,CONVERT(datetime,@date,120)) AND w.ZJ_JE>0`;
  // MIS 只有日期精度：paidAt 是收款日；recordedAt 是 MIS 记录更新时间（分钟级），不是真实收款时刻。
  // 同日多行按登记时间倒序，再按 ZJ_ID 倒序；分页基于房号+收款日聚合后的行。
  const sql=`SELECT COUNT(*) AS total,COALESCE(SUM(g.billCount),0) AS totalBills FROM (SELECT COUNT(*) AS billCount ${scope} GROUP BY ${houseAndDate}) g;
   WITH grouped AS (
     SELECT l.管理处 AS officeCode,${filter.address} AS address,z.姓名 AS ownerName,${paidDate} AS paidDate,
            CONVERT(varchar(50),SUM(w.ZJ_JE),2) AS amount,COUNT_BIG(*) AS billCount,
            MAX(w.收款方式) AS channel,CONVERT(varchar(19),MAX(w.updatedate),120) AS recordedAt,
            ROW_NUMBER() OVER(ORDER BY MAX(w.updatedate) DESC,MAX(w.ZJ_ID) DESC) AS rowNo
       ${scope} GROUP BY ${houseAndDate}
   ) SELECT * FROM grouped WHERE rowNo BETWEEN @firstRow AND @lastRow ORDER BY rowNo;`;
  const result=await this.read(sql,filter.params),sets=(result.recordsets||[]) as any[][];
  const total=Number(sets[0]?.[0]?.total||0),totalBills=Number(sets[0]?.[0]?.totalBills||0);
  const rows=(sets[1]||[]).map((r:any)=>{
   const community=communities.find(c=>c.offices.includes(String(r.officeCode)));
   if(!community)throw new ServiceUnavailableException('MIS返回范围无法确认，未显示数据');
   const paidDateText=String(r.paidDate??'');
   return {
    paidAt:paidDateText,
    paidDate:paidDateText,
    paidAtPrecision:'date',
    address:String(r.address??''),
    ownerName:String(r.ownerName??''),
    amountCents:misMoneyToCents(r.amount),
    channel:r.channel?String(r.channel).trim()||null:null,
    billCount:Number(r.billCount)||0,
    recordedAt:r.recordedAt?`${String(r.recordedAt).replace(' ','T')}+08:00`:null,
    recordedAtPrecision:'minute',
    communityId:community.id,
    communityName:community.name,
   };
  });
  return {total,totalBills,totalHouses:total,page,pageSize,rows};
 }
 async residential(q:MisResidentialQuery,user:AuthUser,access?:ResolvedAccess){
  const cacheable=(q.view==='dashboard'||q.view==='households'||q.view==='amount-brackets')&&(q as any)._aging!==false&&!q.houseKeys?.length;
  const key=cacheable?this.cacheKey('residential',q,user,access):'';
  if(cacheable){const hit=this.cacheGet(key);if(hit!==undefined)return hit;}
  const value=await this.residentialCompute(q,user,access);
  if(cacheable)this.cacheSet(key,value);
  return value;
 }
 private async residentialCompute(q:MisResidentialQuery,user:AuthUser,access?:ResolvedAccess){
  const communities=await this.residentialScope(q,user,access),built=buildMisResidentialQuery(q,communities.flatMap(c=>c.offices));
  const result=await this.read(built.sql,built.params),sets=result.recordsets||[];
  const meta={sourceLabel:'一通MIS',readOnly:true,queriedAt:new Date().toISOString(),communities,smsAvailable:false,smsReason:'尚未接入审核通过的住宅缴费短信通道；仅可预览，不会发送'};
  const amounts=(r:any)=>({receivableCents:misMoneyToCents(r.receivableAmount),paidCents:misMoneyToCents(r.paidAmount),unpaidCents:misMoneyToCents(r.unpaidAmount)});
  if(q.view==='communities'){
   const rows:any[]=[];
   for(const c of communities){
    const one:any=await this.residential({...q,view:'dashboard',communityId:c.id} as any,user,access);
    const sum=one.summary||{};const receivable=Number(sum.receivableCents||0),paid=Number(sum.paidCents||0);
    rows.push({id:c.id,name:c.name,receivableCents:receivable,paidCents:paid,unpaidCents:Number(sum.unpaidCents||0),unpaidHouses:Number(sum.unpaidHouses||0),rate:receivable>0?Math.round((paid/receivable)*1000)/10:null});
   }
   rows.sort((a,b)=>b.unpaidCents-a.unpaidCents);
   return {...meta,rows};
  }
  if(q.view==='amount-brackets'){
  const byKey=new Map<string,any>((sets[0]||[]).map((r:any)=>[String(r.bucketKey),r]));
  const buckets=AMOUNT_BRACKETS.map((bucket)=>{const row=byKey.get(bucket.key);return {...bucket,count:Number(row?.houseCount||0),amountCents:misMoneyToCents(row?.amount)};});
  return {...meta,buckets,total:{count:buckets.reduce((n,b)=>n+b.count,0),amountCents:buckets.reduce((n,b)=>n+b.amountCents,0)}};
 }
 if(!q.view||q.view==='dashboard')return {...meta,summary:{...amounts(sets[0]?.[0]||{}),total:Number(sets[0]?.[0]?.total||0),unpaidHouses:Number(sets[0]?.[0]?.unpaidHouses||0),adjustmentCount:Number(sets[0]?.[0]?.adjustmentCount||0)},byFee:(sets[1]||[]).map((r:any)=>({...amounts(r),feeCode:r.feeCode,feeName:r.feeName||'未命名费项',category:r.category,unpaidHouses:Number(r.unpaidHouses||0)}))};
  if(q.view==='trend'){const bucket=q.bucket==='month'?'month':'day';return {...meta,bucket,invalidDateCount:Number(sets[1]?.[0]?.invalidDateCount||0),rows:(sets[0]||[]).map((r:any)=>bucket==='month'?{month:String(r.month),netCents:misMoneyToCents(r.netAmount),chargedCents:misMoneyToCents(r.chargedAmount),refundedCents:misMoneyToCents(r.refundedAmount)}:{day:String(r.day),netCents:misMoneyToCents(r.netAmount),chargedCents:misMoneyToCents(r.chargedAmount),refundedCents:misMoneyToCents(r.refundedAmount)})};}
  const canSeePhone=this.canEditFees(access);
  const format=(r:any)=>{const {phone,amount,...safe}=r;const p=String(phone||'').trim();return {...safe,amountCents:misMoneyToCents(amount),billCount:r.billCount===undefined?undefined:Number(r.billCount),phone:canSeePhone&&/^1[3-9]\d{9}$/.test(p)?p:undefined,phoneMasked:/^1[3-9]\d{9}$/.test(p)?`${p.slice(0,3)}****${p.slice(-4)}`:p?'号码待核实':'未留手机号',contactEligible:/^1[3-9]\d{9}$/.test(p),communityId:communities.find(c=>c.offices.includes(r.officeCode))?.id};};
  if(q.view==='detail'){if((sets[0]||[]).length>10000)throw new BadRequestException('账单明细超过一万条，请缩小账期或分批');return {...meta,rows:(sets[0]||[]).map(format)};}
  const totalHouses=Number(sets[0]?.[0]?.total||0),totalAmount=misMoneyToCents(sets[0]?.[0]?.amount);
  let aging:any=undefined;
  // aging 只对住户清单有用；dashboard 不再做 2 万户全量扫描。同一筛选（与页码无关）30 秒内复用扫描结果。
  if(q.view==='households'&&(q as any)._aging!==false&&!q.houseKeys?.length){
   const agingQuery={...q} as any;delete agingQuery.page;delete agingQuery.pageSize;delete agingQuery._aging;
   const agingKey=this.cacheKey('aging',agingQuery,user,access),cachedAging=this.cacheGet(agingKey);
   if(cachedAging!==undefined)aging=cachedAging;
   else{
   const scanCap=20000;const scan:any=await this.residential({...q,view:'households',page:1,pageSize:Math.min(Math.max(totalHouses,1),scanCap),_aging:false} as any,user,access);
   const buckets:Record<string,{count:number;amountCents:number}>={'0-30':{count:0,amountCents:0},'31-60':{count:0,amountCents:0},'61-90':{count:0,amountCents:0},'90+':{count:0,amountCents:0}};
   const now=new Date(),monthsNow=now.getFullYear()*12+now.getMonth();
   const owners=new Map<string,{count:number;amountCents:number}>();
   for(const r of scan.rows as any[]){
    const amount=Number(r.amountCents)||0;
    const name=String(r.ownerName||'').trim()||'责任人未记录';
    const o=owners.get(name)||{count:0,amountCents:0};o.count+=1;o.amountCents+=amount;owners.set(name,o);
    const m=/^(\d{4})(0[1-9]|1[0-2])$/.exec(String(r.periodFrom||''));
    if(!m)continue;
    const months=Number(m[1])*12+(Number(m[2])-1),gap=Math.max(0,monthsNow-months);
    const key=gap>3?'90+':gap>2?'61-90':gap>1?'31-60':'0-30';
    buckets[key].count+=1;buckets[key].amountCents+=amount;
   }
   const ownerHouseCounts=new Map<string,number>();
   for(const r of scan.rows as any[]){const n=String(r.ownerName||'').trim();if(!n)continue;ownerHouseCounts.set(n,(ownerHouseCounts.get(n)||0)+1)}
   const topHouses=(scan.rows as any[]).slice().sort((a,b)=>(Number(b.amountCents)||0)-(Number(a.amountCents)||0)||String(a.houseKey).localeCompare(String(b.houseKey))).slice(0,10).map(r=>({houseKey:String(r.houseKey),address:String(r.address||''),ownerName:String(r.ownerName||''),amountCents:Number(r.amountCents)||0,phone:canSeePhone?((r as any).phone??null):null,phoneMasked:String((r as any).phoneMasked||''),ownerHouseCount:ownerHouseCounts.get(String(r.ownerName||'').trim())||1,ownerFirst:false}));
   {const seen=new Set<string>();for(const h of topHouses){const k=h.ownerName.trim();if(seen.has(k))h.ownerFirst=false;else{seen.add(k);h.ownerFirst=true}}}
   const topOwners=[...owners.entries()].map(([name,v])=>({name,...v})).sort((a,b)=>b.amountCents-a.amountCents).slice(0,10);
   aging={buckets,topHouses,owners:topOwners,ownerCount:owners.size,total:totalHouses,amountCents:totalAmount,truncated:scan.rows.length<Number(scan.total||0),scanned:scan.rows.length,scanCap};
   this.cacheSet(agingKey,aging);
   }
  }
  const formatted=(sets[1]||[]).map(format);
  // 内部 aging/导出扫描只要金额与房号，不需要逐户通知状态；避免 2 万户再打一轮打印/短信查询。
  const rows=(q as any)._aging===false?formatted:await this.withNotificationStatus(formatted,user,q);
  return {...meta,total:totalHouses,amountCents:totalAmount,page:q.page||1,pageSize:q.pageSize||20,aging,rows};
 }
 /**
  * 对账 CSV 导出：复用 households 的筛选参数（communityId/category/feeCode/periodFrom/periodTo/q），
  * 内部按 5000 户一页循环取全量，超过 2 万户直接 400 提示缩小范围；口径固定为待缴责任对象。
  * 首屏 total 未超限、但导出期间户数增长超过上限时，流内停止写入并在末尾追加「已截断」警告，不静默截断。
  * 返回流（UTF-8 BOM + RFC4180 转义），由 controller 以附件下载；不写库、不改 MIS。
  */
 async exportResidentialCsv(q:MisResidentialQuery,user:AuthUser,access?:ResolvedAccess){
  if(q.houseKeys?.length)throw new BadRequestException('对账导出按筛选范围全量导出，不接受逐个住户选择');
  if(q.status==='paid')throw new BadRequestException('对账导出口径为待缴住户，请切回待缴视图后导出');
  const first:any=await this.residential({...q,view:'households',status:'unpaid',page:1,pageSize:EXPORT_PAGE_SIZE,_aging:false} as any,user,access);
  const total=Number(first.total)||0;
  if(total>EXPORT_ROW_CAP)throw new BadRequestException(`对账导出最多 ${EXPORT_ROW_CAP} 户，当前筛选共 ${total} 户，请按小区、账期或关键词缩小范围后重试；未导出任何数据`);
  const filename=exportFileName(new Date());
  const disposition=`attachment; filename="unpaid-reconciliation.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  const stream=Readable.from(this.exportCsvChunks({...q,view:'households',status:'unpaid'} as MisResidentialQuery,user,access,first,total));
  return {stream,filename,disposition,rowCount:total};
 }
 /** 逐页取数、逐行输出；不在内存里拼完整 CSV。导出期间户数增长超过上限时停止写入并在末尾追加截断警告，不静默截断。 */
 private async *exportCsvChunks(q:MisResidentialQuery,user:AuthUser,access:ResolvedAccess|undefined,first:any,total:number){
  yield '\uFEFF'+EXPORT_CSV_HEADER+'\r\n';
  let written=0;
  for(let page=1;written<total;page++){
   const data:any=page===1?first:await this.residential({...q,page,pageSize:EXPORT_PAGE_SIZE,_aging:false} as any,user,access);
   const rows:any[]=data.rows||[];
   if(!rows.length)break;
   const communities:any[]=data.communities||first.communities||[];
   const statuses=await this.notificationStatusChunked(rows.map((row:any)=>String(row.houseKey??'')),user);
   for(const row of rows){
    // HTTP 200 与响应头在前面的分页取数时就已发出，这里再抛错会让客户端只拿到不完整 CSV；改为停止写入并显式告知已截断。
    if(written>=EXPORT_ROW_CAP){
     logger.warn(`对账CSV导出超过上限已截断 tenantId=${user.tenantId} cap=${EXPORT_ROW_CAP} initialTotal=${total} written=${written}`);
     yield csvText(`导出已截断：待缴户数超过上限 ${EXPORT_ROW_CAP} 户，本次只导出前 ${EXPORT_ROW_CAP} 户，请缩小范围后重新导出`)+'\r\n';
     return;
    }
    written++;
    yield exportCsvLine(row,communities,statuses.get(String(row.houseKey??'')))+'\r\n';
   }
   if(rows.length<EXPORT_PAGE_SIZE)break;
  }
 }
 /** 通知状态按 1000 户一批查询，避免单条 SQL 参数数组过大；失败已在 notificationStatus 内降级并留痕。 */
 private async notificationStatusChunked(houseKeys:string[],user:AuthUser){
  const out=new Map<string,{printedAt:string|null;printedPaper:'A5'|'A4'|null;smsAt:string|null;smsStatus:'submitted'|'delivered'|null}>();
  for(let i=0;i<houseKeys.length;i+=EXPORT_STATUS_CHUNK){
   const part=await this.notificationStatus(houseKeys.slice(i,i+EXPORT_STATUS_CHUNK),user);
   for(const [key,value] of part)out.set(key,value);
  }
  return out;
 }
 /**
  * 清单「通知状态」：一次性按 houseKey IN 批量取最近一次打印/短信，查询次数与户数无关，禁止 N+1。
  * 打印登记表没有 house_key，只能经批次快照 snapshot.notices[].houseKey 关联；短信表直接按 house_key 过滤。
  * 「已打印」= 有打印登记且批次快照含该户；「已发送」= 短信 status 为 submitted/delivered；queued（演练）与 failed 不算通知。
  * 重复催收抑制：同一条 UNION ALL 顺带统计近 30 天打印登记数与短信数（库里聚合，不额外查询），
  * 两项直接相加（同一批既有打印又有短信算 2 次），合计 >= 2 视为低响应；阈值/窗口为常量，后续配置化。
  */
 private async notificationStatus(houseKeys:string[],user:AuthUser){
  type Row={printedAt:string|null;printedPaper:'A5'|'A4'|null;smsAt:string|null;smsStatus:'submitted'|'delivered'|null;printCount30d:number;smsCount30d:number;count30d:number;suppressed:boolean};
  const out=new Map<string,Row>();
  const keys=[...new Set(houseKeys.map(key=>String(key||'')).filter(Boolean))];
  if(!keys.length||!user.tenantId||!this.batches?.manager)return out;
  const cutoff=new Date(Date.now()-NOTIFY_COUNT_WINDOW_DAYS*86400000);
  // 一条 UNION ALL 覆盖打印与短信两张表；两路都只返回当前页 houseKey 的聚合结果，30 天计数在数据库里算。
  const sql=`SELECT 'print' AS kind,n->>'houseKey' AS house_key,MAX(p.printed_at) AS notified_at,(array_agg(p.paper ORDER BY p.printed_at DESC,p.id DESC))[1] AS printed_paper,NULL::text AS sms_status,COUNT(*) FILTER (WHERE p.printed_at>=$3::timestamptz)::int AS print_count_30d,0::int AS sms_count_30d FROM mis_collection_prints p JOIN mis_collection_batches b ON b.id=p.batch_id AND b.tenant_id=p.tenant_id CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.snapshot->'notices','[]'::jsonb)) n WHERE p.tenant_id=$1 AND n->>'houseKey'=ANY($2::text[]) GROUP BY n->>'houseKey' UNION ALL SELECT 'sms' AS kind,house_key,MAX(COALESCE(delivered_at,submitted_at,created_at)) AS notified_at,NULL::text AS printed_paper,(array_agg(status ORDER BY COALESCE(delivered_at,submitted_at,created_at) DESC,id DESC))[1] AS sms_status,0::int AS print_count_30d,COUNT(*) FILTER (WHERE COALESCE(delivered_at,submitted_at,created_at)>=$3::timestamptz)::int AS sms_count_30d FROM mis_collection_sms WHERE tenant_id=$1 AND house_key=ANY($2::text[]) AND status IN ('submitted','delivered') GROUP BY house_key`;
  try{
   const found:any[]=await this.batches.manager.query(sql,[user.tenantId,keys,cutoff]);
   const iso=(value:unknown)=>{if(!value)return null;const date=value instanceof Date?value:new Date(String(value));return Number.isFinite(date.getTime())?date.toISOString():null};
   for(const row of found||[]){
    const key=String(row.house_key||'');if(!key)continue;
    const current=out.get(key)||{printedAt:null,printedPaper:null,smsAt:null,smsStatus:null,printCount30d:0,smsCount30d:0,count30d:0,suppressed:false};
    if(row.kind==='print'){current.printedAt=iso(row.notified_at);current.printedPaper=row.printed_paper==='A4'?'A4':row.printed_paper==='A5'?'A5':null;current.printCount30d=Number(row.print_count_30d)||0}
    else{current.smsAt=iso(row.notified_at);current.smsStatus=row.sms_status==='delivered'?'delivered':row.sms_status==='submitted'?'submitted':null;current.smsCount30d=Number(row.sms_count_30d)||0}
    out.set(key,current);
   }
   for(const value of out.values()){value.count30d=value.printCount30d+value.smsCount30d;value.suppressed=value.count30d>=NOTIFY_SUPPRESS_MIN}
  }catch(error){
   // 通知状态是清单增强信息：查询失败降级为「未记录」不阻断账单清单，但必须留痕，
   // 不能把 SQL 失败静默伪装成「全部未通知」；日志带租户、户数与错误摘要，不含户号和内容。
   const summary=(error instanceof Error?`${error.name}: ${error.message}`:String(error)).slice(0,200);
   logger.warn(`通知状态查询失败，清单降级为未通知 tenantId=${user.tenantId} houseKeys=${keys.length} error=${summary}`);
  }
  return out;
 }
 /** 只对真实清单分页附加通知状态；内部 _aging:false 大扫描与超过50行的内部调用不查，避免额外开销。 */
 private async withNotificationStatus(rows:any[],user:AuthUser,q:MisResidentialQuery){
  const empty=()=>rows.map(row=>({...row,notifiedPrintedAt:null,notifiedPrintedPaper:null,notifiedSmsAt:null,notifiedSmsStatus:null,notifiedPrintCount30d:0,notifiedSmsCount30d:0,notifiedCount30d:0,notifySuppressed:false}));
  if(!rows.length||(q as any)._aging===false||(q.pageSize??20)>50)return empty();
  const status=await this.notificationStatus(rows.map(row=>String(row.houseKey??'')),user);
  return rows.map(row=>{const one=status.get(String(row.houseKey??''));return {...row,notifiedPrintedAt:one?.printedAt??null,notifiedPrintedPaper:one?.printedPaper??null,notifiedSmsAt:one?.smsAt??null,notifiedSmsStatus:one?.smsStatus??null,notifiedPrintCount30d:one?.printCount30d??0,notifiedSmsCount30d:one?.smsCount30d??0,notifiedCount30d:one?.count30d??0,notifySuppressed:one?.suppressed??false}});
 }
  /** 仅供应短信发送：按责任对象取明文号码，经后端直接给通道，不经前端。 */
  async contactPhones(houseKeys:string[],user:AuthUser,access?:ResolvedAccess){
   if(!houseKeys.length)return new Map<string,string>();
   if(houseKeys.length>200)throw new BadRequestException('每批最多200户，请分批发送');
   const communities=await this.residentialScope({} as MisResidentialQuery,user,access);
   const built=buildMisResidentialQuery({view:'detail',status:'unpaid',houseKeys} as MisResidentialQuery,communities.flatMap(c=>c.offices));
   const result=await this.read(built.sql,built.params),sets=(result.recordsets||[]) as any[][];
   const map=new Map<string,string>();
   for(const r of (sets[0]||[])){const p=String(r.phone||'').trim();if(/^1[3-9]\d{9}$/.test(p))map.set(String(r.houseKey),p);}
   return map;
  }
 async previewCollection(dto:MisCollectionPreviewDto,user:AuthUser,access?:ResolvedAccess){
  if(!dto.filter||!['keys','all'].includes(dto.selection)||!['print','sms'].includes(dto.purpose))throw new BadRequestException('请确认催缴范围与渠道');
  const filter:MisResidentialQuery={...dto.filter,houseKeys:undefined,view:'households',status:'unpaid',page:1,pageSize:201};
  const communities=await this.residentialScope(filter,user,access);
  let keys=dto.houseKeys||[];
  if(dto.selection==='all'){
   const all:any=await this.residential(filter,user,access);
   if(all.total>200)throw new BadRequestException('筛选结果超过200户，请按小区、楼栋或关键词分批；未截取前200户');
   keys=all.rows.map((r:any)=>r.houseKey);
  }
  if(!keys.length)throw new BadRequestException('没有可生成通知的住户');
  const detail:any=await this.residential({...filter,view:'detail',houseKeys:keys},user,access);
  const holds=await this.activeCollectionHolds(keys,user,access),held=new Set(holds.map(h=>h.houseKey));
  const groups=new Map<string,any>();
  for(const r of detail.rows){
   if(held.has(r.houseKey))continue;
   let n=groups.get(r.houseKey);
   if(!n){n={houseKey:r.houseKey,address:r.address,ownerName:r.ownerName,communityId:r.communityId,communityName:communities.find(c=>c.id===r.communityId)?.name||'',phoneMasked:r.phoneMasked,contactEligible:r.contactEligible,amountCents:0,bills:[]};groups.set(r.houseKey,n);}
   n.amountCents+=r.amountCents;if(!Number.isSafeInteger(n.amountCents))throw new BadRequestException('通知金额超出安全范围');
   n.bills.push({id:r.id,feeCode:r.feeCode,feeName:r.feeName||'未命名费用',period:r.period,amountCents:r.amountCents,updatedAt:r.updatedAt||null});
  }
  const notices=[...groups.values()].sort((a,b)=>a.address.localeCompare(b.address,'zh-CN',{numeric:true})||a.houseKey.localeCompare(b.houseKey));
  for(const n of notices)n.bills.sort((a:any,b:any)=>String(a.period).localeCompare(String(b.period))||String(a.id).localeCompare(String(b.id),'en',{numeric:true}));
  if(!notices.length&&!holds.length)throw new ConflictException('所选账单已无待缴余额，请重新查询');
  const totalCents=notices.reduce((s,n)=>s+n.amountCents,0);if(!Number.isSafeInteger(totalCents))throw new BadRequestException('合计金额超出安全范围');
  const canonical=JSON.stringify({purpose:dto.purpose,notices});
  const fingerprint=createHash('sha256').update(canonical).digest('hex');
  return {notices,totalCents,billCount:notices.reduce((s,n)=>s+n.bills.length,0),fingerprint,queriedAt:detail.queriedAt,sourceLabel:'一通MIS',excludedHolds:holds.map(h=>({houseKey:h.houseKey,reason:h.reason,until:h.until})),smsAvailable:false,smsReason:this.smsSettings?(await this.smsSettings.readiness(user.tenantId!)).reason:detail.smsReason,skipped:keys.filter(k=>!groups.has(k)&&!held.has(k)),contactEligibleCount:notices.filter(n=>n.contactEligible).length,contactWarning:'号码来自MIS责任人档案，尚未核实接收意愿与关系；同一号码多户不得直接合并发送。到期日未提供，未判定逾期。'};
 }
 private visibleBatch(batch:MisCollectionBatch|undefined|null,communities:{id:number}[]){
  if(!batch||!batch.communityIds.length||!batch.communityIds.every(id=>communities.some(c=>c.id===id)))throw new NotFoundException('催缴批次不存在或不在当前数据范围');
  return batch;
 }
 async createCollection(dto:MisCollectionPreviewDto,user:AuthUser,access?:ResolvedAccess){
  const allowed=await this.residentialScope(dto.filter||{},user,access);
  if(!dto.confirmed||!dto.idempotencyKey||!/^[a-f0-9]{64}$/.test(dto.fingerprint||''))throw new BadRequestException('请先核对通知预览并明确确认');
  if(!/^[a-f0-9-]{36}$/i.test(dto.idempotencyKey))throw new BadRequestException('批次请求标识不合法');
  const previous=await this.batches!.findOne({where:{tenantId:user.tenantId!,idempotencyKey:dto.idempotencyKey}});
  if(previous){this.visibleBatch(previous,allowed);if(previous.createdBy!==user.id||previous.fingerprint!==dto.fingerprint||previous.purpose!==dto.purpose)throw new ConflictException('请求标识已用于其他批次，请重新预览');return previous;}
  const preview=await this.previewCollection(dto,user,access);
  if(!preview.notices.length)throw new ConflictException('所选住户均已冻结或无待缴余额，未创建批次');
  if(preview.fingerprint!==dto.fingerprint)throw new ConflictException('MIS余额、账单或联系人发生变化，请重新预览后确认；尚未生成通知');
  const tplRow=await this.collectionRepo(TenantConfig).findOne({where:{tenantId:user.tenantId!,key:'residential_notice_template'}});
  const noticeTemplate=(tplRow?.value as any)??null;
  const row=this.batches!.create({tenantId:user.tenantId!,idempotencyKey:dto.idempotencyKey,communityIds:[...new Set(preview.notices.map(n=>Number(n.communityId)))],purpose:dto.purpose,status:dto.purpose==='print'?'generated':'preview_only',fingerprint:preview.fingerprint,houseCount:preview.notices.length,amountCents:String(preview.totalCents),snapshot:{...preview,noticeTemplate},createdBy:user.id,updatedBy:user.id});
  try{return await this.batches!.save(row);}catch(e){
   if((e as any)?.code!=='23505')throw e;
   const concurrent=this.visibleBatch(await this.batches!.findOne({where:{tenantId:user.tenantId!,idempotencyKey:dto.idempotencyKey}}),allowed);
   if(concurrent.createdBy!==user.id||concurrent.fingerprint!==dto.fingerprint||concurrent.purpose!==dto.purpose)throw new ConflictException('批次请求冲突，请重新预览');return concurrent;
  }
 }
 async collectionHistory(q:MisResidentialQuery,user:AuthUser,access?:ResolvedAccess){
  const allowed=await this.residentialScope(q,user,access),page=q.page||1,pageSize=Math.min(q.pageSize||20,50);
  const [rows,total]=await this.batches!.createQueryBuilder('b').where('b.tenant_id=:tenant',{tenant:user.tenantId}).andWhere('b.community_ids <@ ARRAY[:...ids]::integer[]',{ids:allowed.map(c=>c.id)}).select(['b.id','b.createdAt','b.createdBy','b.purpose','b.status','b.houseCount','b.amountCents','b.communityIds']).orderBy('b.id','DESC').skip((page-1)*pageSize).take(pageSize).getManyAndCount();
  return {rows,total,page,pageSize};
 }
 async collectionDetail(id:number,user:AuthUser,access?:ResolvedAccess){
  const allowed=await this.residentialScope({},user,access);
  if(!Number.isSafeInteger(id)||id<1)throw new BadRequestException('批次编号不合法');
  const batch=this.visibleBatch(await this.batches!.findOne({where:{id,tenantId:user.tenantId!}}),allowed);
  const prints=await this.collectionRepo(MisCollectionPrint).find({where:{tenantId:user.tenantId!,batchId:id},order:{id:'DESC'}});
  const keys=((batch.snapshot as any).notices||[]).map((n:any)=>n.houseKey);
  const timeline=keys.length?await this.collectionRepo(MisCollectionEvent).find({where:{tenantId:user.tenantId!,houseKey:In(keys)},order:{id:'DESC'},take:201}):[];
  return {...batch,prints,timeline:timeline.slice(0,200),timelineHasMore:timeline.length>200,timelineScope:'批次内责任对象的跟进记录（跨批次）'};
 }
 /** Additive read-only preflight for collection; existing bill queries and their filters stay unchanged. */
 async postingContext(houseId:number,billIds:string[],user:AuthUser,access?:ResolvedAccess):Promise<import('./mis-posting.service').MisPostingContext>{
  const communities=await this.scope(user,access);if(!communities.length)throw new ForbiddenException('当前范围没有MIS收款授权');
  if(!Number.isSafeInteger(houseId)||houseId<1||!Array.isArray(billIds)||!billIds.length||billIds.length>120||new Set(billIds).size!==billIds.length||billIds.some(id=>typeof id!=='string'||!/^[1-9]\d{0,17}$/.test(id)))throw new BadRequestException('MIS房号或账单标识非法');
  const h=await this.houses.createQueryBuilder('h').innerJoin(Building,'b','b.id=h.building_id AND b.tenant_id=h.tenant_id').where('h.id=:id AND h.tenant_id=:tenantId AND h.archived_at IS NULL',{id:houseId,tenantId:user.tenantId}).select(['h.room_no AS "roomNo"','h.road_name AS road','b.road_name AS "buildingRoad"','b.community_id AS "communityId"','b.lane AS lane','b.building_no AS "buildingNo"']).getRawOne<any>();
  const community=communities.find(c=>c.id===Number(h?.communityId));if(!h||!community)throw new ForbiddenException('该住户不在MIS收款授权范围');
  const house:MisHouseFilter={road:h.road||h.buildingRoad,lane:h.lane||'',buildingNo:h.buildingNo,roomNo:h.roomNo,shop:h.roomNo==='商铺'};if(!house.road)throw new BadRequestException('房号缺少路名，无法安全匹配MIS住户');
  const built=buildMisFeeFilter({status:'unpaid'},community.offices,house);
  const ids=billIds.map((id,i)=>{built.params['postingBill'+i]=id;return '@postingBill'+i}).join(',');
  const result=await this.read(`SELECT CONVERT(varchar(30),w.ZJ_ID) AS id,CONVERT(varchar(30),w.ZH_ID) AS ownerId,l.管理处 AS officeCode,w.ZJ_LX AS feeCode,w.ZJ_CNY AS period,CONVERT(varchar(50),w.ZJ_JE,2) AS amount ${built.from} AND w.ZJ_ID IN (${ids}) AND s.房屋性质 IN (N'01',N'04') AND w.ZL_ID IS NULL ORDER BY w.ZJ_ID`,built.params);
  const rows=result.recordset||[];if(rows.length!==billIds.length||new Set(rows.map((r:any)=>r.id)).size!==billIds.length||new Set(rows.map((r:any)=>r.ownerId)).size!==1)throw new ConflictException('账单已收、已变更或不属于同一MIS住户，请重新核对，未登记收款');
  const bills=rows.map((r:any)=>{if(!/^\d+\.\d{2}00$/.test(r.amount))throw new BadRequestException('源库金额不是可收整分金额，请先在MIS核实');return{id:String(r.id),feeCode:r.feeCode,period:r.period,amountCents:misMoneyToCents(r.amount)}});
  return {houseId,communityId:community.id,address:`${community.name}/${house.lane?house.lane+'弄':''}${house.buildingNo}号${house.roomNo}`,ownerId:String(rows[0].ownerId),officeCodes:community.offices,bills};
 }
 async registerCollectionPrint(id:number,dto:{paper:'A5'|'A4';pageCount:number;requestKey:string;rowsPerPage?:8|12},user:AuthUser,access?:ResolvedAccess){
  const batch=await this.collectionDetail(id,user,access);if(batch.purpose!=='print')throw new BadRequestException('仅纸质通知批次可登记打印');
  if(!['A5','A4'].includes(dto.paper)||!/^[a-f0-9-]{36}$/i.test(dto.requestKey||''))throw new BadRequestException('打印纸张或请求标识不合法');
  if(dto.rowsPerPage!==undefined&&![8,12].includes(dto.rowsPerPage))throw new BadRequestException('打印版式不合法');const rowsPerPage=dto.rowsPerPage??8;const notices=(batch.snapshot as any).notices||[];const noticePageCount=notices.reduce((sum:number,n:any)=>sum+Math.max(1,Math.ceil(n.bills.length/rowsPerPage)),0),pageCount=dto.paper==='A4'?Math.ceil(noticePageCount/2):noticePageCount;
  if(!pageCount||dto.pageCount!==pageCount)throw new ConflictException('打印页数与批次快照不一致，未登记打印');
  if((await this.activeCollectionHolds(notices.map((n:any)=>n.houseKey),user,access)).length)throw new ConflictException('该批次包含已冻结住户，请回清单重新预览，未登记打印');
  const repo=this.collectionRepo(MisCollectionPrint),old=await repo.findOne({where:{tenantId:user.tenantId!,requestKey:dto.requestKey}});
  const same=(v:MisCollectionPrint)=>{if(v.batchId!==id||v.operatorId!==user.id||v.paper!==dto.paper||v.pageCount!==pageCount||v.noticePageCount!==noticePageCount)throw new ConflictException('打印标识已用于另一打印请求');return v};if(old)return same(old);
  try{return await repo.save(repo.create({tenantId:user.tenantId!,batchId:id,operatorId:user.id,pageCount,noticePageCount,paper:dto.paper,printedAt:new Date(),requestKey:dto.requestKey,createdBy:user.id,updatedBy:user.id}));}catch(e){if((e as any)?.code!=='23505')throw e;const found=await repo.findOne({where:{tenantId:user.tenantId!,requestKey:dto.requestKey}});if(!found)throw e;return same(found)}
 }
  /** 只有能编辑收费的人才能看到完整手机号；其他人一律拿脱敏值。 */
  private canEditFees(access?: import('../access/access.service').ResolvedAccess){
   if(!access)return false;
   if(access.isPlatformAdmin||access.isTenantAdmin)return true;
   return !!access.pages?.['fees']?.edit;
  }
 private collectionRepo<T extends import('typeorm').ObjectLiteral>(entity:import('typeorm').EntityTarget<T>){
  if(!this.batches?.manager)throw new ServiceUnavailableException('催缴跟进存储尚未就绪');return this.batches.manager.getRepository(entity);
 }
 async activeCollectionHolds(keys:string[],user:AuthUser,access?:ResolvedAccess){
  if(!keys.length)return [];
  const allowed=await this.residentialScope({},user,access),today=effectDay(new Date());
  return (await this.collectionRepo(MisCollectionHold).find({where:{tenantId:user.tenantId!,houseKey:In(keys),communityId:In(allowed.map(c=>c.id)),status:'active'}})).filter(h=>h.until>=today);
 }
 async recordCollectionFollowup(dto:any,user:AuthUser,access?:ResolvedAccess){
  const allowed=await this.residentialScope({},user,access);
  if(!/^(0[1-4]):[1-9]\d{0,18}:[1-9]\d{0,18}$/.test(dto.houseKey||'')||!allowed.some(c=>c.offices.includes(dto.houseKey.split(':')[0])))throw new ForbiddenException('责任对象不在当前授权范围');
  if(!['phone','promise','hold','cancel_promise','cancel_hold'].includes(dto.action)||!/^[a-f0-9-]{36}$/i.test(dto.requestKey||''))throw new BadRequestException('跟进动作或请求标识不合法');
  const note=String(dto.note||'').trim();if(!note||note.length>500)throw new BadRequestException('请填写不超过500字的跟进说明');
  const today=effectDay(new Date());
  if(dto.action==='promise'){validateMisFeeRange({paidFrom:dto.promisedDate});if(!dto.promisedDate||dto.promisedDate<today||!Number.isSafeInteger(dto.promisedCents)||dto.promisedCents<=0)throw new BadRequestException('承诺日期不能早于今天，承诺金额须为明确正整数分');}
  if(dto.action==='hold'){validateMisFeeRange({paidFrom:dto.until});if(!['dispute','request','complaint'].includes(dto.reason)||!dto.until||dto.until<today)throw new BadRequestException('请填写有效冻结原因和不早于今天的截止日期');}
  const canonical={houseKey:dto.houseKey,action:dto.action,note,promisedDate:dto.promisedDate??null,promisedCents:dto.promisedCents??null,reason:dto.reason??null,until:dto.until??null,recordId:dto.recordId??null};
  const fingerprint=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const communityId=allowed.find(c=>c.offices.includes(dto.houseKey.split(':')[0]))!.id;
  return this.batches!.manager.transaction(async manager=>{
   await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`mis-collection:${user.tenantId}:${dto.requestKey}`]);
   const events=manager.getRepository(MisCollectionEvent),old=await events.findOne({where:{tenantId:user.tenantId!,requestKey:dto.requestKey}});
   if(old){if(old.fingerprint!==fingerprint||old.createdBy!==user.id)throw new ConflictException('请求标识已用于另一项跟进，请重新提交');return old;}
   let recordId:number|null=null;
   if(dto.action==='promise'){
    const raw:any=await this.residential({view:'detail',status:'unpaid',houseKeys:[dto.houseKey]},user,access);const total=raw.rows.reduce((s:number,b:any)=>s+b.amountCents,0);
    if(!Number.isSafeInteger(total)||dto.promisedCents>total)throw new BadRequestException('承诺金额不能超过当前MIS待缴余额');
    const promise=await manager.getRepository(MisCollectionPromise).save(manager.getRepository(MisCollectionPromise).create({tenantId:user.tenantId!,communityId,houseKey:dto.houseKey,promisedDate:dto.promisedDate,promisedCents:String(dto.promisedCents),status:'active',requestKey:dto.requestKey,snapshot:{bills:raw.rows.map((b:any)=>({id:String(b.id),amountCents:b.amountCents})),amountCents:total},createdBy:user.id,updatedBy:user.id}));recordId=promise.id;
   }else if(dto.action==='hold'){
    const hold=await manager.getRepository(MisCollectionHold).save(manager.getRepository(MisCollectionHold).create({tenantId:user.tenantId!,communityId,houseKey:dto.houseKey,reason:dto.reason,until:dto.until,status:'active',requestKey:dto.requestKey,createdBy:user.id,updatedBy:user.id}));recordId=hold.id;
   }else if(dto.action.startsWith('cancel_')){
    if(!Number.isSafeInteger(dto.recordId)||dto.recordId<=0)throw new BadRequestException('请选择要解除的原跟进记录');
    const repo=manager.getRepository(dto.action==='cancel_hold'?MisCollectionHold:MisCollectionPromise);const row:any=await repo.findOne({where:{id:dto.recordId,tenantId:user.tenantId!,houseKey:dto.houseKey,communityId}});
    if(!row)throw new NotFoundException('原跟进不存在或不在当前范围');row.status='cancelled';row.updatedBy=user.id;await repo.save(row);recordId=row.id;
   }
   return events.save(events.create({tenantId:user.tenantId!,communityId,houseKey:dto.houseKey,action:dto.action,note,recordId,requestKey:dto.requestKey,fingerprint,createdBy:user.id,updatedBy:user.id}));
  });
 }
 async collectionFollowups(q:{communityId?:number;q?:string;status?:'all'|'never'|'overdue'|'contacted';sort?:'amount'|'recent'|'address'|'count'|'days';dir?:'asc'|'desc';page?:number;pageSize?:number},user:AuthUser,access?:ResolvedAccess){
  const allowed=await this.residentialScope({communityId:q.communityId},user,access),ids=allowed.map(c=>c.id),today=effectDay(new Date());
  // 跟进待办队列：默认按待缴金额降序（价值优先）；另有最近跟进 / 房号自然序 / 人工跟进次数 / 距今天数。
  // dir 缺省按列选默认方向：房号升序，其余降序；从未跟进在 days 排序里永远排最前。
  const status=q.status??'all',sort=q.sort??'amount',dir=q.dir??(sort==='address'?'asc':'desc'),keyword=String(q.q??'').trim();
  if(!['all','never','overdue','contacted'].includes(status))throw new BadRequestException('跟进筛选不合法');
  if(!['amount','recent','address','count','days'].includes(sort))throw new BadRequestException('跟进排序不合法');
  if(!['asc','desc'].includes(dir))throw new BadRequestException('排序方向不合法');
  if(keyword.length>60)throw new BadRequestException('搜索关键词过长');
  if((q.page!==undefined&&(!Number.isSafeInteger(q.page)||q.page<1))||(q.pageSize!==undefined&&(!Number.isSafeInteger(q.pageSize)||q.pageSize<1||q.pageSize>100)))throw new BadRequestException('分页参数不合法');
  const page=q.page??1,pageSize=q.pageSize??20;
  const promises=await this.collectionRepo(MisCollectionPromise).find({where:{tenantId:user.tenantId!,communityId:In(ids),status:'active'},order:{id:'DESC'}});
  const keys=[...new Set(promises.map(p=>p.houseKey))],payments=keys.length?await this.paidCollectionBills(keys,user,access):[];
  const rows=promises.map(p=>{try{const progress=promiseProgress(p,payments);return {...p,...progress,overdue:!progress.fulfilled&&p.promisedDate<=today}}catch(e){throw new BadRequestException((e as Error).message)}});
  const where:any={tenantId:user.tenantId!,communityId:In(ids)};
  const holds=(await this.collectionRepo(MisCollectionHold).find({where:{...where,status:'active'},order:{id:'DESC'}})).filter(h=>h.until>=today);
  const events=await this.collectionRepo(MisCollectionEvent).find({where,order:{id:'DESC'},take:200});
  const overdueHouseholds=new Set(rows.filter(p=>p.overdue).map(p=>p.houseKey)).size;
  // 今日待跟进：大额且久未人工跟进的待缴户。全程只读，不写库、不改MIS账务；规则缺失时按设置模块默认值。
  let rule:{amountCents:number;inactiveDays:number;enabled:boolean}={...DEFAULT_FOLLOWUP_RULE};
  try{
   const stored=await this.collectionRepo(TenantConfig).findOne({where:{tenantId:user.tenantId!,key:'collection_followup_rule'}});
   const value=(stored?.value||{}) as Partial<typeof DEFAULT_FOLLOWUP_RULE>;
   rule={amountCents:Math.max(0,Math.round(Number(value.amountCents??DEFAULT_FOLLOWUP_RULE.amountCents)||0)),inactiveDays:Math.min(365,Math.max(1,Math.round(Number(value.inactiveDays??DEFAULT_FOLLOWUP_RULE.inactiveDays)||DEFAULT_FOLLOWUP_RULE.inactiveDays))),enabled:(value.enabled??DEFAULT_FOLLOWUP_RULE.enabled)!==false};
  }catch{
   // 规则存储不可读（未配置/跟催存储未就绪）时退回默认规则，不让整页跟进失败；不写任何数据。
   rule={...DEFAULT_FOLLOWUP_RULE};
  }
  // 队列基数 = 待缴金额达到门槛的全部责任对象；跟进状态只做筛选，不再把「已跟进且在规则天数内」直接剔出视野
  // （用户反馈：跟进完就找不到了）。stats 保持原口径（命中户数/金额），供头部「共 N 户 · 金额 ¥X」与空态建议使用。
  let queue:any[]=[],largeInactive:Array<{houseKey:string;address:string;amountCents:number;lastContactAt:string|null;days:number|null;never:boolean}>=[],total=0,totalAmountCents=0,overdueCount=0;
  let stats={avgAmountCents:0,hitCount:0,hitAmountCents:0,thresholdCents:rule.amountCents,inactiveDays:rule.inactiveDays,scanned:0,neverCount:0,overdueCount:0,contactedCount:0};
  if(rule.enabled){
   // _aging:false 表示这是内部分页：放宽 pageSize 上限到2万，并跳过 residential() 自带的账龄全量扫描。
   const scan:any=await this.residential({communityId:q.communityId,view:'households',status:'unpaid',page:1,pageSize:5000,_aging:false} as any,user,access);
   const scannedRows:any[]=scan.rows||[],scannedKeys=[...new Set(scannedRows.map(r=>String(r.houseKey)))];
   // 「上次人工跟进」只认事件表的人工动作（电话/承诺/冻结）；撤销类记录是更正操作，不算一次人工跟进。
   // 按 house_key 聚合成「最近 1 条 + 总次数」，不再把大租户的全部历史事件搬进内存；只取展示需要的 action/note。
   const manualEvents:any[]=scannedKeys.length?await this.collectionRepo(MisCollectionEvent).manager.query(
    `SELECT house_key,COUNT(*)::int AS contact_count,MAX(created_at) AS last_at,(array_agg(action ORDER BY created_at DESC,id DESC))[1] AS last_action,(array_agg(note ORDER BY created_at DESC,id DESC))[1] AS last_note FROM mis_collection_events WHERE tenant_id=$1 AND house_key=ANY($2::text[]) AND action=ANY($3::text[]) GROUP BY house_key`,
    [user.tenantId,scannedKeys,['phone','promise','hold']]
   ):[] as any[];
   let lastEvent=new Map<string,{at:Date;action:'phone'|'promise'|'hold';note:string}>(),contactCount=new Map<string,number>();
   for(const event of manualEvents){const houseKey=String(event.house_key);contactCount.set(houseKey,Number(event.contact_count)||0);lastEvent.set(houseKey,{at:new Date(event.last_at),action:event.last_action as 'phone'|'promise'|'hold',note:String(event.last_note||'')});}
   const todayStart=Date.parse(today+'T00:00:00Z'),dayMs=86400000;
   const daysSince=(last:Date)=>Math.max(0,Math.round((todayStart-Date.parse(effectDay(last)+'T00:00:00Z'))/dayMs));
   const clipNote=(note:string)=>{const chars=Array.from(note);return chars.length>40?chars.slice(0,40).join('')+'…':note;};
   const needle=keyword.toLowerCase(),candidates:any[]=[];
   for(const row of scannedRows){
    const amountCents=Number(row.amountCents)||0;if(amountCents<rule.amountCents)continue;
    const houseKey=String(row.houseKey),last=lastEvent.get(houseKey)||null,days=last?daysSince(last.at):null;
    const followupStatus=!last?'never':days!<rule.inactiveDays?'contacted':'overdue';
    candidates.push({houseKey,address:String(row.address||''),ownerName:String(row.ownerName||''),amountCents,lastContactAt:last?last.at.toISOString():null,days,never:!last,lastAction:last?.action??null,lastNote:last?clipNote(last.note):'',contactCount:contactCount.get(houseKey)||0,phone:(this.canEditFees(access)?((row as any).phone??null):null),phoneMasked:String((row as any).phoneMasked||''),followupStatus});
   }
   const population=Number(scan.total)||scannedRows.length;
   const populationCents=Number.isFinite(Number(scan.amountCents))?Number(scan.amountCents):scannedRows.reduce((sum,row)=>sum+(Number(row.amountCents)||0),0);
   const overdueRows=candidates.filter(r=>r.followupStatus!=='contacted');
   // 搜索与状态都只筛展示集合，不影响 今日待跟进 计数和空态里的整体命中口径。
   const matched=candidates.filter(r=>!needle||r.address.toLowerCase().includes(needle)||r.ownerName.toLowerCase().includes(needle)||r.houseKey.includes(needle));
   const visible=status==='all'?matched:matched.filter(r=>status==='never'?r.never:status==='overdue'?r.followupStatus!=='contacted':r.followupStatus==='contacted');
   // 房号自然序：管理处 → S_ID（数字）→ ZH_ID（数字）；作为 address 排序，也作为其余排序的统一兜底键。
   const addressParts=(row:any)=>String(row.houseKey??'').split(':');
   const compareAddress=(a:any,b:any)=>{const A=addressParts(a),B=addressParts(b);return String(A[0]??'').localeCompare(String(B[0]??''))||(Number(A[1])||0)-(Number(B[1])||0)||(Number(A[2])||0)-(Number(B[2])||0);};
   const direction=dir==='asc'?1:-1;
   visible.sort((a,b)=>{
    let cmp=0;
    if(sort==='address')cmp=compareAddress(a,b)*direction;
    else if(sort==='count')cmp=((Number(a.contactCount)||0)-(Number(b.contactCount)||0))*direction;
    else if(sort==='days'){
     // 从未跟进（days=null）无论升降序都排最前；其余按距今天数比较。
     if(a.never!==b.never)return a.never?-1:1;
     if(!a.never)cmp=((Number(a.days)||0)-(Number(b.days)||0))*direction;
    }
    else if(sort==='recent'){const am=a.lastContactAt?Date.parse(a.lastContactAt):-1,bm=b.lastContactAt?Date.parse(b.lastContactAt):-1;cmp=(am-bm)*direction;}
    else cmp=(a.amountCents-b.amountCents)*direction;
    if(cmp)return cmp;
    // 同值兜底：次数/最近/天数用金额降序，最后统一 houseKey（地址自然序）保证翻页稳定。
    if(sort!=='amount'&&sort!=='address'){const amountCmp=b.amountCents-a.amountCents;if(amountCmp)return amountCmp;}
    return compareAddress(a,b);
   });
   total=visible.length;totalAmountCents=visible.reduce((sum,row)=>sum+row.amountCents,0);overdueCount=overdueRows.length;
   queue=visible.slice((page-1)*pageSize,page*pageSize);
   largeInactive=overdueRows.slice().sort((a,b)=>b.amountCents-a.amountCents||a.houseKey.localeCompare(b.houseKey)).slice(0,100);
   stats={avgAmountCents:population?Math.round(populationCents/population):0,hitCount:candidates.length,hitAmountCents:candidates.reduce((sum,row)=>sum+row.amountCents,0),thresholdCents:rule.amountCents,inactiveDays:rule.inactiveDays,scanned:scannedRows.length,neverCount:candidates.filter(r=>r.never).length,overdueCount:overdueRows.length,contactedCount:candidates.filter(r=>r.followupStatus==='contacted').length};
  }
  return {today,followupHouseholds:Math.max(overdueHouseholds,overdueCount),promises:rows,holds,events,rows:queue,total,totalAmountCents,page,pageSize,status,sort,dir,largeInactive,stats,rule,timelineScope:'责任对象跟进（跨批次）'};
 }
 /** 已缴原账只读入口：复用既有住宅明细SQL，归因不读取updatedate作为收款日。 */
 async paidCollectionBills(houseKeys:string[],user:AuthUser,access?:ResolvedAccess){
  const out:any[]=[];
  for(let i=0;i<houseKeys.length;i+=200){const result:any=await this.residential({view:'detail',status:'paid',houseKeys:houseKeys.slice(i,i+200)},user,access);out.push(...result.rows)}
  return out;
 }
 async collectionEffects(q:{communityId?:number;windowDays?:number;from?:string;to?:string;page?:number;pageSize?:number},user:AuthUser,access?:ResolvedAccess){
  if(q.windowDays!==undefined&&q.windowDays!==30)throw new BadRequestException('当前归因窗口固定T+30天');
  validateMisFeeRange({paidFrom:q.from,paidTo:q.to,page:q.page,pageSize:q.pageSize});
  const allowed=await this.residentialScope({communityId:q.communityId},user,access),ids=allowed.map(c=>c.id);
  const batches=await this.batches!.createQueryBuilder('b').where('b.tenant_id=:tenant',{tenant:user.tenantId}).andWhere('b.community_ids && ARRAY[:...ids]::integer[]',{ids}).orderBy('b.id','ASC').take(10001).getMany();
  if(batches.length>10000)throw new BadRequestException('归因批次超过一万条，请联系管理员分段核对；未截断统计');
  if(batches.some(b=>!Array.isArray((b.snapshot as any)?.notices)))throw new BadRequestException("通知快照不完整，未推算催收效果");
  const candidates=batches.map(b=>({...b,snapshot:{...b.snapshot,notices:((b.snapshot as any).notices||[]).filter((n:any)=>ids.includes(n.communityId))}}));
  const keys=[...new Set(candidates.flatMap(b=>(b.snapshot as any).notices.map((n:any)=>String(n.houseKey))))] as string[];
  const payments=keys.length?await this.paidCollectionBills(keys,user,access):[];
  const effects=calculateCollectionEffects(candidates,payments);
  const eligible=new Set(batches.filter(b=>b.communityIds.every(id=>ids.includes(id))&&(!q.from||effectDay(b.createdAt)>=q.from)&&(!q.to||effectDay(b.createdAt)<=q.to)).map(b=>b.id));
  const all=effects.rows.filter(r=>eligible.has(r.id)).sort((a,b)=>b.id-a.id);
  const notifiedCents=all.reduce((s,r)=>s+r.notifiedCents,0),recoveredCents=all.reduce((s,r)=>s+r.recoveredCents,0);if(!Number.isSafeInteger(notifiedCents)||!Number.isSafeInteger(recoveredCents))throw new BadRequestException('归因汇总金额超出安全范围');
  const page=q.page||1,pageSize=Math.min(q.pageSize||20,100),total=all.length;
  return {rows:all.slice((page-1)*pageSize,page*pageSize),total,page,pageSize,summary:{notifiedCents,recoveredCents,recoveryRate:notifiedCents?Math.round(recoveredCents/notifiedCents*10000)/100:0,clearedHouseholds:all.reduce((s,r)=>s+r.clearedHouseholds,0)},policy:effects.policy,invalidPaidDateCount:effects.invalidPaidDateCount,naturalRecoveryCents:effects.naturalRecoveryCents,sourceLabel:'一通MIS',readOnly:true,queriedAt:new Date().toISOString()};
 }
 async onModuleDestroy(){const p=this.poolPromise;this.poolPromise=null;if(p)await p.then(pool=>pool.close()).catch(()=>{});}
}
