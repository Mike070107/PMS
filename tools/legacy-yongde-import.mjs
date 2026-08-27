#!/usr/bin/env node
/**
 * 永德片区（剑川路140弄 / 150弄、龙吴路5511弄）房产 + 住户 导入 PMS。
 *
 * 为什么单独一个脚本、不复用 legacy-fee-import.mjs：
 * 枫桦那边一个「管理处」就是一个小区，直接映射即可；永德这片完全不是那个结构 ——
 *
 *  1. **同一套房在老库里存了 2~3 份**：`管理处 05 永德段` 是全量归档，
 *     `永德分公司私31xx / 居21xx / 代21xx` 是按房屋性质（私房/居住/代管）拆出来的副本。
 *     照管理处导会把每户建成两三条（150弄 2441 行室表其实只有 1233 个真实门牌）。
 *  2. **05 是 2004-2005 年的旧数据**：姓名不同的 999 户里只有 26 户有过缴费记录，
 *     最后一次收款停在 2005-12-01；分公司那几个码一路收到 2026。
 *     所以**业主姓名要取分公司副本**，05 只在「这个房号只有 05 有」时兜底。
 *  3. **老库没有「永南/永北」这个字段**。拆分依据是车库名：车库 09=永德永南段1、
 *     11=永德永北段1、12=永北246号自行车库、13=永南140弄19号自行车库，
 *     用 3217 条车位登记的地址反推出门牌归属（见 YONGDE_RULES，多数票极其干净）。
 *
 * 用法：
 *   node tools/legacy-yongde-import.mjs --tenant 1 --token <JWT> --mysql-password <pwd> [--dry-run]
 *
 * 幂等：房产按 (小区,弄,号,室) 查重，业主按 legacyRef `wjwy:zh:<ZH_ID>` upsert，可重跑。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    api: 'https://prsznh.cn/api/v1',
    mysql: 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe',
    db: '吴泾物业',
    user: 'root',
    password: process.env.LEGACY_MYSQL_PASSWORD || '',
    lanes: '140,150,5511',
    tenant: '',
    token: process.env.PMS_TOKEN || '',
    chunk: '1000',
    out: resolve(ROOT, 'data-prep', 'yongde-import-report.json'),
    dryRun: false,
    skipHouses: false,
    skipOwners: false,
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
      case '--lanes': args.lanes = next(); break;
      case '--tenant': args.tenant = next(); break;
      case '--token': args.token = next(); break;
      case '--chunk': args.chunk = next(); break;
      case '--out': args.out = next(); break;
      case '--dry-run': args.dryRun = true; break;
      case '--skip-houses': args.skipHouses = true; break;
      case '--skip-owners': args.skipOwners = true; break;
      default: throw new Error(`未知参数：${key}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const LANES = args.lanes.split(',').map((s) => s.trim()).filter(Boolean);
const CHUNK = Math.max(100, Number(args.chunk) || 1000);

/**
 * 弄 + 号 → PMS 小区名。
 *
 * 依据：老库车库名把车库标成了「永德永南段1」(09) / 「永德永北段1」(11) /
 * 「永北246号自行车库」(12) / 「永南140弄19号自行车库」(13)，用 3217 条车位登记的
 * 「地址」字段反推每个门牌的归属，得到下面的区间。多数票非常干净
 * （如 150弄28号 18南/1北、29号 1南/21北），个别反票是住户租到对面车库，属正常。
 *
 * 注意 5511弄不是一刀切：316-323 是夹在永北中间的一块永南飞地，别「优化」成一个区间。
 * 归属改起来很便宜（一个号 = buildings 表一行的 community_id），发现分错直接改。
 */
const YONGDE_RULES = [
  { lane: '140', ranges: [[1, 19]], community: '永南140弄', road: '剑川路' },
  { lane: '150', ranges: [[0, 28]], community: '永南150弄', road: '剑川路' },
  { lane: '150', ranges: [[29, 999]], community: '永北150弄', road: '剑川路' },
  { lane: '5511', ranges: [[223, 234], [316, 323]], community: '永南5511弄', road: '龙吴路' },
  { lane: '5511', ranges: [[236, 299], [324, 350]], community: '永北5511弄', road: '龙吴路' },
];

