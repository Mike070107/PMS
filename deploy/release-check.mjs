/** Release evidence is tied to inputs, not to a verbal 'tested' claim. No production writes. */
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS = {
  api: { label: '线上 API', paths: ['apps/api', 'packages/shared-types', 'pnpm-lock.yaml', 'deploy/srv-deploy-api.sh'] },
  web: { label: '管理后台', paths: ['apps/admin-web', 'packages/shared-types', 'packages/api-client', 'pnpm-lock.yaml'] },
  assistant: { label: 'Windows 数据同步助手', paths: ['tools/data-sync-assistant-v2', 'tools/access-card-agent'] },
  'miniapp-staff': { label: '员工端小程序', paths: ['apps/miniapp-staff', 'packages/shared-types', 'packages/api-client'] },
  'miniapp-owner': { label: '业主端小程序', paths: ['apps/miniapp-owner', 'packages/shared-types', 'packages/api-client'] },
};
const EVIDENCE = join(ROOT, 'artifacts/release-checks');
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
export const productionInput = path => !(/\.md$|\.tsbuildinfo$/.test(path));
export const assistantInput = path => /\.(cs|csproj|xaml|ico|png|manifest)$/.test(path);
const paths = target => {
  if (!TARGETS[target]) throw new Error(`Unknown release target: ${target}`);
  return TARGETS[target].paths;
};
export function deploymentCommit(target, read = git) {
  try { read('show-ref', '--verify', '--quiet', `refs/tags/deployed/${target}`); }
  catch (error) { if (error.status === 1) return null; throw error; }
  return read('rev-parse', '--verify', `refs/tags/deployed/${target}`);
}
export function changed(target, commit = 'HEAD') {
  const base = deploymentCommit(target);
  if (!base) return ['unmarked'];
  return git('diff', '--name-only', base, commit, '--', ...paths(target)).split('\n').filter(Boolean)
    .filter(target === 'assistant' ? assistantInput : productionInput);
}
function fingerprint(target) {
  const files = git('ls-files', '--', ...paths(target), 'deploy/release-check.mjs', 'deploy/release-check.test.mjs', 'package.json')
    .split('\n').filter(Boolean).filter(productionInput).sort();
  return sha(JSON.stringify([process.version, files.map(file => [file, existsSync(join(ROOT, file)) ? sha(readFileSync(join(ROOT, file))) : 'missing'])]));
}
export function assertSource(target, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('需要冻结的完整源码提交');
  if (git('branch', '--show-current') !== 'main') throw new Error('生产只能从 main 发布');
  const dirty = git('status', '--porcelain', '--', ...paths(target), 'deploy/release-check.mjs', 'deploy/publish-production.ps1');
  if (dirty) throw new Error(`发布目标有未提交改动：\n${dirty}`);
  git('merge-base', '--is-ancestor', commit, 'origin/main');
  // 不能从一个较旧但已推送的 main 提交覆盖另一任务刚上线的版本。
  const deployed = deploymentCommit(target);
  if (deployed) git('merge-base', '--is-ancestor', deployed, commit);
  if (git('diff', '--name-only', commit, 'origin/main', '--', ...paths(target)).split('\n').some(file => file && productionInput(file))) {
    throw new Error('发布来源落后于远端受影响源码，先合并并验证，禁止覆盖新版本');
  }
  if (git('diff', '--name-only', commit, '--', ...paths(target))) throw new Error('构建期间源码已变化，停止上传；按新源码重新验收');
}
function record(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
export function evidenceMatches(evidence, hash) { return evidence?.passed === true && evidence.inputHash === hash; }
export function parkingChanges(files) { return files.some(file => /Parking|parking|access-card|shared-types|api-client/.test(file)); }
export function assertVersionIncrease(current, published) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`无效助手版本：${value}`);
    return value.split('.').map(Number);
  };
  const a = parse(current), b = parse(published);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return; if (a[i] < b[i]) break; }
  throw new Error(`助手源码已改变但版本未递增：${current}，线上 ${published}`);
}
function run(command) { execSync(command, { cwd: ROOT, stdio: 'inherit', timeout: 180000 }); }
async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
async function check(target, commit) {
  assertSource(target, commit);
  if (target === 'api' || target === 'web') {
    const app = join(ROOT, 'apps', target === 'web' ? 'admin-web' : 'api');
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      const file = join(app, 'node_modules', dependency, 'package.json');
      if (!existsSync(file)) throw new Error(`本机依赖损坏/缺失：${dependency}；按锁文件恢复后再发布，不能跳过编译`);
    }
  }
  const changes = changed(target, commit);
  if (parkingChanges(changes) || changes.includes('unmarked')) {
    // 本组是 Web/API 契约测试；助手自己的构建和 SelfTest 由助手发布脚本验收。
    const hash = sha(fingerprint('api') + fingerprint('web'));
    const file = join(EVIDENCE, `parking-${hash}.json`);
    if (existsSync(file) && evidenceMatches(JSON.parse(readFileSync(file, 'utf8')), hash)) {
      console.log('复用同源码停车回归证据');
    } else {
      run('pnpm --filter @pms/api test:access-card');
      run('pnpm --filter @pms/api test:parking-owner');
      record(file, { passed: true, inputHash: hash, commit, testedAt: new Date().toISOString(), scope: 'isolated API tests; not field SQL/hardware' });
    }
  }
  if (target === 'assistant') {
    const source = readFileSync(join(ROOT, 'tools/data-sync-assistant-v2/Properties/AssemblyInfo.cs'), 'utf8');
    const version = source.match(/AssemblyVersion\("(\d+\.\d+\.\d+)\.\d+"\)/)?.[1];
    const online = await getJson('https://prsznh.cn/downloads/pms-data-sync-assistant/latest.json');
    assertVersionIncrease(version, online.version);
  }
  const hash = fingerprint(target);
  record(join(EVIDENCE, `${target}-source.json`), { commit, inputHash: hash });
  console.log(`发布预检通过 ${target} ${commit.slice(0, 7)} ${hash.slice(0, 12)}`);
}
function verifySource(target, commit) {
  assertSource(target, commit);
  const evidence = JSON.parse(readFileSync(join(EVIDENCE, `${target}-source.json`), 'utf8'));
  if (evidence.commit !== commit || evidence.inputHash !== fingerprint(target)) throw new Error('验收后源码/依赖改变，停止发布');
  return evidence;
}
function stamp(target, commit) {
  const evidence = verifySource(target, commit);
  const dist = join(ROOT, `apps/${target === 'web' ? 'admin-web' : 'api'}/dist`);
  const files = {};
  let version = `api-${commit.slice(0, 7)}`;
  if (target === 'web') {
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const entry = html.match(/src="\/([^" ]+\.js)"/)?.[1];
    if (!entry) throw new Error('Web 主入口不存在');
    const code = readFileSync(join(dist, entry), 'utf8');
    version = code.match(/2\.0\.\d{8}-\d{4}/)?.[0];
    if (!version || !code.includes(commit)) throw new Error('Web 未注入版本/完整源码提交');
    for (const file of ['index.html', entry, ...readdirSync(join(dist, 'assets')).filter(x => /^ParkingManagementPage-.*\.js$/.test(x)).map(x=>'assets/'+x)]) files[file] = sha(readFileSync(join(dist, file)));
  }
  const release = { target, version, commit, sourceHash: evidence.inputHash, builtAt: new Date().toISOString(), files };
  record(join(dist, 'release.json'), release);
  record(join(EVIDENCE, `${target}-expected.json`), release);
  console.log(JSON.stringify(release));
}
export function assertRelease(expected, actual) {
  for (const key of ['target', 'version', 'commit', 'sourceHash']) if (!expected[key] || expected[key] !== actual?.[key]) throw new Error(`线上 ${key} 不符合本次发布`);
}
async function verifyLive(target) {
  const expected = JSON.parse(readFileSync(join(EVIDENCE, `${target}-expected.json`), 'utf8'));
  const actual = await getJson(`https://prsznh.cn/${target === 'api' ? 'api/v1/health' : 'release.json'}?verify=${Date.now()}`);
  if (target === 'api' && (actual.status !== 'ok' || actual.db !== 'up')) throw new Error('生产 API 不健康');
  assertRelease(expected, target === 'api' ? actual.release : actual);
  for (const [file, hash] of Object.entries(expected.files)) {
    // 普通入口不加 cache-buster：避免只有验收能看到新版、用户仍命中旧 HTML。
    const response = await fetch(`https://prsznh.cn/${file}`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== hash) throw new Error(`线上制品不同：${file}`);
  }
  record(join(EVIDENCE, `${target}-verified.json`), { ...expected, verifiedAt: new Date().toISOString(), fieldInstallation: 'not verified', fieldBusiness: 'not verified' });
  console.log(`公网版本及制品已验证 ${target} ${expected.version} ${expected.commit.slice(0, 7)}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, target, commit] = process.argv.slice(2);
    if (command === 'definitions') console.log(JSON.stringify(TARGETS));
    else if (command === 'changed') console.log(changed(target, commit || 'HEAD').join('\n'));
    else if (command === 'check') await check(target, commit);
    else if (command === 'verify-source') verifySource(target, commit);
    else if (command === 'stamp') stamp(target, commit);
    else if (command === 'verify-live') await verifyLive(target);
    else throw new Error('用法：release-check.mjs changed|check|verify-source|stamp|verify-live target [commit]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
