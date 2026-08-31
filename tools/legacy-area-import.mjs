#!/usr/bin/env node
/**
 * 老收费系统「片区」→ PMS 房产 + 住户档案导入（按 --area 选片区，配置见 AREAS）。
 *
 * 为什么单独一个脚本、不复用 legacy-fee-import.mjs：
 * 枫桦那边一个「管理处」就是一个小区，直接映射即可；永德/吴泾这些片区完全不是那个结构 ——
 *
 *  1. **同一套房在老库里存了 2~3 份**：`永德段(05)`/`吴泾段(06)` 是全量归档，
 *     `X分公司私31xx / 居21xx / 代21xx / 系21xx` 是按房屋性质拆出来的副本。
 *     照管理处导会把每户建成两三条（150弄 2441 行室表其实只有 1233 个真实门牌，
 *     龙吴路5530弄 5138 行只有 2708 个）。
 *  2. **归档副本是十几年前的旧数据**：永德 05 最后收款停在 2005-12-01、吴泾 06 停在 2007-01-01，
 *     姓名冲突时归档副本几乎没有缴费记录（吴泾 5530弄：现行 801/819 有收款，归档只有 10/817）。
 *     所以**业主姓名取分公司副本**，归档只在「这个房号只有它有」时兜底。
 *     判据是各管理处的 MAX(wyzj.ZJ_SKRQ)，接新片区先跑这条。
 *  3. **老库没有「永南/永北」这个字段**。拆分依据是车库名：车库 09=永德永南段1、
 *     11=永德永北段1、12=永北246号自行车库、13=永南140弄19号自行车库，
 *     用 3217 条车位登记的地址反推出门牌归属（见 YONGDE_RULES，多数票极其干净）。
 *
 * 用法：
 *   node tools/legacy-area-import.mjs --area yongde|wujing|jinchuan|xinjia --tenant 1 --token <JWT> --mysql-password <pwd> [--dry-run]
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
    area: '',
    tenant: '',
    token: process.env.PMS_TOKEN || '',
    chunk: '1000',
    out: '',
    dryRun: false,
    skipHouses: false,
    skipOwners: false,
    createMissing: false,
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
      case '--area': args.area = next(); break;
      case '--tenant': args.tenant = next(); break;
      case '--token': args.token = next(); break;
      case '--chunk': args.chunk = next(); break;
      case '--out': args.out = next(); break;
      case '--dry-run': args.dryRun = true; break;
      case '--skip-houses': args.skipHouses = true; break;
      case '--skip-owners': args.skipOwners = true; break;
      case '--create-missing': args.createMissing = true; break;
      default: throw new Error(`未知参数：${key}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const CHUNK = Math.max(100, Number(args.chunk) || 1000);
const REPORT_PATH = args.out || resolve(ROOT, 'data-prep', `${args.area || 'area'}-import-report.json`);

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

/**
 * 片区配置。`sources` 决定从老库捞哪些「路+弄」，`rules` 决定每个门牌落到哪个 PMS 小区。
 * 规则不带 `ranges` = 这个弄整个归一个小区。
 *
 * **弄号必须连路一起限定**：老库里同一个弄号会出现在不同的路上，
 * 而且路名本身还有「龙吴」「龙吴路」两种写法，只按弄过滤会捞进别的小区。
 */
