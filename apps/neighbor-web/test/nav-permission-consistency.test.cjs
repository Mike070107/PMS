// 导航 → 权限注册表 一致性回归：
// 每一次「菜单加了、权限注册表忘了」的事故（/bills、/intranet）都靠这条测试提前发现。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const web = path.resolve(__dirname, '../src');
const repo = path.resolve(__dirname, '../../..');

const shell = fs.readFileSync(path.join(web, 'components/Shell.tsx'), 'utf8');
const access = fs.readFileSync(path.join(web, 'lib/page-access.ts'), 'utf8');
const registry = fs.readFileSync(path.join(repo, 'packages/shared-types/src/pages.ts'), 'utf8');

// 1) 解析 NAV 项：每行形如 { key: 'x', ..., to: '/path', ... }
const navItems = [];
for (const line of shell.split('\n')) {
  const m = line.match(/\{\s*key:\s*'([^']+)'/);
  if (!m) continue;
  const to = line.match(/to:\s*'([^']+)'/);
  const legacy = /legacy:\s*'/.test(line);
  const prod = /prod:\s*'/.test(line);
  if (!to) continue;
  navItems.push({ key: m[1], to: to[1], external: legacy || prod });
}

// 2) 解析 PAGE_ACCESS 映射
const accessEntries = [];
for (const m of access.matchAll(/\{\s*paths:\s*\[([^\]]*)\],\s*keys:\s*\[([^\]]*)\]/g)) {
  const paths = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const keys = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  accessEntries.push({ paths, keys });
}
const pathToKeys = new Map();
for (const e of accessEntries) for (const p of e.paths) pathToKeys.set(p, e.keys);

// 3) 解析注册表里的企业端 key（ADMIN_PAGES 里的 key: 'xxx'）
const registryKeys = new Set();
for (const m of registry.matchAll(/\{\s*key:\s*'([^']+)'[^}]*label:/g)) registryKeys.add(m[1]);

// 允许不参与一致性检查的路径：独立全屏页、无后台权限概念的页面
const IGNORED = new Set(['/screen']);

test('导航里每个页面都必须登记 PAGE_ACCESS', () => {
  const missing = navItems.filter((n) => !n.external && !IGNORED.has(n.to) && !pathToKeys.has(n.to));
  assert.deepEqual(missing.map((n) => `${n.key} → ${n.to}`), [], '以下菜单项没有在 lib/page-access.ts 登记权限映射');
});

test('PAGE_ACCESS 里用到的权限 key 都必须存在于企业端注册表', () => {
  const bad = [];
  for (const [p, keys] of pathToKeys) {
    for (const k of keys) {
      if (k.startsWith('app:')) continue; // 员工端小程序入口，不在企业端注册表
      if (!registryKeys.has(k)) bad.push(`${p} → ${k}`);
    }
  }
  assert.deepEqual(bad, [], '以下映射引用了未注册的页面 key');
});

test('导航项与权限映射的 key 不能各说各话（有映射就必须有注册表归属）', () => {
  const problems = [];
  for (const n of navItems) {
    if (n.external || IGNORED.has(n.to)) continue;
    const keys = pathToKeys.get(n.to);
    if (!keys || !keys.length) continue;
    if (!keys.some((k) => k.startsWith('app:') || registryKeys.has(k))) problems.push(`${n.key} → ${n.to} (keys: ${keys.join(',')})`);
  }
  assert.deepEqual(problems, []);
});
