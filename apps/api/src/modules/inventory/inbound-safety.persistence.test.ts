import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { GoodsReceipt, Material, Stock, StockLot, StockMovement } from '../../entities';
import { StockReservation } from '../../entities/work-order-material-draft.entity';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { Reflector } from '@nestjs/core';
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';

// No env/config/network connection. A brand-new on-disk embedded PostgreSQL database only.
test('一般入库撤销：隔离磁盘数据库、原单/批次/审计、幂等、负数与已领用/预留保护、刷新重开', async () => {
  const out = resolve(process.cwd(), '../../outputs/inbound-warehouse-safety-20261116');
  mkdirSync(out, { recursive: true });
  const directory = mkdtempSync(resolve(out, 'isolated-db-'));
  let pg = new PGlite(directory);
  const ds = new DataSource({ type: 'postgres', entities: [GoodsReceipt, Material, Stock, StockLot, StockMovement, StockReservation], synchronize: false });
  await (ds as any).buildMetadatas();
  (ds as any).isInitialized = true;
  ds.createQueryRunner = (): any => {
    const qr: any = { connection: ds, isReleased: false, isTransactionActive: false, data: {}, connect: async () => {}, release: async () => {},
      query: async (sql: string, params: any[] = [], structured = false) => {
        const out = await pg.query(sql, params); if (!structured) return out.rows;
        const result = new QueryResult(); result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows; return result;
      } };
    qr.broadcaster = new Broadcaster(qr); qr.manager = ds.createEntityManager(qr);
    qr.startTransaction = async () => { await pg.exec('BEGIN'); qr.isTransactionActive = true; };
    qr.commitTransaction = async () => { await pg.exec('COMMIT'); qr.isTransactionActive = false; };
    qr.rollbackTransaction = async () => { await pg.exec('ROLLBACK'); qr.isTransactionActive = false; };
    return qr;
  };
  const audit = 'created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), created_by int, updated_by int';
  try {
    await pg.exec(`CREATE TABLE goods_receipts (id serial PRIMARY KEY,tenant_id int,receipt_no varchar(40),receipt_type varchar(20),purchase_order_id int,source_text varchar(255),attachments jsonb DEFAULT '[]',warehouse_id int,receiver_id int,items jsonb DEFAULT '[]',${audit});
      CREATE TABLE materials (id serial PRIMARY KEY,tenant_id int,code varchar(60),name varchar(120),spec varchar(120),category varchar(60),unit varchar(20),default_cost_cents int DEFAULT 0,photo_url varchar(500),photo_urls jsonb DEFAULT '[]',aliases jsonb DEFAULT '[]',params text,enabled boolean DEFAULT true,${audit});
      CREATE TABLE stocks (id serial PRIMARY KEY,tenant_id int,warehouse_id int,material_id int,qty numeric(12,2),safety_qty numeric(12,2),location_id int,${audit});
      CREATE TABLE stock_lots (id serial PRIMARY KEY,tenant_id int,warehouse_id int,material_id int,lot_no varchar(60),initial_qty numeric(12,2),remaining_qty numeric(12,2),unit_cost_cents int,supplier_id int,purchase_order_id int,goods_receipt_id int,source_type varchar(40),source_id int,received_at timestamptz,${audit});
      CREATE TABLE stock_movements (id serial PRIMARY KEY,tenant_id int,warehouse_id int,material_id int,type varchar(20),qty numeric(12,2),unit_cost_cents int,ref_type varchar(40),ref_id int,location_id int,note text,reversal_of_movement_id int,${audit});
      CREATE UNIQUE INDEX idx_isolated_reversal ON stock_movements(reversal_of_movement_id) WHERE reversal_of_movement_id IS NOT NULL;
      CREATE TABLE stock_reservations (id serial PRIMARY KEY,tenant_id int,warehouse_id int,material_id int,work_order_id int,qty numeric(12,2),${audit});
      INSERT INTO materials(id,tenant_id,code,name,unit) VALUES(20,1,'M20','隔离材料','个');`);
    const service: any = Object.create(InventoryService.prototype);
    service.dataSource = ds;
    service.resolveTenantId = (u: any) => u.tenantId;
    service.visibleWarehouseIds = async () => [10];
    service.assertWarehouseVisible = async (_t: number, user: any, id: number) => { if (id !== 10 || user.denied) throw Error('warehouse forbidden'); };
    service.refreshReferenceCosts = async () => {};
    const user = { id: 9, tenantId: 1 };
    async function seed(id: number, remaining = 5, qty = 5, receiptType = 'general') {
      await pg.query(`INSERT INTO goods_receipts(id,tenant_id,receipt_no,receipt_type,warehouse_id,items) VALUES($1,1,$2,$3,10,'[{"materialId":20,"qty":5,"unitCostCents":100}]')`, [id, `GR-${id}`, receiptType]);
      await pg.query(`INSERT INTO stocks(tenant_id,warehouse_id,material_id,qty,safety_qty) VALUES(1,10,20,$1,0)`, [qty]);
      await pg.query(`INSERT INTO stock_lots(tenant_id,warehouse_id,material_id,lot_no,initial_qty,remaining_qty,unit_cost_cents,goods_receipt_id,received_at) VALUES(1,10,20,$1,5,$2,100,$3,now())`, [`LOT-${id}`, remaining, id]);
      await pg.query(`INSERT INTO stock_movements(tenant_id,warehouse_id,material_id,type,qty,unit_cost_cents,ref_type,ref_id,created_by) VALUES(1,10,20,'inbound',5,100,'general_receipt',$1,9)`, [id]);
    }
    service.ensureWarehouse = async () => {};
    service.ensureMaterials = async () => {};
    service.resolveLocationLabels = async () => new Map();
    service.defaultLocationOf = async () => null;
    service.buildNo = () => 'GR-1';
    const created = await service.createGeneralReceipt({ warehouseId: 10, sourceText: '隔离入库', items: [{ materialId: 20, qty: 5, unitCostCents: 100 }] }, user);
    assert.equal(created.id, 1); assert.equal(created.warehouseId, 10);
    assert.equal(Number((await ds.getRepository(Stock).findOneByOrFail({ tenantId: 1 })).qty), 5);
    await assert.rejects(service.reverseGoodsReceipt(1, '错仓', { ...user, tenantId: 2 }), /不存在/);
    await assert.rejects(service.reverseGoodsReceipt(1, '错仓', { ...user, denied: true }), /forbidden/);
    await assert.rejects(service.reverseGoodsReceipt(1, ' ', user), /原因/);
    assert.deepEqual(await service.reverseGoodsReceipt(1, '隔离测试选错仓', user), { id: 1, receiptNo: 'GR-1', reversed: true, alreadyReversed: false });
    assert.equal((await service.reverseGoodsReceipt(1, '重试', user)).alreadyReversed, true);
    assert.equal(Number((await ds.getRepository(Stock).findOneByOrFail({ tenantId: 1 })).qty), 0);
    const original = await ds.getRepository(GoodsReceipt).findOneByOrFail({ id: 1 });
    assert.equal(original.items[0].qty, 5); assert.equal(original.warehouseId, 10);
    const reversal = await ds.getRepository(StockMovement).findOneByOrFail({ refType: 'receipt_reversal' });
    assert.equal(Number(reversal.qty), -5); assert.equal(reversal.createdBy, 9); assert.match(reversal.note!, /隔离测试选错仓/);
    await assert.rejects(pg.query(`INSERT INTO stock_movements(reversal_of_movement_id) VALUES($1)`, [reversal.reversalOfMovementId]), /duplicate key/);
    assert.equal((await service.listGoodsReceipts({}, user))[0].reversed, true);
    // Each rejected receipt gets a fresh stock row to keep scenarios independent.
    await pg.exec('DELETE FROM stocks'); await seed(2, 4, 10);
    await assert.rejects(service.reverseGoodsReceipt(2, '已用', user), /已有领用/);
    await pg.exec('DELETE FROM stocks'); await seed(3, 5, 3);
    await assert.rejects(service.reverseGoodsReceipt(3, '不足', user), /insufficient/);
    assert.equal(Number((await ds.getRepository(StockLot).findOneByOrFail({ goodsReceiptId: 3 })).remainingQty), 5, '事务失败须回滚原批次');
    await pg.exec('DELETE FROM stocks'); await seed(4);
    await pg.exec('INSERT INTO stock_reservations(tenant_id,warehouse_id,material_id,qty) VALUES(1,10,20,1)');
    await assert.rejects(service.reverseGoodsReceipt(4, '预留', user), /库存不足/);
    await pg.exec('DELETE FROM stock_reservations; DELETE FROM stocks'); await seed(5, 5, 5, 'purchase_order');
    await assert.rejects(service.reverseGoodsReceipt(5, '采购', user), /采购单入库不支持/);
    for (const warehouseId of [undefined, null, 0, -1, NaN]) {
      await assert.rejects(service.createGeneralReceipt({ warehouseId, items: [{}], sourceText: 'test' }, user), /明确选择/);
      await assert.rejects(service.createGoodsReceipt({ warehouseId, items: [{}] }, user), /明确选择/);
    }
    await pg.close(); pg = new PGlite(directory);
    const refreshed = await ds.getRepository(StockMovement).find({ where: { refType: 'receipt_reversal' } });
    assert.equal(refreshed.length, 1); assert.equal(refreshed[0].reversalOfMovementId, reversal.reversalOfMovementId);
    assert.equal((await service.listGoodsReceipts({}, user)).find((r: any) => r.id === 1).reversed, true);
    const required = Reflect.getMetadata(PERMISSION_KEY, InventoryController.prototype.reverseGoodsReceipt);
    assert.deepEqual(required.items, [{ pageKey: 'inventory', action: 'edit' }, { pageKey: 'app:inventory', action: 'edit' }]);
    const guard = new RolesOrPermissionGuard(new Reflector(), {
      getAccess: async (u: any) => ({ allowed: u.allowed }),
      hasAnyPermission: (a: any, items: any[]) => a.allowed && items.some((i) => i.action === 'edit'),
    } as any);
    const context = (u: any): any => ({ getHandler: () => InventoryController.prototype.reverseGoodsReceipt, getClass: () => InventoryController, switchToHttp: () => ({ getRequest: () => ({ user: u }) }) });
    await assert.rejects(guard.canActivate(context(undefined)), /权限不足/);
    await assert.rejects(guard.canActivate(context({ ...user, allowed: false })), /权限不足/);
    assert.equal(await guard.canActivate(context({ ...user, allowed: true })), true);
    console.log(`ISOLATED_DATABASE=${directory}; reopened/read OK; audit/unique-index/rollback/tenant/scope/permission metadata OK`);
  } finally { await pg.close(); }
});
