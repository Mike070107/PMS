import { BadRequestException } from '@nestjs/common';
import type { ParkingProofUpload } from '../../entities';

export const DEFAULT_PARKING_RATES = {
  owner: { 1: 180, 2: 360, 3: 540, 6: 1080, 12: 1800 },
  tenant: { 1: 260, 2: 520, 3: 780, 6: 1560, 12: 2760 },
};
export function supportsFamilyActivation(version: string | null | undefined) {
  const parts = (version || '').split('.').slice(0, 3).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) && parts.reduce((sum, n, index) => sum + n * [1000000, 1000, 1][index], 0) >= 2005040;
}
export function normalizeParkingRates(value: Record<string, any>) {
  const result: Record<string, Record<string, number>> = {};
  for (const identity of ['owner', 'tenant']) {
    result[identity] = {};
    for (const month of [1, 2, 3, 6, 12]) {
      const amount = value?.[identity]?.[month];
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1000000 || Math.abs(Math.round(amount * 100) - amount * 100) > 0.00001)
        throw new BadRequestException(`${identity === 'owner' ? '业主车' : '租户车'} ${month} 个月金额须为 0 至 1000000 元，最多两位小数`);
      result[identity][month] = amount;
    }
  }
  return result;
}
export function prepareFamilyRegistration(payload: Record<string, unknown>, proof: ParkingProofUpload | null) {
  if (payload.identity !== '亲情车') return;
  if (!proof || proof.plate !== String(payload.plate).trim().toUpperCase() || proof.registrationId)
    throw new BadRequestException('亲情车须先生成当前车牌的上传二维码');
  const garages = Array.isArray(payload.garages) ? payload.garages : [];
  if (!garages.length || garages.some((key) => !['phase1', 'phase2', 'main', 'civil'].includes(String(key))))
    throw new BadRequestException('请选择亲情车审核后开通的目标车库');
  Object.assign(payload, { requiresProofReview: true, state: 0, amount: 0, effective: '0'.repeat(256), download: '0'.repeat(256) });
}

export function validateRegistrationGarageNumbers(payload: Record<string, unknown>) {
  const garages = Array.isArray(payload.garages) ? payload.garages : [];
  const supplied = (payload.garageNumbers || {}) as Record<string, unknown>;
  const numbers: Record<string, string> = {};
  for (const key of ['main', 'civil']) {
    if (!garages.includes(key)) continue;
    const value = typeof supplied[key] === 'string' ? supplied[key].trim() : '';
    if (!value || value.length > 20) throw new BadRequestException(`请填写${key === 'main' ? '二期大车库' : '二期人防车库'}车库号（最多20字）`);
    numbers[key] = value;
  }
  payload.garageNumbers = numbers;
  payload.spaces = numbers.main || '';
}
