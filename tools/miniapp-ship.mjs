#!/usr/bin/env node
/**
 * 小程序「改完 → 手机上看到」一条命令。
 *
 *   pnpm mp                 业主端自动预览（推到手机上的「微信开发者工具」小程序，不用扫码）
 *   pnpm mp:staff           员工端自动预览
 *   pnpm mp -- --qr         生成二维码图片（Windows 会自动打开），用微信扫
 *   pnpm mp -- --upload     上传成体验版，版本号自动取 me.ts 里的 BUILD_VERSION
 *   pnpm mp -- --upload --desc "修图片黑屏"
 *
 * 每次都会依次做完：编译共享包 → 构建 npm → 预览/上传，
 * 省掉在开发者工具里手点「工具 → 构建 npm」再点「预览」这两步。
 *
 * 前置（只配一次）：开发者工具 → 设置 → 安全设置 → 打开「服务端口」。
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 开发者工具 CLI；换了安装路径就在这里加一条 */
const CLI_CANDIDATES = [
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
  '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
];

const APPS = {
  owner: { dir: 'apps/miniapp-owner', label: '业主端 邻修' },
  staff: { dir: 'apps/miniapp-staff', label: '员工端 邻修管理' },
};

function parseArgs(argv) {
  const opts = { app: 'owner', mode: 'auto-preview', desc: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--staff') opts.app = 'staff';
    else if (arg === '--owner') opts.app = 'owner';
    else if (arg === '--qr') opts.mode = 'preview';
    else if (arg === '--upload') opts.mode = 'upload';
    else if (arg === '--desc') opts.desc = argv[++i] ?? '';
    else if (APPS[arg]) opts.app = arg;
  }
  return opts;
}

function resolveCli() {
  const found = CLI_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    fail(
      '找不到微信开发者工具 CLI。\n' +
        '   装在别的盘就把路径加到 tools/miniapp-ship.mjs 的 CLI_CANDIDATES 里。',
    );
  }
  return found;
}

/** 抛而不是直接 exit —— 调用方要能决定某一步失败是否值得终止 */
class ShipError extends Error {}

function fail(message) {
  throw new ShipError(message);
}

function run(file, args, opts = {}) {
  return execFileSync(file, args, { stdio: 'inherit', ...opts });
}

