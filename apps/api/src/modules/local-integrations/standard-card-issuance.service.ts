import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, Not } from 'typeorm';
import { AccessCardIssueBatch, AccessCardIssueItem, AccessCardLegacyCardCheck } from '../../entities';
import { LocalIntegration, LocalIntegrationTask } from '../../entities/local-integration.entity';
import { icToWg } from '../access-card-issuance/access-card-routing';
import { Resource } from './protocol';
export interface StandardCardRoute { integrationKey: string; resourceId: string }
const writesCards = (resource: Resource) => ['card.inspect', 'card.write'].every(operation => resource.capabilities.some(c => c.operation === operation && c.revision === 1));
const online = (row: LocalIntegration) => row.enabled && row.lastSeenAt && Date.now() - new Date(row.lastSeenAt).getTime() < 15000;

/** Bridge into the existing issuance/allocator ledger. Generic task creation cannot manufacture this binding. */
@Injectable()
export class StandardCardIssuanceService {
  constructor(@InjectRepository(LocalIntegrationTask) private readonly tasks: Repository<LocalIntegrationTask>) {}
  async workstations(tenantId: number) {
    const rows = await this.tasks.manager.getRepository(LocalIntegration).find({where:{tenantId},order:{id:'ASC'}});
    return rows.filter(online).flatMap(row => row.resources.filter(r => writesCards(r) && row.ready.some(ready => ready.id === r.id && writesCards(ready)))
      .map(r => ({id:row.key, name:row.name, resourceId:r.id, resourceName:r.label})));
  }
  async resolveRoute(tenantId: number, workstationId?: string, resourceId?: string, manager = this.tasks.manager): Promise<StandardCardRoute | null> {
    if (!workstationId?.startsWith('local-')) {
      if (resourceId) throw new BadRequestException('标准资源必须绑定标准工作站');
      return null;
    }
    const row = await manager.getRepository(LocalIntegration).findOneBy({tenantId,key:workstationId});
    if (!row || !online(row)) throw new BadRequestException('标准工作站不存在、离线或已停用');
    const resource = row.resources.find(r => r.id === resourceId && writesCards(r));
    if (!resource || !row.ready.some(r => r.id === resource.id && writesCards(r))) throw new BadRequestException('标准写卡资源未注册或尚未就绪');
    return {integrationKey:row.key, resourceId:resource.id};
  }
  async assertBatchReplay(batch: AccessCardIssueBatch, resourceId?: string) {
    if (!batch.workstationId?.startsWith('local-')) {
      if (resourceId) throw new ConflictException('原任务不是标准写卡任务');
      return;
    }
    const item = await this.tasks.manager.getRepository(AccessCardIssueItem).findOneBy({ tenantId: batch.tenantId, batchId: batch.id, sequence: 1 });
    const inspect = item && await this.tasks.findOneBy({ tenantId: batch.tenantId, issuanceItemId: item.id, operation: 'card.inspect' });
    if (!inspect || inspect.resourceId !== resourceId || inspect.integrationKey !== batch.workstationId) throw new ConflictException('幂等键已用于另一标准写卡资源');
  }
  async startBatch(manager: EntityManager, batch: AccessCardIssueBatch, items: AccessCardIssueItem[], route: StandardCardRoute | null) {
    if (!route) return;
    await this.resolveRoute(batch.tenantId, route.integrationKey, route.resourceId, manager);
    if (batch.workstationId !== route.integrationKey) throw new ConflictException('批次工作站绑定不一致');
    await this.inspect(manager, batch, items[0], route);
  }
  private async inspect(manager: EntityManager, batch: AccessCardIssueBatch, item: AccessCardIssueItem, route: StandardCardRoute) {
    await manager.getRepository(LocalIntegrationTask).save({tenantId:batch.tenantId,integrationKey:route.integrationKey,resourceId:route.resourceId,revision:1,
      operation:'card.inspect',idempotencyKey:`issuance:${item.id}:inspect`,command:{card:{profileId:route.resourceId}},issuanceItemId:item.id,allocationId:null,status:'pending',createdBy:batch.createdBy,updatedBy:batch.updatedBy});
  }
  private async context(manager: EntityManager, task: LocalIntegrationTask) {
    if (!task.issuanceItemId) return null;
    const item = await manager.getRepository(AccessCardIssueItem).findOne({where:{id:task.issuanceItemId,tenantId:task.tenantId},lock:{mode:'pessimistic_write'}});
    if (!item) throw new ConflictException('发卡明细绑定不存在');
    const batch = await manager.getRepository(AccessCardIssueBatch).findOne({where:{id:item.batchId,tenantId:task.tenantId},lock:{mode:'pessimistic_write'}});
    if (!batch || batch.workstationId !== task.integrationKey || batch.status === 'cancelled') throw new ConflictException('发卡批次绑定失效');
    return {item,batch};
  }
  private async stop(manager: EntityManager, item: AccessCardIssueItem, batch: AccessCardIssueBatch, message: string) {
    item.lastErrorMessage=message.slice(0,500);item.lastErrorRef='STD_CARD';batch.status='needs_operator';
    await manager.save(item);await manager.save(batch);
  }
  async acceptResult(manager: EntityManager, task: LocalIntegrationTask) {
    const context=await this.context(manager,task);if(!context)return;
    const {item,batch}=context;
    if (task.status !== 'succeeded') {
      await this.stop(manager,item,batch,`标准工作站结果${task.status === 'unknown' ? '未知，禁止自动重写，请核对原任务与实卡' : '失败，请核对实卡后人工处理'}：${String(task.result?.code ?? 'LEASE_EXPIRED')}`);return;
    }
    const records=task.result?.records as Array<Record<string,string>> | undefined;
    if (!records || records.length!==1 || !/^[0-9A-F]{8}$/.test(records[0].cardUid ?? '')) throw new BadRequestException('需要唯一实卡 UID 回读（8 位大写十六进制）');
    const uid=records[0].cardUid;
    if (task.operation==='card.inspect') {
      const occupied=await manager.getRepository(AccessCardIssueItem).findOneBy({tenantId:item.tenantId,icCardNo:uid,id:Not(item.id)});
      if (occupied) {item.cardStatus='duplicate_card';await this.stop(manager,item,batch,'该实卡 UID 已属于另一发卡明细，禁止重复写卡');return;}
      item.icCardNo=uid;item.cardStatus='uid_read';item.lastErrorMessage=null;item.lastErrorRef=null;
      await manager.save(item);
      await manager.getRepository(AccessCardLegacyCardCheck).save({tenantId:item.tenantId,itemId:item.id,icCardNo:uid,status:'pending',matches:[],allocatedIcNo:null,requestedAt:new Date(),checkedAt:null,leaseAgentKey:null,leaseExpiresAt:null,lastError:null});
      batch.status='processing';await manager.save(batch);return;
    }
    if(task.operation!=='card.write')throw new ConflictException('非写卡操作不能更改发卡明细');
    const check=await manager.getRepository(AccessCardLegacyCardCheck).findOneBy({tenantId:item.tenantId,itemId:item.id,id:task.allocationId!});
    const card=task.command.card;
    if(task.result?.evidence!=='card_readback' || uid!==card?.uid || records[0].cardNumber!==card?.number)throw new BadRequestException('实卡回读 UID / 分配卡号不匹配');
    if(!check || check.status!=='clear' || !check.allocatedIcNo || check.icCardNo!==uid || item.icCardNo!==uid
      || card?.uid!==uid || card?.number!==String(check.allocatedIcNo) || card?.allocationId!==String(check.id) || card?.profileId!==task.resourceId) throw new ConflictException('真实卡号分配绑定已改变，禁止接受写卡完成');
    item.cardStatus='card_completed';item.cardCompletedAt=new Date();item.wgCardNo=batch.projectPhase==='phase2'?icToWg(uid):null;item.lastErrorMessage=null;item.lastErrorRef=null;
    await manager.save(item);
    // Access/controller and legacy statuses remain untouched: those are separate physical/business stages.
    const next=await manager.getRepository(AccessCardIssueItem).findOne({where:{tenantId:item.tenantId,batchId:batch.id,sequence:item.sequence+1},order:{sequence:'ASC'}});
    batch.status=next?'waiting_for_card':'processing';batch.currentSequence=next?.sequence ?? item.sequence;await manager.save(batch);
    if(next)await this.inspect(manager,batch,next,{integrationKey:task.integrationKey,resourceId:task.resourceId});
  }
  async advanceAllocation(tenantId: number, itemId: number, transaction?: EntityManager) {
    const advance = async (manager: EntityManager) => {
      const inspect=await manager.getRepository(LocalIntegrationTask).findOneBy({tenantId,issuanceItemId:itemId,operation:'card.inspect',status:'succeeded'});
      if(!inspect)return;
      const context=await this.context(manager,inspect);if(!context)return;
      const {item,batch}=context;
      if(await manager.getRepository(LocalIntegrationTask).findOneBy({tenantId,issuanceItemId:itemId,operation:'card.write'}))return;
      const check=await manager.getRepository(AccessCardLegacyCardCheck).findOne({where:{tenantId,itemId},lock:{mode:'pessimistic_write'}});
      if(!check || check.status==='pending')return;
      if(check.status!=='clear'){if(check.status==='duplicate')item.cardStatus='duplicate_card';await this.stop(manager,item,batch,check.status==='duplicate'?'旧库发现重复实卡，禁止写卡':'旧库分配失败，未下发写卡');return;}
      if(!Number.isSafeInteger(check.allocatedIcNo) || check.allocatedIcNo! <= 0)return;
      if(check.icCardNo!==item.icCardNo)throw new ConflictException('实卡与分配记录绑定不一致');
      await manager.getRepository(LocalIntegrationTask).save({tenantId,integrationKey:inspect.integrationKey,resourceId:inspect.resourceId,operation:'card.write',revision:1,idempotencyKey:`issuance:${item.id}:write`,
        issuanceItemId:item.id,allocationId:check.id,command:{card:{uid:check.icCardNo,number:String(check.allocatedIcNo),profileId:inspect.resourceId,allocationId:String(check.id)}},status:'pending',createdBy:inspect.createdBy,updatedBy:inspect.updatedBy});
      item.cardStatus='writing';await manager.save(item);batch.status='processing';await manager.save(batch);
    };
    return transaction ? advance(transaction) : this.tasks.manager.transaction(advance);
  }
}
