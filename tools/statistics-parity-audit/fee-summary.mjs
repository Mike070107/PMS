#!/usr/bin/env node
/**
 * 「收费汇总」块级复算（旧 MIS 快照只读，不连 MIS/生产）：
 * 按 管理处 + 收款日期区间 输出每个收费项目的 收款块 / 退款块 / 调整块 / 净额（分），
 * 用于和产线实测值或旧系统截图核对。
 *
 * 口径（与 fee-nature 实现一致）：
 * - 收款块：paid_date ∈ [from,to) 且 refund_date 为空且 amount>0；
 * - 退款块：refund_date ∈ [from,to) 且 amount>0，取绝对值；
 * - 调整块：paid_date ∈ [from,to) 且 refund_date 为空且 amount<0；
 * - 净额  ：paid_date ∈ [from,to) 且 refund_date 为空（收款 + 负调整），退款块只作信息列。
 *
 * 用法：
 *   node tools/statistics-parity-audit/fee-summary.mjs --office 02 --from 2026-10-01 --to 2026-11-01
 */

import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args.set(token.slice(2), next); i++; } else args.set(token.slice(2), 'true');
}
const dataDir = path.resolve(args.get('data-dir') ?? 'outputs/mis-db-sync-20261106/data');
const office = args.get('office');
const from = args.get('from');
const to = args.get('to');
if (!office || !from || !to) {
  console.error('需要 --office、--from、--to（例如 --office 02 --from 2026-10-01 --to 2026-11-01）');
  process.exit(2);
}

function parseLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function readCsv(fileName, onRow) {
  const filePath = path.join(dataDir, fileName);
  await access(filePath);
  const rl = readline.createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  let header;
  for await (const line of rl) {
    if (!header) { header = parseLine(line.replace(/^\uFEFF/, '')); continue; }
    if (line.length === 0) continue;
    const cells = parseLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] ?? '';
    await onRow(row);
  }
}

const buildings = new Map();
await readCsv('0752_dbo.楼表.csv', (row) => buildings.set(row.L_ID, row));
const rooms = new Map();
await readCsv('0880_dbo.室表.csv', (row) => rooms.set(row.S_ID, row));
const owners = new Map();
await readCsv('1015_dbo.业主表.csv', (row) => owners.set(row.ZH_ID, row));

const byFee = new Map();
const bump = (fee, field, cents) => {
  const cell = byFee.get(fee) ?? { recv: 0, refund: 0, adjust: 0, net: 0, rows: 0 };
  cell[field] += cents;
  byFee.set(fee, cell);
};

await readCsv('0267_dbo.WYZJ.csv', (row) => {
  const sc = (row.SC ?? '').trim();
  if (sc !== '' && sc !== '0') return;
  const owner = owners.get(row.ZH_ID);
  const room = owner ? rooms.get(owner.S_ID) : undefined;
  const building = room ? buildings.get(room.L_ID) : undefined;
  if (!building || building['管理处'] !== office) return;
  const fee = (row.ZJ_LX ?? '').trim();
  const cents = Math.round(Number(row.ZJ_JE) * 100);
  const paid = (row.ZJ_SKRQ ?? '').trim().slice(0, 10);
  const refund = (row.ZJ_TKRQ ?? '').trim().slice(0, 10);
  const paidIn = paid >= from && paid < to;
  const refundIn = refund >= from && refund < to;
  if (paidIn && !refund) {
    const cell = byFee.get(fee) ?? { recv: 0, refund: 0, adjust: 0, net: 0, rows: 0 };
    cell.rows += 1;
    byFee.set(fee, cell);
    if (cents > 0) bump(fee, 'recv', cents);
    if (cents < 0) bump(fee, 'adjust', cents);
    bump(fee, 'net', cents);
  }
  if (refundIn && cents > 0) bump(fee, 'refund', cents);
});

const fees = [...byFee.keys()].sort();
let totals = { recv: 0, refund: 0, adjust: 0, net: 0 };
console.log(`# 收费汇总复算：管理处 ${office}，收款日期 ${from} ~ ${to}（分）`);
console.log('| 收费项目 | 收款块 | 笔数 | 退款块 | 调整块 | 净额 |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const fee of fees) {
  const cell = byFee.get(fee);
  console.log(`| ${fee} | ${cell.recv} | ${cell.rows} | ${cell.refund} | ${cell.adjust} | ${cell.net} |`);
  totals = {
    recv: totals.recv + cell.recv,
    refund: totals.refund + cell.refund,
    adjust: totals.adjust + cell.adjust,
    net: totals.net + cell.net,
  };
}
console.log(`| 合计 | ${totals.recv} | — | ${totals.refund} | ${totals.adjust} | ${totals.net} |`);
