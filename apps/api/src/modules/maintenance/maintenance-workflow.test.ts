import assert from 'node:assert/strict';
import test from 'node:test';
import { MAINTENANCE_STATUS } from '../../entities/maintenance-order.entity';
import { MaintenanceService } from './maintenance.service';

const service = Object.create(MaintenanceService.prototype) as any;

function row(status: string) {
  return {
    status,
    fillerId: 11,
    fillerName: '填单人',
    fillerSignUrl: null,
    repairerId: 22,
    repairerName: '修理人',
    repairerSignUrl: null,
    inspectorId: null,
    inspectorName: null,
    inspectorSignUrl: null,
    inspectedAt: null,
  };
}

test('养护单三方签字严格按填单人、修理人、查验员流转', () => {
  const order = row(MAINTENANCE_STATUS.WAITING_FILLER);
  assert.equal(service.expectedSlot(order), 'filler');
  service.applySignedSlot(order, 'filler', '/filler.png', 11, '填单人');
  assert.equal(order.status, MAINTENANCE_STATUS.WAITING_REPAIRER);
  service.applySignedSlot(order, 'repairer', '/repairer.png', 22, '修理人');
  assert.equal(order.status, MAINTENANCE_STATUS.WAITING_INSPECTOR);
  service.applySignedSlot(order, 'inspector', '/inspector.png', 33, '查验员');
  assert.equal(order.status, MAINTENANCE_STATUS.PENDING_PRINT);
  assert.equal(service.expectedSlot(order), null);
});

test('养护单不允许越级签字', () => {
  const order = row(MAINTENANCE_STATUS.WAITING_FILLER);
  assert.throws(
    () => service.applySignedSlot(order, 'repairer', '/wrong.png', 22, '修理人'),
    /先完成填单人签字/,
  );
  assert.equal(order.status, MAINTENANCE_STATUS.WAITING_FILLER);
});
