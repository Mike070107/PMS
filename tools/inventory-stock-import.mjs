#!/usr/bin/env node
/**
 * 期初库存导入：把纸质 / 表格的库存清单一次性补录进某个仓。
 *
 * 为什么不是「一般入库」：POST /goods-receipts/general 要求每种材料至少一张实物照片
 * （证明零星采买真买了东西），补录历史存量没有照片。系统里给这件事准备的入口是
 * **盘点调整**（PATCH /stocks/:id，后台库存页「调整原因」的示例文案就是「系统上线前存量补录」），
 * 它会建批次、落流水、刷新 SKU 参考成本，全部走 stock-ledger 的口径。
 *
 * 唯一绕过 API 的一步：`stocks` 空行（qty=0）。系统里没有「把这个 SKU 加进这个仓」的接口，
 * 库存行只能由入库动作顺带建出来。空行不含任何数量 / 金额语义，建完之后所有数量和成本
 * 都由 PATCH /stocks/:id 产生，批次、流水、参考成本一条不漏。
 *
 * 同一材料多个单价：先分清是哪种情况（docs/inventory-costing.md「价格不同 ≠ 多批次」）——
 *   同一种货、不同时间买的不同价 → 同一 SKU 多条批次，加 --allow-multi-price 确认后导入；
 *   其实是不同规格的货、清单没写规格 → 把 spec 补全再导，别并进一个 SKU。
 * 默认遇到「同名同规格多个单价」直接停下来要求二选一（2026-08-31 上海新家踩过：
 *   断路器 ¥55/¥20 其实是两种规格，并成一个 SKU 后客户对不上，拆分用 inventory-split-sku.mjs）。
 *
 * 用法：
 *   node tools/inventory-stock-import.mjs --file data-prep/inventory-opening-xxx.json \
 *        --token <JWT> [--api https://prsznh.cn/api/v1] [--tenant 1] [--dry-run] [--force]
 *   token 也可以走 PMS_TOKEN 环境变量。--dry-run 只打印计划，不写任何数据。
 *
 * 安全阀：目标仓里已经有库存（qty > 0）的 SKU 默认跳过并告警，避免重跑把存量算两遍；
 * 确认要覆盖时才加 --force（--force 下清单数量视为「盘点后的实际数量」，可能产生盘亏）。
 *
 * 输入格式（清单本身放 data-prep/，那个目录已在 .gitignore 里，别把客户数据提交进仓库）：
 *   {
 *     "warehouse": "上海新家管理处",            // 也可以写 "warehouseId": 5
 *     "sourceNote": "系统上线前存量补录（纸质库存清单）",
 *     "items": [
 *       { "category": "电器", "name": "断路器", "spec": "", "unit": "个", "unitPrice": 55, "qty": 5 },
 *       { "category": "电器", "name": "断路器", "spec": "", "unit": "个", "unitPrice": 20, "qty": 2 }
 *     ]
 *   }
 *   name + spec 与库里已有 SKU 相同就直接复用（与服务端 assertMaterialUnique 同口径），
 *   单位和类别以库里为准，不会被清单覆盖。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const args = {
    api: 'https://prsznh.cn/api/v1',
    token: process.env.PMS_TOKEN || '',
    tenant: '1',
    file: '',
    out: '',
    sshHost: 'ubuntu@1.15.172.131',
    sshKey: `${process.env.HOME || process.env.USERPROFILE}/.ssh/pms_repair_key.pem`,
    pgContainer: 'pms-postgres',
    pgUser: 'pms',
    pgDb: 'pms_repair',
    dryRun: false,
    force: false,
    allowMultiPrice: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--api') args.api = next();
    else if (key === '--token') args.token = next();
    else if (key === '--tenant') args.tenant = next();
    else if (key === '--file') args.file = next();
    else if (key === '--out') args.out = next();
    else if (key === '--ssh-host') args.sshHost = next();
    else if (key === '--ssh-key') args.sshKey = next();
    else if (key === '--pg-container') args.pgContainer = next();
    else if (key === '--pg-user') args.pgUser = next();
    else if (key === '--pg-db') args.pgDb = next();
    else if (key === '--dry-run') args.dryRun = true;
    else if (key === '--force') args.force = true;
    else if (key === '--allow-multi-price') args.allowMultiPrice = true;
    else throw new Error(`未知参数：${key}`);
  }
  if (!args.file) throw new Error('必须指定 --file <清单 json>');
  if (!args.token && !args.dryRun) throw new Error('必须指定 --token 或设置 PMS_TOKEN');
  return args;
}

// ---------------------------------------------------------------- API

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
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`${method} ${path} → ${res.status} ${detail}`);
  }
  return data;
}

/** 只用来建 qty=0 的库存空行，见文件头说明 */
function runSql(sql) {
  return execFileSync(
    'ssh',
    [
      '-i', args.sshKey,
      args.sshHost,
      `sudo -n docker exec -i ${args.pgContainer} psql -U ${args.pgUser} -d ${args.pgDb} -v ON_ERROR_STOP=1 -f -`,
    ],
    { input: sql, encoding: 'utf8' },
  );
}

