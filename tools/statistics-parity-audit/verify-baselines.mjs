#!/usr/bin/env node
/**
 * 两张年度汇总 × 旧 MIS 离线快照的「验收基准」复核（只读本地 CSV，不连 MIS/生产）。
 *
 * 复核对象（来自既有验收基准/回归用例）：
 * - 欠费年度汇总：02 管理处管理费（费项 01）、默认 12 项房屋性质
 *   2011=921.00、2012=307.00、2014=477.90、2025=16,595.00；
 * - 实收年度汇总：01 管理处 2004 年按应收年月归年 = 88,240 分（¥882.40）。
 *
 * 结论差异提示：当年（2026）数字随新账单/收款持续变化，基准必须绑定快照日期；
 * 历史年度应与基准逐分一致。
 *
 * 用法：node tools/statistics-parity-audit/verify-baselines.mjs --data-dir outputs/mis-db-sync-20261106/data
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
/** 欠费报表默认 12 项房屋性质（排除 06 空房）。 */
const DEFAULT_NATURES = new Set(['01', '02', '03', '04', '05', '07', '08', '09', '10', '11', '12', '13']);

const sums = new Map();
const bump = (key, cents) => sums.set(key, (sums.get(key) ?? 0) + cents);

await readCsv('0267_dbo.WYZJ.csv', (row) => {
  const sc = (row.SC ?? '').trim();
  if (sc !== '' && sc !== '0') return;
  const period = (row.ZJ_CNY ?? '').trim();
  const year = period.slice(0, 4);
  if (!/^\d{4}$/.test(year)) return;
  const owner = owners.get(row.ZH_ID);
  const room = owner ? rooms.get(owner.S_ID) : undefined;
  const building = room ? buildings.get(room.L_ID) : undefined;
  if (!building) return;
  const office = building['管理处'];
  const cents = Math.round(Number(row.ZJ_JE) * 100);
  const nature = (row.FWXZ_DH ?? '').trim();
  const fee = (row.ZJ_LX ?? '').trim();
  const paid = (row.ZJ_SKRQ ?? '').trim() !== '';
  if (paid) bump(`received|${office}|${year}`, cents);
  if (!paid && fee === '01' && DEFAULT_NATURES.has(nature)) bump(`arrears|${office}|${year}`, cents);
});

let failures = 0;
const show = (type, office, year, expectedCents, label) => {
  const cents = sums.get(`${type}|${office}|${year}`) ?? 0;
  const ok = cents === expectedCents;
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${label.padEnd(28)} 快照=${(cents / 100).toFixed(2).padStart(14)} 基准=${(expectedCents / 100).toFixed(2).padStart(14)}`);
};

console.log(`# 年度汇总验收基准复核（${dataDir}）`);
show('arrears', '02', '2011', 92100, '欠费 02 2011 管理费');
show('arrears', '02', '2012', 30700, '欠费 02 2012 管理费');
show('arrears', '02', '2014', 47790, '欠费 02 2014 管理费');
show('arrears', '02', '2025', 1659500, '欠费 02 2025 管理费');
show('received', '01', '2004', 88240, '实收 01 2004');
console.log('');
console.log('提示：当年（2026）数字随新账单/收款变化，须以快照日期为基准，不做固定断言。');
process.exitCode = failures === 0 ? 0 : 1;
