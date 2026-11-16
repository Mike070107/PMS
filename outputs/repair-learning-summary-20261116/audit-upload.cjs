const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = process.cwd(), out = path.join(root, 'outputs/repair-learning-summary-20261116');
const read = p => fs.readFileSync(p);
const json = p => JSON.parse(read(p).toString('utf8').replace(/^\uFEFF/, ''));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = args => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
const scopes = ['apps/api/src', 'apps/api/package.json', 'apps/api/tsconfig.json', 'apps/miniapp-staff', 'packages/shared-types', 'packages/api-client', 'packages/miniapp-ui', 'tools/build-miniapp-libs.mjs', 'tools/miniapp-ship.mjs', 'pnpm-lock.yaml'];
const sources = () => git(['ls-files','-z','--',...scopes]).split('\0').filter(Boolean).map(p=>({path:p,sha256:hash(read(p))}));
const freezePath = path.join(out, 'source-freeze.json');
assert.equal(git(['status','--porcelain','--untracked-files=all','--',...scopes]), '', 'Source scopes dirty');
if(process.argv[2]==='freeze') {
  const head=git(['rev-parse','HEAD']);
  assert.equal(head,git(['rev-parse','origin/main']));
  assert.equal(git(['branch','--show-current']),'main');
  const result={head,frozenAt:new Date().toISOString(),sourceFiles:sources()};
  fs.writeFileSync(freezePath,JSON.stringify(result,null,2)+'\n');
  console.log(`Frozen ${result.sourceFiles.length} source files at pushed main ${head}`);
  process.exit(0);
}
const frozen=json(freezePath);
assert.deepEqual(sources(), frozen.sourceFiles,'Sources changed after freeze');
const receipt=json('.ship-log.json').filter(x=>x.app==='staff').at(-1);
assert(receipt&&frozen.head.startsWith(receipt.hash),'Wrong uploaded commit');
const config=json('apps/miniapp-staff/project.config.json');
assert.equal(config.appid,'wx002fde4bfaa4c7d9');
const logBytes=read(path.join(out,'cli-upload-staff.log'));
const log=logBytes.toString(logBytes[0]===255&&logBytes[1]===254?'utf16le':'utf8');
fs.writeFileSync(path.join(out,'cli-upload-staff.utf8.log'),log.replace(/^\uFEFF/,''),'utf8');
assert(/(?:^|\n)\s*[√✔]\s*(?:upload|Upload code success)/i.test(log)||/upload (?:code )?success|上传成功/i.test(log),'Missing official explicit upload success');
assert(log.includes('Using AppID: '+config.appid),'Official CLI used a different AppID');
assert(log.includes(receipt.version)&&log.includes(receipt.hash),'CLI version/commit differ from receipt');
const stamp=read('apps/miniapp-staff/miniprogram/utils/buildStamp.ts').toString();
assert.match(stamp,/BUILD_VERSION = 'dev'/); assert.match(stamp,/BUILD_COMMIT = ''/);
function walk(dir, cb){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);e.isDirectory()?walk(p,cb):cb(p);}}
const artifacts=[];
for(const pkg of ['shared-types','api-client','miniapp-ui']) {
  const dist=path.join(root,'packages',pkg,'miniprogram_dist');
  walk(dist,src=>{
    if(!/\.(js|json|wxss|wxml)$/.test(src))return;
    const dest=path.join(root,'apps/miniapp-staff/miniprogram/miniprogram_npm/@pms',pkg,path.relative(dist,src));
    const sha256=hash(read(src)); assert.equal(hash(read(dest)),sha256,'Stale runtime: '+dest);
    artifacts.push({path:path.relative(root,dest).replace(/\\/g,'/'),sha256});
  });
}
const result={checkedAt:new Date().toISOString(),sourceCommit:frozen.head,sourceUnchanged:true,app:'staff',appid:config.appid,version:receipt.version,uploadedAt:receipt.time,explicitOfficialCliSuccess:true,wrapperGlobalDirty:receipt.dirty,globalDirtyExplanation:'Untracked evidence outside shipped source scopes; frozen 936 tracked source files unchanged and shipped source scopes clean. Wrapper plus-local-changes annotation is global, not shipped source drift.',buildStampRestored:true,runtimeFileCount:artifacts.length,runtimeArtifacts:artifacts,scope:'Development upload only. API production not deployed. Experience pointer/review/release and native phone verification not performed. Owner unchanged at previous 1.0.20261116b / 74e332d0.'};
fs.writeFileSync(path.join(out,'upload-audit.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,runtimeArtifacts:undefined},null,2));
