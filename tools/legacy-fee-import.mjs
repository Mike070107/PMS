#!/usr/bin/env node
/**
 * 吴泾物业老收费系统（本机 MySQL）→ PMS 的一次性导入工具。
 *
 * 导什么：指定小区的 房产 / 业主档案 / 每户收费标准 / 历史账单，四样按顺序导，
 * 后一样依赖前一样（账单要先有房号，业主姓名要先有档案）。
 *
 * 怎么保证可以重跑：所有写入都带 legacyRef（wjwy:zh:<ZH_ID> / wjwy:dj:<wydj.ID> /
 * wjwy:zj:<ZJ_ID>），服务端按它 upsert。同一份数据跑第二遍只会更新、不会建重，
 * 所以中途失败直接重跑即可，不用先清库。
 *
 * 用法：
 *   node tools/legacy-fee-import.mjs --api https://prsznh.cn/api/v1 --token <JWT> \
 *        [--tenant 1] [--offices 01,09,10] [--dry-run] [--skip-houses] [--bills-from 200401]
 *   凭据也可以用 --account/--password（走 /auth/admin-login）。
 *
 * 前置：本机 MySQL 里有 `吴泾物业` 库；服务端已部署带 /fees 的版本。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const args = {
    api: 'https://prsznh.cn/api/v1',
    mysql: 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe',
    db: '吴泾物业',
    user: 'root',
    password: process.env.LEGACY_MYSQL_PASSWORD || '',
    offices: '01,09,10',
    tenant: '',
    token: process.env.PMS_TOKEN || '',
    account: '',
    accountPassword: '',
    chunk: '2000',
    billsFrom: '',
    out: resolve(ROOT, 'data-prep', 'legacy-import-report.json'),
    dryRun: false,
    skipHouses: false,
    skipOwners: false,
    skipStandards: false,
    skipBills: false,
    skipParking: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    switch (key) {
      case '--api': args.api = next(); break;
      case '--mysql': args.mysql = next(); break;
      case '--db': args.db = next(); break;
      case '--mysql-user': args.user = next(); break;
      case '--mysql-password': args.password = next(); break;
      case '--offices': args.offices = next(); break;
      case '--tenant': args.tenant = next(); break;
      case '--token': args.token = next(); break;
      case '--account': args.account = next(); break;
      case '--password': args.accountPassword = next(); break;
      case '--chunk': args.chunk = next(); break;
      case '--bills-from': args.billsFrom = next(); break;
      case '--out': args.out = next(); break;
      case '--dry-run': args.dryRun = true; break;
      case '--skip-houses': args.skipHouses = true; break;
      case '--skip-owners': args.skipOwners = true; break;
      case '--skip-standards': args.skipStandards = true; break;
      case '--skip-bills': args.skipBills = true; break;
      case '--skip-parking': args.skipParking = true; break;
      default:
        throw new Error(`未知参数：${key}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const OFFICES = args.offices.split(',').map((s) => s.trim()).filter(Boolean);
const CHUNK = Math.max(100, Number(args.chunk) || 2000);

/**
 * 老系统的「管理处」→ PMS 小区名。
 * 09/10 是二期 A/B 两个收费口径，PMS 里合成一个「枫桦景苑二期」——
 * 两边的楼号互不重叠（09 是 228弄1-6/21-33/50-53 + 宝秀路，10 是 228弄7-20/35-49 + 永德路），
 * 合并不会撞号。新增小区时在这里加一行。
 */
const OFFICE_TO_COMMUNITY = {
  '01': '枫桦景苑一期',
  '09': '枫桦景苑二期',
  '10': '枫桦景苑二期',
};

/** 老系统收费项目代号（setupsfxm.dh）→ PMS feeCode。名称仍按老库原文随行落库 */
const FEE_CODE_MAP = {
  '01': 'management',
  '02': 'rent',
  '03': 'clean_guard',
  '04': 'parking',
  '05': 'temp_parking',
  '06': 'guard',
  '07': 'clean',
  '08': 'clean_guard',
  '09': 'network',
  '10': 'rent',
  '11': 'rent',
  '12': 'water',
  '13': 'electricity',
  '14': 'locker',
  '15': 'vacant_rent',
};