/** 老系统房屋性质 → 商铺（其余按住宅） */
const SHOP_KINDS = new Set(['04', '05', '06', '08', '10']);

/** '246东-3' → 246；认不出数字前缀返回 NaN */
function buildingNumber(no) {
  const m = String(no ?? '').match(/^\s*(\d+)/);
  return m ? Number(m[1]) : NaN;
}

function resolveCommunity(lane, buildingNo) {
  const n = buildingNumber(buildingNo);
  if (!Number.isFinite(n)) return null;
  for (const rule of YONGDE_RULES) {
    if (rule.lane !== lane) continue;
    if (rule.ranges.some(([lo, hi]) => n >= lo && n <= hi)) return rule;
  }
  return null;
}

// ---------------------------------------------------------------- MySQL

/** 见 legacy-fee-import.mjs 的同名函数：NULL 打印成字面量 NULL，制表符/换行被转义 */
function queryMysql(sql) {
  const out = execFileSync(
    args.mysql,
    [
      `-u${args.user}`,
      ...(args.password ? [`-p${args.password}`] : []),
      '--default-character-set=utf8mb4',
      '--batch',
      '-D', args.db,
      '-e', sql,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );
  const lines = out.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return [];
  const headers = lines[0].split('\t');
  const unescape = (v) =>
    v.replace(/\\([tnr0\\])/g, (_, ch) => ({ t: '\t', n: '\n', r: '\r', 0: '\0', '\\': '\\' }[ch]));
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

// ---------------------------------------------------------------- 清洗

/** 认得出的手机号才进 phone，其余（固话、带汉字的）原样留 contactNote */
function splitContact(raw) {
  const text = (raw || '').trim();
  if (!text) return { phone: null, contactNote: null };
  const compact = text.replace(/[\s-]/g, '');
  if (/^1[3-9]\d{9}$/.test(compact)) return { phone: compact, contactNote: null };
  const embedded = compact.match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
  if (embedded) return { phone: embedded[0], contactNote: text };
  return { phone: null, contactNote: text };
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
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const detail = parsed && parsed.message ? JSON.stringify(parsed.message) : String(text).slice(0, 300);
    throw new Error(`${method} ${path} → HTTP ${res.status} ${detail}`);
  }
  return parsed && typeof parsed === 'object' && 'code' in parsed && 'data' in parsed ? parsed.data : parsed;
}

// ---------------------------------------------------------------- 主流程

const laneList = LANES.map((l) => `'${l}'`).join(',');

async function main() {
  const report = { startedAt: new Date().toISOString(), lanes: LANES, steps: {} };

  // 一次把三个弄的所有房间连业主查出来（约 6600 行），在 JS 里按门牌去重
  const raw = queryMysql(`
    SELECT l.管理处, l.路, l.弄, l.号, s.室, s.建筑面积, s.房屋性质,
           z.ZH_ID, z.姓名, z.联系方式, z.车牌号
    FROM 楼表 l
    JOIN 室表 s ON s.L_ID = l.L_ID AND s.SC = 0
    LEFT JOIN 业主表 z ON z.S_ID = s.S_ID AND z.SC = 0 AND z.退户日期 IS NULL
    WHERE l.弄 IN (${laneList}) AND l.SC = 0
    ORDER BY l.弄, l.号, s.室
  `);
  console.log(`老库室表原始行数：${raw.length}（含 05 归档副本）`);

  /**
   * 按 (弄,号,室) 去重。同一门牌有多份时：
   * **优先非 05 的那份** —— 05「永德段」是 2004-2005 年的归档，姓名早就过时了。
   * 同为非 05 时取 ZH_ID 大的（后建的那条）。
   */
  const byDoor = new Map();
  const skippedNoCommunity = [];
  for (const row of raw) {
    const rule = resolveCommunity(row.弄, row.号);
    if (!rule) {
      skippedNoCommunity.push(`${row.弄}弄${row.号}号${row.室}`);
      continue;
    }
    const key = `${row.弄}|${row.号}|${row.室}`;
    const prev = byDoor.get(key);
    const isArchive = row.管理处 === '05';
    if (!prev) { byDoor.set(key, { ...row, rule, isArchive, others: [] }); continue; }
    // 现行副本压归档副本；同档次取 ZH_ID 大的
    const better =
      (prev.isArchive && !isArchive) ||
      (prev.isArchive === isArchive && Number(row.ZH_ID || 0) > Number(prev.ZH_ID || 0));
    if (better) {
      byDoor.set(key, { ...row, rule, isArchive, others: [...prev.others, prev] });
    } else {
      prev.others.push(row);
    }
  }

  /**
   * 联系方式补捞：93 条联系方式里 91 条在 05 归档副本上，选中的现行副本反而是空的。
   * **只在两份记录姓名一致时才补** —— 姓名不同说明房子已经换过户，
   * 那个号码是上一任业主的，安到现住户名下就是给错人打电话（37 条属于这种，一律不补）。
   */
  let mergedContacts = 0;
  for (const door of byDoor.values()) {
    if (String(door.联系方式 || '').trim()) continue;
    const sameName = door.others.find(
      (o) =>
        String(o.联系方式 || '').trim() &&
        String(o.姓名 || '').trim() === String(door.姓名 || '').trim() &&
        String(door.姓名 || '').trim() !== '',
    );
    if (sameName) {
      door.联系方式 = sameName.联系方式;
      mergedContacts += 1;
    }
  }
  const doors = [...byDoor.values()];
  console.log(`去重后真实门牌：${doors.length}（跳过无法归属的 ${skippedNoCommunity.length} 条）`);

  const byCommunity = {};
  for (const d of doors) {
    byCommunity[d.rule.community] = (byCommunity[d.rule.community] || 0) + 1;
  }
  console.log('按小区分布：', byCommunity);
  console.log(`其中仍取自 05 归档副本（该门牌没有现行副本）：${doors.filter((d) => d.isArchive).length}`);
  console.log(`从同名的另一份副本补回联系方式：${mergedContacts} 条`);
  report.steps.dedupe = {
    rawRows: raw.length,
    doors: doors.length,
    byCommunity,
    fromArchive: doors.filter((d) => d.isArchive).length,
    mergedContacts,
    skippedNoCommunity: skippedNoCommunity.slice(0, 100),
  };

  if (args.dryRun) {
    const withOwner = doors.filter((d) => d.ZH_ID && String(d.姓名 || '').trim());
    const contacts = withOwner.map((d) => splitContact(d.联系方式));
    console.log(`业主档案：${withOwner.length} 条（手机 ${contacts.filter((c) => c.phone).length}、其它联系方式 ${contacts.filter((c) => !c.phone && c.contactNote).length}）`);
    console.log('\n[dry-run] 未写入任何数据');
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
    return;
  }

  authHeader = `Bearer ${args.token}`;
  const communities = await api('/communities', { query: { includeGroups: true } });
  const communityByName = new Map(communities.map((c) => [c.name, c]));
  for (const name of Object.keys(byCommunity)) {
    if (!communityByName.has(name)) {
      throw new Error(`PMS 里没有小区「${name}」，请先在「房产管理」里建好再导`);
    }
  }

  // ---- 房产 ----
  const existing = await api('/houses');
  const norm = (v) => String(v ?? '').replace(/\s+/g, '').trim();
  const houseKey = (c, lane, no, room) => `${norm(c)}|${norm(lane)}|${norm(no)}|${norm(room)}`;
  const have = new Set(existing.map((h) => houseKey(h.communityName, h.lane, h.buildingNo, h.roomNo)));

  const houseResult = { total: doors.length, created: 0, skipped: 0, failed: [] };
  if (!args.skipHouses) {
    /**
     * 按楼栋分组、组内串行、组间并发。
     *
     * POST /houses 传 (communityId + lane + buildingNo) 时服务端会 upsert 楼栋，
     * 那是「先查再写」不是原子操作：同一栋楼的两个请求并发就可能建出两条楼栋记录。
     * 按楼分组后同一栋楼永远只有一个请求在飞，不同楼之间才并发，既安全又快 4 倍。
     * （走这条路而不是先 POST /buildings，是因为建楼接口会顺带生成小程序码图片，
     *   190 栋楼 = 190 次微信 getUnlimited，容易把频率打爆；房号这条路只落码记录不出图，
     *   图留给「楼栋报修码」页的「批量补齐」统一生成。）
     */
    const groups = new Map();
    for (const d of doors) {
      const gk = `${d.rule.community}|${d.弄}|${d.号}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(d);
    }
    const groupList = [...groups.values()];
    console.log(`    ${doors.length} 个房号分布在 ${groupList.length} 栋楼，按楼分组并发导入`);

    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < groupList.length) {
        const group = groupList[cursor++];
        for (const d of group) {
          done += 1;
          if (done % 200 === 0) process.stdout.write(`    房产 ${done}/${doors.length}\r`);
          if (have.has(houseKey(d.rule.community, d.弄, d.号, d.室))) { houseResult.skipped += 1; continue; }
          const road = d.rule.road;
          const roomSuffix = /^\d+$/.test(String(d.室 || '')) ? '室' : '';
          try {
            await api('/houses', {
              method: 'POST',
              body: {
                communityId: communityByName.get(d.rule.community).id,
                lane: d.弄,
                buildingNo: d.号,
                roomNo: d.室,
                propertyType: SHOP_KINDS.has(d.房屋性质) ? '商铺' : '住宅',
                roadName: road,
                fullAddress: `${road}${d.弄}弄${d.号}号${d.室}${roomSuffix}`,
                areaSqm: d.建筑面积 && Number(d.建筑面积) > 0 ? String(d.建筑面积) : undefined,
              },
            });
            houseResult.created += 1;
          } catch (e) {
            if (houseResult.failed.length < 100) {
              houseResult.failed.push(`${d.rule.community} ${d.弄}/${d.号}/${d.室}：${e.message}`);
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    process.stdout.write('\n');
  }
  console.log(`[房产] 新建 ${houseResult.created}，已存在跳过 ${houseResult.skipped}，失败 ${houseResult.failed.length}`);
  report.steps.houses = houseResult;

  // ---- 业主档案 ----
  const owners = doors
    .filter((d) => d.ZH_ID && String(d.姓名 || '').trim())
    .map((d) => {
      const contact = splitContact(d.联系方式);
      return {
        communityName: d.rule.community,
        lane: d.弄,
        buildingNo: d.号,
        roomNo: d.室,
        name: truncate(d.姓名, 60),
        phone: contact.phone,
        contactNote: truncate(contact.contactNote, 255),
        legacyRef: `wjwy:zh:${d.ZH_ID}`,
      };
    });
  console.log(`[业主] 待导 ${owners.length} 条（手机 ${owners.filter((o) => o.phone).length}、仅其它联系方式 ${owners.filter((o) => !o.phone && o.contactNote).length}）`);

  const ownerResult = { total: owners.length, created: 0, updated: 0, unmatched: [], conflicts: [] };
  if (!args.skipOwners) {
    for (let i = 0; i < owners.length; i += CHUNK) {
      const slice = owners.slice(i, i + CHUNK);
      const res = await api('/owners-mgmt/import', { method: 'POST', body: { rows: slice } });
      ownerResult.created += res.created;
      ownerResult.updated += res.updated;
      ownerResult.unmatched.push(...res.unmatched);
      ownerResult.conflicts.push(...res.conflicts);
      process.stdout.write(`    业主 ${Math.min(i + CHUNK, owners.length)}/${owners.length}\r`);
    }
    process.stdout.write('\n');
  }
  ownerResult.unmatched = ownerResult.unmatched.slice(0, 200);
  ownerResult.conflicts = ownerResult.conflicts.slice(0, 200);
  console.log(`[业主] 新建 ${ownerResult.created}，更新 ${ownerResult.updated}，未匹配房号 ${ownerResult.unmatched.length}，冲突 ${ownerResult.conflicts.length}`);
  report.steps.owners = ownerResult;

  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已写入 ${args.out}`);
}

main().catch((err) => {
  console.error('\n导入失败：', err.message);
  process.exit(1);
});
