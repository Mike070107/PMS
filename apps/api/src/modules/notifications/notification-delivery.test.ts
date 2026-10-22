import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationsService } from './notifications.service';
import { NotifyChannel, NotifyStatus } from '../../common/enums';

function fixture(remaining: number, sendOk = true) {
  let row: any;
  const service: any = Object.create(NotificationsService.prototype);
  service.logger = { error() {}, warn() {} };
  service.notificationRepo = {
    create: (x: any) => x,
    save: async (x: any) => { row = { id: 1, ...x }; return row; },
    findOne: async () => row,
    update: async (_: any, x: any) => { Object.assign(row, x); },
  };
  service.userRepo = { findOne: async () => ({ id: 2, wxOpenid: 'test' }) };
  service.settings = { getSettingsByTenant: async () => ({ wxSubscribeTemplates: { orderAssigned: 'template' } }) };
  service.trySendServiceAccount = async () => false;
  let sends = 0;
  service.grantRepo = { findOne: async () => ({ remaining }), save: async () => {} };
  service.wechat = {
    getTemplateFields: async () => [],
    sendSubscribeMessageDetailed: async () => { sends++; return { ok: sendOk, errcode: sendOk ? undefined : 43101 }; },
  };
  const send = () => service.notifyUser({ tenantId: 1, receiverId: 2, eventKey: 'order_pool_new', title: '新工单', payload: { workOrderId: 150 }, template: 'orderAssigned', templateFields: {} });
  return { service, send, row: () => row, sends: () => sends };
}

test('额度耗尽保留工单引用、明确失败原因且不调用微信，阅读不篡改发送结果', async () => {
  const f = fixture(0);
  const result = await f.send();
  assert.equal(result.externalSent, false);
  assert.match(result.reason, /额度用完/);
  assert.equal(f.row().payload.workOrderId, 150);
  assert.equal(f.sends(), 0);
  await f.service.markRead(1, { id: 2, tenantId: 1 });
  assert.equal(f.row().status, NotifyStatus.FALLBACK);
  assert.ok(f.row().readAt);
});

test('微信接受与拒绝结果分别记录，不能把站内成功当微信成功', async () => {
  for (const ok of [true, false]) {
    const f = fixture(1, ok);
    const result = await f.send();
    assert.equal(result.externalSent, ok);
    assert.equal(f.sends(), 1);
    assert.equal(f.row().channel, ok ? NotifyChannel.WX_SUBSCRIBE : NotifyChannel.IN_APP);
    if (!ok) assert.match(result.reason, /发送失败/);
  }
});


test('建单自动分流逐人记录真实结果，微信未发送通知本处办公室', async () => {
  const { RepairsService } = await import('../repairs/repairs.service');
  const service: any = Object.create(RepairsService.prototype);
  service.repairRequestRepo = { findOne: async () => ({ repairType: 'menjing', addressText: '228弄51号1302室', content: '新开卡' }) };
  service.findTypeRule = async () => ({ label: '智能化相关' });
  const messages: any[] = [], logs: any[] = [];
  service.notifications = { notifyUser: async (x: any) => {
    messages.push(x);
    return { externalSent: x.receiverId === 2, reason: x.receiverId === 2 ? '微信已发送' : '额度用完，仅站内通知' };
  } };
  service.dispatchersToNotify = async (tenant: number, community: number, except: any) => {
    assert.equal(tenant, 1); assert.equal(community, 2); assert.equal(except, null);
    return [{ id: 8 }];
  };
  service.dataSource = { getRepository: () => ({ create: (x: any) => x, save: async (x: any) => logs.push(x) }) };
  await service.notifyCandidatesOnCreate({ id: 150, requestId: 150, tenantId: 1, communityId: 2, orderNo: 'RX-TEST', status: 'created', createdAt: new Date() }, [{ id: 2, name: '叶双' }, { id: 1668, name: '孔赟' }], 8);
  assert.deepEqual(messages.map(x => x.receiverId), [2, 1668, 8]);
  assert.match(logs[0].note, /叶双：微信已发送.*孔赟：额度用完/);
  assert.equal(messages[2].eventKey, 'order_notification_failed');
  assert.equal(messages[2].payload.workOrderId, 150);
});

test('完整识别入口中卡片权限规则优先于AI的公区误判', async () => {
  const { RepairsService } = await import('../repairs/repairs.service');
  const service: any = Object.create(RepairsService.prototype);
  service.resolveTenantId = () => 1;
  service.listPublicRepairTypes = async () => [];
  service.repairTextAi = { parse: async () => ({ publicArea: true }) };
  service.parseAddressByRule = async () => ({ matched: true, level: 'house', houseId: 1302, roomNo: '1302', buildingId: 120, addressText: '枫桦景苑二期51号1302室' });
  const result = await service.parseRepairAddress({ text: '228弄51号1302新开卡，开通楼道权限' }, { tenantId: 1 });
  assert.equal(result.houseId, 1302);
  assert.equal(result.level, 'house');
  assert.equal(result.publicArea, false);
});
