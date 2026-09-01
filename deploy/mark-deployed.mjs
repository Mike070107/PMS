#!/usr/bin/env node
/**
 * 标记「哪个提交已经推到了哪个目标」，让并行的多个会话互相知道线上是什么版本。
 *
 *   node deploy/mark-deployed.mjs status
 *       每个目标：线上标记在哪个提交、之后还有哪些提交没上线、工作区有没有未提交的相关改动。
 *       另一个会话准备推送前先跑这个，就不会重复推、也不会漏推。
 *
 *   node deploy/mark-deployed.mjs <api|web|miniapp-staff|miniapp-owner> [--pkg 包名] [--commit sha] [--note 一句话] [--at "YYYY-MM-DD HH:mm"] [--allow-dirty] [--no-push]
 *       部署成功后调用：把 deployed/<目标> 标签移到该提交，往 deploy/DEPLOY_LOG.md 追加一条
 *      （带上自上次标记以来这个目标相关路径的提交列表），提交并推送（main + 标签）。
 *
 * 为什么要有这个（2026-08-27）：两个会话各改各的，A 打包时工作区里带着 B 没提交的半成品，
 * B 后来问「我的东西上没上」谁都说不清。pack.ps1 是按工作区打包的，所以标记时会检查
 * 该目标相关路径有没有未提交改动 —— 有就拒绝，除非 --allow-dirty（并在记录里注明）。
 */
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = resolve(ROOT, 'deploy', 'DEPLOY_LOG.md');

/** 每个目标「改了哪些路径算需要重新部署」；共享包改了三个端都要重发 */
const TARGETS = {
  api: { label: '线上 API', paths: ['apps/api', 'packages/shared-types', 'deploy/srv-deploy-api.sh'] },
  web: { label: '管理后台', paths: ['apps/admin-web', 'packages/shared-types', 'packages/api-client'] },
  'miniapp-staff': { label: '员工端小程序', paths: ['apps/miniapp-staff', 'packages/shared-types', 'packages/api-client'] },
  'miniapp-owner': { label: '业主端小程序', paths: ['apps/miniapp-owner', 'packages/shared-types', 'packages/api-client'] },
};

const git = (args, opts = {}) =>
  execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tryGit = (args) => { try { return git(args); } catch { return null; } };
const tagOf = (target) => `deployed/${target}`;
const pathArgs = (paths) => paths.map((p) => `"${p}"`).join(' ');

function parseArgs(argv) {
  const out = { _: [], allowDirty: false, push: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-dirty') out.allowDirty = true;
    else if (a === '--no-push') out.push = false;
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
    else out._.push(a);
  }
  return out;
}

function fmtNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dirtyFiles(paths) {
  const out = tryGit(`status --porcelain -- ${pathArgs(paths)}`) || '';
  return out.split('\n').filter(Boolean);
}

function pendingCommits(target, upto = 'HEAD') {
  const tag = tagOf(target);
  // 不能写 ${tag}^{commit}：Windows 上 execSync 走 cmd.exe，^ 是它的转义符，会被吃掉
  const base = tryGit(`rev-parse --verify --quiet refs/tags/${tag}`);
  if (!base) return { base: null, commits: null };
  const list = tryGit(`log --oneline ${base}..${upto} -- ${pathArgs(TARGETS[target].paths)}`) || '';
  return { base, commits: list.split('\n').filter(Boolean) };
}

function status() {
  tryGit('fetch -q origin --tags --force');
  const head = git('rev-parse --short HEAD');
  const behind = tryGit('rev-list --count HEAD..origin/main') || '?';
  console.log(`HEAD ${head}（origin/main 领先本地 ${behind} 个提交）\n`);
  for (const [target, def] of Object.entries(TARGETS)) {
    const { base, commits } = pendingCommits(target);
    const dirty = dirtyFiles(def.paths);
    const title = `${def.label} (${target})`;
    if (!base) {
      console.log(`● ${title}\n    还没标记过 —— 部署后跑 node deploy/mark-deployed.mjs ${target}`);
    } else {
      const baseShort = git(`rev-parse --short ${base}`);
      const when = git(`log -1 --format=%cd --date=format:"%m-%d %H:%M" ${base}`);
      if (!commits.length) console.log(`✓ ${title}\n    线上 = ${baseShort}（${when}），之后没有相关提交，已是最新`);
      else {
        console.log(`✗ ${title}\n    线上 = ${baseShort}（${when}），还有 ${commits.length} 个相关提交没上线：`);
        commits.forEach((c) => console.log(`      ${c}`));
      }
    }
    if (dirty.length) {
      console.log(`    ! 工作区有 ${dirty.length} 处未提交改动（pack 会把它们打进包）：`);
      dirty.slice(0, 8).forEach((f) => console.log(`      ${f}`));
      if (dirty.length > 8) console.log(`      … 还有 ${dirty.length - 8} 处`);
    }
    console.log('');
  }
}

