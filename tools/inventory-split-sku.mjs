#!/usr/bin/env node
/**
 * 把某条库存批次拆到另一个 SKU：同名不同规格的货被并进了一个 SKU 时用它补救。
 *
 * 背景（2026-08-31 上海新家期初导入）：纸质清单里「断路器 ¥55×5」和「断路器 ¥20×2」
 * 规格栏是空的，导入按 name+spec 判重并成了一个 SKU 的两条批次。客户确认其实是
 * 两种规格的货 —— 价格不同因为货不同，就该是两个 SKU（docs/inventory-costing.md 的边界）。
 * 反过来「同一种货、不同时间买的不同价」不要用这个工具，那本来就该是同 SKU 多批次。
 *
 * 做什么：把一条批次（stock_lots）连同它的库存数量、盘点流水一起搬到目标 SKU，
 * 然后按剩余批次重算两边的参考成本。全程金额守恒，跑完自动对比各仓总值。
 *
 * 安全阀（不满足直接拒绝，避免把已经发生的领料历史搬乱）：
 *   - 批次必须原封未动（remaining_qty == initial_qty）；
 *   - 批次没有被任何工单领料分摊（work_order_material_allocations）引用；
 *   - 对应的盘点流水能唯一定位（同仓同 SKU 同单价同数量的 adjust 恰好一条），
 *     定位不到就只搬批次和库存并告警，流水留在原 SKU 上人工核对。
 *
 * 用法：
 *   node tools/inventory-split-sku.mjs --lot 46 --name 断路器 --spec 2P小型 \
 *        [--category 电器] [--unit 个] --token <JWT> [--dry-run]
 *   目标 SKU 按 name+spec 找，已有就复用（category/unit 以库里为准），没有就新建。
 *   token 也可以走 PMS_TOKEN。--dry-run 只打印计划。
 */
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const args = {
    api: 'https://prsznh.cn/api/v1',
    token: process.env.PMS_TOKEN || '',
    tenant: '1',
    lot: 0,
    name: '',
    spec: '',
    category: '',
    unit: '',
    sshHost: 'ubuntu@1.15.172.131',
    sshKey: `${process.env.HOME || process.env.USERPROFILE}/.ssh/pms_repair_key.pem`,
    pgContainer: 'pms-postgres',
    pgUser: 'pms',
    pgDb: 'pms_repair',
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--api') args.api = next();
    else if (key === '--token') args.token = next();
    else if (key === '--tenant') args.tenant = next();
    else if (key === '--lot') args.lot = Number(next());
    else if (key === '--name') args.name = next();
    else if (key === '--spec') args.spec = next();
    else if (key === '--category') args.category = next();
    else if (key === '--unit') args.unit = next();
    else if (key === '--ssh-host') args.sshHost = next();
    else if (key === '--ssh-key') args.sshKey = next();
    else if (key === '--pg-container') args.pgContainer = next();
    else if (key === '--pg-user') args.pgUser = next();
    else if (key === '--pg-db') args.pgDb = next();
    else if (key === '--dry-run') args.dryRun = true;
    else throw new Error(`未知参数：${key}`);
  }
  if (!args.lot || !Number.isInteger(args.lot)) throw new Error('必须指定 --lot <批次 id>');
  if (!args.name) throw new Error('必须指定 --name <目标 SKU 名称>');
  if (!args.spec) throw new Error('必须指定 --spec <目标 SKU 规格>（拆分的意义就是把规格补全，别再留空）');
  if (!args.token && !args.dryRun) throw new Error('必须指定 --token 或设置 PMS_TOKEN');
  return args;
}

const args = parseArgs(process.argv);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${args.api}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
      'x-acting-tenant-id': args.tenant,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