const FEE_NAME_MAP = {
  '01': '物业管理费',
  '02': '租金',
  '03': '保洁保安费',
  '04': '泊位费',
  '05': '临时停车费',
  '06': '保安费',
  '07': '保洁费',
  '08': '保安保洁费',
  '09': '网络费',
  '10': '青客租金',
  '11': '青客未签约租金',
  '12': '水费',
  '13': '电费',
  '14': '快递柜费',
  '15': '空房租金',
};

/** 老系统 收款方式列表：1 现金 / 2 支票 / 3 贷记凭证 */
const PAY_METHOD_MAP = { '1': 'cash', '2': 'cheque', '3': 'bank' };

/** 老系统 房屋性质（fwxzk）→ PMS property_type。只分住宅/商铺两类 */
const SHOP_KINDS = new Set(['04', '05', '06', '08', '10']);

// ---------------------------------------------------------------- MySQL

/**
 * 跑一条查询，拿回对象数组。
 *
 * mysql --batch 输出 TSV，两个坑都踩过（2026-08-26）：
 * 1. **NULL 打印成字面量 `NULL`**（不是 `\N`，那是 INTO OUTFILE 的写法）。
 *    不还原成 null，「弄」是空的那批商铺就变成 lane='NULL'，房号一条都匹配不上；
 *    退款日期也会被当成有值，全部账单被判成「已退款」。
 * 2. 不加 `--raw` 时值里的制表符/换行会转义成 `\t` `\n`，必须自己还原，
 *    否则备注里有换行的行会把整个 TSV 撕成两行。加 `--raw` 反而更糟（不转义 = 直接错行）。
 */
function queryMysql(sql) {
  const out = execFileSync(
    args.mysql,
    [
      `-u${args.user}`,
      ...(args.password ? [`-p${args.password}`] : []),
      '--default-character-set=utf8mb4',
      '--batch',
      '-D',
      args.db,
      '-e',
      sql,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );
  const lines = out.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return [];
  const headers = lines[0].split('\t');
  const unescape = (v) =>
    v.replace(/\\([tnr0\\])/g, (_, ch) =>
      ({ t: '\t', n: '\n', r: '\r', 0: '\0', '\\': '\\' }[ch]),
    );
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      const v = cells[i];
      row[h] = v === undefined || v === 'NULL' ? null : unescape(v);
    });
    return row;
  });
}

const officeList = OFFICES.map((o) => `'${o}'`).join(',');

/** 房号定位四段：小区 / 弄 / 号 / 室，与服务端 common/house-index.ts 的匹配规则对应 */
function locatorOf(row) {
  return {
    communityName: OFFICE_TO_COMMUNITY[row.管理处] || null,
    lane: row.弄 || null,
    buildingNo: row.号 || null,
    roomNo: row.室 || null,
  };
}

// ---------------------------------------------------------------- 字段清洗

/**
 * 老库的「联系方式」是自由文本：手机号、8 位固话、「13916151630袁」、
 * 「643430400*3025」都有。认得出的手机号才进 phone，其余原样留 contactNote。
 * 宁可空着让人补，也不能让业主端拿一个错号码去匹配房屋。
 */
function splitContact(raw) {
  const text = (raw || '').trim();
  if (!text) return { phone: null, contactNote: null };
  const compact = text.replace(/[\s-]/g, '');
  if (/^1[3-9]\d{9}$/.test(compact)) return { phone: compact, contactNote: null };
  const embedded = compact.match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
  if (embedded) return { phone: embedded[0], contactNote: text };
  return { phone: null, contactNote: text };
}

/** '112.1000' → 11210（分）。老库是 decimal(19,4)，直接乘 100 会有浮点尾巴 */
function toCents(value) {
  if (value == null || value === '') return 0;
  return Math.round(Number(value) * 100);
}

/** '2019-01-01 00:00:00' → '2019-01-01'；空值返回 null */
function toDate(value) {
  if (!value || value.startsWith('0000')) return null;
  return value.slice(0, 10);
}

/** MySQL datetime（东八区）→ ISO 时刻，落库时才不会整体偏 8 小时 */
function toIso(value) {
  const date = toDate(value);
  if (!date) return null;
  const time = value.length > 10 ? value.slice(11, 19) : '00:00:00';
  return `${date}T${time}+08:00`;
}

