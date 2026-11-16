const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = process.cwd();
const out = path.join(root, 'outputs/address-dedupe-20261116');
const apps = ['staff', 'owner'];
const scopes = [...apps.map(a => `apps/miniapp-${a}`), 'packages/shared-types', 'packages/api-client', 'packages/miniapp-ui'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => fs.readFileSync(p);
const json = p => JSON.parse(read(p).toString('utf8').replace(/^\uFEFF/, ''));
const git = args => cp.execFileSync('git', args, { encoding: 'utf8' }).trim();
const sources = () => git(['ls-files', '-z', '--', ...scopes]).split('\0').filter(Boolean).map(p => ({ path: p, sha256: hash(read(p)) }));
const freezePath = path.join(out, 'source-freeze.json');
assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', ...scopes]), '', 'Source scopes must be clean');
if (process.argv[2] === 'freeze') {
  const head = git(['rev-parse', 'HEAD']);
  assert.equal(git(['rev-parse', 'origin/main']), head, 'Build/upload must start from pushed main');
  const result = { head, frozenAt: new Date().toISOString(), sourceFiles: sources() };
  fs.writeFileSync(freezePath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Frozen ${result.sourceFiles.length} source files at ${head}`);
  process.exit(0);
}
const frozen = json(freezePath);
assert.deepEqual(sources(), frozen.sourceFiles, 'Sources changed after freeze');
const receipts = json(path.join(root, '.ship-log.json'));
const results = [];
function walk(dir, cb) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name); e.isDirectory() ? walk(p, cb) : cb(p);
  }
}
for (const app of apps) {
  const entry = receipts.filter(x => x.app === app).at(-1);
  assert(entry && frozen.head.startsWith(entry.hash), 'Wrong uploaded commit: ' + app);
  const config = json(`apps/miniapp-${app}/project.config.json`);
  const rawLog = path.join(out, `cli-upload-${app}.log`);
  const bytes = read(fs.existsSync(rawLog) ? rawLog : path.join(out, `cli-upload-${app}.utf8.log`));
  const log = bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8');
  assert(/(?:^|\n)\s*[√✔]\s*(?:upload|Upload code success)/i.test(log) || /upload (?:code )?success|上传成功/i.test(log), 'Need explicit upload success: ' + app);
  const stamp = read(`apps/miniapp-${app}/miniprogram/utils/buildStamp.ts`).toString('utf8');
  assert.match(stamp, /BUILD_VERSION = 'dev'/); assert.match(stamp, /BUILD_COMMIT = ''/);
  const files = [];
  for (const pkg of ['shared-types', 'api-client', 'miniapp-ui']) {
    const dist = path.join(root, 'packages', pkg, 'miniprogram_dist');
    walk(dist, src => {
      if (!/\.(js|json|wxss|wxml)$/.test(src)) return;
      const dest = path.join(root, `apps/miniapp-${app}/miniprogram/miniprogram_npm/@pms`, pkg, path.relative(dist, src));
      const sha256 = hash(read(src));
      assert.equal(hash(read(dest)), sha256, 'Different runtime artifact: ' + dest);
      files.push({ path: path.relative(root, dest).replace(/\\/g, '/'), sha256 });
    });
  }
  const actual = require(path.join(root, `apps/miniapp-${app}/miniprogram/miniprogram_npm/@pms/shared-types/address.js`));
  for (const name of ['永南150弄', '永北150弄']) assert.equal(actual.formatFullAddress(name, { lane: '150', buildingNo: '6' }, '201'), name + '6号/201');
  assert.equal(actual.dedupeAddressText('永南140弄/40弄6号'), '永南140弄/40弄6号');
  results.push({ app, appid: config.appid, version: entry.version, uploadedAt: entry.time, sourceCommit: frozen.head, explicitCliSuccess: true, sourceUnchanged: true, buildStampRestored: true, runtimeFileCount: files.length, runtimeArtifacts: files });
}
const result = { checkedAt: new Date().toISOString(), sourceFreeze: frozen.head, sourceUnchanged: true, scope: 'Development upload only; API/Web not deployed; experience selection/review/release and native phone acceptance not performed', apps: results };
fs.writeFileSync(path.join(out, 'upload-audit.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ runtimeArtifacts, ...summary }) => summary), null, 2));
