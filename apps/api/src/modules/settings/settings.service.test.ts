import assert from 'node:assert/strict';
import test from 'node:test';
import type { Repository } from 'typeorm';
import { House, TenantConfig, User } from '../../entities';
import { SettingsService } from './settings.service';

function serviceWithConfig(value: Record<string, unknown> | null) {
  const configRepo = {
    findOne: async () => (value ? { value } : null),
  } as unknown as Repository<TenantConfig>;
  return new SettingsService(
    configRepo,
    {} as Repository<User>,
    {} as Repository<House>,
  );
}

test('uses the tenant auto-review setting when it is valid', async () => {
  const service = serviceWithConfig({ hours: 72 });
  assert.equal(await service.getAutoReviewHoursByTenant(1), 72);
});

test('falls back to 48 hours for missing or invalid settings', async () => {
  assert.equal(await serviceWithConfig(null).getAutoReviewHoursByTenant(1), 48);
  assert.equal(
    await serviceWithConfig({ hours: 0 }).getAutoReviewHoursByTenant(1),
    48,
  );
  assert.equal(
    await serviceWithConfig({ hours: 721 }).getAutoReviewHoursByTenant(1),
    48,
  );
});
