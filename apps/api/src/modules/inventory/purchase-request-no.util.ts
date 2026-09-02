import type { EntityManager } from 'typeorm';

/** 每日从 001 开始的短采购申请号：PR-260902-001。 */
export async function nextPurchaseRequestNo(
  manager: EntityManager,
  tenantId: number,
  now = new Date(),
): Promise<string> {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const yy = parts.year;
  const mm = parts.month;
  const dd = parts.day;
  const prefix = `PR-${yy}${mm}${dd}-`;
  // 同一租户同一天串行取号，避免两个维修工同时提报拿到同号。
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `purchase-request-no:${tenantId}:${yy}${mm}${dd}`,
  ]);
  const rows = await manager.query(
    'SELECT request_no FROM purchase_requests WHERE tenant_id = $1 AND request_no LIKE $2',
    [tenantId, `${prefix}%`],
  );
  const max = (rows as Array<{ request_no: string }>).reduce((value, row) => {
    const match = String(row.request_no || '').match(/-(\d+)$/);
    return Math.max(value, match ? Number(match[1]) || 0 : 0);
  }, 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
