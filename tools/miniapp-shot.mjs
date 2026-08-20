#!/usr/bin/env node
/**
 * 用微信开发者工具的自动化能力给小程序页面截图，便于自己核对 UI（而不是只看代码）。
 *
 * 用法：
 *   node tools/miniapp-shot.mjs owner pages/index/index pages/orders/orders
 *   node tools/miniapp-shot.mjs staff pages/login/login
 *
 * 前置：
 *   1. 开发者工具已登录，「设置 → 安全设置 → 服务端口」已开启
 *   2. 先起自动化端口（Node 24 不允许直接 spawn .bat，所以不走 automator.launch）：
 *      cli.bat auto --project <项目路径> --auto-port 9420
 *
 * 截图输出到 .screenshots/<app>-<page>.png（该目录不入库）。
 */
import automator from 'miniprogram-automator';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const [app, ...pages] = process.argv.slice(2);
if (!app || !pages.length) {
  console.error('用法: node tools/miniapp-shot.mjs <owner|staff> <page...>');
  process.exit(1);
}

const port = process.env.AUTO_PORT || '9420';
const outDir = join(repoRoot, '.screenshots');
mkdirSync(outDir, { recursive: true });

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);

console.log(`connecting ws://127.0.0.1:${port} ...`);
const miniProgram = await withTimeout(
  automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` }),
  30000,
  'connect',
);
console.log('connected');

for (const page of pages) {
  const path = page.startsWith('/') ? page : `/${page}`;
  const name = `${app}-${page.replace(/[\\/]/g, '_')}.png`;
  try {
    console.log(`-> ${path}`);
    await withTimeout(miniProgram.reLaunch(path), 30000, `reLaunch ${path}`);
    await new Promise((r) => setTimeout(r, 2500));
    await withTimeout(
      miniProgram.screenshot({ path: join(outDir, name) }),
      30000,
      `screenshot ${path}`,
    );
    console.log(`√ ${path} -> .screenshots/${name}`);
  } catch (err) {
    console.error(`x ${path}: ${err.message}`);
  }
}

await miniProgram.disconnect();
console.log('done');
process.exit(0);
