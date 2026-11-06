import {Column,Entity,Index} from 'typeorm';
import {TenantEntity} from '../common/base.entity';
@Entity('mis_collection_promises')
@Index('mis_collection_promises_scope',['tenantId','communityId','status'])
@Index('mis_collection_promises_request',['tenantId','requestKey'],{unique:true})
export class MisCollectionPromise extends TenantEntity {
 @Column({name:'house_key',type:'varchar',length:70}) houseKey:string;
 @Column({name:'community_id',type:'int'}) communityId:number;
 @Column({name:'promised_date',type:'date'}) promisedDate:string;
 @Column({name:'promised_cents',type:'bigint'}) promisedCents:string;
 @Column({type:'varchar',length:16,default:'active'}) status:'active'|'cancelled';
 @Column({name:'request_key',type:'varchar',length:36}) requestKey:string;
 @Column({type:'jsonb'}) snapshot:Record<string,unknown>;
}
@Entity('mis_collection_holds')
@Index('mis_collection_holds_scope',['tenantId','communityId','status'])
@Index('mis_collection_holds_request',['tenantId','requestKey'],{unique:true})
export class MisCollectionHold extends TenantEntity {
 @Column({name:'house_key',type:'varchar',length:70}) houseKey:string;
 @Column({name:'community_id',type:'int'}) communityId:number;
 @Column({type:'varchar',length:12}) reason:'dispute'|'request'|'complaint';
 @Column({name:'until_date',type:'date'}) until:string;
 @Column({type:'varchar',length:16,default:'active'}) status:'active'|'cancelled';
 @Column({name:'request_key',type:'varchar',length:36}) requestKey:string;
}
@Entity('mis_collection_events')
@Index('mis_collection_events_house',['tenantId','houseKey','createdAt'])
@Index('mis_collection_events_request',['tenantId','requestKey'],{unique:true})
export class MisCollectionEvent extends TenantEntity {
 @Column({name:'house_key',type:'varchar',length:70}) houseKey:string;
 @Column({name:'community_id',type:'int'}) communityId:number;
 @Column({type:'varchar',length:20}) action:'phone'|'promise'|'hold'|'cancel_promise'|'cancel_hold';
 @Column({type:'varchar',length:500,default:''}) note:string;
 @Column({type:'varchar',length:64}) fingerprint:string;
 @Column({name:'record_id',type:'int',nullable:true}) recordId:number|null;
 @Column({name:'request_key',type:'varchar',length:36}) requestKey:string;
}

@Entity('mis_collection_prints')
@Index('mis_collection_prints_request',['tenantId','requestKey'],{unique:true})
@Index('mis_collection_prints_batch',['tenantId','batchId'])
export class MisCollectionPrint extends TenantEntity {
 @Column({name:'batch_id',type:'int'}) batchId:number;
 @Column({name:'operator_id',type:'int'}) operatorId:number;
 @Column({name:'page_count',type:'int'}) pageCount:number;
 @Column({name:'notice_page_count',type:'int'}) noticePageCount:number;
 @Column({type:'varchar',length:2}) paper:'A5'|'A4';
 @Column({name:'printed_at',type:'timestamptz'}) printedAt:Date;
 @Column({name:'request_key',type:'varchar',length:36}) requestKey:string;
}
