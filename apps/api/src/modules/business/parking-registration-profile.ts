/** 收费类别不是旧库授权类型：四组均使用月租车，车型分别保留。 */
export function legacyRegistrationProfile(vehicleClass: string): { carType: 1; identity: '住户车' | '租户车' | '亲情车' } | null {
  const value = vehicleClass.trim();
  // 明确否定/未识别名称不能因为含关键词而获得授权；其余保留用户要求的包含匹配。
  if (/未知|未识别|不属于|非(?:住户车|业主车|产权车|租户车|亲情车)/.test(value)) return null;
  const identities = new Set<'住户车' | '租户车' | '亲情车'>();
  if (/住户车|业主车|产权车位|产权车/.test(value)) identities.add('住户车');
  if (value.includes('租户车')) identities.add('租户车');
  if (value.includes('亲情车')) identities.add('亲情车');
  if (identities.size !== 1) return null;
  return { carType: 1, identity: [...identities][0] };
}
