const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');

test('档案五级入口、多房产关联、多电话、成功联系标记及窄屏', async () => {
  const built = await esbuild.build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import PropertyArchive from '@/pages/PropertyArchive';
      import '@/styles/design.css';import '@/styles/app.css';import '@/styles/large.css';import '@/styles/guards.css';
      createRoot(document.getElementById('root')).render(<PropertyArchive/>);`, loader: 'tsx', resolveDir: app },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js',
    alias: { '@': path.join(app, 'src') },
    plugins: [{ name: 'isolated-adapters', setup(build) {
      build.onResolve({ filter: /^(@pms\/api-client|@\/lib\/auth|@\/lib\/perm|@\/components\/MigratedSurface)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
        if (args.path.endsWith('/perm')) return { contents: `export const can=()=>!location.search.includes('readonly');`, loader: 'js' };
        if (args.path.endsWith('/auth')) return { contents: `const session={user:{id:1},access:{isTenantAdmin:true}};export const useSession=()=>session;`, loader: 'js' };
        if (args.path.endsWith('/MigratedSurface')) return { contents: `import React from 'react';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/es/locale/zh_CN';import '@/styles/migrated-surface.css';export default function Surface({children}){return <ConfigProvider locale={zhCN} theme={{token:{fontSize:16,controlHeight:44,borderRadius:8}}}><App><section className="migrated-surface">{children}</section></App></ConfigProvider>}`, loader: 'tsx', resolveDir: app };
        return { loader: 'js', contents: `
          const seed={offices:[{id:1,name:'测试管理处'}],communities:[{id:1,name:'公寓A',officeId:1,communityType:'apartment'}],buildings:[{id:1,communityId:1,buildingNo:'A栋',buildingType:'residential'},{id:2,communityId:1,buildingNo:'沿街商铺',buildingType:'shop'}],houses:[{id:1,buildingId:1,roomNo:'101',owners:[]},{id:2,buildingId:1,roomNo:'102',owners:[]}],owners:[],links:[]};
          let db=JSON.parse(localStorage.getItem('archive-fixture')||'null')||seed;
          window.__calls=[];
          export async function request({url,method='GET',query={},data={}}){
            window.__calls.push({url,method,query,data});
            if(url==='/communities/offices')return db.offices;
            const [kind,id,action]=url.slice(1).split('/');const key=kind==='owners-mgmt'?'owners':kind;
            if(method==='GET'){
              let rows=db[key]||[];
              if(query.communityId)rows=rows.filter(r=>r.communityId===query.communityId);
              if(query.buildingId&&key!=='owners')rows=rows.filter(r=>r.buildingId===query.buildingId);
              if(key==='owners'&&query.houseId)rows=rows.filter(r=>db.links.some(l=>l.ownerId===r.id&&l.houseId===query.houseId));
              if(key==='owners'&&query.buildingId)rows=rows.filter(r=>db.links.some(l=>l.ownerId===r.id&&l.ownerBuildingId===query.buildingId));
              if(key==='offices')return {offices:rows};
              return key==='houses'?{rows,total:rows.length}:rows;
            }
            if(action==='properties'){
              if(method==='POST')db.links.push({ownerId:Number(id),...data});
              else db.links=db.links.filter(l=>!(l.ownerId===Number(id)&&l.houseId===query.houseId&&l.ownerBuildingId===query.ownerBuildingId));
            }else if(action==='contact-events'){
              const owner=db.owners.find(r=>r.id===Number(id));owner.phoneActivity=[{phone:data.phone,status:data.result,last_contacted_at:new Date().toISOString()}];
            }else if(method==='POST'){
              const row={...data,id:db[key].length+1};db[key].push(row);
              if(key==='owners')db.links.push({ownerId:row.id,houseId:data.houseId,ownerBuildingId:data.ownerBuildingId});
            }else if(method==='PATCH'){Object.assign(db[key].find(r=>r.id===Number(id)),data);}
            localStorage.setItem('archive-fixture',JSON.stringify(db));return {ok:true};
          }
        ` };
      });
    } }], define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"' },
  });
  const server = http.createServer((req, res) => {
    const ext = req.url === '/fixture.js' ? 'js' : req.url === '/fixture.css' ? 'css' : 'html';
    res.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html; charset=utf-8' }[ext]);
    res.end(ext === 'html' ? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root" style="padding:20px"></div><script src="/fixture.js"></script>' : built.outputFiles.find(f => f.path.endsWith('.' + ext)).contents);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
    await page.goto(origin);
    const row = text => page.getByRole('row').filter({ hasText: text });
    await row('测试管理处').getByRole('button', { name: '查看下级' }).click();
    await row('公寓A').getByRole('button', { name: '查看下级' }).click();
    await row('A栋').getByRole('button', { name: '查看下级' }).click();
    await row('101').getByRole('button', { name: '管理业主' }).click();
    await page.getByRole('button', { name: '新增业主', exact: true }).click();
    await page.getByRole('button', { name: /保\s*存/, exact: true }).click();
    await page.locator('#archive_name[aria-invalid="true"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'archive_name');
    await page.locator('#archive_name').fill('测试业主甲');
    await page.getByLabel('主要联系电话').fill('13800000001');
    await page.getByRole('button', { name: '添加联系电话' }).click();
    await page.getByLabel('其他电话 1').fill('021-12345678');
    await page.getByRole('button', { name: /保\s*存/, exact: true }).click();
    await row('测试业主甲').waitFor();
    assert.ok(await row('测试业主甲').getByText('021-12345678', { exact: true }).isVisible());
    await page.getByRole('combobox', { name: '记录021-12345678联系结果' }).click();
    await page.getByTitle('已联系成功', { exact: true }).click();
    await row('测试业主甲').locator('.ant-tag').filter({ hasText: '已联系成功' }).waitFor();
    fs.mkdirSync(path.join(app,'../../outputs/property-archive'), { recursive: true });
    await page.screenshot({ path: path.join(app,'../../outputs/property-archive/owner-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(app,'../../outputs/property-archive/owner-mobile.png'), animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('tab', { name: '房号', exact: true }).click();
    await row('102').getByRole('button', { name: '管理业主' }).click();
    await page.getByRole('button', { name: '关联已有业主' }).click();
    await page.getByRole('button', { name: '搜 索', exact: true }).click();
    await page.getByRole('combobox', { name: '选择已有业主' }).click();
    await page.getByTitle('测试业主甲 · 13800000001', { exact: true }).click();
    await page.locator('.ant-modal:visible .ant-modal-footer .ant-btn-primary').click();
    await row('测试业主甲').waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('archive-fixture')).links.length), 2);
    await page.getByRole('tab', { name: '楼栋 / 商铺', exact: true }).click();
    await row('沿街商铺').getByRole('button', { name: '管理业主' }).click();
    assert.equal(await page.getByRole('button', { name: '新增业主', exact: true }).count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    fs.mkdirSync(path.join(app,'../../outputs/property-archive'), { recursive: true });
    await page.screenshot({ path: path.join(app,'../../outputs/property-archive/mobile.png'), animations: 'disabled' });
    await page.reload();
    await row('测试管理处').waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('archive-fixture')).owners[0].contactPhones[0]), '021-12345678');
    await page.goto(origin+'/?readonly=1');
    await row('测试管理处').waitFor();
    assert.equal(await page.getByRole('button', { name: /新增|编辑|删除/ }).count(), 0);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