const AREAS = {
  yongde: {
    label: '永德片区（剑川路140/150弄、龙吴路5511弄）',
    sources: [
      { roadLike: '剑川%', lane: '140' },
      { roadLike: '剑川%', lane: '150' },
      { roadLike: '龙吴%', lane: '5511' },
    ],
    // 「永德段」是 2004-2005 年的全量归档，同门牌有现行副本时一律让位
    archiveOffices: ['05'],
    rules: YONGDE_RULES,
  },
  wujing: {
    label: '吴泾新村（龙吴路5530弄）',
    sources: [{ roadLike: '龙吴%', lane: '5530' }],
    // 「吴泾段」同理，最后收款停在 2007-01-01
    archiveOffices: ['06'],
    rules: [{ lane: '5530', community: '吴泾新村', road: '龙吴路' }],
  },
  jinchuan: {
    label: '锦川公寓（剑川路139弄）',
    sources: [{ roadLike: '剑川%', lane: '139' }],
    // 只有管理处 14 一份，没有归档副本
    archiveOffices: [],
    rules: [{ lane: '139', community: '锦川公寓', road: '剑川路' }],
  },
  xinjia: {
    label: '上海新家（通海路328弄 + 临街非居住）',
    // 通海路还有 360弄（管理处 99/61）和招商部的几间，不属于上海新家，
    // 所以这里必须连管理处一起限定，不能只按路名捞
    sources: [
      { roadLike: '通海%', lane: '328', office: '44' },
      { roadLike: '通海%', lane: null, office: '44' },
    ],
    archiveOffices: [],
    rules: [
      { lane: '328', community: '上海新家', road: '通海路' },
      { lane: null, community: '上海新家', road: '通海路' },
    ],
    /**
     * 临街那 8 间的「号」在老库里被填成了字面量「非居住」（房屋性质当门牌用），
     * 真门牌（348甲/348乙/350甲…）塞在「室」里。照搬会在房产树上出现一个
     * 「非居住号」的楼栋，维修工按这个地址找不到门。
     * 这里把它掰正：门牌号 = 原来的「室」，室号统一记「商铺」（与枫桦临街商铺一致）。
     */
    normalize(row) {
      if (String(row.号 ?? '').trim() === '非居住') {
        return { ...row, 号: String(row.室 ?? '').trim(), 室: '商铺' };
      }
      return row;
    },
  },
};

const AREA = AREAS[args.area];
if (!AREA) {
  throw new Error(`--area 必须是：${Object.keys(AREAS).join(' / ')}`);
}

/** 老系统房屋性质 → 商铺（其余按住宅） */
const SHOP_KINDS = new Set(['04', '05', '06', '08', '10']);

/** '246东-3' → 246；认不出数字前缀返回 NaN */
function buildingNumber(no) {
  const m = String(no ?? '').match(/^\s*(\d+)/);
  return m ? Number(m[1]) : NaN;
}

