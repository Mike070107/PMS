import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execSync, execFileSync } from 'node:child_process';
let pnpmVersion;
export function packageManagerVersion() {
  if (!pnpmVersion) pnpmVersion = execSync('pnpm --version', { encoding:'utf8', timeout:30000, stdio:['ignore','pipe','pipe'] }).trim();
  if (!/^\d+\.\d+\.\d+/.test(pnpmVersion)) throw Error('cannot identify package manager');
  return pnpmVersion;
}

export const digest = data => createHash('sha256').update(data).digest('hex');
export function readReceipt(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
export function saveReceipt(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, file);
}
export function buildEnvironment(env = process.env) {
  const selected = Object.fromEntries(Object.keys(env).filter(k => k.startsWith('VITE_') || ['NODE_ENV','NODE_OPTIONS','CI','TZ','LANG','BROWSERSLIST_ENV','BROWSERSLIST'].includes(k)).sort().map(k => [k,env[k]]));
  selected.preloads = [...String(env.NODE_OPTIONS || '').matchAll(/(?:--(?:require|import|(?:experimental-)?loader)|-r)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g)].map(match => { const file=resolve(match[1] || match[2] || match[3]); return [file,existsSync(file)?digest(readFileSync(file)):'missing']; });
  return selected;
}
export function recipeKey({ target, commit, inputHash, mode = 'build', env = process.env, toolchain = { pnpm: packageManagerVersion() } }) {
  if (!['api','web'].includes(target) || !/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{64}$/.test(inputHash)) throw Error('invalid release cache identity');
  return digest(JSON.stringify({ schema: 1, target, commit, inputHash, mode, node: process.version, platform: process.platform, arch: process.arch, toolchain, environment: buildEnvironment(env) }));
}
export function distManifest(directory) {
  const files = {};
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const full = join(folder,entry.name), name = relative(directory,full).replaceAll('\\','/');
      if (entry.isSymbolicLink()) throw Error('build output contains a symlink');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && name !== 'release.json') files[name] = digest(readFileSync(full));
      else if (!entry.isFile()) throw Error('unexpected build output entry');
    }
  }
  visit(directory);
  if (!Object.keys(files).length) throw Error('empty build output');
  return files;
}
function matchingManifest(directory, manifest) {
  try { return JSON.stringify(distManifest(directory)) === JSON.stringify(manifest); } catch { return false; }
}
export function cachedBuild({ root, target, commit, inputHash, env, execute, log = console.log }) {
  const key = recipeKey({ target, commit, inputHash, env });
  const dist = join(root, 'apps', target === 'web' ? 'neighbor-web' : 'api', 'dist');
  const file = join(root, 'artifacts', 'release-checks', `build-${target}-${key}.json`);
  const receipt = readReceipt(file), started = performance.now();
  if (receipt?.passed === true && receipt.key === key && matchingManifest(dist, receipt.files)) {
    log(`缓存命中 ${target} build：源码、工具链、构建环境及全部输出 SHA256 一致 (${Math.round(performance.now()-started)}ms)`);
    return { reused: true, key, elapsedMs: performance.now()-started };
  }
  // No receipt is written when the command fails or produces incomplete output.
  execute(`pnpm --filter @pms/${target === 'web' ? 'neighbor-web' : 'api'} build`);
  const files = distManifest(dist);
  const entry = target === 'web' ? 'index.html' : 'main.js';
  if (!files[entry]) throw Error(`build missing ${entry}`);
  const result = { passed: true, key, target, commit, inputHash, files, builtAt: new Date().toISOString(), elapsedMs: performance.now()-started };
  saveReceipt(file,result);
  log(`构建完成 ${target} (${Math.round(result.elapsedMs)}ms)`);
  return { reused: false, ...result };
}
function packageReceipt(root, options) {
  const key = recipeKey(options);
  return { key, file: join(root,'artifacts','release-checks',`package-${options.target}-${key}.json`) };
}
function assertPackagePath(root, file, target) {
  const full = resolve(file), rel = relative(resolve(root,'deploy'),full);
  if (isAbsolute(rel) || rel.startsWith('..') || /[\\/]/.test(rel) || !new RegExp(`^pms-${target}-(?:fast-)?[0-9-]+\\.tar\\.gz$`).test(rel)) throw Error('package outside release directory');
  return full;
}
export function rememberPackage({ root, target, commit, inputHash, mode, env, artifact, release }) {
  const options = {target,commit,inputHash,mode,env}, {key,file} = packageReceipt(root,options);
  const full = assertPackagePath(root,artifact,target);
  if (lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile()) throw Error('invalid package type');
  if (release?.target !== target || release.commit !== commit || release.sourceHash !== inputHash || !release.version) throw Error('package release proof mismatch');
  const entry = target === 'api' ? 'api/dist/release.json' : './release.json';
  const embedded = JSON.parse(execFileSync('tar',['-xOf',full,entry],{encoding:'utf8',maxBuffer:32*1024*1024}));
  if (JSON.stringify(embedded) !== JSON.stringify(release)) throw Error('embedded package release proof mismatch');
  const sha256 = digest(readFileSync(full));
  saveReceipt(file,{ passed:true,key,artifact:full,sha256,release,mode,createdAt:new Date().toISOString() });
  return full;
}
export function findPackage({ root, target, commit, inputHash, mode, env }) {
  const { key, file } = packageReceipt(root,{target,commit,inputHash,mode,env}), receipt = readReceipt(file);
  try {
    if (receipt?.passed !== true || receipt.key !== key || receipt.mode !== mode || receipt.release?.target !== target || receipt.release.commit !== commit || receipt.release.sourceHash !== inputHash) return null;
    const full = assertPackagePath(root,receipt.artifact,target);
    if (lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile() || digest(readFileSync(full)) !== receipt.sha256) return null;
    return { artifact:full, release:receipt.release, sha256:receipt.sha256 };
  } catch { return null; }
}
