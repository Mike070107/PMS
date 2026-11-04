import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { TenantConfig } from '../../entities/tenant-config.entity';
import { AuthUser } from '../../common/current-user.decorator';
import { IsBoolean, IsInt, ValidateIf, IsString, Max, MaxLength, Min } from 'class-validator';
export class CollectionSmsConfigDto {
 @ValidateIf((_, v) => v !== undefined) @IsBoolean() enabled?:boolean;
 @ValidateIf((_, v) => v !== undefined) @IsString() @MaxLength(64) signName?:string;
 @ValidateIf((_, v) => v !== undefined) @IsString() @MaxLength(40) templateCode?:string;
 @ValidateIf((_, v) => v !== undefined) @IsString() @MaxLength(500) templateContent?:string;
 @ValidateIf((_, v) => v !== undefined) @IsString() @MaxLength(128) accessKeyId?:string;
 @ValidateIf((_, v) => v !== undefined) @IsString() @MaxLength(256) accessKeySecret?:string;
 @ValidateIf((_, v) => v !== undefined) @IsBoolean() clearCredentials?:boolean;
 @ValidateIf((_, v) => v !== undefined) @IsBoolean() approved?:boolean;
 @ValidateIf((_, v) => v !== undefined) @IsInt() @Min(8) @Max(20) startHour?:number;
 @ValidateIf((_, v) => v !== undefined) @IsInt() @Min(9) @Max(21) endHour?:number;
 @ValidateIf((_, v) => v !== undefined) @IsInt() @Min(24) @Max(2160) cooldownHours?:number;
 @ValidateIf((_, v) => v !== undefined) @IsInt() @Min(1) @Max(3) dailyLimit?:number;
}
export const DEFAULT_COLLECTION_SMS={enabled:false,provider:'aliyun',signName:'',templateCode:'',templateContent:'尊敬的业主，截至${date}，您名下${address}的${period}物业服务费待缴金额为${amount}元，请与物业管理处核对并办理缴费。如已缴费，请忽略本通知。',approved:false,startHour:9,endHour:18,cooldownHours:168,dailyLimit:1};
const KEY='residential_collection_sms';
@Injectable()
export class CollectionSmsService {
 constructor(@InjectRepository(TenantConfig) private readonly repo:Repository<TenantConfig>){}
 private tenant(user:AuthUser){if(!user.tenantId)throw new ForbiddenException('请先选择公司');return user.tenantId}
 private key(tenant:number){const secret=process.env.SETTINGS_ENCRYPTION_KEY||process.env.JWT_SECRET;if(!secret)throw new ServiceUnavailableException('服务端未配置设置加密主密钥，不能保存短信凭据');return createHash('sha256').update('collection-sms-v1:'+tenant+':'+secret).digest()}
 private encrypt(value:string,tenant:number){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(tenant),iv);cipher.setAAD(Buffer.from(KEY));const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.')}
 private decrypt(value:string,tenant:number){const [iv,tag,data]=value.split('.');try{const cipher=createDecipheriv('aes-256-gcm',this.key(tenant),Buffer.from(iv,'base64'));cipher.setAAD(Buffer.from(KEY));cipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8')}catch{throw new ServiceUnavailableException('短信凭据无法解密，请由管理员重新保存；未发送短信')}}
 private async stored(tenantId:number){const row=await this.repo.findOne({where:{tenantId,key:KEY}});return {...DEFAULT_COLLECTION_SMS,...(row?.value||{})} as typeof DEFAULT_COLLECTION_SMS&{keyIdCipher?:string;keySecretCipher?:string;keyIdTail?:string}}
 async get(user:AuthUser){const raw=await this.stored(this.tenant(user));const {enabled,provider,signName,templateCode,templateContent,approved,startHour,endHour,cooldownHours,dailyLimit}=raw;return {enabled,provider,signName,templateCode,templateContent,approved,startHour,endHour,cooldownHours,dailyLimit,hasAccessKeyId:!!raw.keyIdCipher,hasAccessKeySecret:!!raw.keySecretCipher,accessKeyIdMasked:raw.keyIdCipher?'••••'+(raw.keyIdTail||''):'',readiness:await this.readiness(this.tenant(user))}}
 async save(dto:CollectionSmsConfigDto,user:AuthUser){
  const tenantId=this.tenant(user);
  // Database CAS, not a process-local mutex: retries reapply only this request's patch.
  for(let attempt=0;attempt<12;attempt++){
  const row=await this.repo.findOne({where:{tenantId,key:KEY}});
  const raw={...DEFAULT_COLLECTION_SMS,...(row?.value||{})} as Awaited<ReturnType<CollectionSmsService['stored']>>,next={...raw};
  for(const key of ['enabled','signName','templateCode','templateContent','approved','startHour','endHour','cooldownHours','dailyLimit'] as const)if(dto[key]!==undefined)(next as any)[key]=dto[key];
  if(next.startHour>=next.endHour)throw new BadRequestException('发送时段结束时间必须晚于开始时间');
  if(next.templateCode&&!/^SMS_\d+$/.test(next.templateCode))throw new BadRequestException('模板CODE格式应为SMS_加数字');
  if(/[【】]/.test(next.signName))throw new BadRequestException('签名不填写括号，由阿里云添加');
  const variables=Array.from(next.templateContent.matchAll(/\$\{([^}]+)\}/g),m=>m[1]);
  if(variables.some(v=>!['date','address','period','amount'].includes(v))||new Set(variables).size!==variables.length)throw new BadRequestException('仅支持date、address、period、amount变量，每个变量只能出现一次');
  if(!variables.includes('address')||!variables.includes('amount')||!next.templateContent.trim())throw new BadRequestException('模板应包含address和amount变量及固定通知内容');
  const changedTemplate=next.templateCode!==raw.templateCode||next.templateContent!==raw.templateContent||next.signName!==raw.signName;
  if(changedTemplate)next.approved=false;
  if(dto.clearCredentials){delete next.keyIdCipher;delete next.keySecretCipher;delete next.keyIdTail;next.enabled=false;}
  if(dto.accessKeyId?.trim()){next.keyIdCipher=this.encrypt(dto.accessKeyId.trim(),tenantId);next.keyIdTail=dto.accessKeyId.trim().slice(-4);}
  if(dto.accessKeySecret?.trim())next.keySecretCipher=this.encrypt(dto.accessKeySecret.trim(),tenantId);
  if(next.enabled&&(!next.keyIdCipher||!next.keySecretCipher||!next.signName||!next.templateCode||!next.approved))throw new BadRequestException('请先保存凭据、签名和模板，再确认已通过阿里云审核后开启');
  if(row){
   const result=await this.repo.createQueryBuilder().update(TenantConfig).set({value:next,updatedBy:user.id})
    .where('tenant_id = :tenantId AND key = :key AND value = CAST(:expected AS jsonb)',{tenantId,key:KEY,expected:JSON.stringify(row.value)}).execute();
   if(result.affected===1)return this.get(user);
  }else{
   const result=await this.repo.createQueryBuilder().insert().into(TenantConfig).values({tenantId,key:KEY,value:next,updatedBy:user.id}).orIgnore().returning('id').execute();
   if(result.raw.length)return this.get(user);
  }
  }
  throw new ConflictException('短信配置正在被其他管理员修改，请刷新后重试');
 }
 async readiness(tenantId:number){const s=await this.stored(tenantId);const configured=!!(s.keyIdCipher&&s.keySecretCipher&&s.signName&&s.templateCode&&s.approved);
  return {provider:'aliyun',configured,enabled:s.enabled,canSend:false,reason:!configured?'请在系统设置→催缴短信配置阿里云凭据、签名及审核通过的模板':!s.enabled?'催缴短信总开关未开启':'配置已保存；真实发送及运营商回执链路尚未验收，暂不可发送。保存配置不会触发发送'};
 }
 /** Provider use only. Not routed through a controller and never returned from settings. */
 async credentials(tenantId:number){const s=await this.stored(tenantId);if(!s.keyIdCipher||!s.keySecretCipher)throw new BadRequestException('阿里云短信凭据未配置');return {accessKeyId:this.decrypt(s.keyIdCipher,tenantId),accessKeySecret:this.decrypt(s.keySecretCipher,tenantId)}}
}
