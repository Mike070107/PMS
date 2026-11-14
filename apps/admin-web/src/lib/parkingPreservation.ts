import { accessCardIssuance as api } from '@pms/api-client';

type Target = { database: 'parking1' | 'parking2'; sourceRecordId: string; id?: number };
type Plan = { kind: 'change_plate' | 'update_vehicle_type'; batchId: string; plate: string; payload: Record<string, unknown>;
  targets: Target[]; cloudId: string | null; cloudDone?: boolean };
const normalize = (value: unknown) => String(value ?? '').replace(/[\s·.．・-]/g, '').toUpperCase();
const wait = () => new Promise<void>(resolve => window.setTimeout(resolve, 800));
const newKey = () => `preserve-${Date.now()}-${crypto.randomUUID()}`;

/** Legacy entry uses immutable, persisted original requests, not a new task after timeout. */
export async function runPreservedParkingOperation(args: {
  scope: string; kind: Plan['kind']; plate: string; database: Target['database']; sourceRecordId: string;
  payload: Record<string, unknown>; cloudKnown: boolean; cloudId: string | null;
  recordOf: (row: api.ParkingQueryRow) => Target & { plate: string };
  onTask: (task: api.ParkingOperation) => void;
}) {
  const plate = normalize(args.plate), key = `pms-legacy-preservation-v1:${args.scope}:${args.kind}:${plate}`;
  let plan: Plan | null = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) { plan = JSON.parse(raw); if (!plan || plan.kind !== args.kind || plan.plate !== plate || !plan.batchId || !Array.isArray(plan.targets) || !plan.targets.length) throw new Error(); }
  } catch { throw new Error('原请求记录无法读取，已禁止新提交；请核对办理记录'); }
  const persist = (p: Plan) => localStorage.setItem(key, JSON.stringify(p));
  if (plan) {
    if (args.kind === 'change_plate' ? normalize(args.payload.newPlate) !== plan.payload.newPlate : args.payload.identity !== plan.payload.identity ||
      plan.targets[0].database !== args.database || plan.targets[0].sourceRecordId !== args.sourceRecordId)
      throw new Error(`尚有原请求未确认：${args.kind === 'change_plate' ? `新牌 ${plan.payload.newPlate}` : `${plan.targets[0].database} 车型 ${plan.payload.identity}`}。请恢复原输入核对原任务，不要创建新任务`);
  } else {
    if (!args.sourceRecordId) throw new Error('缺少原记录编号，请重新查询');
    if (args.kind === 'change_plate' && !args.cloudKnown) throw new Error('人防状态未知，已停止换牌，请重新查询');
    const batchId = newKey();
    let payload: Record<string, unknown>, targets: Target[];
    if (args.kind === 'change_plate') {
      const newPlate = normalize(args.payload.newPlate);
      if (newPlate.length < 6 || newPlate === plate) throw new Error('请输入不同的有效新车牌');
      let query = await api.createParkingQuery(plate);
      for (let i = 0; !['completed', 'failed'].includes(query.status) && i < 90; i++) { await wait(); query = await api.parkingQuery(query.id); }
      if (query.status !== 'completed') throw new Error('双库原牌查询未完成，没有提交换牌');
      targets = query.rows.map(args.recordOf).filter(t => normalize(t.plate) === plate).map(({ database, sourceRecordId }) => ({ database, sourceRecordId }));
      if (!targets.length || targets.some(t => !t.sourceRecordId) || new Set(targets.map(t => t.database)).size !== targets.length ||
          !targets.some(t => t.database === args.database && t.sourceRecordId === args.sourceRecordId)) throw new Error('原牌来源缺失、重复或已变化，请重新查询');
      payload = { plate, newPlate, batchId, sourceQueryId: query.id };
    } else {
      if (!['住户车', '租户车', '亲情车'].includes(String(args.payload.identity))) throw new Error('请选择允许的车型文字值');
      targets = [{ database: args.database, sourceRecordId: args.sourceRecordId }];
      payload = { plate, ownerRoom: args.payload.ownerRoom, identity: args.payload.identity };
    }
    plan = { kind: args.kind, batchId, plate, payload, targets, cloudId: args.kind === 'change_plate' ? args.cloudId : null };
    persist(plan); // Must succeed before first POST.
  }
  for (const target of plan.targets) {
    let task = target.id ? await api.parkingOperation(target.id) : await api.createParkingOperation({
      database: target.database, kind: plan.kind, sourceRecordId: target.sourceRecordId,
      idempotencyKey: `${plan.batchId}-${target.database}`, payload: plan.payload,
    });
    const check = (value: api.ParkingOperation) => {
      if (value.kind !== plan!.kind || value.database !== target.database || value.sourceRecordId !== target.sourceRecordId ||
          Object.keys(plan!.payload).some(k => value.payload[k] !== plan!.payload[k])) throw new Error('原任务目标不一致，已停止核对');
      args.onTask(value);
    };
    check(task); target.id = task.id; persist(plan);
    for (let i = 0; ['pending', 'running'].includes(task.status) && i < 112; i++) { await wait(); task = await api.parkingOperation(task.id); check(task); }
    if (task.status !== 'completed') throw new Error(`原任务 #${task.id} ${task.status === 'failed' ? `失败：${task.error || '未执行成功'}` : '结果未知'}；已保留原请求，不能重办已成功来源`);
    if (task.result?.verified !== true || task.result.preserved !== true || task.result.preservationContract !== 1 ||
        task.result.database !== target.database || String(task.result.issueId) !== target.sourceRecordId ||
        task.result.plate !== (plan.payload.newPlate || plate)) throw new Error('原值保护回执不完整，原请求已保留');
  }
  if (plan.cloudId && !plan.cloudDone) {
    const cloudTask = await api.changeDeliyunPlate({ vehicleId: plan.cloudId, plate, newPlate: String(plan.payload.newPlate), idempotencyKey: `${plan.batchId}-deliyun` });
    args.onTask(cloudTask);
    if (cloudTask.status !== 'completed' || cloudTask.result?.verified !== true || cloudTask.sourceRecordId !== plan.cloudId ||
        cloudTask.payload.plate !== plate || cloudTask.payload.newPlate !== plan.payload.newPlate)
      throw new Error(`旧库已完成，人防原任务 #${cloudTask.id} 尚未成功：${cloudTask.error || '结果未知'}；请核对原任务，不会重办旧库`);
    plan.cloudDone = true; persist(plan);
  }
  let query = await api.createParkingQuery(String(plan.payload.newPlate || plate));
  for (let i = 0; !['completed', 'failed'].includes(query.status) && i < 90; i++) { await wait(); query = await api.parkingQuery(query.id); }
  if (query.status !== 'completed') throw new Error('写后独立查询未完成，原请求已保留');
  for (const target of plan.targets) {
    const hits = query.rows.map(args.recordOf).filter(t => t.database === target.database && normalize(t.plate) === String(plan!.payload.newPlate || plate));
    if (hits.length !== 1 || hits[0].sourceRecordId !== target.sourceRecordId) throw new Error('写后原记录独立读回不一致，请核对原任务');
    if (plan.kind === 'update_vehicle_type') {
      const row = query.rows.find(r => r.database === target.database && args.recordOf(r).sourceRecordId === target.sourceRecordId)!;
      const identities = Object.entries(row.fields).filter(([name]) => ['carbrand', 'carbeand', 'identity', '车型', '车辆类型'].includes(name.replace(/_/g, '').toLowerCase()));
      if (!identities.length || identities.some(([, value]) => value !== plan!.payload.identity)) throw new Error('车型独立读回不一致，原请求已保留');
    }
  }
  localStorage.removeItem(key);
  return String(plan.payload.newPlate || plate);
}
