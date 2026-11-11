import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { Material, Stock, StockLot, StockMovement } from '../../entities';
import { StockReservation, WorkOrderMaterialDraft } from '../../entities/work-order-material-draft.entity';
import { RepairsService } from './repairs.service';
import { WorkOrderStatus, StockMovementType } from '../../common/enums';
import { applyStockDelta, consumeStockLots } from '../inventory/stock-ledger';

test('独立 PostgreSQL：并发预留不超库存，同版本竞争拒绝覆盖，提交扣库保持事务一致', {skip: !process.env.PMS_MATERIAL_TEST_PG}, async () => {
  const config = JSON.parse(process.env.PMS_MATERIAL_TEST_PG!);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'pms_material_isolated');
  const ds = new DataSource({type:'postgres', ...config, entities:[Material,Stock,StockLot,StockMovement,StockReservation,WorkOrderMaterialDraft],synchronize:true});
  await ds.initialize();
  try {
    await ds.getRepository(Material).save({id:20,tenantId:1,code:'fixture-20',name:'电源',unit:'个',enabled:true});
    await ds.getRepository(Stock).save({tenantId:1,warehouseId:10,materialId:20,qty:5,safetyQty:0});
    await ds.getRepository(StockLot).save({tenantId:1,warehouseId:10,materialId:20,lotNo:'fixture-lot',initialQty:5,remainingQty:5,unitCostCents:100,receivedAt:new Date()});
    const s = Object.create(RepairsService.prototype) as any;
    s.resolveTenantId=()=>1; s.assertWorkOrderScope=()=>undefined; s.ensureAssigneeOrAdmin=async()=>undefined;
    s.lockWorkOrder=async(m:any,id:number)=>{await m.query('SELECT pg_advisory_xact_lock($1)',[id]);return {id,tenantId:1,status:WorkOrderStatus.IN_PROGRESS};};
    s.listWorkOrderStockOptions=async(_id:number,_u:any,_a:any,warehouseId:number)=>({warehouseId});
    s.dataSource=ds;
    const user={id:9,tenantId:1};
    const row={materialId:20,warehouseId:10,name:'电源',qty:3,note:'换新'};
    const [a,b]=await Promise.all([s.saveMaterialDraft(1,{version:0,rows:[row]},user),s.saveMaterialDraft(2,{version:0,rows:[row]},user)]);
    assert.equal(Number(a.rows[0].stockQty)+Number(b.rows[0].stockQty),5);
    assert.equal((await ds.getRepository(StockReservation).find()).reduce((n,r)=>n+Number(r.qty),0),5);
    const race=await Promise.allSettled([s.saveMaterialDraft(1,{version:a.version,rows:[{...row,qty:1}]},user),s.saveMaterialDraft(1,{version:a.version,rows:[{...row,qty:2}]},user)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(race.filter(r=>r.status==='rejected').length,1);
    const latest=await ds.getRepository(WorkOrderMaterialDraft).findOneByOrFail({tenantId:1,workOrderId:1});
    await s.saveMaterialDraft(1,{version:latest.version,rows:[]},user);
    const full=await s.saveMaterialDraft(2,{version:b.version,rows:[{...row,qty:5}]},user);
    assert.equal(full.rows[0].stockQty,5);
    await ds.transaction(async(m)=>{
      await s.lockWorkOrder(m,2);
      await s.releaseMaterialDraft(m,1,2,[{...row,qty:5}],false);
      await consumeStockLots(m,{tenantId:1,warehouseId:10,materialId:20,qty:5,operatorId:9});
      await applyStockDelta(m,{tenantId:1,warehouseId:10,materialId:20,deltaQty:-5,type:StockMovementType.OUTBOUND,unitCostCents:100,refType:'fixture-complete',refId:2,operatorId:9});
    });
    assert.equal(await ds.getRepository(StockReservation).count(),0);
    assert.equal(Number((await ds.getRepository(Stock).findOneByOrFail({tenantId:1})).qty),0);
    assert.equal(Number((await ds.getRepository(StockLot).findOneByOrFail({tenantId:1})).remainingQty),0);
    assert.equal(await ds.getRepository(StockMovement).count(),1);
  } finally {await ds.destroy();}
});