function resolveCommunity(lane, buildingNo) {
  const n = buildingNumber(buildingNo);
  for (const rule of AREA.rules) {
    // lane 为 null 的规则匹配「这条路上没写弄」的那批
    const laneMatch = rule.lane == null ? (lane == null || lane === '') : rule.lane === lane;
    if (!laneMatch) continue;
    if (!rule.ranges) return rule; // 整个弄归一个小区，门牌不是数字也认（车库、配套房）
    if (Number.isFinite(n) && rule.ranges.some(([lo, hi]) => n >= lo && n <= hi)) return rule;
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

/**
 * 路 + 弄（+ 可选管理处）一起限定，见 AREAS 的注释。
 * `lane: null` = 这条路上没写弄的那批；`office` 用于同一条路上还有别家小区的情况。
 */
const sourceFilter = AREA.sources
  .map((s) => {
    const parts = [`l.路 LIKE '${s.roadLike}'`];
    parts.push(s.lane == null ? `(l.弄 IS NULL OR l.弄 = '')` : `l.弄 = '${s.lane}'`);
    if (s.office) parts.push(`l.管理处 = '${s.office}'`);
    return `(${parts.join(' AND ')})`;
  })
  .join(' OR ');

async function main() {
  const report = { startedAt: new Date().toISOString(), area: args.area, steps: {} };

  // 一次把三个弄的所有房间连业主查出来（约 6600 行），在 JS 里按门牌去重
  const raw = queryMysql(`
    SELECT l.管理处, l.路, l.弄, l.号, s.室, s.建筑面积, s.房屋性质,
           z.ZH_ID, z.姓名, z.联系方式, z.车牌号
    FROM 楼表 l
    JOIN 室表 s ON s.L_ID = l.L_ID AND s.SC = 0
    LEFT JOIN 业主表 z ON z.S_ID = s.S_ID AND z.SC = 0 AND z.退户日期 IS NULL
    WHERE (${sourceFilter}) AND l.SC = 0
    ORDER BY l.弄, l.号, s.室
  `);
  console.log(`【${AREA.label}】老库室表原始行数：${raw.length}（含归档副本）`);

  /**
   * 按 (弄,号,室) 去重。同一门牌有多份时：
   * **优先非 05 的那份** —— 05「永德段」是 2004-2005 年的归档，姓名早就过时了。
   * 同为非 05 时取 ZH_ID 大的（后建的那条）。
   */
  const byDoor = new Map();
  const skippedNoCommunity = [];
  for (const rawRow of raw) {
    // 片区自带的门牌矫正（如上海新家把「号」填成了「非居住」），在去重之前做，
    // 否则同一间房会因为矫正前后 key 不同而被当成两间
    const row = AREA.normalize ? AREA.normalize(rawRow) : rawRow;
    const rule = resolveCommunity(row.弄, row.号);
    if (!rule) {
      skippedNoCommunity.push(`${row.弄}弄${row.号}号${row.室}`);
      continue;
    }
    const key = `${row.弄}|${row.号}|${row.室}`;
    const prev = byDoor.get(key);
    const isArchive = (AREA.archiveOffices ?? []).includes(row.管理处);
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
   * 联系方式补捞：永德那批 93 条联系方式里 91 条在归档副本上，选中的现行副本反而是空的。
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
  console.log(`其中仍取自归档副本（该门牌没有现行副本）：${doors.filter((d) => d.isArchive).length}`);
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
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    return;
  }

  authHeader = `Bearer ${args.token}`;
  const communities = await api('/communities', { query: { includeGroups: true } });
  const communityByName = new Map(communities.map((c) => [c.name, c]));
  /**
   * 目标小区必须在 PMS 里已经存在，**默认不自动创建**。
   *
   * 2026-08-29 踩过：这里原来是「找不到就建一个顶层小区」。用户当天把小区结构
   * 重组过（「龙吴路5530弄」改名成「吴泾新村」并挂到管理处底下），规则里的名字没跟着改，
   * 脚本就默默建了个游离的顶层「龙吴路5530弄」，2713 套房全导进了错的地方 ——
   * 树上看不出异常，得对着数据库才发现。名字对不上时**停下来把候选列出来**，
   * 比事后搬 149 栋楼便宜得多。确实要新建时加 --create-missing。
   */
  const missing = Object.keys(byCommunity).filter((name) => !communityByName.has(name));
  if (missing.length && !args.createMissing) {
    const candidates = communities
      .filter((c) => !c.isGroup)
      .map((c) => c.name)
      .join('、');
    throw new Error(
      `PMS 里没有小区「${missing.join('」「')}」。\n` +
      `  现有可挂房产的小区：${candidates}\n` +
      `  → 改 AREAS 里的 community 名字对上，或加 --create-missing 让脚本新建（会建成顶层小区，之后要手工挂到管理处下）`,
    );
  }
  for (const name of missing) {
    const rule = AREA.rules.find((r) => r.community === name);
    const created = await api('/communities', {
      method: 'POST',
      body: { name, address: rule ? `${rule.road}${rule.lane}弄` : undefined },
    });
    communityByName.set(name, created);
    console.log(`  ⚠ 新建了顶层小区「${name}」（id ${created.id}）—— 记得去「房产管理」把它挂到对应管理处下面`);
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
          // 「弄」可能没有（临街门牌）。不判空会拼出「通海路null弄348甲号」这种地址，
          // 前面几个片区每行都有弄，一直没暴露（2026-08-31 导上海新家时撞上）。
          const lanePart = d.弄 ? `${d.弄}弄` : '';
          const room = String(d.室 ?? '').trim();
          const isShop = SHOP_KINDS.has(d.房屋性质);
          // 商铺的「室」在老库里就是「商铺」两个字，地址里不该再重复一遍
          // （与房产页 buildFullAddress 的规则一致）
          const roomPart =
            isShop && (!room || room === '商铺')
              ? ''
              : `${room}${/^\d+$/.test(room) ? '室' : ''}`;
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
                fullAddress: `${road}${lanePart}${d.号}号${roomPart}`,
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
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已写入 ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('\n导入失败：', err.message);
  process.exit(1);
});