function truncate(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

// ---------------------------------------------------------------- API

let authHeader = '';

async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(args.api.replace(/\/$/, '') + path);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    });
  }
  const headers = { 'content-type': 'application/json' };
  if (authHeader) headers.authorization = authHeader;
  if (args.tenant) headers['x-acting-tenant-id'] = String(args.tenant);
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail = parsed && parsed.message ? JSON.stringify(parsed.message) : text.slice(0, 400);
    throw new Error(`${method} ${path} → HTTP ${res.status} ${detail}`);
  }
  return parsed && typeof parsed === 'object' && 'code' in parsed && 'data' in parsed
    ? parsed.data
    : parsed;
}

async function login() {
  if (args.token) {
    authHeader = `Bearer ${args.token}`;
    return;
  }
  if (!args.account || !args.accountPassword) {
    throw new Error('需要 --token，或 --account + --password');
  }
  const res = await api('/auth/admin-login', {
    method: 'POST',
    body: { account: args.account, password: args.accountPassword },
  });
  authHeader = `Bearer ${res.accessToken}`;
}

/** 分批 POST，逐批打印进度 —— 十几万行的导入必须能看出跑到哪了 */
async function postInChunks(path, key, rows, merge) {
  const summary = {};
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const res = await api(path, { method: 'POST', body: { [key]: slice } });
    merge(summary, res);
    const done = Math.min(i + CHUNK, rows.length);
    process.stdout.write(`    ${path} ${done}/${rows.length}\r`);
  }
  process.stdout.write('\n');
  return summary;
}

// ---------------------------------------------------------------- 取数

function fetchRooms() {
  return queryMysql(`
    SELECT l.管理处, l.路, l.弄, l.号, s.室, s.建筑面积, s.房屋性质, s.S_ID
    FROM 楼表 l
    JOIN 室表 s ON s.L_ID = l.L_ID AND s.SC = 0
    WHERE l.管理处 IN (${officeList}) AND l.SC = 0
  `);
}

function fetchOwners() {
  return queryMysql(`
    SELECT z.ZH_ID, z.姓名, z.联系方式, l.管理处, l.弄, l.号, s.室
    FROM 业主表 z
    JOIN 室表 s ON s.S_ID = z.S_ID AND s.SC = 0
    JOIN 楼表 l ON l.L_ID = s.L_ID AND l.SC = 0
    WHERE l.管理处 IN (${officeList})
      AND z.SC = 0
      AND z.退户日期 IS NULL
      AND TRIM(IFNULL(z.姓名, '')) <> ''
    ORDER BY z.ZH_ID
  `);
}

function fetchStandards() {
  return queryMysql(`
    SELECT d.ID, d.DH, d.JE, d.BZ, d.StDate, d.Histroy, d.WenHao, d.备注,
           l.管理处, l.弄, l.号, s.室
    FROM wydj d
    JOIN 业主表 z ON z.ZH_ID = d.ZH_ID AND z.SC = 0
    JOIN 室表 s ON s.S_ID = z.S_ID AND s.SC = 0
    JOIN 楼表 l ON l.L_ID = s.L_ID AND l.SC = 0
    WHERE l.管理处 IN (${officeList}) AND IFNULL(d.SC, '0') = '0'
    ORDER BY d.ID
  `);
}

/**
 * 车位费（泊位费）账单。**不在 wyzj 里** —— 老系统把车位单独做了一套：
 * `车位申请登记表`（一个车位一条登记）+ `缴费通知表`（一条登记每月一张单）。
 * 只导物业管理费会漏掉这 12 万条（2026-08-27 就漏过一次）。
 *
 * 房号靠登记表的 zh_id 回到业主 → 室 → 楼；「非小区业户」（外来租户）没有本小区房号，
 * 挂不上 house，交给调用方计数报出来，不猜。
 */
