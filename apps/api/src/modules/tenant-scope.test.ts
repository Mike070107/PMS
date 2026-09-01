import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '../common/enums';
import { InventoryService } from './inventory/inventory.service';
import { PropertiesService } from './properties/properties.service';
import { QrService } from './qr/qr.service';
import { RepairsService } from './repairs/repairs.service';
import { SettingsService } from './settings/settings.service';

const scopedResolvers = [
  ['inventory', Object.create(InventoryService.prototype)],
  ['properties', Object.create(PropertiesService.prototype)],
  ['repairs', Object.create(RepairsService.prototype)],
  ['qr', Object.create(QrService.prototype)],
] as const;

test('company view tenant scope wins over the superadmin role', () => {
  const acting = { id: 1, role: UserRole.SUPERADMIN, tenantId: 7 };
  for (const [name, service] of scopedResolvers) {
    assert.equal(
      (service as any).resolveTenantId(acting),
      7,
      `${name} should use the verified acting tenant`,
    );
    assert.throws(
      () => (service as any).resolveTenantId(acting, 8),
      `${name} should reject a tenant that conflicts with company view`,
    );
  }

  const settings = Object.create(SettingsService.prototype) as SettingsService;
  assert.equal((settings as any).requireTenant(acting), 7);
});

test('bare superadmin still needs an explicit tenant outside company view', () => {
  const platform = { id: 1, role: UserRole.SUPERADMIN, tenantId: null };
  for (const [name, service] of scopedResolvers) {
    assert.equal(
      (service as any).resolveTenantId(platform, 9),
      9,
      `${name} should support explicit platform operations`,
    );
    assert.throws(
      () => (service as any).resolveTenantId(platform),
      `${name} should reject an unscoped platform request`,
    );
  }
});

test('按编号读取或操作工单时仍校验管理处小区范围', () => {
  const service = Object.create(RepairsService.prototype) as any;
  service.scopeIds = () => [10, 11];
  assert.doesNotThrow(() => service.assertWorkOrderScope({ communityId: 10 }, {}));
  assert.throws(
    () => service.assertWorkOrderScope({ communityId: 99 }, {}),
    /work order not found/,
  );
});

test('按库存/仓库编号操作时仍校验可见仓范围', async () => {
  const service = Object.create(InventoryService.prototype) as any;
  service.visibleWarehouseIds = async () => [3, 4];
  const user = { id: 7, tenantId: 1 };
  await assert.doesNotReject(() => service.assertWarehouseVisible(1, user, 3, {}));
  await assert.rejects(
    () => service.assertWarehouseVisible(1, user, 9, {}),
    /warehouse not found/,
  );
});
