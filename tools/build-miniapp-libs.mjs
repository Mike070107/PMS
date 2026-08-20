#!/usr/bin/env node
/**
 * 把三个 workspace 包编译成微信小程序可用的 JS 产物。
 *
 * 微信「构建 npm」只认 JS，而这些包的入口是 TS 源码，
 * 所以先 tsc 到各自的 miniprogram_dist/（package.json 的 "miniprogram" 字段指向它），
 * 再把 miniapp-ui 的自定义组件与 wxss 原样拷进去。
 *
 * 用法：node tools/build-miniapp-libs.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 仓库根没有装 typescript，用小程序包里那份（版本与 typecheck 一致） */
function resolveTsc() {
  const candidates = [
    join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(repoRoot, 'apps', 'miniapp-owner', 'node_modules', 'typescript', 'bin', 'tsc'),
    join(repoRoot, 'apps', 'api', 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error('x  找不到 typescript，请先 pnpm install');
    process.exit(1);
  }
  return found;
}

const tsc = resolveTsc();

const PACKAGES = ['shared-types', 'api-client', 'miniapp-ui'];

/**
 * 小程序运行时真正加载的是各自 miniprogram/miniprogram_npm/ 下的副本，
 * 不是各包的 miniprogram_dist。以前靠开发者工具「构建 npm」手动同步，
 * 忘了跑就会出现「代码改了、真机上还是旧行为」——排查半天才发现是副本没更新
 * （formatDateTime 修好后进度里时间仍是空白，就是这么来的）。
 * 这里编译完直接覆盖过去，构建 npm 不再是必需步骤。
 */
const MINIAPPS = ['miniapp-owner', 'miniapp-staff'];

function syncToApps(pkg, dist) {
  for (const app of MINIAPPS) {
    const target = join(repoRoot, 'apps', app, 'miniprogram', 'miniprogram_npm', '@pms', pkg);
    // 目标不存在说明这个小程序还没构建过 npm，交给开发者工具首次生成，不擅自创建
    if (!existsSync(target)) {
      console.log(`    skip ${app}（还没有 miniprogram_npm/@pms/${pkg}，先在工具里构建一次 npm）`);
      continue;
    }
    rmSync(target, { recursive: true, force: true });
    cpSync(dist, target, { recursive: true });
    console.log(`    sync -> apps/${app}/miniprogram/miniprogram_npm/@pms/${pkg}`);
  }
}

function build(pkg) {
  const dir = join(repoRoot, 'packages', pkg);
  const dist = join(dir, 'miniprogram_dist');
  rmSync(dist, { recursive: true, force: true });
  console.log(`==> tsc ${pkg}`);
  execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.build.json')], {
    stdio: 'inherit',
  });
  return dist;
}

for (const pkg of PACKAGES) {
  const dist = build(pkg);

  if (pkg === 'miniapp-ui') {
    // 自定义组件（js/json/wxml/wxss）与设计令牌样式直接拷贝
    const src = join(repoRoot, 'packages', 'miniapp-ui');
    cpSync(join(src, 'components'), join(dist, 'components'), { recursive: true });
    cpSync(join(src, 'tokens.wxss'), join(dist, 'tokens.wxss'));
  }

  if (!existsSync(join(dist, 'index.js'))) {
    console.error(`x  ${pkg}: 未生成 index.js`);
    process.exit(1);
  }
  console.log(`    ok -> packages/${pkg}/miniprogram_dist`);
  syncToApps(pkg, dist);
}

console.log('\n完成，两个小程序的 miniprogram_npm 已同步，直接编译预览即可。');
