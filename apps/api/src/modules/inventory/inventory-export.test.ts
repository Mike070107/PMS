import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { InventoryService } from './inventory.service';

test('库存导出行级筛选：xlsx 列与库位明细字符串', async () => {
  const service: any = Object.create(InventoryService.prototype);
  service.resolveTenantId = () => 1;
  service.listStocks = async () => [{
    warehouseId: 2, materialName: '收发器电源', spec: '5V 2A', unit: '个', qty: 5, safetyStock: 0,
    unitCostCents: 1200, amountCents: 6000, updatedAt: '2026-11-09T14:17:34+08:00',
    locations: [{ locationId: 11, label: 'A架', qty: 3 }, { locationId: 12, label: 'B架', qty: 2 }],
  }];
  service.warehouseRepo = { find: async () => [{ id: 2, name: '智能化维修工仓库' }] };
  const buffer: Buffer = await service.exportStocks({}, { id: 7, tenantId: 1 }, { scopeAll: true } as any);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.worksheets[0];
  const header = (sheet.getRow(1).values as any[]).slice(1);
  assert.deepEqual(header, ['仓库', '材料', '规格', '单位', '当前库存', '安全库存', '单位成本（元）', '库存金额（元）', '库位明细', '更新时间']);
  const row = (sheet.getRow(2).values as any[]).slice(1);
  assert.equal(row[0], '智能化维修工仓库');
  assert.equal(row[1], '收发器电源');
  assert.equal(row[4], 5);
  assert.equal(row[6], 12);
  assert.equal(row[8], 'A架×3 / B架×2');
});
