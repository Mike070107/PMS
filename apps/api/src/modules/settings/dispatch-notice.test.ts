import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from 'class-validator';
import { DispatchNoticeRecipientsDto } from './dto';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { PGlite } from '@electric-sql/pglite';

test('待派通知配置仅接受有权限且覆盖管理处的在职人员', async () => {
  const controller: any = Object.create(SettingsController.prototype);
  let saved: number[] | undefined;
  controller.accessService = {
    listVisibleOffices: async () => [{ id: 1, name: '管理处' }],
    userIdsWithPermission: async (_tenant: number, page: string) => page === 'app:dispatch' ? [2, 3] : [3, 4],
    filterUsersCoveringOffice: async () => new Set([2, 3]),
  };
  controller.settingsService = {
    dispatchNoticeUsers: async (_tenant: number, ids: number[]) => ids.filter((id) => id === 2).map((id) => ({ id, name: '甲' })),
    getDispatchNoticeRecipients: async () => saved ?? null,
    saveDispatchNoticeRecipients: async (_tenant: number, _office: number, ids: number[]) => { saved = ids; },
  };
  const user = { id: 9, tenantId: 1 } as any;
  await assert.rejects(() => controller.saveDispatchNoticeRecipients({ officeId: 1, userIds: [3] }, user), /必须在职/);
  await assert.rejects(() => controller.getDispatchNoticeRecipients(2, user), /工作范围/);
  const result = await controller.saveDispatchNoticeRecipients({ officeId: 1, userIds: [2] }, user);
  assert.deepEqual(result.selected, [2]);
  const dto = Object.assign(new DispatchNoticeRecipientsDto(), { officeId: 1, userIds: [] });
  assert.ok((await validate(dto)).length > 0);
});

test('指定人员按租户及管理处持久化，更新不覆盖其他配置', async () => {
  const pg = new PGlite();
  try {
    await pg.query(`CREATE TABLE tenant_configs (
      tenant_id int NOT NULL, key varchar(60) NOT NULL, value jsonb NOT NULL,
      created_by int, updated_by int, created_at timestamptz, updated_at timestamptz,
      UNIQUE (tenant_id, key)
    )`);
    const repo = {
      query: async (sql: string, args: unknown[]) => (await pg.query(sql, args as any[])).rows,
      findOne: async ({ where }: any) => (await pg.query('SELECT value FROM tenant_configs WHERE tenant_id=$1 AND key=$2', [where.tenantId, where.key])).rows[0] || null,
    };
    const service = new SettingsService(repo as any, {} as any, {} as any);
    assert.equal(await service.getDispatchNoticeRecipients(1, 1), null);
    await service.saveDispatchNoticeRecipients(1, 1, [7, 7, 8], 9);
    await service.saveDispatchNoticeRecipients(1, 2, [10], 9);
    await service.saveDispatchNoticeRecipients(2, 1, [11], 9);
    await service.saveDispatchNoticeRecipients(1, 1, [8], 9);
    assert.deepEqual(await service.getDispatchNoticeRecipients(1, 1), [8]);
    assert.deepEqual(await service.getDispatchNoticeRecipients(1, 2), [10]);
    assert.deepEqual(await service.getDispatchNoticeRecipients(2, 1), [11]);
  } finally { await pg.close(); }
});
