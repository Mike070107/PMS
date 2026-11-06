import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 住宅MIS通知快照；不改变源账务，不记录虚假的打印或短信送达。 */
@Entity('mis_collection_batches')
@Index('mis_collection_batches_tenant_key',['tenantId','idempotencyKey'],{unique:true})
export class MisCollectionBatch extends TenantEntity {
 @Column({name:'idempotency_key',type:'varchar',length:64}) idempotencyKey:string;
 @Column({name:'community_ids',type:'int',array:true}) communityIds:number[];
 @Column({type:'varchar',length:10}) purpose:'print'|'sms';
 @Column({type:'varchar',length:30}) status:'generated'|'preview_only';
 @Column({type:'varchar',length:64}) fingerprint:string;
 @Column({name:'house_count',type:'int'}) houseCount:number;
 @Column({name:'amount_cents',type:'bigint'}) amountCents:string;
 @Column({type:'jsonb'}) snapshot:Record<string,unknown>;
}
