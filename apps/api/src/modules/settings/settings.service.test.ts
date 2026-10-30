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

// ---------------- 催办时段 ----------------
// 半夜催办会让维修工把提醒整个关掉，所以时段判断必须准，跨零点也要对。

const window = (startAt: string, endAt: string) => ({
  enabled: true,
  acceptMinutes: 60,
  startAt,
  endAt,
});
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(2026, 7, 29, h, m, 0);
  return d;
};

test('催办时段：白天区间只在区间内为真', () => {
  const w = window('08:00', '20:00');
  assert.equal(SettingsService.withinWindow(w, at('08:00')), true);
  assert.equal(SettingsService.withinWindow(w, at('12:30')), true);
  assert.equal(SettingsService.withinWindow(w, at('19:59')), true);
  assert.equal(SettingsService.withinWindow(w, at('20:00')), false); // 终点不含
  assert.equal(SettingsService.withinWindow(w, at('23:30')), false); // 8-28 那条就是这个点
  assert.equal(SettingsService.withinWindow(w, at('07:59')), false);
});

test('催办时段：跨零点按「或」判', () => {
  const w = window('20:00', '08:00');
  assert.equal(SettingsService.withinWindow(w, at('23:30')), true);
  assert.equal(SettingsService.withinWindow(w, at('02:00')), true);
  assert.equal(SettingsService.withinWindow(w, at('07:59')), true);
  assert.equal(SettingsService.withinWindow(w, at('08:00')), false);
  assert.equal(SettingsService.withinWindow(w, at('12:00')), false);
});

test('催办时段：起止相同 = 全天', () => {
  const w = window('00:00', '00:00');
  assert.equal(SettingsService.withinWindow(w, at('03:00')), true);
  assert.equal(SettingsService.withinWindow(w, at('15:00')), true);
});


function settingsFixture() {
  const rows: any[] = [];
  const repo = {
    find: async ({ where }: any) => rows.filter(r => r.tenantId === where.tenantId),
    findOne: async ({ where }: any) => rows.find(r => r.tenantId === where.tenantId && r.key === where.key) || null,
    create: (data: any) => ({ ...data }),
    save: async (data: any) => { if (!rows.includes(data)) rows.push(data); return data; },
  };
  return { rows, service: new SettingsService(repo as any, {} as any, {} as any) };
}

test('抄表配置独立持久化，密钥脱敏；空值/脱敏串保留，切换模型不改维修配置', async () => {
  const { rows, service } = settingsFixture();
  const user = { id: 7, tenantId: 1 } as any;
  await service.updateSettings({ aiAssist: { apiKey: 'repair-only-key', enabled: true } }, user);
  const saved = await service.updateSettings({ meterVision: { enabled: true,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus', apiKey: 'meter-private-key' } } as any, user);
  assert.equal((saved as any).meterVision.apiKey.includes('meter-private'), false);
  await service.updateSettings({ meterVision: { model: 'qwen-vl-ocr', apiKey: '' } } as any, user);
  await service.updateSettings({ meterVision: { apiKey: (saved as any).meterVision.apiKey } } as any, user);
  const raw = await (service as any).getMeterVisionRaw(1);
  assert.equal(raw.apiKey, 'meter-private-key');
  assert.equal(raw.model, 'qwen-vl-ocr');
  assert.equal((await service.getAiAssistRaw(1)).apiKey, 'repair-only-key');
  assert.equal((await service.getAiAssistRaw(1)).model, 'deepseek-v4-flash');
  assert.equal((await (service as any).getMeterVisionRaw(2)).enabled, false);
  assert.equal(rows.filter(r => r.tenantId === 1 && r.key === 'meter_vision').length, 1);
});

test('更换识别服务地址必须提供对应密钥；缺字段不能开启', async () => {
  const { service } = settingsFixture();
  const user = { id: 7, tenantId: 1 } as any;
  await assert.rejects(service.updateSettings({ meterVision: { enabled: true } } as any, user), /API Key/);
  await service.updateSettings({ meterVision: { enabled: true, apiKey: 'meter-test-key' } } as any, user);
  await assert.rejects(service.updateSettings({ meterVision: { baseUrl: 'https://other.example/v1' } } as any, user), /密钥|API Key/);
});
