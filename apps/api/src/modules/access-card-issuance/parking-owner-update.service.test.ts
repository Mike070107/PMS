import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import { CreateParkingOwnerUpdateDto } from './dto';
import { ParkingOwnerUpdate } from '../../entities/parking-owner-update.entity';
import { ParkingHistory } from '../../entities/parking-history.entity';
import { ParkingRecordSnapshot } from '../../entities/parking-record-snapshot.entity';
import { issueAgentSecret } from './agent-auth';

const before = { name: null, phone: null, room: '228/53/301', note: null };
const after = { ...before, phone: '02112345678', note: '测试备注\n第二行' };
const input = (): CreateParkingOwnerUpdateDto => ({
  database: 'parking2', externalOwnerId: '1851', plate: '苏K163SM',
  idempotencyKey: 'owner-test-request-001', expected: { ...before }, values: { ...after },
});
const user = { id: 1, tenantId: 1 } as any;

function harness() {
  const secret = issueAgentSecret();
  const agent = { tenantId: 1, agentKey: 'test-gateway', enabled: true, kind: 'parking_gateway',
    status: 'online', lastSeenAt: new Date(), version: '2.5.16', tokenHash: secret.tokenHash, capabilities: { parkingDbWrite: true } };
  const tasks: ParkingOwnerUpdate[] = [];
  const history: any[] = [];
  const snapshots = ['苏K163SM', '沪A007U0'].map((plate, i) => ({ id: i + 1,
    values: { plate, ownerId: '1851', ownerName: null, phone: null, room: before.room, note: i ? '另一辆车的备注' : null } }));
  let locked = false;
  const chain = (get: () => unknown) => {
    const qb: any = {};
    for (const key of ['where', 'andWhere', 'orderBy', 'setLock', 'setOnLocked']) qb[key] = () => qb;
    qb.getOne = async () => get();
    qb.getMany = async () => get();
    return qb;
  };
  const repo: any = {
    create: (data: any) => ({ ...data }),
    save: async (task: ParkingOwnerUpdate) => { if (!task.id) { task.id = tasks.length + 1; tasks.push(task); } return task; },
    findOne: async ({ where, lock }: any) => {
      if (lock?.mode === 'pessimistic_write') locked = true;
      return tasks.find((task) => Object.entries(where).every(([key, value]) => task[key] === value)) ?? null;
    },
    createQueryBuilder: () => chain(() => tasks.find((task) => task.status === 'pending') ?? null),
  };
  const manager: any = { getRepository: (entity: unknown) => {
    if (entity === ParkingOwnerUpdate) return repo;
    if (entity === ParkingHistory) return { create: (data: any) => data, save: async (data: any) => { history.push(data); return data; } };
    if (entity === ParkingRecordSnapshot) return { createQueryBuilder: () => chain(() => snapshots), save: async (data: any) => data };
    throw new Error('Unexpected repository');
  } };
  repo.manager = { transaction: async (fn: any) => fn(manager) };
  const service = Object.create(AccessCardIssuanceService.prototype) as AccessCardIssuanceService;
  Object.assign(service, { parkingOwnerUpdateRepo: repo, agentRepo: {
    find: async () => { agent.lastSeenAt = new Date(); return [agent]; }, findOne: async () => agent,
  } });
  return { service, tasks, history, snapshots, repo, secret, agent, locked: () => locked };
}

test('缺失/空车牌在 DTO 与入队前拒绝，不让助手再次遇到缺车牌', async () => {
  for (const plate of [undefined, null, '']) {
    const dto = plainToInstance(CreateParkingOwnerUpdateDto, { ...input(), plate });
    assert.ok((await validate(dto)).some((error) => error.property === 'plate'));
    const h = harness();
    await assert.rejects(h.service.createParkingOwnerUpdate(dto, user), /必须携带当前车辆的车牌/);
    assert.equal(h.tasks.length, 0);
  }
  await assert.rejects(harness().service.createParkingOwnerUpdate({ ...input(), plate: '  ' }, user), /必须携带/);
});

test('缺失表单字段不能被当成清空值，显式 null 仍可提交', async () => {
  const h = harness();
  await assert.rejects(h.service.createParkingOwnerUpdate({ ...input(), values: { phone: '02112345678' } }, user), /缺少/);
  assert.equal(h.tasks.length, 0);
  const task = await h.service.createParkingOwnerUpdate(input(), user);
  assert.equal(task.status, 'pending');
});

