import {Cron,CronExpression} from '@nestjs/schedule';
import {BadRequestException,ConflictException,ForbiddenException,Inject,Injectable,Logger,ServiceUnavailableException} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';import {Equal,Repository} from 'typeorm';import {createHash,randomUUID} from 'node:crypto';
import {BusinessTransaction} from '../../entities/business-transaction.entity';import {BusinessServiceType,BusinessTransactionStatus} from '../../common/enums';
import {AuthUser} from '../../common/current-user.decorator';import {ResolvedAccess} from '../access/access.service';import {scopeCommunityIds} from '../access/scope.util';
import {MisFeesService} from './mis-fees.service';import {resolveMisCollector} from './mis-collector.util';import {MisPostingCommand,validateMisPosting} from './mis-posting.util';
export interface MisPostingContext {houseId:number;communityId:number;address:string;ownerId:string;officeCodes:string[];bills:MisPostingCommand['bills'];}
export interface CreateMisPosting {houseId:number;billIds:string[];amountCents:number;paymentMethod:string;confirmed:boolean;idempotencyKey:string;}
@Injectable()
export class MisPostingService{
 constructor(@InjectRepository(BusinessTransaction) private readonly repo:Repository<BusinessTransaction>,@Inject(MisFeesService) private readonly reader:{postingContext(houseId:number,billIds:string[],user:AuthUser,access?:ResolvedAccess):Promise<MisPostingContext>},@Inject('MIS_POSTING_CONNECTOR') private readonly connector:any){}
 private sweeping=false;
 @Cron(CronExpression.EVERY_MINUTE)
 async sweep():Promise<void>{
  if(this.sweeping||process.env.MIS_POSTING_MODE!=='on')return;this.sweeping=true;
  try{
   // A dead worker may have committed MIS: only inspect its original receipt, never blindly replay.
   await this.repo.createQueryBuilder().update(BusinessTransaction).set({externalSyncStatus:'mis_unknown'}).where('service_type IN (:...kinds)',{kinds:['mis_property','mis_berth']}).andWhere('external_sync_status IN (:...states)',{states:['mis_running','mis_checking']}).andWhere('updated_at<:stale',{stale:new Date(Date.now()-5*60000)}).execute();
   const due=await this.repo.createQueryBuilder('t').select('t.id','id').where('t.service_type IN (:...kinds)',{kinds:['mis_property','mis_berth']}).andWhere('t.external_sync_status IN (:...states)',{states:['mis_queued','mis_unknown']}).orderBy('t.id','ASC').limit(20).getRawMany<{id:number}>();
   for(const row of due)await this.runOne(Number(row.id));
  }catch{new Logger(MisPostingService.name).error('MIS队列本轮处理未完成，持久办理单已保留；请核查服务状态');}finally{this.sweeping=false;}
 }
 async runOne(id:number):Promise<void>{
  if(process.env.MIS_POSTING_MODE!=='on')return;
  const row=await this.repo.findOne({where:{id}});if(!row||!['mis_property','mis_berth'].includes(row.serviceType)||row.status!=='paid'||!['mis_queued','mis_unknown'].includes(row.externalSyncStatus))return;
  const inspect=row.externalSyncStatus==='mis_unknown',claimedStatus=inspect?'mis_checking':'mis_running';
  const mis={...(row.snapshot.mis as any)},snapshot={...row.snapshot,mis:{...mis,runId:randomUUID(),attempts:Number(mis.attempts||0)+1,startedAt:new Date().toISOString()}};
  const where={id:row.id,tenantId:row.tenantId,serviceType:row.serviceType,externalSyncStatus:row.externalSyncStatus};
  const claim=await this.repo.update(where,{externalSyncStatus:claimedStatus,snapshot:snapshot as any});if(!claim.affected)return;
  let status:string,lastError:string|null=null,result:any=null;
  try{
   result=inspect?await this.connector.inspect(mis.command):await this.connector.post(mis.command);
   if(result?.state==='synced')status='synced';else{status=inspect?'mis_manual':'mis_unknown';lastError=inspect?'原凭证未确认销账；收款事实已保留，请核查后在原单重试，勿再次收款':'源库未给出完整核验结果，请按原凭证核查';}
  }catch(e){status=inspect?'mis_unknown':(e as any)?.state==='unknown'?'mis_unknown':'mis_failed';lastError=status==='mis_unknown'?'MIS结果未知：系统只核查原凭证，不自动重复销账或收款':'MIS销账未完成：收款事实已保留，请核查原单后重试';}
  await this.repo.update({id:row.id,tenantId:row.tenantId,externalSyncStatus:claimedStatus,snapshot:Equal(snapshot)},{externalSyncStatus:status,snapshot:{...snapshot,mis:{...snapshot.mis,lastError,result,finishedAt:new Date().toISOString()}} as any});
 }
 async retry(id:number,user:AuthUser,access?:ResolvedAccess){
  await this.detail(id,user,access);if(process.env.MIS_POSTING_MODE!=='on')throw new ServiceUnavailableException('MIS正式写入未启用，不会重试销账');
  const row=await this.repo.findOneByOrFail({id,tenantId:user.tenantId!});
  if(row.externalSyncStatus==='mis_unknown'){await this.runOne(id);return this.detail(id,user,access);}
  if(!['mis_failed','mis_manual'].includes(row.externalSyncStatus))return this.detail(id,user,access);
  let checked:any;try{checked=await this.connector.inspect((row.snapshot.mis as any).command);}catch{throw new ConflictException('原凭证核验未完成，不能安全重试；收款事实仍保留');}
  if(!['synced','unpaid'].includes(checked?.state))throw new ConflictException('原凭证核验结果不明确，不能重试');
  const next=checked.state==='synced'?'synced':'mis_queued';
  await this.repo.update({id,tenantId:user.tenantId!,externalSyncStatus:row.externalSyncStatus,snapshot:Equal(row.snapshot)},{externalSyncStatus:next,snapshot:{...row.snapshot,mis:{...(row.snapshot.mis as any),lastError:null,retryRequestedBy:user.id,retryRequestedAt:new Date().toISOString()}} as any,updatedBy:user.id});
  return this.detail(id,user,access);
 }
 async detail(id:number,user:AuthUser,access?:ResolvedAccess){
  const scope=this.scope(user,access);if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw new BadRequestException('办理编号非法');
  const row=await this.repo.findOne({where:{id,tenantId:user.tenantId!}});if(!row||!['mis_property','mis_berth'].includes(row.serviceType)||scope&&(!row.communityId||!scope.includes(row.communityId)))throw new ForbiddenException('办理单不存在或不在当前数据范围');
  const mis=row.snapshot.mis as any;return{id:row.id,txnNo:row.txnNo,serviceType:row.serviceType,status:row.status,amountCents:row.amountCents,paymentMethod:mis?.command?.paymentMethod||row.paymentMethod,createdAt:row.createdAt,createdBy:row.createdBy,houseId:row.houseId,communityId:row.communityId,address:(row.snapshot.house as any)?.address||'',externalSyncStatus:row.externalSyncStatus,receiptNo:mis?.command?.receiptNo||null,bills:mis?.command?.bills||[],execution:{attempts:Number(mis?.attempts||0),lastError:mis?.lastError||null,startedAt:mis?.startedAt||null,finishedAt:mis?.finishedAt||null},sourceLabel:'一通MIS'};
 }
 async lookup(key:string,user:AuthUser,access?:ResolvedAccess){
  this.scope(user,access);if(typeof key!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))throw new BadRequestException('原办理标识非法');
  const row=await this.repo.findOne({where:{tenantId:user.tenantId!,txnNo:'MIS-'+key.toLowerCase()}});if(!row)return{found:false};if(row.createdBy!==user.id)throw new ForbiddenException('只能恢复本人原办理单');return{found:true,posting:await this.detail(row.id,user,access)};
 }
 readiness(user:AuthUser,access?:ResolvedAccess){
  const scope=this.scope(user,access);const configured=process.env.MIS_POSTING_MODE==='on'&&Number(process.env.MIS_FEES_TENANT_ID)===user.tenantId&&!!process.env.MIS_FEES_USER&&!!process.env.MIS_FEES_PASSWORD&&(!scope||scope.length>0);
  const methods=['cash','wechat','alipay','bank','card','other'].filter(method=>{try{resolveMisCollector(process.env.MIS_POSTING_MAPPING,user.tenantId!,user.id,method);return true}catch{return false}});
  return {enabled:configured&&methods.length>0,methods:configured?methods:[],sourceLabel:'一通MIS',reason:!configured?'MIS正式收款尚未启用，本页仅核对应收，请在物业系统收款':!methods.length?'当前员工的MIS收款人/收款方式映射尚未核实，不可收款':'本次仍会核对源账单、本人收款映射与封帐，确认前不会登记收款'};
 }
 private scope(user:AuthUser,access?:ResolvedAccess){if(!user.tenantId||!access)throw new ForbiddenException('缺少公司或数据范围授权');return scopeCommunityIds(access);}
 async create(dto:CreateMisPosting,user:AuthUser,access?:ResolvedAccess):Promise<BusinessTransaction>{
  const scope=this.scope(user,access);
  if(process.env.MIS_POSTING_MODE!=='on')throw new ServiceUnavailableException('MIS正式收款尚未启用，请勿在PMS收款；源库未修改');
  if(Object.keys(dto).some(k=>!['houseId','billIds','amountCents','paymentMethod','confirmed','idempotencyKey'].includes(k)))throw new BadRequestException('收款人和MIS内部字段只能由服务端确定');
  if(dto.confirmed!==true||!Number.isSafeInteger(dto.houseId)||dto.houseId<1||!/^[-a-f0-9]{36}$/i.test(dto.idempotencyKey)||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/i.test(dto.idempotencyKey)||!Number.isSafeInteger(dto.amountCents)||dto.amountCents<0)throw new BadRequestException('请核对住户、金额并确认收款');
  if(!Array.isArray(dto.billIds)||!dto.billIds.length||dto.billIds.length>120||dto.billIds.some(id=>typeof id!=='string'||!/^[1-9]\d{0,17}$/.test(id))||new Set(dto.billIds).size!==dto.billIds.length)throw new BadRequestException('请选择1至120条不重复的MIS账单');
  const fingerprint=createHash('sha256').update(JSON.stringify([user.id,dto.houseId,[...dto.billIds].sort(),dto.amountCents,dto.paymentMethod])).digest('hex');
  const txnNo='MIS-'+dto.idempotencyKey.toLowerCase();
  const match=(row:BusinessTransaction)=>{if(row.createdBy!==user.id||(row.snapshot.mis as any)?.fingerprint!==fingerprint)throw new ConflictException('同一幂等标识已用于不同收款，请在原办理记录核对');if(scope&&(!row.communityId||!scope.includes(row.communityId)))throw new ForbiddenException('原收款单不在当前数据范围');return row;};
  const previous=await this.repo.findOne({where:{tenantId:user.tenantId!,txnNo}});if(previous)return match(previous);
  let collector:ReturnType<typeof resolveMisCollector>;try{collector=resolveMisCollector(process.env.MIS_POSTING_MAPPING,user.tenantId!,user.id,dto.paymentMethod);}catch{throw new BadRequestException('MIS实际收款人或收款方式映射未核实，请先完成本人映射；未登记收款');}
  const context=await this.reader.postingContext(dto.houseId,dto.billIds,user,access);
  if(context.houseId!==dto.houseId||scope&&!scope.includes(context.communityId))throw new ForbiddenException('该住户不在收款授权范围');
  const command:MisPostingCommand={ownerId:context.ownerId,officeCodes:context.officeCodes,receiptNo:'PMS:'+dto.idempotencyKey.toLowerCase(),paidDate:new Date(Date.now()+8*3600000).toISOString().slice(0,10).replace(/-/g,''),...collector,bills:context.bills};
  const amount=validateMisPosting(command);if(amount!==dto.amountCents||context.bills.length!==dto.billIds.length||context.bills.some(b=>!dto.billIds.includes(b.id)))throw new ConflictException('MIS金额或账单已变化，请重新核对，未登记收款');
  let preflight:any;try{preflight=await this.connector.inspect(command);}catch{throw new ConflictException('MIS账单、本人映射或财务封帐核验未通过，请核实后再收款；未登记收款');}
  if(preflight?.state!=='unpaid')throw new ConflictException('原MIS凭证已有销账结果或核验未完成，请核实原办理单；未登记新收款');
  const row=this.repo.create({tenantId:user.tenantId!,txnNo,serviceType:(context.bills[0].feeCode==='01'?'mis_property':'mis_berth') as BusinessServiceType,status:BusinessTransactionStatus.PAID,ruleId:null,communityId:context.communityId,houseId:context.houseId,ownerId:null,targetType:'mis_owner',targetId:null,quantity:context.bills.length,startDate:null,endDate:null,amountCents:amount,paymentMethod:dto.paymentMethod,externalSyncStatus:'mis_queued',invoiceStatus:'not_required',remark:null,snapshot:{house:{id:context.houseId,address:context.address},mis:{fingerprint,command,attempts:0}},createdBy:user.id,updatedBy:user.id});
  try{return await this.repo.manager.transaction(async manager=>{
   // Sorted, transaction-scoped database locks serialize competing receipts across API processes.
   for(const id of [...dto.billIds].sort())await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`mis:${user.tenantId}:${id}`]);
   const durable=manager.getRepository(BusinessTransaction);
   const concurrent=await durable.findOne({where:{tenantId:user.tenantId!,txnNo}});if(concurrent)return match(concurrent);
   const overlap=await durable.createQueryBuilder('t').where('t.tenant_id=:tenant',{tenant:user.tenantId}).andWhere("t.status='paid'").andWhere("EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(t.snapshot->'mis'->'command'->'bills','[]'::jsonb)) b WHERE b->>'id' = ANY(:billIds))",{billIds:dto.billIds}).getOne();
   if(overlap)throw new ConflictException('所选账单已经登记PMS收款，请查原办理单，不要再次收款');
   return durable.save(row);
  });}catch(e){if((e as any)?.code!=='23505')throw e;const race=await this.repo.findOne({where:{tenantId:user.tenantId!,txnNo}});if(!race)throw new ConflictException('原收款正在保存，请按原单核对，勿重新收款');return match(race);}
 }
}