function mark(target, args) {
  const def = TARGETS[target];
  tryGit('fetch -q origin --tags --force');
  const commit = git(`rev-parse ${args.commit || 'HEAD'}`);
  const short = git(`rev-parse --short ${commit}`);
  const dirty = dirtyFiles(def.paths);
  if (dirty.length && !args.allowDirty) {
    console.error(`✗ ${def.label} 相关路径有未提交改动，pack 打进包的和标记的提交对不上：\n  ${dirty.join('\n  ')}\n先提交，或确认包里确实带了这些改动再加 --allow-dirty。`);
    process.exit(1);
  }
  const { base, commits } = pendingCommits(target, commit);
  const lines = [];
  lines.push(`## ${args.at || fmtNow()} · ${target} · ${short}`);
  lines.push('');
  if (args.pkg) lines.push(`- 包：\`${args.pkg}\``);
  lines.push(`- 提交：${short} ${git(`log -1 --format=%s ${commit}`)}`);
  if (args.note) lines.push(`- 说明：${args.note}`);
  if (dirty.length) lines.push(`- ⚠ 标记时工作区有未提交改动（--allow-dirty）：${dirty.map((f) => f.trim()).join('，')}`);
  if (base) {
    const baseShort = git(`rev-parse --short ${base}`);
    if (commits.length) {
      lines.push(`- 自上次（${baseShort}）以来上线的相关提交：`);
      commits.forEach((c) => lines.push(`  - ${c}`));
    } else {
      lines.push(`- 自上次（${baseShort}）以来没有相关提交（重新部署）`);
    }
  } else {
    lines.push('- 首次标记；之前的发布没有记录，此前的提交视为已上线');
  }
  lines.push('');

  if (!existsSync(LOG)) {
    writeFileSync(LOG, `# 发布记录\n\n> 由 \`deploy/mark-deployed.mjs\` 追加，最新的在最下面。查「还有什么没上线」用 \`node deploy/mark-deployed.mjs status\`。\n\n`);
  }
  appendFileSync(LOG, `${lines.join('\n')}\n`);
  git(`tag -f ${tagOf(target)} ${commit}`);
  git('add deploy/DEPLOY_LOG.md');
  git(`commit -q -m "deploy: ${target} → ${short}"`);
  console.log(lines.join('\n'));
  if (args.push) {
    git('push -q origin HEAD:main');
    git(`push -q -f origin ${tagOf(target)}`);
    // 推完回读一次远端。多会话并行时，别人一句 `git push --tags -f` 就能把这个标签
    // 顶回旧值，而这里照样打印「已推送」——2026-09-01 就这么让 deployed/miniapp-owner
    // 退回上一版：DEPLOY_LOG 里明明记着刚发的包，status 却说「还有 8 个提交没上线」，
    // 下一个会话照着这个状态会把同一版再发一遍。
    const remoteLine = tryGit(`ls-remote --tags origin refs/tags/${tagOf(target)}`) || '';
    const remoteSha = remoteLine.split(/\s+/)[0] || '';
    if (remoteSha !== commit) {
      console.error('');
      console.error(
        `✗ 标签没落到远端：${tagOf(target)} 现在指向 ${remoteSha.slice(0, 7) || '(不存在)'}，应该是 ${short}。`,
      );
      console.error('  多半是别的会话用旧标签强推了一次。重新打并回读确认：');
      console.error(`    git tag -f ${tagOf(target)} ${short} && git push -f origin ${tagOf(target)}`);
      console.error(`    git ls-remote --tags origin | grep ${tagOf(target)}`);
      process.exit(1);
    }
    console.log(`✓ 已推送 main 和标签 ${tagOf(target)}（远端已回读确认 = ${short}）`);
  } else {
    console.log(`（--no-push：记得 git push origin main && git push -f origin ${tagOf(target)}）`);
  }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (!cmd || cmd === 'status') status();
else if (TARGETS[cmd]) mark(cmd, args);
else {
  console.error(`用法：node deploy/mark-deployed.mjs status | ${Object.keys(TARGETS).join(' | ')}`);
  process.exit(1);
}