test('创建→领取→读回确认→查询贯通车牌，同户多车备注隔离、重复回报仅一条审计', async () => {
  const h = harness();
  const created = await h.service.createParkingOwnerUpdate(input(), user);
  assert.equal(created.plate, '苏K163SM');
  const claimed = await h.service.claimParkingOwnerUpdate(h.agent.agentKey, h.secret.token);
  assert.ok(claimed.task);
  assert.equal(claimed.task.plate, input().plate);
  assert.equal(claimed.task.externalOwnerId, '1851');
  assert.deepEqual(claimed.task.values, after);
  // 可选：把真实 service 的领取报文交给 Windows 自检反序列化，不另外手写一份协议。
  if (process.env.PMS_PARKING_OWNER_CONTRACT) writeFileSync(process.env.PMS_PARKING_OWNER_CONTRACT, JSON.stringify(claimed.task));
  const values = { ...after, note: after.note + '\r\n操作来源：PMS系统' };
  const report = { taskId: created.id, result: 'success' as const, values };
  await h.service.reportParkingOwnerUpdate(h.agent.agentKey, h.secret.token, report);
  await h.service.reportParkingOwnerUpdate(h.agent.agentKey, h.secret.token, report);
  assert.ok(h.locked());
  assert.equal(h.history.length, 1);
  assert.equal(h.history[0].plateAfter, input().plate);
  assert.equal(h.snapshots[0].values.note, after.note + '\n操作来源：PMS系统');
  assert.equal(h.snapshots[1].values.note, '另一辆车的备注');
  assert.equal(h.snapshots[1].values.phone, after.phone);
  assert.equal((await h.service.getParkingOwnerUpdate(created.id, user)).status, 'completed');
});

test('相同提交重发复用原任务；同一幂等键不准改变车牌或更新内容', async () => {
  const h = harness();
  const original = await h.service.createParkingOwnerUpdate(input(), user);
  assert.equal((await h.service.createParkingOwnerUpdate(input(), user)).id, original.id);
  await assert.rejects(h.service.createParkingOwnerUpdate({ ...input(), plate: '沪A007U0' }, user), /已有其他更新内容/);
  await assert.rejects(h.service.createParkingOwnerUpdate({ ...input(), values: { ...after, phone: null } }, user), /已有其他更新内容/);
  assert.equal(h.tasks.length, 1);
});

test('返回任意改动不算成功：读回号码不等于请求时拒绝确认', async () => {
  const h = harness();
  const original = await h.service.createParkingOwnerUpdate(input(), user);
  await h.service.claimParkingOwnerUpdate(h.agent.agentKey, h.secret.token);
  await assert.rejects(h.service.reportParkingOwnerUpdate(h.agent.agentKey, h.secret.token, {
    taskId: original.id, result: 'success', values: { ...after, phone: 'wrong', note: after.note + '\n操作来源：PMS系统' },
  }), /电话.*不一致/);
  assert.equal(h.tasks[0].status, 'running');
  assert.equal(h.history.length, 0);
});

test('其他租户不能读取任务；其他网关不能回报当前租约', async () => {
  const h = harness();
  const original = await h.service.createParkingOwnerUpdate(input(), user);
  await assert.rejects(h.service.getParkingOwnerUpdate(original.id, { ...user, tenantId: 2 }), /不存在/);
  await h.service.claimParkingOwnerUpdate(h.agent.agentKey, h.secret.token);
  h.tasks[0].leaseAgentKey = 'other-gateway';
  await assert.rejects(h.service.reportParkingOwnerUpdate(h.agent.agentKey, h.secret.token, {
    taskId: original.id, result: 'failed', errorMessage: 'test',
  }), /不属于当前网关/);
});

// 显式启用的本机浏览器回归入口：复用真实创建/领取/回报 service，仅仓库为内存。
// 不加载数据库配置、不代理其他请求、不连接现场；模拟已入队但 HTTP 响应丢失。
if (process.env.PMS_OWNER_BROWSER_PORT) {
  const h = harness();
  const submissions: unknown[] = [];
  createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4197');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-client-source');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'OPTIONS') { res.end(); return; }
    const send = (data: unknown) => res.end(JSON.stringify({ code: 0, data }));
    try {
      const path = req.url || '';
      if (path === '/__test/status') { send({ submissions, tasks: h.tasks, history: h.history }); return; }
      if (path.endsWith('/parking/owners/updates') && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const dto = plainToInstance(CreateParkingOwnerUpdateDto, JSON.parse(body));
        assert.deepEqual(await validate(dto), []);
        submissions.push(dto);
        const task = await h.service.createParkingOwnerUpdate(dto, user);
        if (submissions.length === 1) {
          res.statusCode = 503;
          res.end(JSON.stringify({ message: '本机回归：已入队但响应中断' }));
        } else {
          const claimed = await h.service.claimParkingOwnerUpdate(h.agent.agentKey, h.secret.token);
          if (claimed.task) await h.service.reportParkingOwnerUpdate(h.agent.agentKey, h.secret.token, {
            taskId: claimed.task.taskId, result: 'success', values: {
              ...claimed.task.values,
              note: (claimed.task.values.note ? claimed.task.values.note + '\n' : '') + '操作来源：PMS系统',
            },
          });
          send(await h.service.getParkingOwnerUpdate(task.id, user));
        }
        return;
      }
      if (/\/parking\/owners\/updates\/\d+$/.test(path)) {
        send(await h.service.getParkingOwnerUpdate(Number(path.split('/').pop()), user)); return;
      }
      if (path.endsWith('/auth/config')) { send({}); return; }
      res.statusCode = 404; res.end(JSON.stringify({ message: '本机回归不代理此接口' }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    }
  }).listen(Number(process.env.PMS_OWNER_BROWSER_PORT), '127.0.0.1', () => {
    console.log('Parking owner in-memory browser regression API listening (no database connection).');
  });
}
