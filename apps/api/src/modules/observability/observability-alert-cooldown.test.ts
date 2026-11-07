import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityService } from './observability.service';

/** 只模拟 detectAlerts 依赖的查询/写入，验证 6 小时 cooling 与恢复后重置。 */
test('同一 alert fingerprint 6 小时内只建一次工单，恢复后再次触发才允许新建', async () => {
  const saved: any[] = [];
  let metricRows: any[] = [];
  const makeQb = (rows: () => any[]) => {
    const q: any = {};
    for (const method of ['select', 'addSelect', 'where', 'groupBy', 'addGroupBy', 'orderBy', 'addOrderBy']) q[method] = () => q;
    q.getRawMany = async () => rows();
    return q;
  };
  const logQueue: any[][] = [];
  const logRepo: any = {
    create: (value: any) => value,
    save: async (value: any) => { const row = { ...value, id: saved.length + 1, createdAt: value.createdAt ?? new Date() }; saved.push(row); return row; },
    findOne: async ({ where, order }: any) => {
      const rows = saved.filter((row) => {
        if (where.fingerprint && row.fingerprint !== where.fingerprint) return false;
        if (where.action && row.action !== where.action) return false;
        if (where.createdAt) {
          const cutoff = where.createdAt.value ?? where.createdAt._value ?? where.createdAt;
          if (!(new Date(row.createdAt) > new Date(cutoff))) return false;
        }
        return true;
      });
      rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return rows[0] ?? null;
    },
    createQueryBuilder: () => {
      const rows = logQueue.shift() ?? [];
      return makeQb(() => rows);
    },
  };
  const metricRepo: any = { createQueryBuilder: () => makeQb(() => metricRows) };
  const service: any = new ObservabilityService(logRepo, metricRepo, {} as any, {} as any, {} as any, {} as any, {} as any);
  const recentAlertRows = () => {
    const by = new Map<string, any>();
    for (const row of saved.filter((r) => r.action === 'system_alert')) {
      const prev = by.get(row.fingerprint);
      if (!prev || new Date(row.createdAt) > new Date(prev.lastAt)) by.set(row.fingerprint, { tenantId: row.tenantId, fingerprint: row.fingerprint, lastAt: row.createdAt });
    }
    return [...by.values()];
  };
  const run = async (rows: any[]) => { metricRows = rows; logQueue.push([], [], recentAlertRows()); return service.detectAlerts(); };
  const slow = [{ tenantId: '1', source: 'admin-web', requests: '20', errors: '0', slowRequests: '10', avgDurationMs: '2500' }];
  const recovered = [{ tenantId: '1', source: 'admin-web', requests: '20', errors: '0', slowRequests: '0', avgDurationMs: '300' }];

  assert.equal((await run(slow)).length, 1, '首次触发建1条');
  assert.equal(saved.filter((r) => r.action === 'system_alert').length, 1);
  assert.equal((await run(slow)).length, 0, '6小时内同 fingerprint 不重复建单');
  assert.equal(saved.filter((r) => r.action === 'system_alert').length, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await run(recovered)).length, 0);
  assert.ok(saved.some((r) => r.action === 'system_alert_recovered'), '指标恢复后写恢复标记');
  assert.equal((await run(slow)).length, 1, '恢复后再次触发可以新建');
  assert.equal(saved.filter((r) => r.action === 'system_alert').length, 2);
});
