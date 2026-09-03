#!/usr/bin/env node
/**
 * 上线前核对报告：「工单用料 — 库存流水 — FIFO 批次」三者对不对得上。
 *
 * 为什么要有：撤回改造（迁移 1789088400000）给历史用料补了 legacy_issue 来源和兼容完工批次，
 * 但**没有也不允许**去动任何库存数量。批次分摊缺失、流水丢失这类历史脏数据，
 * 迁移里悄悄补一笔就是在编账 —— 必须列成清单交给管理员逐条核对。
 *
 * 撤回退料要求「按原 FIFO 分摊精确退回原批次」；分摊对不上的用料在撤回时会被服务端
 * 直接拒绝（见 RepairsService.checkUsageReturnable）。这份报告就是提前把这些单找出来，
 * 免得办公室点了撤回才发现撤不了。
 *
 * 只读，不写任何数据。
 *
 * 用法（在能连到数据库的机器上跑，读 apps/api/.env 里的同一组 DB_* 变量）：
 *   node tools/work-order-material-audit.mjs
 *   node tools/work-order-material-audit.mjs --tenant 1 --json > audit.json
 *
 * 退出码：发现异常记录时为 1，全部对得上为 0（可以挂进上线前的检查脚本）。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const apiDir = path.join(repoRoot, 'apps', 'api');
const require = createRequire(path.join(apiDir, 'package.json'));

/** apps/api/.env 和进程环境合并；进程环境优先，方便临时覆盖 */
function loadEnv() {
  const envPath = path.join(apiDir, '.env');
  const fromFile = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      fromFile[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...fromFile, ...process.env };
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const tenantArg = args.indexOf('--tenant');
const tenantId = tenantArg >= 0 ? Number(args[tenantArg + 1]) : null;

const env = loadEnv();
const { Client } = require('pg');
const client = new Client({
  host: env.DB_HOST ?? 'localhost',
  port: Number(env.DB_PORT ?? 5432),
  user: env.DB_USER ?? 'pms',
  password: env.DB_PASS ?? '',
  database: env.DB_NAME ?? 'pms_repair',
});

const tenantFilter = tenantId ? 'AND m.tenant_id = $1' : '';
const params = tenantId ? [tenantId] : [];

/**
 * 每一项都是「撤回时会被拒绝」或「账面解释不通」的情况。
 * 分开列而不是合成一个总数：管理员要按类型决定怎么处理，混在一起没法分工。
 */
const CHECKS = [
  {
    key: 'allocation_missing',
    title: '用料没有任何 FIFO 批次分摊记录',
    hint: '撤回/作废时无法还原原批次，服务端会拒绝退料。需人工确认当初扣的是哪批货。',
    sql: `
      SELECT m.id, m.tenant_id, m.work_order_id, wo.order_no, m.material_id, mat.name AS material_name,
             m.warehouse_id, m.qty, m.status, m.source_action
        FROM work_order_materials m
        JOIN work_orders wo ON wo.id = m.work_order_id AND wo.tenant_id = m.tenant_id
        LEFT JOIN materials mat ON mat.id = m.material_id AND mat.tenant_id = m.tenant_id
       WHERE NOT EXISTS (
               SELECT 1 FROM work_order_material_allocations a
                WHERE a.tenant_id = m.tenant_id AND a.work_order_material_id = m.id
             )
         ${tenantFilter}
       ORDER BY m.tenant_id, m.id`,
  },
  {
    key: 'allocation_mismatch',
    title: '分摊数量和用料数量对不上',
    hint: '差额部分退不回去。核对当初的出库单据后由管理员补齐或标注。',
    sql: `
      SELECT m.id, m.tenant_id, m.work_order_id, wo.order_no, m.material_id, mat.name AS material_name,
             m.qty, SUM(a.qty) AS allocated_qty, m.status
        FROM work_order_materials m
        JOIN work_orders wo ON wo.id = m.work_order_id AND wo.tenant_id = m.tenant_id
        LEFT JOIN materials mat ON mat.id = m.material_id AND mat.tenant_id = m.tenant_id
        JOIN work_order_material_allocations a
          ON a.tenant_id = m.tenant_id AND a.work_order_material_id = m.id
       WHERE TRUE ${tenantFilter}
       GROUP BY m.id, m.tenant_id, m.work_order_id, wo.order_no, m.material_id, mat.name, m.qty, m.status
      HAVING ABS(SUM(a.qty) - m.qty) > 0.005
       ORDER BY m.tenant_id, m.id`,
  },
  {
    key: 'lot_gone',
    title: '分摊指向的库存批次已经不存在',
    hint: '批次被删过或来自更早的数据迁移。退料时无处可还，撤回会被拒绝。',
    sql: `
      SELECT DISTINCT m.id, m.tenant_id, m.work_order_id, wo.order_no, a.stock_lot_id
        FROM work_order_materials m
        JOIN work_orders wo ON wo.id = m.work_order_id AND wo.tenant_id = m.tenant_id
        JOIN work_order_material_allocations a
          ON a.tenant_id = m.tenant_id AND a.work_order_material_id = m.id
        LEFT JOIN stock_lots l ON l.id = a.stock_lot_id
       WHERE l.id IS NULL ${tenantFilter}
       ORDER BY m.tenant_id, m.id`,
  },
  {
    key: 'movement_missing',
    title: '用料没有对应的出库流水',
    hint: '库存台账里看不到这笔扣减。属于批次机制之前的历史数据，只标注、不补账。',
    sql: `
      SELECT m.id, m.tenant_id, m.work_order_id, wo.order_no, m.material_id, mat.name AS material_name,
             m.warehouse_id, m.qty, m.created_at, m.source_action
        FROM work_order_materials m
        JOIN work_orders wo ON wo.id = m.work_order_id AND wo.tenant_id = m.tenant_id
        LEFT JOIN materials mat ON mat.id = m.material_id AND mat.tenant_id = m.tenant_id
       WHERE NOT EXISTS (
               SELECT 1 FROM stock_movements sm
                WHERE sm.tenant_id = m.tenant_id
                  AND sm.material_id = m.material_id
                  AND sm.warehouse_id = m.warehouse_id
                  AND sm.type = 'outbound'
                  AND sm.ref_type IN ('work_order', 'work_order_complete')
                  AND sm.ref_id = m.work_order_id
             )
         ${tenantFilter}
       ORDER BY m.tenant_id, m.id`,
  },
  {
    key: 'reversed_without_return',
    title: '已标记冲销但没有退料流水',
    hint: '库存可能少还了一笔。核对 stock_movements 后处理。',
    sql: `
      SELECT m.id, m.tenant_id, m.work_order_id, wo.order_no, m.qty, m.reversed_at, m.reverse_reason
        FROM work_order_materials m
        JOIN work_orders wo ON wo.id = m.work_order_id AND wo.tenant_id = m.tenant_id
       WHERE m.status = 'reversed' AND m.reversal_movement_id IS NULL ${tenantFilter}
       ORDER BY m.tenant_id, m.id`,
  },
  {
    key: 'multi_active_batch',
    title: '同一工单有多个生效中的完工批次',
    hint: '正常只该有一个。出现多条说明并发写入没挡住，需人工确认哪一次才是当前有效的完工。',
    sql: `
      SELECT m.tenant_id, m.work_order_id, wo.order_no, COUNT(*)::int AS active_batches
        FROM work_order_completion_batches m
        JOIN work_orders wo ON wo.id = m.work_order_id AND wo.tenant_id = m.tenant_id
       WHERE m.status = 'active' ${tenantFilter}
       GROUP BY m.tenant_id, m.work_order_id, wo.order_no
      HAVING COUNT(*) > 1
       ORDER BY m.tenant_id, m.work_order_id`,
  },
];

async function main() {
  await client.connect();
  const report = { generatedAt: new Date().toISOString(), tenantId, sections: [] };
  let problems = 0;
  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql, params);
    problems += rows.length;
    report.sections.push({ key: check.key, title: check.title, hint: check.hint, count: rows.length, rows });
  }
  await client.end();

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`工单用料核对报告  ${report.generatedAt}${tenantId ? `  租户 #${tenantId}` : '  （全部租户）'}`);
    console.log('='.repeat(72));
    for (const section of report.sections) {
      console.log(`\n[${section.count === 0 ? 'OK ' : '异常'}] ${section.title}：${section.count} 条`);
      if (!section.count) continue;
      console.log(`      ${section.hint}`);
      for (const row of section.rows.slice(0, 50)) {
        console.log(`      ${JSON.stringify(row)}`);
      }
      if (section.rows.length > 50) console.log(`      …… 其余 ${section.rows.length - 50} 条见 --json 输出`);
    }
    console.log(
      problems
        ? `\n共 ${problems} 条需要人工核对。**不要**为了让报告变干净直接改库存数量或删历史。`
        : '\n三者完全对得上，可以上线。',
    );
  }
  process.exit(problems ? 1 : 0);
}

main().catch((error) => {
  console.error(`核对失败：${error.message}`);
  process.exit(2);
});
