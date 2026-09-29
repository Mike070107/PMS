import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveAgentStatus, orderAgentsByAvailability } from './agent-status';

const now = new Date('2026-09-29T08:00:00.000Z');

test('从未心跳或超过 15 秒的代理显示离线', () => {
  assert.equal(effectiveAgentStatus({ status: 'online', lastSeenAt: null }, now), 'offline');
  assert.equal(effectiveAgentStatus({
    status: 'online',
    lastSeenAt: new Date('2026-09-29T07:59:44.999Z'),
  }, now), 'offline');
});

test('新鲜心跳保留代理上报状态', () => {
  assert.equal(effectiveAgentStatus({
    status: 'online',
    lastSeenAt: new Date('2026-09-29T07:59:50.000Z'),
  }, now), 'online');
  assert.equal(effectiveAgentStatus({
    status: 'degraded',
    lastSeenAt: new Date('2026-09-29T07:59:50.000Z'),
  }, now), 'degraded');
});

test('重复注册时优先返回持续在线且心跳最新的网关', () => {
  const ordered = orderAgentsByAvailability([
    { status: 'offline' as const, lastSeenAt: null, key: 'old-never-connected' },
    { status: 'online' as const, lastSeenAt: new Date('2026-09-29T07:59:48.000Z'), key: 'online-older' },
    { status: 'online' as const, lastSeenAt: new Date('2026-09-29T07:59:55.000Z'), key: 'online-latest' },
    { status: 'online' as const, lastSeenAt: new Date('2026-09-29T07:58:00.000Z'), key: 'stale-database-online' },
  ], now);
  assert.deepEqual(ordered.map((item) => item.key), [
    'online-latest',
    'online-older',
    'stale-database-online',
    'old-never-connected',
  ]);
});
