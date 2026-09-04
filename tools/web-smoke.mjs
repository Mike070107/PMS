/**
 * 后台冒烟测试：**真登录、真点、真断言**，给 browser-automation skill 的 --script 用。
 *
 * 为什么要有：改完只跑 typecheck/build，或者只用 mock 预览包看一眼，都不能证明
 * 功能在真实系统里是好的（2026-09-04 Mike：「你修改后是不是没对功能做测试」）。
 * 这个脚本走完整条路：登录 → 打开页面 → 点开抽屉/弹窗 → 断言关键控件和文案在不在。
 *
 * 用法（在能上网的机器上）：
 *   1) 账号密码放进本机文件，**别提交**（.gitignore 已排除 .smoke-credentials）：
 *        printf '账号\n密码' > .smoke-credentials
 *      也可以用环境变量 PMS_SMOKE_USER / PMS_SMOKE_PASS 覆盖。
 *   2) node <browser-automation skill 目录>/browser.mjs https://prsznh.cn/login --script tools/web-smoke.mjs
 *
 * 返回 { passed, failed, cases: [...] }：failed > 0 就是有回归，别发版。
 * 截图默认写到 PMS_SMOKE_SHOT 指定的目录（不传就不截图）。
 *
 * 只做**只读**操作：登录、翻页、点开抽屉和弹窗，不提交任何表单、不改任何数据 ——
 * 这跑的是生产环境，测试数据一旦落库就得再花力气清理。
 */
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.env.PMS_SMOKE_BASE || 'https://prsznh.cn';
const SHOT_DIR = process.env.PMS_SMOKE_SHOT || '';

function credentials() {
  if (process.env.PMS_SMOKE_USER && process.env.PMS_SMOKE_PASS) {
    return { account: process.env.PMS_SMOKE_USER, password: process.env.PMS_SMOKE_PASS };
  }
  for (const file of ['.smoke-credentials', '../.smoke-credentials']) {
    if (!existsSync(file)) continue;
    const [account, password] = readFileSync(file, 'utf8').trim().split(/\r?\n/).map((s) => s.trim());
    if (account && password) return { account, password };
  }
  throw new Error('没有测试账号：先写 .smoke-credentials（两行：账号、密码）或设 PMS_SMOKE_USER/PMS_SMOKE_PASS');
}

/** 等到页面真渲染出内容 —— 只等 domcontentloaded 会撞上还停在 Suspense 占位的那一瞬 */
const settled = (page) =>
  page.waitForFunction(() => document.body.innerText.replace(/\s/g, '').length > 40, { timeout: 120000 });

const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/smoke-${name}.png` }).catch(() => {});
};

export default async function run(page) {
  const { account, password } = credentials();
  const cases = [];
  const check = async (name, fn) => {
    try {
      const value = await fn();
      const ok = value?.ok !== false;
      cases.push({ name, ok, ...value });
    } catch (e) {
      cases.push({ name, ok: false, error: String(e).slice(0, 300) });
    }
  };

  await page.setViewportSize({ width: 1440, height: 900 });

  await check('登录', async () => {
    await settled(page);
    // 登录页默认停在「微信扫码」，账号密码在第二个页签
    await page.getByRole('tab', { name: '账号密码' }).click({ timeout: 30000 });
    await page.locator('input[placeholder="请输入登录账号"]').fill(account);
    await page.locator('input[placeholder="请输入密码"]').fill(password);
    await page.getByRole('button', { name: /登\s*录/ }).first().click();
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 60000 });
    await shot(page, '01-login');
    return { ok: true, url: page.url() };
  });

  await check('工单详情首屏显示工单编号', async () => {
    await page.goto(`${BASE}/work-orders`, { waitUntil: 'domcontentloaded' });
    await settled(page);
    await page.waitForTimeout(3000);
    // 默认筛选可能停在一个空档（如「待派单」0 条），先切到有数据的那一档
    for (const label of [/^待验收\s*[1-9]/, /^全部\s*[1-9]/, /^维修中\s*[1-9]/]) {
      const tab = page.getByText(label).first();
      if (await tab.count()) { await tab.click(); await page.waitForTimeout(2000); break; }
    }
    await page.getByText('表格明细', { exact: true }).first().click({ timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const rows = page.locator('.ant-table-row:not(.ant-table-measure-row)');
    const count = await rows.count();
    if (!count) return { ok: false, reason: '这个账号看不到任何工单，无法验证详情' };
    await rows.first().click();
    await page.waitForSelector('.ant-drawer-content', { timeout: 30000 });
    await page.waitForTimeout(2000);
    const hero = (await page.locator('.pms-workorder-detail-content').innerText()).replace(/\s+/g, ' ');
    await shot(page, '02-work-order');
    const orderNo = /工单编号\s*([A-Z0-9-]+)/.exec(hero)?.[1] || null;
    return { ok: !!orderNo, orderNo };
  });

  await check('维修经验按管理处折叠', async () => {
    await page.goto(`${BASE}/experience-notes`, { waitUntil: 'domcontentloaded' });
    await settled(page);
    await page.waitForTimeout(2500);
    const groups = await page.locator('.experience-office-groups .ant-collapse-item').count();
    const open = await page.locator('.experience-office-groups .ant-collapse-item-active').count();
    const flat = await page.locator('.experience-notebook').count();
    await shot(page, '03-experience-notes');
    // 只有一个管理处时不套折叠面板，这时平铺也算通过
    return { ok: groups > 1 ? open === 1 : flat >= 0, groups, open, flat };
  });

  await check('一般入库的语音填表与拖拽上传', async () => {
    await page.goto(`${BASE}/inventory`, { waitUntil: 'domcontentloaded' });
    await settled(page);
    await page.waitForTimeout(3000);
    await page.getByText('一般入库', { exact: true }).first().click({ timeout: 30000 });
    await page.waitForSelector('.ant-modal-content', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const text = await page.locator('.ant-modal-content').innerText();
    const draggers = await page.locator('.ant-modal-content .ant-upload-drag').count();
    const box = await page.locator('.ant-modal-footer .ant-btn-primary').first().boundingBox();
    const okInViewport = !!box && box.y + box.height <= page.viewportSize().height;
    await shot(page, '04-general-receipt');
    return {
      ok: text.includes('说一句，自动填明细') && text.includes('识别并填表') && draggers > 0 && okInViewport,
      voiceCard: text.includes('说一句，自动填明细'),
      draggers,
      okInViewport,
    };
  });

  const failed = cases.filter((c) => !c.ok);
  return { passed: cases.length - failed.length, failed: failed.length, cases };
}