// ---------------------------------------------------------------- 工具

const normSpec = (value) => String(value ?? '').trim();
const skuKey = (name, spec) => `${String(name).trim()}|${normSpec(spec)}`;
const toCents = (yuan) => Math.round(Number(yuan) * 100);
const yuan = (cents) => (cents / 100).toFixed(2);

// ---------------------------------------------------------------- 主流程

async function main() {
  const plan = JSON.parse(readFileSync(resolve(ROOT, args.file), 'utf8'));
  if (!Array.isArray(plan.items) || !plan.items.length) throw new Error('清单没有 items');

  // 1. 目标仓
  const warehouses = await api('/warehouses');
  const warehouse = plan.warehouseId
    ? warehouses.find((w) => w.id === plan.warehouseId)
    : warehouses.find((w) => w.name === plan.warehouse);
  if (!warehouse) throw new Error(`找不到仓库：${plan.warehouseId || plan.warehouse}`);
  console.log(`目标仓：#${warehouse.id} ${warehouse.name}（${warehouse.type}${warehouse.officeName ? ' · ' + warehouse.officeName : ''}）`);

  // 2. SKU：名称 + 规格判重，与服务端 assertMaterialUnique 同口径
  const materials = await api('/materials');
  const materialByKey = new Map(materials.map((m) => [skuKey(m.name, m.spec), m]));

  const skus = new Map(); // skuKey -> { category, name, spec, unit, rows: [...] }
  for (const item of plan.items) {
    const key = skuKey(item.name, item.spec);
    if (!skus.has(key)) {
      skus.set(key, { category: item.category, name: String(item.name).trim(), spec: normSpec(item.spec), unit: item.unit, rows: [] });
    }
    skus.get(key).rows.push({ qty: Number(item.qty), unitCostCents: toCents(item.unitPrice) });
  }

  // 同名同规格出现多个单价：十有八九是规格没写全，先逼着确认再动手
  const multiPrice = [...skus.values()].filter((sku) => new Set(sku.rows.map((r) => r.unitCostCents)).size > 1);
  if (multiPrice.length && !args.allowMultiPrice) {
    for (const sku of multiPrice) {
      const prices = sku.rows.map((r) => `${yuan(r.unitCostCents)} 元 ×${r.qty}`).join('、');
      console.error(`多价待确认  ${sku.name}${sku.spec ? ' / ' + sku.spec : ''}：${prices}`);
    }
    throw new Error(
      '同名同规格出现多个单价（上面已列出）。是不同规格的货就把清单里的 spec 补全；' +
      '确认是同一种货不同批价，再加 --allow-multi-price 重跑。',
    );
  }

  const report = { warehouseId: warehouse.id, warehouse: warehouse.name, createdMaterials: [], reusedMaterials: [], skipped: [], adjustments: [] };

  // 3. 缺的 SKU 建出来；已有的直接复用（单位、类别以库里为准，不覆盖）
  for (const sku of skus.values()) {
    const key = skuKey(sku.name, sku.spec);
    const existing = materialByKey.get(key);
    if (existing) {
      sku.material = existing;
      report.reusedMaterials.push({ id: existing.id, code: existing.code, name: existing.name, spec: existing.spec, unit: existing.unit });
      console.log(`复用 SKU  ${existing.code} ${existing.name}${existing.spec ? ' / ' + existing.spec : ''}（单位 ${existing.unit}）`);
      continue;
    }
    const payload = {
      name: sku.name,
      spec: sku.spec || undefined,
      category: sku.category,
      unit: sku.unit,
      // 参考成本先按清单第一条单价填；补录完 stock-ledger 会按剩余批次加权重算
      defaultCostCents: sku.rows[0].unitCostCents,
    };
    if (args.dryRun) {
      console.log(`[dry-run] 新建 SKU ${sku.name}${sku.spec ? ' / ' + sku.spec : ''}（${sku.category}·${sku.unit}）`);
      sku.material = { id: null, code: '(dry-run)', ...payload };
      continue;
    }
    const created = await api('/materials', { method: 'POST', body: payload });
    sku.material = created;
    materialByKey.set(key, created);
    report.createdMaterials.push({ id: created.id, code: created.code, name: created.name, spec: created.spec, unit: created.unit });
    console.log(`新建 SKU  ${created.code} ${created.name}${created.spec ? ' / ' + created.spec : ''}（单位 ${created.unit}）`);
  }

  // 4. 目标仓已有的库存行；有存量的 SKU 默认跳过，避免重跑翻倍
  let stocks = await api(`/stocks?warehouseId=${warehouse.id}`);
  const stockByMaterial = new Map(stocks.map((s) => [s.materialId, s]));
  const todo = [];
  for (const sku of skus.values()) {
    const stock = sku.material.id ? stockByMaterial.get(sku.material.id) : undefined;
    if (stock && Number(stock.qty) > 0 && !args.force) {
      report.skipped.push({ materialId: sku.material.id, name: sku.name, currentQty: Number(stock.qty), reason: '目标仓已有库存，未 --force 不覆盖' });
      console.log(`跳过     ${sku.name}${sku.spec ? ' / ' + sku.spec : ''}：目标仓已有 ${stock.qty}，加 --force 才处理`);
      continue;
    }
    todo.push(sku);
  }
  if (!todo.length) {
    console.log('没有需要补录的行。');
    return report;
  }

  // 5. 建库存空行（唯一绕过 API 的一步，见文件头）
  const missing = todo.filter((sku) => !stockByMaterial.has(sku.material.id));
  if (missing.length && !args.dryRun) {
    const values = missing
      .map((sku) => `(${args.tenant}, ${warehouse.id}, ${sku.material.id}, 0, 0)`)
      .join(',\n       ');
    const sql = `INSERT INTO stocks (tenant_id, warehouse_id, material_id, qty, safety_qty)\nVALUES ${values}\nON CONFLICT (warehouse_id, material_id) DO NOTHING;`;
    runSql(sql);
    console.log(`已建库存空行 ${missing.length} 条`);
    stocks = await api(`/stocks?warehouseId=${warehouse.id}`);
    stocks.forEach((s) => stockByMaterial.set(s.materialId, s));
  } else if (missing.length) {
    console.log(`[dry-run] 需要新建库存空行 ${missing.length} 条`);
  }

  // 6. 逐行盘盈：同一 SKU 的多个单价按顺序各成一条批次
  const note = (plan.sourceNote || '期初存量补录').slice(0, 180);
  for (const sku of todo) {
    const stock = sku.material.id ? stockByMaterial.get(sku.material.id) : undefined;
    if (!stock && !args.dryRun) throw new Error(`库存行没建出来：${sku.name}`);
    let target = stock ? Number(stock.qty) : 0;
    for (const row of sku.rows) {
      target = Number((target + row.qty).toFixed(2));
      const label = `${sku.name}${sku.spec ? ' / ' + sku.spec : ''} +${row.qty} @ ${yuan(row.unitCostCents)} 元 → 累计 ${target}`;
      if (args.dryRun) {
        console.log(`[dry-run] ${label}`);
        continue;
      }
      await api(`/stocks/${stock.id}`, {
        method: 'PATCH',
        body: { qty: target, unitCostCents: row.unitCostCents, note: `${note}（单价 ${yuan(row.unitCostCents)} 元）` },
      });
      report.adjustments.push({ stockId: stock.id, materialId: sku.material.id, name: sku.name, spec: sku.spec, addQty: row.qty, unitCostCents: row.unitCostCents, targetQty: target });
      console.log(`补录     ${label}`);
    }
  }

  return report;
}

main()
  .then((report) => {
    if (args.dryRun) return;
    const out = resolve(ROOT, args.out || `data-prep/inventory-opening-${report.warehouseId}-report.json`);
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n完成：新建 SKU ${report.createdMaterials.length}、复用 ${report.reusedMaterials.length}、盘盈 ${report.adjustments.length} 条、跳过 ${report.skipped.length}`);
    console.log(`报告：${out}`);
  })
  .catch((err) => {
    console.error(`导入失败：${err.message}`);
    process.exit(1);
  });
