import { BadRequestException, ForbiddenException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Building, Community, House, User } from '../../entities';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { buildMisFeeQuery, MisFeeQuery, MisHouseFilter, misFeeStatus, misMoneyToCents } from './mis-fees.query';

// 与用户确认的映射；公寓收费台、北桥和颛桥均不参与物业费查询。
export const MIS_PROPERTY_OFFICES:Record<string,string[]>={
 '枫桦景苑一期':['01'],'枫桦景苑二期':['02','03'],'上海新家':['04'],
};
@Injectable()
export class MisFeesService implements OnModuleDestroy {
 private poolPromise:Promise<any>|null=null;
 constructor(@InjectRepository(Community) private readonly communities:Repository<Community>,@InjectRepository(House) private readonly houses:Repository<House>){}
 private configured(){return !!(process.env.MIS_FEES_TENANT_ID&&process.env.MIS_FEES_USER&&process.env.MIS_FEES_PASSWORD);}
 private async scope(user:AuthUser,access?:ResolvedAccess){
  if(!user.tenantId)throw new ForbiddenException('请选择公司后查询');
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
 async metadata(user:AuthUser,access?:ResolvedAccess){
  const communities=await this.scope(user,access);
  if(!this.configured()||!communities.length)return {available:false,readOnly:true,communities,feeItems:[],message:!this.configured()?'一通MIS查询连接尚未配置':'当前公司或管理处没有已映射的物业费数据'};
  const result=await this.read('SELECT DH AS code,XM AS name FROM dbo.SETUPSFXM ORDER BY DH');
  return {available:true,readOnly:true,communities,feeItems:result.recordset,sourceLabel:'一通MIS',message:'查询MIS账单明细，不登记收款，不合并公寓收费流水'};
 }
 async searchHouses(communityId:number,q:string|undefined,user:AuthUser,access?:ResolvedAccess){
  const allowed=await this.scope(user,access);
  if(!allowed.some(c=>c.id===communityId))throw new ForbiddenException('该小区不在MIS查询授权范围');
  const qb=this.houses.createQueryBuilder('h').innerJoin(Building,'b','b.id=h.building_id AND b.tenant_id=h.tenant_id')
   .leftJoin(User,'u',"u.house_id=h.id AND u.tenant_id=h.tenant_id AND u.role='owner' AND u.status='active'")
   .where('h.tenant_id=:tenantId AND b.community_id=:communityId',{tenantId:user.tenantId,communityId})
   .select(['h.id AS id','h.room_no AS "roomNo"','COALESCE(h.road_name,b.road_name) AS road','b.lane AS lane','b.building_no AS "buildingNo"','MAX(u.name) AS "ownerName"'])
   .groupBy('h.id,b.road_name,b.lane,b.building_no').orderBy('b.building_no','ASC').addOrderBy('h.room_no','ASC').limit(50);
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
 async onModuleDestroy(){const p=this.poolPromise;this.poolPromise=null;if(p)await p.then(pool=>pool.close()).catch(()=>{});}
}
