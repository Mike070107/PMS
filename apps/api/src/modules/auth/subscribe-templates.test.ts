import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from './auth.service';

test('员工端同时下发新单、催接单、办公室催修模板并去重', async () => {
  const service = Object.create(AuthService.prototype) as any;
  service.settings = {
    async getSettingsByTenant() {
      return {
        wxSubscribeTemplates: {
          orderDispatched: 'owner-dispatched',
          orderReview: 'owner-review',
          orderAssigned: 'staff-new',
          orderOverdue: 'staff-overdue',
          orderUrge: 'staff-new',
        },
      };
    },
  };

  assert.deepEqual(await service.resolveSubscribeTemplates(1, 'staff'), [
    'staff-new',
    'staff-overdue',
  ]);
  assert.deepEqual(await service.resolveSubscribeTemplates(1, 'owner'), [
    'owner-dispatched',
    'owner-review',
  ]);
});