function fetchParkingBills(offset, limit) {
  return queryMysql(`
    SELECT t.ID, t.缴费年月, t.金额, t.收款日期, t.退款日期, t.取消日期, t.合并ID,
           d.车库编号, d.车位编号, d.车型, d.牌照号, d.用户姓名, d.用户类型, d.zh_id,
           l.管理处, l.弄, l.号, s.室
    FROM 缴费通知表 t
    JOIN 车位申请登记表 d ON d.登记ID = t.登记ID
    LEFT JOIN 业主表 z ON z.ZH_ID = d.zh_id AND z.SC = 0
    LEFT JOIN 室表 s ON s.S_ID = z.S_ID AND s.SC = 0
    LEFT JOIN 楼表 l ON l.L_ID = s.L_ID AND l.SC = 0
    WHERE d.管理处 IN (${officeList}) AND IFNULL(t.sc, 0) = 0
    ORDER BY t.ID
    LIMIT ${limit} OFFSET ${offset}
  `);
}

function countParkingBills() {
  return Number(
    queryMysql(`
      SELECT COUNT(*) AS n
      FROM 缴费通知表 t
      JOIN 车位申请登记表 d ON d.登记ID = t.登记ID
      WHERE d.管理处 IN (${officeList}) AND IFNULL(t.sc, 0) = 0
    `)[0].n,
  );
}

