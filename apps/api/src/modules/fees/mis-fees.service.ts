import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { collectionEffects as calculateCollectionEffects, effectDay, promiseProgress } from './mis-collection-effect';
import { validateMisFeeRange } from './mis-fees.query';
import { CollectionSmsService } from '../settings/collection-sms.service';
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

// 与用户确认的映射；公寓收费台、北桥和颛桥均不参与物业费查询。
export const MIS_PROPERTY_OFFICES:Record<string,string[]>={
 '枫桦景苑一期':['01'],'枫桦景苑二期':['02','03'],'上海新家':['04'],
};
@Injectable()
export class MisFeesService implements OnModuleDestroy {
 private poolPromise:Promise<any>|null=null;
 constructor(@InjectRepository(Community) private readonly communities:Repository<Community>,@InjectRepository(House) private readonly houses:Repository<House>,@InjectRepository(MisCollectionBatch) private readonly batches?:Repository<MisCollectionBatch>, private readonly smsSettings?:CollectionSmsService, private readonly followupRule?:import('../settings/collection-followup.service').CollectionFollowupService){}
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
 private async read(text:string,params:Record<string,string|number>={}){
  if(!/^\s*(SELECT|WITH)\b/i.test(text)||/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|ALTER|DROP|TRUNCATE)\b/i.test(text))throw new Error('MIS只读查询校验失败');
  const sql=require('mssql'),pool=await this.pool(),req=pool.request();
  for(const [key,value] of Object.entries(params))req.input(key,typeof value==='number'?sql.Int:sql.NVarChar(4000),value);
  try{return await req.query(text);}catch{throw new ServiceUnavailableException('一通MIS查询未完成，请稍后重试；未使用旧数据替代');}
 }
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
 private async residentialScope(q:MisResidentialQuery,user:AuthUser,access?:ResolvedAccess){
  let communities=await this.scope(user,access);
  if(q.houseId)throw new BadRequestException('住宅总览请使用范围与住户查询，不接受内部房号ID');
  if(q.communityId){if(!communities.some(c=>c.id===q.communityId))throw new ForbiddenException('该小区不在MIS查询授权范围');communities=communities.filter(c=>c.id===q.communityId);}
  if(!communities.length)throw new ForbiddenException('当前范围没有可查询的一通MIS物业数据');
  return communities;
 }
 async residential(q:MisResidentialQuery,user:AuthUser,access?:ResolvedAccess){
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
  if(!q.view||q.view==='dashboard')return {...meta,summary:{...amounts(sets[0]?.[0]||{}),total:Number(sets[0]?.[0]?.total||0),unpaidHouses:Number(sets[0]?.[0]?.unpaidHouses||0),adjustmentCount:Number(sets[0]?.[0]?.adjustmentCount||0)},byFee:(sets[1]||[]).map((r:any)=>({...amounts(r),feeCode:r.feeCode,feeName:r.feeName||'未命名费项',category:r.category,unpaidHouses:Number(r.unpaidHouses||0)}))};
  if(q.view==='trend')return {...meta,invalidDateCount:Number(sets[1]?.[0]?.invalidDateCount||0),rows:(sets[0]||[]).map((r:any)=>({day:r.day,netCents:misMoneyToCents(r.netAmount),chargedCents:misMoneyToCents(r.chargedAmount),refundedCents:misMoneyToCents(r.refundedAmount)}))};
  const format=(r:any)=>{const {phone,amount,...safe}=r;const p=String(phone||'').trim();return {...safe,amountCents:misMoneyToCents(amount),billCount:r.billCount===undefined?undefined:Number(r.billCount),phoneMasked:/^1[3-9]\d{9}$/.test(p)?`${p.slice(0,3)}****${p.slice(-4)}`:p?'号码待核实':'未留手机号',contactEligible:/^1[3-9]\d{9}$/.test(p),communityId:communities.find(c=>c.offices.includes(r.officeCode))?.id};};
  if(q.view==='detail'){if((sets[0]||[]).length>10000)throw new BadRequestException('账单明细超过一万条，请缩小账期或分批');return {...meta,rows:(sets[0]||[]).map(format)};}
  const totalHouses=Number(sets[0]?.[0]?.total||0),totalAmount=misMoneyToCents(sets[0]?.[0]?.amount);
  let aging:any=undefined;
  if((q as any)._aging!==false&&!q.houseKeys?.length){
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
   const topOwners=[...owners.entries()].map(([name,v])=>({name,...v})).sort((a,b)=>b.amountCents-a.amountCents).slice(0,10);
   aging={buckets,owners:topOwners,ownerCount:owners.size,total:totalHouses,amountCents:totalAmount,truncated:scan.rows.length<Number(scan.total||0),scanned:scan.rows.length,scanCap};
  }
  return {...meta,total:totalHouses,amountCents:totalAmount,page:q.page||1,pageSize:q.pageSize||20,aging,rows:(sets[1]||[]).map(format)};
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
  const row=this.batches!.create({tenantId:user.tenantId!,idempotencyKey:dto.idempotencyKey,communityIds:[...new Set(preview.notices.map(n=>Number(n.communityId)))],purpose:dto.purpose,status:dto.purpose==='print'?'generated':'preview_only',fingerprint:preview.fingerprint,houseCount:preview.notices.length,amountCents:String(preview.totalCents),snapshot:preview,createdBy:user.id,updatedBy:user.id});
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
 async collectionFollowups(q:{communityId?:number;houseKeys?:string[]},user:AuthUser,access?:ResolvedAccess){
  const allowed=await this.residentialScope(q,user,access),ids=allowed.map(c=>c.id),today=effectDay(new Date());
  const promises=await this.collectionRepo(MisCollectionPromise).find({where:{tenantId:user.tenantId!,communityId:In(ids),status:'active'},order:{id:'DESC'}});
  const keys=[...new Set(promises.map(p=>p.houseKey))],payments=keys.length?await this.paidCollectionBills(keys,user,access):[];
  const rows=promises.map(p=>{try{const progress=promiseProgress(p,payments);return {...p,...progress,overdue:!progress.fulfilled&&p.promisedDate<=today}}catch(e){throw new BadRequestException((e as Error).message)}});
  const requested=q.houseKeys||[];if(requested.length>200)throw new BadRequestException('每批最多200个跟进责任对象');for(const key of requested){if(!/^(0[1-4]):[1-9]\d{0,18}:[1-9]\d{0,18}$/.test(key)||!allowed.some(c=>c.offices.includes(key.split(':')[0])))throw new ForbiddenException('跟进对象不在授权范围');}
  const where:any={tenantId:user.tenantId!,communityId:In(ids),...(requested.length?{houseKey:In(requested)}:{})};
  const holds=(await this.collectionRepo(MisCollectionHold).find({where:{...where,status:'active'},order:{id:'DESC'}})).filter(h=>h.until>=today);
  const events=await this.collectionRepo(MisCollectionEvent).find({where,order:{id:'DESC'},take:200});
  const rule=this.followupRule?await this.followupRule.get(user):{amountCents:180000,inactiveDays:7,enabled:true};
  let largeInactive:any[]=[],stats:any=null;
  if(rule.enabled){
   const scan:any=await this.residential({communityId:q.communityId,view:'households',status:'unpaid',page:1,pageSize:5000},user,access);
   const avg=scan.total?Math.round(scan.amountCents/scan.total):0;
   const last=new Map<string,string>();
   for(const e of events as any[]){const t=String(e.createdAt||'');if(!t)continue;const prev=last.get(e.houseKey);if(!prev||t>prev)last.set(e.houseKey,t)}
   const hit=(scan.rows as any[]).filter(r=>Number(r.amountCents)>=rule.amountCents).map(r=>{const at=last.get(r.houseKey);const days=at?Math.floor((Date.now()-new Date(at).getTime())/86400000):null;return {houseKey:r.houseKey,address:r.address,amountCents:Number(r.amountCents),lastContactAt:at||null,days,never:!at}}).filter(x=>x.never||(x.days as number)>=rule.inactiveDays).sort((a,b)=>b.amountCents-a.amountCents);
   largeInactive=hit.slice(0,100);
   stats={avgAmountCents:avg,hitCount:hit.length,hitAmountCents:hit.reduce((sum,x)=>sum+x.amountCents,0),thresholdCents:rule.amountCents,inactiveDays:rule.inactiveDays,scanned:scan.rows.length};
  }
  return {today,followupHouseholds:Math.max(new Set(rows.filter(p=>p.overdue).map(p=>p.houseKey)).size,largeInactive.length),promises:requested.length?rows.filter(p=>requested.includes(p.houseKey)):rows,holds,events,largeInactive,stats,rule,timelineScope:'责任对象跟进（跨批次）'};
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
