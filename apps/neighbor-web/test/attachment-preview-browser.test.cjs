const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {chromium}=require('playwright-core');
function pdf(){
  const parts=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    ...['300 500','500 300'].map(s=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${s}] /Resources <<>> /Contents 5 0 R >>`)];
  const draw='0 .3 .7 rg 40 50 120 180 re f\n';
  parts.push(`<< /Length ${draw.length} >>\nstream\n${draw}endstream`);
  let s='%PDF-1.4\n', offsets=[];
  parts.forEach((p,i)=>{offsets.push(s.length);s+=`${i+1} 0 obj\n${p}\nendobj\n`;});
  const x=s.length;s+=`xref\n0 6\n0000000000 65535 f \n`+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(s);
}
test('附件图片灯箱及 PDF 独立弹窗、异常与资源释放', {timeout:300000},async()=>{
  const { build, preview } = await import('vite');
  const root = path.resolve(__dirname, '..');
  const outDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pms-preview-'));
  const config = {root,base:'/',logLevel:'error',build:{target:'esnext',outDir,rollupOptions:{input:path.join(__dirname,'attachment-preview.fixture.html')}}};
  await build(config);
  const browser = await chromium.launch({executablePath:process.env.PMS_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const server = await preview({...config,preview:{host:'127.0.0.1',port:0}});
  const out=path.resolve(root,'../../outputs/attachment-preview');fs.mkdirSync(out,{recursive:true});
  try {
    for(const width of [1440,390]){
      const page=await browser.newPage({viewport:{width,height:900}});
      page.on('pageerror',e=>console.error(e.message));
      await page.addInitScript(()=>{const urls=new Set();window.urls=urls;const c=URL.createObjectURL.bind(URL),r=URL.revokeObjectURL.bind(URL);URL.createObjectURL=b=>{const u=c(b);urls.add(u);return u};URL.revokeObjectURL=u=>{urls.delete(u);r(u)};});
      // The PMS static server serves .mjs as a binary download.
      await page.route('**/assets/*.mjs', async route => {
        const response = await route.fetch();
        await route.fulfill({response, contentType: 'application/octet-stream'});
      });
      await page.route('**/synthetic.pdf',r=>r.fulfill({body:pdf(),contentType:'application/pdf'}));
      const url='http://127.0.0.1:'+server.httpServer.address().port+'/test/attachment-preview.fixture.html';
      await page.goto(url);
      const img=page.getByRole('button',{name:'预览图片：合成.png'});
      await img.focus();await page.waitForFunction(()=>!document.querySelector('button')?.disabled);await img.press('Enter');
      const large=page.locator('.ant-image-preview-img');await large.waitFor();
      await large.hover();await page.mouse.wheel(0,-200);
      await page.waitForFunction(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ant-image-preview-img')).transform).a > 1);
      const bounds = await large.boundingBox();
      const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 42, cy + 36, { steps: 5 });
      await page.waitForFunction(() => {
        const transform = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ant-image-preview-img')).transform);
        return Math.abs(transform.e) + Math.abs(transform.f) > 5;
      });
      await page.mouse.up();
      await page.screenshot({path:path.join(out,'image-'+width+'.png')});await page.keyboard.press('Escape');await large.waitFor({state:'hidden'});
      const trigger=page.getByRole('button',{name:'预览 PDF：合成.pdf'});await trigger.locator('img').waitFor();await trigger.click();
      const dialog=page.getByRole('dialog');await dialog.getByAltText('第 2 页').waitFor();
      await dialog.getByRole('button',{name:'放大',exact:true}).click();await dialog.getByText('120%',{exact:true}).waitFor();
      await dialog.getByRole('button',{name:'重置'}).click();await dialog.getByText('100%',{exact:true}).waitFor();
      const stage=dialog.getByLabel('PDF 页面');await stage.hover();await page.mouse.wheel(0,-100);await dialog.getByText('110%',{exact:true}).waitFor();
      const box=await stage.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+200);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+100,{steps:6});await page.mouse.up();assert.ok(await stage.evaluate(el=>el.scrollTop)>0);
      const [dl]=await Promise.all([page.waitForEvent('download'),dialog.getByRole('button',{name:'下载原文件'}).click()]);assert.equal(dl.suggestedFilename(),'合成.pdf');assert.deepEqual(fs.readFileSync(await dl.path()),pdf());
      await page.screenshot({path:path.join(out,'pdf-'+width+'.png')});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
      await page.evaluate(()=>window.cleanup());await page.waitForFunction(()=>window.urls.size===0);
      for(const mode of ['error','empty','cancel']){
        await page.goto('about:blank');await page.goto(url+'#'+mode);
        if(mode==='error'){await page.getByText('没有读取此附件的权限').waitFor();await page.getByRole('button',{name:'重试'}).click();await page.locator('button img').waitFor();}
        if(mode==='empty')await page.getByText('该 PDF 没有可显示的页面').waitFor();
        if(mode==='cancel')await page.getByLabel('正在加载 PDF').waitFor();
        await page.evaluate(()=>window.cleanup());if(mode==='cancel')await page.waitForFunction(()=>window.cancelled);await page.waitForFunction(()=>window.urls.size===0);
      }
      await page.close();
    }
  } catch(e){console.error(e);throw e;} finally {await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));}
});
