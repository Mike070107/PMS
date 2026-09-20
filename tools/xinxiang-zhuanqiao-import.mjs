#!/usr/bin/env node
/**
 * 用户提供的「馨香臣寓颏桥店」房间清单→生产房产。
 *
 * 数字房间：1-101 = 1 号楼 101 室，类型为公寓。
 * 中文房间：没有楼层的独立商铺，收在「单层商铺」这个楼栋分组下，
 *             roomNo/shopName 保留原名，fullAddress 不带虚构门牌号。
 *
 * 用法：
 *   node tools/xinxiang-zhuanqiao-import.mjs --dry-run
 *   PMS_TOKEN=<短期 JWT> node tools/xinxiang-zhuanqiao-import.mjs
 *
 * 幂等：按（小区，楼栋，房号）跳过已存在房产；同一楼栋串行、不同楼栋并发，
 * 避免楼栋 upsert 的「先查后建」在并发时造成重复楼栋。
 */

const COMMUNITY_NAME = '馨香臣寓颏桥店';
const EXPECTED_OFFICE_NAME = '馨香臣寓颏桥店管理处';
const SHOP_BUILDING = '单层商铺';
const SHOP_NAMES = ['物业办公室', '建信办公室', '超市', '棋牌室'];

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run');
const apiBase = process.env.PMS_API || 'https://prsznh.cn/api/v1';
const token = process.env.PMS_TOKEN || '';
const tenantId = process.env.PMS_TENANT_ID || '1';

function generateRows() {
  const rows = [];
  for (let building = 1; building <= 12; building += 1) {
    const roomsPerFloor = building % 2 === 0 ? 8 : 7;
    for (let floor = 1; floor <= 3; floor += 1) {
      for (let room = 1; room <= roomsPerFloor; room += 1) {
        const roomNo = `${floor}0${room}`;
        rows.push({
          buildingNo: String(building),
          roomNo,
          propertyType: '公寓',
          fullAddress: `${COMMUNITY_NAME}${building}号${roomNo}室`,
        });
      }
    }
  }
  for (let room = 1; room <= 7; room += 1) {
    const roomNo = `10${room}`;
    rows.push({
      buildingNo: '13',
      roomNo,
      propertyType: '公寓',
      fullAddress: `${COMMUNITY_NAME}13号${roomNo}室`,
    });
  }
  for (let room = 1; room <= 2; room += 1) {
    const roomNo = `10${room}`;
    rows.push({
      buildingNo: '15',
      roomNo,
      propertyType: '公寓',
      fullAddress: `${COMMUNITY_NAME}15号${roomNo}室`,
    });
  }
  SHOP_NAMES.forEach((name) => {
    rows.push({
      buildingNo: SHOP_BUILDING,
      roomNo: name,
      propertyType: '商铺',
      shopName: name,
      fullAddress: `${COMMUNITY_NAME}${name}`,
    });
  });
  return rows;
}

const rows = generateRows();
if (rows.length !== 283) throw new Error(`清单数量应为 283，实际 ${rows.length}`);
if (rows.filter((row) => row.propertyType === '公寓').length !== 279) {
  throw new Error('公寓房间数量应为 279');
}

async function request(path, { method = 'GET', body, query } = {}) {
  const url = new URL(apiBase.replace(/\/$/, '') + path);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-acting-tenant-id': tenantId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> HTTP ${response.status} ${String(parsed?.message || text).slice(0, 300)}`);
  }
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
}

async function main() {
  console.log(`清单：${rows.length} 套（公寓 279，商铺 4）`);
  console.log('楼栋：1–13 号、15 号，以及「单层商铺」分组');
  if (dryRun) {
    console.log('[dry-run] 未写入任何数据');
    return;
  }
  if (!token) throw new Error('缺少 PMS_TOKEN');

  const communities = await request('/communities', { query: { includeGroups: true } });
  const community = communities.find((item) => item.name === COMMUNITY_NAME && !item.isGroup);
  if (!community) throw new Error(`生产不存在小区「${COMMUNITY_NAME}」`);
  if (community.officeName !== EXPECTED_OFFICE_NAME) {
    throw new Error(
      `「${COMMUNITY_NAME}」当前归属「${community.officeName || '未划入'}」，` +
      `不是「${EXPECTED_OFFICE_NAME}」，停止导入`,
    );
  }

  const existing = await request('/houses', { query: { communityId: community.id } });
  const keyOf = (buildingNo, roomNo) => `${String(buildingNo).trim()}|${String(roomNo).trim()}`;
  const have = new Set(existing.map((row) => keyOf(row.buildingNo, row.roomNo)));
  const groups = new Map();
  rows.forEach((row) => {
    if (!groups.has(row.buildingNo)) groups.set(row.buildingNo, []);
    groups.get(row.buildingNo).push(row);
  });

  const result = { created: 0, skipped: 0, failed: [] };
  let cursor = 0;
  const groupList = [...groups.values()];
  const worker = async () => {
    while (cursor < groupList.length) {
      const group = groupList[cursor++];
      for (const row of group) {
        if (have.has(keyOf(row.buildingNo, row.roomNo))) {
          result.skipped += 1;
          continue;
        }
        try {
          await request('/houses', {
            method: 'POST',
            body: { communityId: community.id, ...row },
          });
          result.created += 1;
        } catch (error) {
          result.failed.push(`${row.buildingNo}-${row.roomNo}: ${error.message}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`新建 ${result.created}，已存在跳过 ${result.skipped}，失败 ${result.failed.length}`);
  result.failed.slice(0, 20).forEach((line) => console.error(line));
  if (result.failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