function quoteWin(value) {
  return /[\s&()[\]{}^=;!'+,`~"]/.test(value) ? `"${value}"` : value;
}

/**
 * 开发者工具 CLI 在 Windows 上是 .bat，Node 20+ 拒绝直接 spawn（EINVAL），
 * 必须过一层 cmd；安装路径带空格和中文，逐段加引号。
 *
 * 关键：这个 CLI **失败时也返回退出码 0**，只在输出里打一行 [error]。
 * 早先直接 stdio:'inherit' 不看输出，结果上传失败照样打印「完成」，
 * 还去 start 一张根本没生成的二维码，弹出「Windows 找不到文件」。
 * 所以这里自己抓输出判断成败。
 */
function runCli(args) {
  const command = [cli, ...args].map(quoteWin).join(' ');
  let output = '';
  try {
    output =
      process.platform === 'win32'
        ? execSync(command, { encoding: 'utf8', shell: 'cmd.exe' })
        : execFileSync(cli, args, { encoding: 'utf8' });
  } catch (err) {
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    process.stdout.write(output);
    fail(`开发者工具 CLI 执行失败：${args[0]}`);
  }
  process.stdout.write(output);
  if (/\[error\]|✖/.test(output)) {
    fail(explainCliError(output, args[0]));
  }
  return output;
}

/** 把 CLI 那串 stack 翻成能直接照做的一句话 */
function explainCliError(output, action) {
  // 这条文案极具误导性：node_modules 明明在，真正的原因是上一行
  // 「Fetching AppID detailed information」失败 —— 当前登录的微信号
  // 对这个小程序没有权限，工具拿不到它的配置，于是在打包 npm 这步炸掉。
  if (/__NO_NODE_MODULES__/.test(output) && /Fetching AppID .* detailed/.test(output)) {
    return [
      `${action} 失败：工具取不到这个小程序的配置（报错写的是 NO_NODE_MODULES，但 node_modules 是好的）。`,
      '   实际原因：开发者工具当前登录的微信号对该小程序没有权限。',
      '   处理：公众平台（该小程序）→ 管理 → 成员管理 → 把这个微信号加为「开发者」，',
      '        或在开发者工具右上角切换成有权限的微信号后重跑。',
    ].join('\n');
  }
  if (/41002/.test(output)) {
    return (
      `${action} 失败：微信返回 41002（appid missing）。\n` +
      '   这不是代码问题 —— 开发者工具当前登录的微信号，对这个小程序没有发布权限。\n' +
      '   处理：公众平台（该小程序）→ 管理 → 成员管理 → 把这个微信号加为「开发者」，\n' +
      '        或在开发者工具右上角切换成有权限的微信号后重跑。'
    );
  }
  if (/45009|out of limit/i.test(output)) {
    return `${action} 失败：接口调用超出微信当天配额，明天再试或换个方式发版。`;
  }
  return `${action} 失败，详见上面 CLI 的输出。`;
}

/** 版本号的唯一来源是「我的」页那个常量，避免上传时手填错 */
function readBuildVersion(appDir) {
  const mePath = join(repoRoot, appDir, 'miniprogram/pages/me/me.ts');
  if (!existsSync(mePath)) return '';
  const matched = /BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(
    readFileSync(mePath, 'utf8'),
  );
  return matched ? matched[1] : '';
}

/**
 * 上传台账（本机，不入库）。
 *
 * 为什么要这个：BUILD_VERSION 是手改的常量，很容易连着好几个提交都忘了升号
 * （2026-08-25 就出现过 1.0.20260825e 横跨四个提交）。同一个号上传多次之后，
 * 公众平台「版本管理」里并排几条一模一样的版本号，选体验版时根本分不出哪条是新的，
 * 选错就表现为「体验版怎么退回旧版本了」，而手机上的版本号还长得像对的。
 * 所以：同号但代码不同的第二次上传直接拦下来，并把 git 短 hash 写进上传描述，
 * 让公众平台上的每条版本都能对回一个提交。
 */
const SHIP_LOG = join(repoRoot, '.ship-log.json');

function gitInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0;
    return { hash, dirty };
  } catch {
    return { hash: '', dirty: false };
  }
}

function readShipLog() {
  try {
    return existsSync(SHIP_LOG) ? JSON.parse(readFileSync(SHIP_LOG, 'utf8')) : [];
  } catch {
    return [];
  }
}

function appendShipLog(entry) {
  try {
    writeFileSync(SHIP_LOG, `${JSON.stringify([...readShipLog(), entry], null, 2)}\n`);
  } catch {
    // 台账写不下不该挡住发版，下次上传就少一条记录而已
  }
}

/** 同一个版本号、不同的代码 —— 拦住，否则公众平台上两条同号版本分不清 */
function assertVersionNotReused(appKey, ver, git) {
  const clash = readShipLog().find(
    (row) => row.app === appKey && row.version === ver && row.hash !== git.hash,
  );
  if (!clash) return;
  fail(
    `版本号 ${ver} 已经在 ${clash.time} 用代码 ${clash.hash} 上传过了，这次的代码是 ${git.hash}。\n` +
      `   同号上传两次，公众平台「版本管理」里会并排两条 ${ver}，选体验版必然选错 ——\n` +
      `   先把 apps/${appKey === 'staff' ? 'miniapp-staff' : 'miniapp-owner'}/miniprogram/pages/me/me.ts 里的\n` +
      '   BUILD_VERSION 往后挪一位再重跑（那个常量就是手机上「我的」页显示的版本号）。',
  );
}

// 顶层抛出的 ShipError 只打那一句可照做的说明，不要甩一屏 stack
process.on('uncaughtException', (err) => {
  console.error(`\nx  ${err instanceof ShipError ? err.message : err?.stack || err}\n`);
  process.exit(1);
});

