const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const origin = 'https://prsznh.cn';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function get(url) { const r = await fetch(url, {headers: {'cache-control':'no-cache'}}); assert.equal(r.status, 200, url); return Buffer.from(await r.arrayBuffer()); }
(async () => {
  const commit = process.argv[2]; assert.match(commit, /^[a-f0-9]{40}$/);
  const web = JSON.parse(await get(`${origin}/release.json?t=${Date.now()}`));
  const api = JSON.parse(await get(`${origin}/api/v1/health?t=${Date.now()}`));
  const assistant = JSON.parse(await get(`${origin}/downloads/pms-data-sync-assistant/latest.json?t=${Date.now()}`));
  assert.equal(web.commit, commit); assert.equal(api.release.commit, commit); assert.equal(assistant.sourceCommit, commit);
  assert.equal(api.status, 'ok'); assert.equal(api.db, 'up'); assert.equal(assistant.version, '2.5.55');
  assert.equal(assistant.url, assistant.downloadUrl);
  const exe = await get(assistant.downloadUrl); assert.equal(hash(exe), assistant.sha256);
  fs.writeFileSync(path.join(__dirname, 'production-assistant-2.5.55.exe'), exe);
  const dist = path.join(root, 'apps/neighbor-web/dist/assets');
  const assets = [];
  for (const filename of fs.readdirSync(dist).filter(n => /^(Vehicles|ParkingTab|GarageSpacePicker)-.*\.js$/.test(n))) {
    const local = fs.readFileSync(path.join(dist, filename));
    const online = await get(`${origin}/assets/${filename}`);
    assert.equal(hash(online), hash(local), filename);
    assets.push({filename, sha256: hash(online)});
  }
  assert.ok(assets.some(a => a.filename.startsWith('Vehicles-')));
  assert.ok(assets.some(a => a.filename.startsWith('ParkingTab-')));
  const pickerFiles = fs.readdirSync(dist).filter(n => n.endsWith('.js')).filter(n => fs.readFileSync(path.join(dist,n),'utf8').includes('确认车位'));
  assert.ok(pickerFiles.length, 'Picker must be present in production build');
  for (const filename of pickerFiles) {
    const online = await get(`${origin}/assets/${filename}`); assert.equal(hash(online), hash(fs.readFileSync(path.join(dist,filename))));
    const text = online.toString(); assert.ok(text.includes('搜索车位号')); assert.ok(text.includes('重试读取车位'));
    if (!assets.some(a => a.filename === filename)) assets.push({filename,sha256:hash(online)});
  }
  const report = {verifiedAt:new Date().toISOString(), commit, web, api, assistant, assistantDownload:{bytes:exe.length,sha256:hash(exe)}, assets, scope:'Read-only public release identity, DB health, exact Web assets, assistant manifest and executable SHA256. No production business writes, field SQL or device tests. Field installation not verified.'};
  fs.writeFileSync(path.join(__dirname,'production-verification.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