function fetchBills(offset, limit) {
  const periodFilter = args.billsFrom ? `AND w.ZJ_CNY >= '${args.billsFrom}'` : '';
  return queryMysql(`
    SELECT w.ZJ_ID, w.ZJ_LX, w.ZJ_CNY, w.ZJ_JE, w.ZJ_SKRQ, w.ZJ_TKRQ, w.收款方式ID,
           w.HBDJHM, w.凭证号码, w.发票号码, w.收款人, w.备注, z.姓名,
           l.管理处, l.弄, l.号, s.室
    FROM wyzj w
    JOIN 业主表 z ON z.ZH_ID = w.ZH_ID AND z.SC = 0
    JOIN 室表 s ON s.S_ID = z.S_ID AND s.SC = 0
    JOIN 楼表 l ON l.L_ID = s.L_ID AND l.SC = 0
    WHERE l.管理处 IN (${officeList}) AND IFNULL(w.SC, '0') = '0' ${periodFilter}
    ORDER BY w.ZJ_ID
    LIMIT ${limit} OFFSET ${offset}
  `);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const report = { startedAt: new Date().toISOString(), offices: OFFICES, steps: {} };

  console.log(`老库：${args.db}，管理处 ${OFFICES.join('/')} → ${[...new Set(Object.values(OFFICE_TO_COMMUNITY))].join('、')}`);
  if (!args.dryRun) await login();

  // ---- 1. 房产：老库有、PMS 没有的房号补齐 ----
  const rooms = fetchRooms();
  console.log(`\n[1/5] 房产：老库 ${rooms.length} 间`);

  let houses = [];
  let communities = [];
  if (!args.dryRun) {
    communities = await api('/communities', { query: { includeGroups: true } });
    houses = await api('/houses');
  }
  const communityByName = new Map(communities.map((c) => [c.name, c]));
  const norm = (v) => String(v ?? '').replace(/\s+/g, '').trim();
  const houseKey = (c, lane, no, room) => `${norm(c)}|${norm(lane)}|${norm(no)}|${norm(room)}`;
  const buildingKey = (c, lane, no) => `${norm(c)}|${norm(lane)}|${norm(no)}`;

  const existingHouses = new Set();
  const housesInBuilding = new Map();
  for (const h of houses) {
    existingHouses.add(houseKey(h.communityName, h.lane, h.buildingNo, h.roomNo));
    const bk = buildingKey(h.communityName, h.lane, h.buildingNo);
    housesInBuilding.set(bk, (housesInBuilding.get(bk) || 0) + 1);
  }

  const missingHouses = [];
  for (const room of rooms) {
    const loc = locatorOf(room);
    if (!loc.communityName) continue;
    const hk = houseKey(loc.communityName, loc.lane, loc.buildingNo, loc.roomNo);
    if (existingHouses.has(hk)) continue;
    // 商铺在老库里「室」填的是门牌号（永德路153号 → 室=153），PMS 里是「商铺」。
    // 楼下只有一户时按楼匹配即可，不算缺房号 —— 否则会给同一间商铺建出第二条。
    const bk = buildingKey(loc.communityName, loc.lane, loc.buildingNo);
    if ((housesInBuilding.get(bk) || 0) === 1) continue;
    missingHouses.push({ room, loc });
  }

  console.log(`      PMS 已有 ${houses.length} 间，缺 ${missingHouses.length} 间`);
  const houseResult = { legacyRooms: rooms.length, pmsHouses: houses.length, created: 0, failed: [] };
  if (!args.dryRun && !args.skipHouses && missingHouses.length) {
    for (const { room, loc } of missingHouses) {
      const community = communityByName.get(loc.communityName);
      if (!community) {
        houseResult.failed.push(`${loc.communityName}（小区不存在）`);
        continue;
      }
      try {
        await api('/houses', {
          method: 'POST',
          body: {
            communityId: community.id,
            lane: loc.lane || undefined,
            buildingNo: loc.buildingNo,
            roomNo: loc.roomNo,
            propertyType: SHOP_KINDS.has(room.房屋性质) ? '商铺' : '住宅',
            roadName: room.路 || undefined,
            fullAddress: `${room.路 || ''}${loc.lane ? `${loc.lane}弄` : ''}${loc.buildingNo}号${loc.roomNo}`,
            // CreateHouseDto 用 @IsNumberString 收面积，传 number 会被 400 顶回来
            areaSqm: room.建筑面积 ? String(room.建筑面积) : undefined,
          },
        });
        houseResult.created += 1;
      } catch (e) {
        houseResult.failed.push(`${loc.communityName} ${loc.buildingNo}号${loc.roomNo}：${e.message}`);
      }
    }
    console.log(`      新建 ${houseResult.created} 间，失败 ${houseResult.failed.length} 间`);
  }
  report.steps.houses = houseResult;

  // ---- 2. 业主档案 ----
  const ownerRows = fetchOwners();
  console.log(`\n[2/5] 业主档案：老库 ${ownerRows.length} 条`);
  const owners = ownerRows.map((row) => {
    const loc = locatorOf(row);
    const contact = splitContact(row.联系方式);
    return {
      communityName: loc.communityName,
      lane: loc.lane,
      buildingNo: loc.buildingNo,
      roomNo: loc.roomNo,
      name: truncate(row.姓名, 60),
      phone: contact.phone,
      contactNote: truncate(contact.contactNote, 255),
      legacyRef: `wjwy:zh:${row.ZH_ID}`,
    };
  }).filter((row) => row.name && row.communityName);
  console.log(`      有手机号 ${owners.filter((o) => o.phone).length} 条，仅固话/备注 ${owners.filter((o) => !o.phone && o.contactNote).length} 条`);

  if (!args.dryRun && !args.skipOwners) {
    report.steps.owners = await postInChunks('/owners-mgmt/import', 'rows', owners, (acc, res) => {
      acc.created = (acc.created || 0) + res.created;
      acc.updated = (acc.updated || 0) + res.updated;
      acc.unmatched = [...(acc.unmatched || []), ...res.unmatched];
      acc.conflicts = [...(acc.conflicts || []), ...res.conflicts];
    });
    const o = report.steps.owners;
    console.log(`      新建 ${o.created}，更新 ${o.updated}，未匹配房号 ${o.unmatched.length}，冲突 ${o.conflicts.length}`);
  } else {
    report.steps.owners = { planned: owners.length };
  }

  // ---- 3. 收费标准 ----
  const stdRows = fetchStandards();
  console.log(`\n[3/5] 收费标准：老库 ${stdRows.length} 条`);
  const standards = stdRows.map((row) => {
    const loc = locatorOf(row);
    const code = FEE_CODE_MAP[row.DH] || 'other';
    const amount = toCents(row.JE);
    const standardCents = toCents(row.BZ);
    return {
      house: loc,
      feeCode: code,
      feeName: FEE_NAME_MAP[row.DH] || '其他',
      amountCents: amount,
      standardCents: standardCents && standardCents !== amount ? standardCents : null,
      effectiveFrom: toDate(row.StDate) || '2000-01-01',
      // Histroy=1 是老系统里被新标准替代的那批，导进来只作留痕，不参与生成账单
      status: row.Histroy === '1' ? 'history' : 'active',
      docNo: truncate(row.WenHao, 60),
      remark: truncate(row.备注, 255),
      legacyRef: `wjwy:dj:${row.ID}`,
    };
  }).filter((row) => row.house.communityName);
  console.log(`      当前生效 ${standards.filter((s) => s.status === 'active').length}，历史 ${standards.filter((s) => s.status === 'history').length}`);

  if (!args.dryRun && !args.skipStandards) {
    report.steps.standards = await postInChunks('/fees/import', 'standards', standards, (acc, res) => {
      acc.created = (acc.created || 0) + res.standards.created;
      acc.updated = (acc.updated || 0) + res.standards.updated;
      acc.unmatched = [...(acc.unmatched || []), ...res.standards.unmatched];
    });
    const s = report.steps.standards;
    console.log(`      新建 ${s.created}，更新 ${s.updated}，未匹配房号 ${s.unmatched.length}`);
  } else {
    report.steps.standards = { planned: standards.length };
  }

  // ---- 4. 历史账单 ----
  console.log('\n[4/5] 物业管理费账单');
  const totalBills = Number(
    queryMysql(`
      SELECT COUNT(*) AS n
      FROM wyzj w
      JOIN 业主表 z ON z.ZH_ID = w.ZH_ID AND z.SC = 0
      JOIN 室表 s ON s.S_ID = z.S_ID AND s.SC = 0
      JOIN 楼表 l ON l.L_ID = s.L_ID AND l.SC = 0
      WHERE l.管理处 IN (${officeList}) AND IFNULL(w.SC, '0') = '0'
        ${args.billsFrom ? `AND w.ZJ_CNY >= '${args.billsFrom}'` : ''}
    `)[0].n,
  );
  console.log(`      老库 ${totalBills} 条`);

  const billStats = { created: 0, updated: 0, unmatched: [], paid: 0, unpaid: 0, refunded: 0 };
  // 一次只从 MySQL 取一段，几十万行不要一口气读进内存
  const READ_PAGE = 20000;
  for (let offset = 0; offset < totalBills; offset += READ_PAGE) {
    const page = fetchBills(offset, READ_PAGE);
    const bills = page.map((row) => {
      const loc = locatorOf(row);
      const paidAt = toIso(row.ZJ_SKRQ);
      const refundedAt = toIso(row.ZJ_TKRQ);
      const status = refundedAt ? 'refunded' : paidAt ? 'paid' : 'unpaid';
      if (status === 'paid') billStats.paid += 1;
      else if (status === 'refunded') billStats.refunded += 1;
      else billStats.unpaid += 1;
      return {
        house: loc,
        ownerName: truncate(row.姓名, 60),
        feeCode: FEE_CODE_MAP[row.ZJ_LX] || 'other',
        feeName: FEE_NAME_MAP[row.ZJ_LX] || '其他',
        period: row.ZJ_CNY,
        amountCents: toCents(row.ZJ_JE),
        status,
        paidAt,
        refundedAt,
        paymentMethod: PAY_METHOD_MAP[row.收款方式ID] || null,
        // 老系统一张收据收好几个月：合并单据号才是「这几条是一起收的」的凭据。
        // 只有真收到钱的才算收据号 —— 未缴的行上那个号是**通知单号**，
        // 摆在「收据号」列里会让收费员以为这笔已经收过（2026-08-27 截图核对时发现）。
        receiptNo:
          status === 'unpaid'
            ? null
            : row.HBDJHM
              ? `HB${row.HBDJHM}`
              : truncate(row.凭证号码, 60),
        invoiceNo: truncate(row.发票号码, 60),
        cashier: truncate(row.收款人, 60),
        remark: truncate(row.备注, 255),
        legacyRef: `wjwy:zj:${row.ZJ_ID}`,
      };
    }).filter((row) => row.house.communityName && /^\d{6}$/.test(row.period || ''));

    if (!args.dryRun && !args.skipBills) {
      const res = await postInChunks('/fees/import', 'bills', bills, (acc, r) => {
        acc.created = (acc.created || 0) + r.bills.created;
        acc.updated = (acc.updated || 0) + r.bills.updated;
        acc.unmatched = [...(acc.unmatched || []), ...r.bills.unmatched];
      });
      billStats.created += res.created || 0;
      billStats.updated += res.updated || 0;
      billStats.unmatched.push(...(res.unmatched || []).slice(0, 50));
    }
    console.log(`      已处理 ${Math.min(offset + READ_PAGE, totalBills)}/${totalBills}`);
  }
  billStats.unmatched = Array.from(new Set(billStats.unmatched)).slice(0, 200);
  report.steps.bills = { total: totalBills, ...billStats };
  console.log(
    `      新建 ${billStats.created}，更新 ${billStats.updated}，` +
    `已缴 ${billStats.paid} / 未缴 ${billStats.unpaid} / 退款 ${billStats.refunded}，` +
    `未匹配房号 ${billStats.unmatched.length}`,
  );

  // ---- 5. 车位费账单 ----
  console.log('\n[5/5] 车位费账单（泊位费）');
  const totalParking = countParkingBills();
  console.log(`      老库 ${totalParking} 条`);
  const parkStats = {
    total: totalParking,
    created: 0,
    updated: 0,
    unmatched: [],
    noHouse: 0,
    paid: 0,
    unpaid: 0,
    refunded: 0,
    cancelled: 0,
  };

  for (let offset = 0; offset < totalParking; offset += READ_PAGE) {
    const page = fetchParkingBills(offset, READ_PAGE);
    const rows = [];
    for (const row of page) {
      const status = row.取消日期
        ? 'cancelled'
        : row.退款日期
          ? 'refunded'
          : row.收款日期
            ? 'paid'
            : 'unpaid';
      parkStats[status] += 1;
      // 非小区业户（外来租户）没有本小区房号，fee_bills 的 house_id 挂不上，只能跳过
      if (!row.管理处 || !row.号) {
        parkStats.noHouse += 1;
        continue;
      }
      const spot = [row.车库编号, row.车位编号].filter(Boolean).join('-');
      const remark = [
        spot ? `车位 ${spot}` : null,
        row.车型 || null,
        row.牌照号 || null,
        row.用户类型 && row.用户类型 !== '本小区业户' ? row.用户类型 : null,
      ].filter(Boolean).join(' · ');
      rows.push({
        house: locatorOf(row),
        ownerName: truncate(row.用户姓名, 60),
        feeCode: 'parking',
        feeName: '泊位费',
        period: row.缴费年月,
        amountCents: toCents(row.金额),
        status,
        paidAt: toIso(row.收款日期),
        refundedAt: toIso(row.退款日期),
        // 车位费老系统没记收款方式，留空好过瞎填一个「现金」
        paymentMethod: null,
        receiptNo: status === 'unpaid' || !row.合并ID ? null : `HB${row.合并ID}`,
        remark: truncate(remark, 255),
        legacyRef: `wjwy:tz:${row.ID}`,
      });
    }

    if (!args.dryRun && !args.skipParking && rows.length) {
      const res = await postInChunks('/fees/import', 'bills', rows, (acc, r) => {
        acc.created = (acc.created || 0) + r.bills.created;
        acc.updated = (acc.updated || 0) + r.bills.updated;
        acc.unmatched = [...(acc.unmatched || []), ...r.bills.unmatched];
      });
      parkStats.created += res.created || 0;
      parkStats.updated += res.updated || 0;
      parkStats.unmatched.push(...(res.unmatched || []).slice(0, 50));
    }
    console.log(`      已处理 ${Math.min(offset + READ_PAGE, totalParking)}/${totalParking}`);
  }
  parkStats.unmatched = Array.from(new Set(parkStats.unmatched)).slice(0, 200);
  report.steps.parking = parkStats;
  console.log(
    `      新建 ${parkStats.created}，更新 ${parkStats.updated}，` +
    `已缴 ${parkStats.paid} / 未缴 ${parkStats.unpaid} / 退款 ${parkStats.refunded} / 作废 ${parkStats.cancelled}，` +
    `非小区业户无房号跳过 ${parkStats.noHouse}，未匹配房号 ${parkStats.unmatched.length}`,
  );

  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已写入 ${args.out}`);
}

main().catch((err) => {
  console.error('\n导入失败：', err.message);
  process.exit(1);
});
