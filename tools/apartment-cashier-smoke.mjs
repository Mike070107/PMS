/**
 * 公寓收费工作台冒烟：真登录、真点、真断言，给 browser-automation skill 的 --script 用。
 *
 * 为什么要有：这页之前只注册在 import.meta.env.DEV 的 /dev 预览路由里，生产构建
 * 组件是 null，用户在「收费业务」里根本找不到（2026-10-11 Mike：「为什么我到现在
 * 都没建到收费业务里出现你新开发的这个页面」）。typecheck 和 build 发现不了这种
 * 「接没接进去」的缺陷，只能用真账号点菜单来证。
 *
 * 用法：node <browser-automation skill 目录>/browser.mjs https://prsznh.cn/login \
 *         --script D:/00项目开发/PMS/tools/apartment-cashier-smoke.mjs
 * 账号同 web-smoke：.smoke-credentials 两行，或 PMS_SMOKE_USER/PMS_SMOKE_PASS。
 * 账号必须同时满足两件事，否则菜单里本来就不会有这项，测出来的失败不是代码的问题：
 *   1) 所属物业公司的功能授权（tenants.enabled_pages）开了 `fees`；
 *   2) 账号的业务角色对 `fees` 有查看权（企业超级管理员自动全开）。
 * 现成的 testadmin 是「吴泾物业总经理」，角色没勾 fees，用它跑这条会红。
 *
 * 只做只读操作：登录、点菜单、展开三级选址下拉。不提交收费表单 —— 这是生产库，
 * 一旦落账就得再去冲红。
 */
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.env.PMS_SMOKE_BASE || 'https://prsznh.cn';
const SHOT_DIR = process.env.PMS_SMOKE_SHOT || '';

function credentials() {
  if (process.env.PMS_SMOKE_USER && process.env.PMS_SMOKE_PASS) {
    return { account: process.env.PMS_SMOKE_USER, password: process.env.PMS_SMOKE_PASS };
  }
  for (const file of ['.smoke-credentials', '../.smoke-credentials', 'D:/00项目开发/PMS/.smoke-credentials']) {
    if (!existsSync(file)) continue;
    const [account, password] = readFileSync(file, 'utf8').trim().split(/\r?\n/).map((s) => s.trim());
    if (account && password) return { account, password };
  }
  throw new Error('没有测试账号：先写 .smoke-credentials（两行：账号、密码）或设 PMS_SMOKE_USER/PMS_SMOKE_PASS');
}

const settled = (page) =>
  page.waitForFunction(() => document.body.innerText.replace(/\s/g, '').length > 40, { timeout: 120000 });
const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/cashier-${name}.png`, fullPage: true }).catch(() => {});
};

/** 展开某个 label 对应的下拉，返回选项文字 */
async function openSelect(page, label) {
  const box = page.locator('.cashier-room-form label', { hasText: label }).first();
  await box.locator('.ant-select').click({ timeout: 30000 });
  await page.waitForTimeout(1200);
  const options = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content');
  const texts = await options.allInnerTexts();
  return { box, options, texts: texts.map((t) => t.trim()).filter(Boolean) };
}

export default async function run(page) {
  const { account, password } = credentials();
  const cases = [];
  const check = async (name, fn) => {
    try {
      const value = await fn();
      cases.push({ name, ok: value?.ok !== false, ...value });
    } catch (e) {
      cases.push({ name, ok: false, error: String(e).slice(0, 300) });
    }
  };

  await page.setViewportSize({ width: 1440, height: 900 });

  await check('登录', async () => {
    await settled(page);
    await page.getByRole('tab', { name: '账号密码' }).click({ timeout: 30000 });
    await page.locator('input[placeholder="请输入登录账号"]').fill(account);
    await page.locator('input[placeholder="请输入密码"]').fill(password);
    await page.getByRole('button', { name: /登\s*录/ }).first().click();
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 60000 });
    return { ok: true, url: page.url() };
  });

  await check('收费业务菜单里有「公寓收费工作台」，点进去就是这页', async () => {
    const item = page.locator('.ant-menu-item', { hasText: '公寓收费工作台' }).first();
    const visible = await item.count();
    if (!visible) {
      const menu = (await page.locator('.ant-menu').innerText()).replace(/\s+/g, ' ');
      return { ok: false, reason: '菜单里找不到公寓收费工作台', menu: menu.slice(0, 300) };
    }
    await item.click();
    await page.waitForFunction(() => location.pathname === '/apartment-cashier', { timeout: 30000 });
    await settled(page);
    await page.waitForTimeout(2500);
    const text = (await page.locator('.apartment-cashier').innerText()).replace(/\s+/g, ' ');
    await shot(page, '01-page');
    return { ok: text.includes('选择收费房间'), path: new URL(page.url()).pathname, head: text.slice(0, 80) };
  });

  await check('选址是小区 → 楼栋 → 房号三级，且公寓地址里不塞弄号', async () => {
    const labels = (await page.locator('.cashier-room-form label b').allInnerTexts()).map((t) => t.trim());
    const order = labels.slice(0, 3).join('>');
    const community = await openSelect(page, '小区');
    if (!community.texts.length) return { ok: false, reason: '小区下拉是空的', labels };
    const target = community.texts.find((t) => t.includes('颛桥')) || community.texts[0];
    await community.options.filter({ hasText: target }).first().click();
    await page.waitForTimeout(2500);

    const building = await openSelect(page, '楼栋');
    if (!building.texts.length) return { ok: false, reason: `${target} 下没有楼栋`, labels };
    await building.options.first().click();
    await page.waitForTimeout(2500);

    const room = await openSelect(page, '房号');
    if (!room.texts.length) return { ok: false, reason: '楼栋下没有房号', labels };
    await room.options.first().click();
    await page.waitForTimeout(2500);
    await shot(page, '02-address');

    const laneInBuilding = building.texts.some((t) => t.includes('弄'));
    return {
      ok: order === '小区>楼栋>房号' && !laneInBuilding,
      order,
      community: target,
      buildings: building.texts.length,
      rooms: room.texts.length,
      laneInBuilding,
    };
  });

  await check('选中房号带出业主姓名和电话（旧地址已进业主档案）', async () => {
    // 注意：带 showSearch 的 antd Select 自己也渲染一个 <input>，按序号取会取到小区
    // 那个搜索框，一定要按 placeholder 定位。
    const form = page.locator('.cashier-room-form');
    const name = await form.locator('input[placeholder*="姓名"]').first().inputValue();
    const phone = await form.locator('input[placeholder*="手机号"]').first().inputValue();
    const room = (await page.locator('.cashier-selected-room').innerText()).replace(/\s+/g, ' ');
    await shot(page, '03-owner');
    return { ok: !!name, name: name ? '有' : '空', phone: phone ? '有' : '空', room: room.slice(0, 60) };
  });

  await check('历史缴费显示收费员姓名，不是旧库裸的操作员 id', async () => {
    const list = page.locator('.cashier-history');
    if (!(await list.count())) return { ok: false, reason: '没有历史缴费区块' };
    const text = (await list.innerText()).replace(/\s+/g, ' ');
    await shot(page, '04-history');
    const bareId = /收费员\s*[:：]?\s*\d+\b/.test(text);
    return { ok: !bareId, bareId, sample: text.slice(0, 200) };
  });

  const failed = cases.filter((c) => !c.ok);
  return { passed: cases.length - failed.length, failed: failed.length, cases };
}
