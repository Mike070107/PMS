import { request } from '@pms/api-client';

export async function propertyCarBillingClass(plate: string) {
  const rules = await request<Array<{ enabled: boolean; serviceType: string; config?: { vehicleClass?: string } }>>({ url: '/business/rules' });
  const classes = new Set(rules.filter(rule => rule.enabled && rule.serviceType === 'parking_monthly')
    .map(rule => rule.config?.vehicleClass).filter(value => value === '产权车' || value === '产权车位'));
  if (!classes.size) throw new Error('请先启用产权车收费分组');
  if (classes.size === 1) return [...classes][0]!;
  const current = await readPlateBillingClass(plate);
  if (current === '产权车' || current === '产权车位') return current;
  throw new Error('已启用两个产权车收费分组，请先核对收费规则');
}

export async function readPlateBillingClass(plate: string) {
  const tags = await request<Array<{ vehicleClass: string }>>({ url: '/business/plate-tags', query: { plates: plate } });
  return tags[0]?.vehicleClass;
}
