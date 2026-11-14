import { BadRequestException } from '@nestjs/common';

export const VEHICLE_IDENTITIES = ['住户车', '租户车', '亲情车'];
export function requiresVehiclePreservation(kind: string): boolean {
  return kind === 'change_plate' || kind === 'update_vehicle_type';
}
export function validatePreservedOperation(kind: string, payload: Record<string, unknown>, sourceRecordId?: string) {
  if (!requiresVehiclePreservation(kind)) return;
  if (!sourceRecordId?.trim()) throw new BadRequestException('缺少车辆记录编号，请重新查询');
  const allowed = kind === 'change_plate' ? ['plate', 'newPlate', 'batchId', 'sourceQueryId'] : ['plate', 'ownerRoom', 'identity'];
  if (Object.keys(payload).some(key => !allowed.includes(key)))
    throw new BadRequestException('此操作不允许携带其他车辆字段；换牌不能修改车型或计费类别');
  if (!String(payload.plate || '').trim()) throw new BadRequestException('原车牌不能为空');
  if (kind === 'change_plate') {
    if (!String(payload.newPlate || '').trim() || plateKey(payload.plate) === plateKey(payload.newPlate))
      throw new BadRequestException('新车牌不能为空或与原车牌相同');
    payload.plate = plateKey(payload.plate); payload.newPlate = plateKey(payload.newPlate);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(payload.batchId || '')) || !Number.isSafeInteger(Number(payload.sourceQueryId)) || Number(payload.sourceQueryId) <= 0)
      throw new BadRequestException('换牌必须提供原批次编号和真实双库查询凭据');
  } else if (!VEHICLE_IDENTITIES.includes(String(payload.identity))) {
    throw new BadRequestException('车型只接受住户车、租户车或亲情车文字值');
  }
}
export function plateKey(value: unknown): string { return String(value || '').replace(/[\s·.．・-]/g, '').toUpperCase(); }

/** Exact JSON values, including null, are compared; no alias fallback or display labels. */
export function assertPreservedReceipt(task: { kind: string; database: string; sourceRecordId: string | null; payload: Record<string, unknown> }, values: Record<string, any>) {
  const fail = () => { throw new BadRequestException('助手未返回完整一致的车辆原值保护回执，不能标为成功'); };
  if (values.verified !== true || values.preserved !== true || values.preservationContract !== 1 ||
      values.database !== task.database || String(values.issueId) !== task.sourceRecordId ||
      values.plate !== (task.kind === 'change_plate' ? task.payload.newPlate : task.payload.plate)) fail();
  const before = values.before, after = values.after;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return fail();
  for (const key of ['P_id', 'P_plate', 'Car_Lei', 'Owner_ID', 'End_Time', 'Sart_Time', 'Car_Money', 'Car_Deposit', 'Car_Zt', 'Car_ID', 'P_Color', 'P_note', 'P_Effective', 'P_Download', 'P_Spaces'])
    if (!Object.prototype.hasOwnProperty.call(before, key) || !Object.prototype.hasOwnProperty.call(after, key)) fail();
  if (!Object.prototype.hasOwnProperty.call(before, 'Car_Brand') && !Object.prototype.hasOwnProperty.call(before, 'Car_Beand')) fail();
  for (const row of [before, after]) if ('Car_Brand' in row && 'Car_Beand' in row && row.Car_Brand !== row.Car_Beand) fail();
  if (String(before.P_id) !== task.sourceRecordId || String(after.P_id) !== task.sourceRecordId || before.P_plate !== task.payload.plate || after.P_plate !== values.plate) fail();
  for (const key of Object.keys(before)) {
    if (key.toLowerCase() === 'p_admin') continue;
    if (task.kind === 'change_plate' && key === 'P_plate') continue;
    if (task.kind === 'update_vehicle_type' && ['Car_Brand', 'Car_Beand'].includes(key)) {
      if (after[key] !== task.payload.identity) fail();
    } else if (!(key in after) || JSON.stringify(before[key]) !== JSON.stringify(after[key])) fail();
  }
  if (task.kind === 'change_plate' && values.previousPlate !== task.payload.plate) fail();
}
