import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { Material, Stock, StockLot, StockMovement } from '../../entities';
import { StockReservation, WorkOrderMaterialDraft } from '../../entities/work-order-material-draft.entity';
import { WorkOrderMaterialReservations1795801000000 } from '../../migrations/1795801000000-WorkOrderMaterialReservations';
import { StockMovementType, WorkOrderStatus } from '../../common/enums';
import { applyStockDelta, consumeStockLots } from '../inventory/stock-ledger';
import { RepairsService } from './repairs.service';

test('预留草稿在数据库保存、刷新、释放，失败的事务不丢原预留', async () => {
  const pg = new PGlite();
  const ds = new DataSource({ type: 'postgres', entities: [Material, Stock, StockLot, StockMovement, StockReservation, WorkOrderMaterialDraft], synchronize: false });
  await (ds as any).buildMetadatas();
  const runner = (): any => {
    const qr: any = { connection: ds, isReleased: false, isTransactionActive: false, data: {}, connect: async () => {}, release: async () => {},
      query: async (sql: string, params: any[] = [], structured = false) => {
        const out = await pg.query(sql, params);
        if (!structured) return out.rows;
        const result = new QueryResult(); result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows; return result;
      } };
    qr.broadcaster = new Broadcaster(qr); qr.manager = ds.createEntityManager(qr);
    qr.startTransaction = async () => { await pg.exec('BEGIN'); qr.isTransactionActive = true; };
    qr.commitTransaction = async () => { await pg.exec('COMMIT'); qr.isTransactionActive = false; };
    qr.rollbackTransaction = async () => { await pg.exec('ROLLBACK'); qr.isTransactionActive = false; };
    return qr;
  };
  (ds as any).isInitialized = true; ds.createQueryRunner = runner;
  try {
    const migration = new WorkOrderMaterialReservations1795801000000();
    await migration.up({ query: (sql: string) => pg.query(sql) } as any);
    await migration.up({ query: (sql: string) => pg.query(sql) } as any);
    await pg.exec(`CREATE TABLE materials (id serial PRIMARY KEY, tenant_id int, code varchar(60), name varchar(120), spec varchar(120), category varchar(60), unit varchar(20), default_cost_cents int DEFAULT 0, photo_url varchar(500), photo_urls jsonb DEFAULT '[]', aliases jsonb DEFAULT '[]', params text, enabled boolean DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), created_by int, updated_by int);
      CREATE TABLE stocks (id serial PRIMARY KEY, tenant_id int, warehouse_id int, material_id int, qty numeric(12,2), safety_qty numeric(12,2), location_id int, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), created_by int, updated_by int);
      CREATE TABLE stock_lots (id serial PRIMARY KEY, tenant_id int, warehouse_id int, material_id int, lot_no varchar(60), initial_qty numeric(12,2), remaining_qty numeric(12,2), unit_cost_cents int, supplier_id int, purchase_order_id int, goods_receipt_id int, source_type varchar(40), source_id int, received_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), created_by int, updated_by int);
      CREATE TABLE stock_movements (id serial PRIMARY KEY, tenant_id int, warehouse_id int, material_id int, type varchar(20), qty numeric(12,2), unit_cost_cents int, ref_type varchar(40), ref_id int, location_id int, note text, reversal_of_movement_id int, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), created_by int, updated_by int);
      INSERT INTO materials (id,tenant_id,code,name,unit) VALUES (20,1,'M20','电源','个');
      INSERT INTO stocks (tenant_id,warehouse_id,material_id,qty,safety_qty) VALUES (1,10,20,5,0);
      INSERT INTO stock_lots (tenant_id,warehouse_id,material_id,lot_no,initial_qty,remaining_qty,unit_cost_cents,received_at) VALUES (1,10,20,'lot',5,5,100,now());`);
    const service = Object.create(RepairsService.prototype) as any;
    service.resolveTenantId = () => 1; service.assertWorkOrderScope = () => undefined;
    service.ensureAssigneeOrAdmin = async () => undefined;
    service.lockWorkOrder = async (_m: any, id: number) => ({ id, tenantId: 1, status: WorkOrderStatus.IN_PROGRESS });
    service.listWorkOrderStockOptions = async (_id: number, _u: any, _a: any, warehouseId: number) => ({ warehouseId });
    service.workOrderRepo = { findOne: async ({ where }: any) => ({ ...where, status: WorkOrderStatus.IN_PROGRESS }) };
    service.dataSource = ds;
    const user = { id: 9, tenantId: 1 }, row = { materialId: 20, warehouseId: 10, name: '电源', qty: 3, note: '换新' };
    const first = await service.saveMaterialDraft(1, { version: 0, rows: [row] }, user);
    assert.equal((await service.getMaterialDraft(1, user)).rows[0].note, '换新');
    await assert.rejects(service.saveMaterialDraft(1, { version: first.version, rows: [{ ...row, materialId: 999 }] }, user), /不存在/);
    assert.equal(Number((await ds.getRepository(StockReservation).findOneBy({ tenantId: 1, workOrderId: 1 }))?.qty), 3);
    const second = await service.saveMaterialDraft(2, { version: 0, rows: [row] }, user);
    assert.equal(second.rows[0].stockQty, 2);
    await assert.rejects(ds.transaction(async (manager) => {
      await consumeStockLots(manager, { tenantId: 1, warehouseId: 10, materialId: 20, qty: 1, operatorId: 9 });
      await applyStockDelta(manager, { tenantId: 1, warehouseId: 10, materialId: 20, deltaQty: -1, type: StockMovementType.OUTBOUND, unitCostCents: 100, refType: 'isolated-test', refId: null, operatorId: 9 });
    }), /库存不足/);
    assert.equal(Number((await ds.getRepository(StockLot).findOneBy({ tenantId: 1 }))?.remainingQty), 5, '拒绝出库时批次扣减必须回滚');
    await service.saveMaterialDraft(1, { version: first.version, rows: [] }, user);
    const retry = await service.saveMaterialDraft(2, { version: second.version, rows: [row] }, user);
    assert.equal(retry.rows[0].stockQty, 3);
    assert.equal(Number((await ds.getRepository(Stock).findOneBy({ tenantId: 1 }))?.qty), 5, '预留不能生成正式出库');
  } finally { await pg.close(); }
});
