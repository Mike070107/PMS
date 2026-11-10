#!/usr/bin/env node
/**
 * 统计汇总 × 旧 MIS 离线对账（只读本地 CSV 快照，不连 MIS/生产）。
 *
 * 用途：用旧 MIS 逻辑快照复算「项目欠费年度汇总」各管理处×年度的未收金额，
 * 并把其中「房屋性质=06 空房」的部分单独拆出来——PMS 欠费报表默认不勾 06，
 * 因此用户在旧系统全选性质时看到的数字，会比 PMS 默认口径多出 06 这一列。
 *
 * 口径（与镜像同步 SQL 一致）：
 * - 只取 dbo.WYZJ 未删除行（ISNULL(SC,'0')='0'）；
 * - 未收 = ZJ_SKRQ（收款日期）与 ZJ_TKRQ（退款日期）均为空，且 ZJ_JE>0；
 * - 年度 = ZJ_CNY（应收年月，YYYYMM）前四位；
 * - 管理处 = 楼表.管理处，经 业主表.ZH_ID→S_ID→室表→楼表 关联（镜像为 INNER JOIN）。
 *
 * 用法：
 *   node tools/statistics-parity-audit/parity-audit.mjs --data-dir outputs/mis-db-sync-20261106/data
 *   node ... --office 01 --year 2007 --detail     # 打印某格明细
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
const onlyOffice = args.get('office');
const onlyYear = args.get('year');
const wantDetail = args.get('detail') === 'true';

/** RFC4180 行解析：支持引号包裹、逗号、双写引号。 */
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

const money = (cents) => (cents / 100).toFixed(2);

const buildings = new Map();
await readCsv('0752_dbo.楼表.csv', (row) => buildings.set(row.L_ID, { office: row['管理处'], no: row['号'], roomAddr: '' }));
const rooms = new Map();
await readCsv('0880_dbo.室表.csv', (row) => rooms.set(row.S_ID, { lId: row.L_ID, room: row['室'], nature: row['房屋性质'], area: row['建筑面积'] }));
const owners = new Map();
await readCsv('1015_dbo.业主表.csv', (row) => owners.set(row.ZH_ID, { sId: row.S_ID, name: row['姓名'] }));

const cells = new Map();
const joinGap = { rows: 0, cents: 0 };
const details = [];

await readCsv('0267_dbo.WYZJ.csv', (row) => {
  const sc = (row.SC ?? '').trim();
  if (sc !== '' && sc !== '0') return;
  const period = (row.ZJ_CNY ?? '').trim();
  const year = period.slice(0, 4);
  if (!/^\d{4}$/.test(year)) return;
  if ((row.ZJ_SKRQ ?? '').trim() !== '' || (row.ZJ_TKRQ ?? '').trim() !== '') return;
  const cents = Math.round(Number(row.ZJ_JE) * 100);
  if (!(cents > 0)) return;
  const owner = owners.get(row.ZH_ID);
  const room = owner ? rooms.get(owner.sId) : undefined;
  const building = room ? buildings.get(room.lId) : undefined;
  if (!building) { joinGap.rows++; joinGap.cents += cents; return; }
  const office = building.office;
  if (onlyOffice && office !== onlyOffice) return;
  if (onlyYear && year !== onlyYear) return;
  const nature = (row.FWXZ_DH ?? '').trim();
  const key = `${office}|${year}`;
  const cell = cells.get(key) ?? { all: 0, no06: 0, six: 0, rows: 0, rows06: 0 };
  cell.all += cents;
  cell.rows++;
  if (nature === '06') { cell.six += cents; cell.rows06++; } else cell.no06 += cents;
  cells.set(key, cell);
  if (wantDetail) details.push({ office, year, zjId: row.ZJ_ID, sId: owner?.sId, room: room?.room, roomNo: building.no, owner: owner?.name, nature, feeCode: row.ZJ_LX, period, cents });
});

const years = [...new Set([...cells.keys()].map((key) => key.split('|')[1]))].sort();
const offices = [...new Set([...cells.keys()].map((key) => key.split('|')[0]))].sort();

console.log(`# 统计汇总 × MIS 离线对账（${dataDir}）`);
console.log('');
console.log(`关联缺口（镜像 INNER JOIN 会丢弃的无业主行）：${joinGap.rows} 行 / ${money(joinGap.cents)} 元`);
console.log('');
console.log('| 管理处 | 年度 | 未收(全部性质) | 未收(不含06) | 其中06空房 | 行数 | 06行数 |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const office of offices) {
  for (const year of years) {
    const cell = cells.get(`${office}|${year}`);
    if (!cell) continue;
    console.log(`| ${office} | ${year} | ${money(cell.all)} | ${money(cell.no06)} | ${money(cell.six)} | ${cell.rows} | ${cell.rows06} |`);
  }
}

if (wantDetail && details.length > 0) {
  console.log('');
  console.log('| 管理处 | 年度 | ZJ_ID | S_ID | 房号 | 业主 | 性质 | 费项 | 年月 | 金额 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |');
  details.sort((a, b) => b.cents - a.cents);
  for (const item of details) {
    const houseNo = item.roomNo ? `${item.roomNo}/${item.room}` : String(item.room ?? '');
    console.log(`| ${item.office} | ${item.year} | ${item.zjId} | ${item.sId} | ${houseNo} | ${item.owner} | ${item.nature} | ${item.feeCode} | ${item.period} | ${money(item.cents)} |`);
  }
}

if (cells.size === 0) {
  console.log('');
  console.log('（筛选后无匹配行；请检查 --office/--year 或数据目录）');
}