const opts = parseArgs(process.argv.slice(2));
const app = APPS[opts.app];
const cli = resolveCli();
const projectPath = join(repoRoot, app.dir);
const version = readBuildVersion(app.dir);

console.log(`\n==> ${app.label}（${opts.app}）  ${version ? `v${version}` : ''}`);

console.log('\n==> 1/3 编译共享包');
run(process.execPath, [join(repoRoot, 'tools/build-miniapp-libs.mjs')]);

console.log('\n==> 2/3 构建 npm');
// 共享包的产物上一步已经直接同步进 miniprogram_npm，这一步只是让开发者工具再确认一遍。
// 它失败往往不是 npm 的问题（多半是账号权限），不值得就此终止 ——
// 继续往下走，让真正的错误暴露在预览/上传那一步，报错也更接近本质。
try {
  runCli(['build-npm', '--project', projectPath]);
} catch (err) {
  console.warn(`\n!  构建 npm 未通过，继续尝试预览：\n${err?.message || err}\n`);
}

if (opts.mode === 'upload') {
  if (!version) fail('读不到 BUILD_VERSION，无法确定上传版本号');
  const git = gitInfo();
  assertVersionNotReused(opts.app, version, git);
  if (git.dirty) {
    console.warn(
      `\n!  工作区有未提交的改动，这次上传的包和提交 ${git.hash} 对不上。\n` +
        '   以后想查「体验版里到底是哪份代码」会查不出来，建议先提交再传。\n',
    );
  }
  // 描述里始终带上代码位置，公众平台版本列表里才能一眼对回提交
  const stamp = `${git.hash}${git.dirty ? '+本地改动' : ''}`;
  const desc = `${opts.desc || `${version} 构建`}${stamp ? `（${stamp}）` : ''}`;
  console.log(`\n==> 3/3 上传体验版 v${version}：${desc}`);
  runCli(['upload', '--project', projectPath, '-v', version, '-d', desc]);
  appendShipLog({
    app: opts.app,
    version,
    hash: git.hash,
    dirty: git.dirty,
    desc,
    time: new Date().toISOString(),
  });
  console.log(
    `\n完成。上传的是 ${version}（代码 ${stamp || '未知'}）。还要两步：\n` +
      `  1. 公众平台 → 版本管理 → 开发版本 → 找到描述里带 ${git.hash || version} 的那条 → 「选为体验版」\n` +
      '     （同号版本可能有多条，认描述里的 hash，别只认版本号）\n' +
      '  2. 手机微信里先把这个小程序从「最近使用」删掉，再重新进 —— 否则跑的还是缓存包\n' +
      '  进小程序「我的」页最下面核对版本号，和上面这个对不上就说明第 1 步选错了版本\n',
  );
} else if (opts.mode === 'preview') {
  const outDir = join(repoRoot, '.screenshots');
  mkdirSync(outDir, { recursive: true });
  const qrPath = join(outDir, `mp-preview-${opts.app}.png`);
  console.log('\n==> 3/3 生成预览二维码');
  runCli(['preview', '--project', projectPath, '--qr-format', 'image', '--qr-output', qrPath]);
  // CLI 说成功也要确认图真的落地了，否则又是去 start 一个不存在的文件
  if (!existsSync(qrPath)) fail(`CLI 没有报错，但二维码没生成：${qrPath}`);
  console.log(`\n二维码：${qrPath}`);
  if (process.platform === 'win32') {
    try {
      run('cmd', ['/c', 'start', '', qrPath], { stdio: 'ignore' });
    } catch {
      // 打不开就让用户自己去那个路径看，不算失败
    }
  }
  console.log('用微信扫它即可，扫完就是最新代码。\n');
} else {
  console.log('\n==> 3/3 自动预览（推送到手机）');
  runCli(['auto-preview', '--project', projectPath]);
  console.log(
    '\n完成。手机上打开微信 → 搜索/最近使用里的「微信开发者工具」小程序 →\n' +
      '进「预览」就是刚推上去的这份代码，不用扫码、不用清缓存。\n',
  );
}