function runSql(sql) {
  return execFileSync(
    'ssh',
    [
      '-i', args.sshKey,
      args.sshHost,
      `sudo -n docker exec -i ${args.pgContainer} psql -U ${args.pgUser} -d ${args.pgDb} -v ON_ERROR_STOP=1 -qAt -F'|' -f -`,
    ],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

/** SQL 里只允许拼数字，名称/规格一律走 API，不进 SQL */
const int = (value, label) => {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} 不是整数：${value}`);
  return n;
};

const yuan = (cents) => `¥${(cents / 100).toFixed(2)}`;

function warehouseTotals() {
  const out = runSql(`
    SELECT s.warehouse_id,
           SUM(COALESCE(l.value,0) + GREATEST(s.qty - COALESCE(l.remaining,0), 0) * m.default_cost_cents)::bigint
    FROM stocks s
    JOIN materials m ON m.id=s.material_id
    LEFT JOIN (SELECT warehouse_id, material_id, SUM(remaining_qty) AS remaining, SUM(remaining_qty*unit_cost_cents) AS value
               FROM stock_lots WHERE tenant_id=${int(args.tenant, 'tenant')} AND remaining_qty>0 GROUP BY 1,2) l
      ON l.warehouse_id=s.warehouse_id AND l.material_id=s.material_id
    WHERE s.tenant_id=${int(args.tenant, 'tenant')} AND s.qty>0
    GROUP BY 1 ORDER BY 1;`);
  return out;
}

async function main() {
  const tenant = int(args.tenant, 'tenant');
  const lotId = int(args.lot, 'lot');

  // 1. 批次现状 + 安全阀
  const lotRow = runSql(`
    SELECT l.id, l.warehouse_id, l.material_id, l.initial_qty, l.remaining_qty, l.unit_cost_cents,
           m.name, COALESCE(m.spec,''), m.category, m.unit,
           (SELECT COUNT(*) FROM work_order_material_allocations a WHERE a.tenant_id=${tenant} AND a.stock_lot_id=l.id)
    FROM stock_lots l JOIN materials m ON m.id=l.material_id
    WHERE l.tenant_id=${tenant} AND l.id=${lotId};`);
  if (!lotRow) throw new Error(`找不到批次 #${lotId}`);
  const [, warehouseId, fromMaterialId, initialQty, remainingQty, unitCostCents, fromName, fromSpec, fromCategory, fromUnit, allocCount] = lotRow.split('|');
  if (Number(allocCount) > 0) throw new Error(`批次 #${lotId} 已被 ${allocCount} 条工单领料分摊引用，搬走会把领料历史搬乱，拒绝执行`);
  if (Number(remainingQty) !== Number(initialQty)) throw new Error(`批次 #${lotId} 已被部分领用（${remainingQty}/${initialQty}），拒绝执行`);
  const qty = Number(remainingQty);
  console.log(`源批次   #${lotId}：${fromName}${fromSpec ? ' / ' + fromSpec : ''} × ${qty} @ ${yuan(Number(unitCostCents))}（仓 #${warehouseId}，SKU #${fromMaterialId}）`);

  // 2. 目标 SKU：name+spec 判重复用，否则新建
  const materials = await api('/materials');
  const key = (name, spec) => `${String(name).trim()}|${String(spec ?? '').trim()}`;
  let target = materials.find((m) => key(m.name, m.spec) === key(args.name, args.spec));
  if (target) {
    console.log(`目标 SKU 复用：${target.code} ${target.name} / ${target.spec}（#${target.id}）`);
  } else if (args.dryRun) {
    console.log(`[dry-run] 将新建 SKU：${args.name} / ${args.spec}（${args.category || fromCategory} · ${args.unit || fromUnit}），参考成本 ${yuan(Number(unitCostCents))}`);
  } else {
    target = await api('/materials', {
      method: 'POST',
      body: {
        name: args.name.trim(),
        spec: args.spec.trim(),
        category: args.category || fromCategory,
        unit: args.unit || fromUnit,
        defaultCostCents: Number(unitCostCents),
      },
    });
    console.log(`目标 SKU 新建：${target.code} ${target.name} / ${target.spec}（#${target.id}）`);
  }
  if (target && target.id === Number(fromMaterialId)) throw new Error('目标 SKU 和源 SKU 是同一个，没有可拆的');

  // 3. 对应盘点流水（唯一才搬）
  const movementIds = runSql(`
    SELECT id FROM stock_movements
    WHERE tenant_id=${tenant} AND warehouse_id=${int(warehouseId, 'warehouse')} AND material_id=${int(fromMaterialId, 'material')}
      AND type='adjust' AND unit_cost_cents=${int(unitCostCents, 'cost')} AND qty=${qty} AND ref_type='stock';`)
    .split('\n').filter(Boolean);
  const movementId = movementIds.length === 1 ? int(movementIds[0], 'movement') : null;
  if (!movementId) console.warn(`⚠ 流水定位到 ${movementIds.length} 条（期望 1），流水不搬，留在原 SKU 上人工核对`);

  if (args.dryRun) {
    console.log(`[dry-run] 计划：批次 #${lotId} → 目标 SKU；库存 −${qty}/+${qty}；流水 ${movementId ? '#' + movementId + ' 跟着搬' : '不动'}；两边参考成本按剩余批次重算`);
    return;
  }

  // 4. 一个事务里搬批次、库存、流水，重算参考成本
  const before = warehouseTotals();
  runSql(`
BEGIN;
UPDATE stock_lots SET material_id=${target.id} WHERE tenant_id=${tenant} AND id=${lotId} AND remaining_qty=initial_qty;
UPDATE stocks SET qty = qty - ${qty} WHERE tenant_id=${tenant} AND warehouse_id=${int(warehouseId, 'warehouse')} AND material_id=${int(fromMaterialId, 'material')} AND qty >= ${qty};
INSERT INTO stocks (tenant_id, warehouse_id, material_id, qty, safety_qty, location_id)
SELECT ${tenant}, ${int(warehouseId, 'warehouse')}, ${target.id}, ${qty}, 0, s.location_id
FROM stocks s WHERE s.tenant_id=${tenant} AND s.warehouse_id=${int(warehouseId, 'warehouse')} AND s.material_id=${int(fromMaterialId, 'material')}
ON CONFLICT (warehouse_id, material_id) DO UPDATE SET qty = stocks.qty + EXCLUDED.qty;
${movementId ? `UPDATE stock_movements SET material_id=${target.id} WHERE tenant_id=${tenant} AND id=${movementId};` : ''}
UPDATE materials m SET default_cost_cents = sub.avg
FROM (SELECT material_id, ROUND(SUM(remaining_qty*unit_cost_cents)/NULLIF(SUM(remaining_qty),0))::int AS avg
      FROM stock_lots WHERE tenant_id=${tenant} AND remaining_qty>0 AND material_id IN (${int(fromMaterialId, 'material')}, ${target.id})
      GROUP BY material_id) sub
WHERE m.tenant_id=${tenant} AND m.id=sub.material_id;
COMMIT;`);
  const after = warehouseTotals();

  // 5. 金额守恒校验：拆分只是换个 SKU 挂法，各仓总值一分都不能变
  if (before !== after) {
    console.error(`❌ 各仓总值发生了变化！\n拆前：\n${before}\n拆后：\n${after}\n立刻人工核对 stock_lots/stocks。`);
    process.exit(1);
  }
  console.log(`完成。各仓总值未变：\n${after.split('\n').map((line) => {
    const [wid, cents] = line.split('|');
    return `  仓 #${wid}：${yuan(Number(cents))}`;
  }).join('\n')}`);
  console.log(`源 SKU #${fromMaterialId} 现存与目标 SKU #${target.id} 的数量/金额请在后台「库存与采购」页复核一眼。`);
}

main().catch((err) => {
  console.error(`拆分失败：${err.message}`);
  process.exit(1);
});
