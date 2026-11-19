const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

test('公寓收费后打印、历史补打、重复及超长保护', {timeout:90000}, async () => {
  const dist = path.resolve(__dirname,'../dist');
  const html = fs.readFileSync(path.join(dist,'index.html'),'utf8');
  const base = html.match(/src="([^"]*\/)assets\//)[1];
  const origin = 'http://127.0.0.1:18789';
  const browser = await chromium.launch({channel:'chrome'});
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  let historicalRemark='历史票备注，已核对收费明细。'.repeat(10), historyItemCount=1, charges=0, reprints=0;
  const history = {receiptNo:'HISTORY-02',paidAt:'2026-11-19T01:00:00Z',amountCents:12300,paymentMethod:'cash',status:'paid',items:[{feeCode:'rent',feeName:'房租',amountCents:12300}]};
  const access={isTenantAdmin:true,scopeAll:true,pages:{},communityIds:[]};
  const user={id:1,name:'隔离收费员',tenantId:1};
  try {
    await page.addInitScript(({access,user})=>{
      if(window!==window.top)return;
      sessionStorage.setItem('pms.admin.token','sample.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600}))+'.sample');
      sessionStorage.setItem('pms.admin.user',JSON.stringify(user));
      sessionStorage.setItem('pms.admin.access',JSON.stringify(access));
      window.print=()=>{throw Error('错误：整页打印')};
      window.printJobs=[];
      // Intercept only the OS spool boundary. Keep the actual print document for PDF rendering.
      new MutationObserver(()=>{
        for(const frame of document.querySelectorAll('iframe')){
          const w=frame.contentWindow;
          if(!w || w.print?.captured) continue;
          const capture=()=>{window.printJobs.push(w.document.documentElement.outerHTML);w.dispatchEvent(new Event('afterprint'));};
          capture.captured=true; w.print=capture;
        }
      }).observe(document,{childList:true,subtree:true});
    },{access,user});
    const assets=new Map();
    await page.route('**/*', async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort();
      const key=url.pathname.replace(/^\/api\/v1/,'');
      if(key!==url.pathname){
        let data=[];
        if(key==='/auth/me')data={user,access};
        if(key==='/communities')data=[{id:20,name:'测试公寓',communityType:'apartment'}];
        if(key==='/buildings')data=[{id:34,buildingNo:'34',communityId:20}];
        if(key==='/houses')data=[{id:101,communityId:20,communityName:'测试公寓',buildingId:34,buildingNo:'34',roomNo:'101',owners:[],owner:{id:1,name:'测试住户'}}];
        if(key==='/fees/houses/101')data={rateQuote:'sample',standards:[{status:'active',feeCode:'rent',amountCents:15000}]};
        if(key.includes('/history')||key.endsWith('/today'))data={rows:[history],total:1};
        if(key==='/fees/cashier/charges'){charges++;data={receiptNo:'CHARGE-01',paidAt:history.paidAt};}
        if(key.endsWith('/reprint')){reprints++;data={};}
        if(key.endsWith('/receipts/HISTORY-02'))data={...history,roomNo:'202',buildingNo:'35',remark:historicalRemark,items:Array.from({length:historyItemCount},(_,i)=>({...history.items[0],feeCode:'fee-'+i}))};
        return route.fulfill({json:data});
      }
      const relative=url.pathname.slice(base.length);
      const asset=relative.startsWith('assets/');
      let body=asset?fs.readFileSync(path.join(dist,relative)):Buffer.from(html);
      if(process.env.PMS_VERIFY_RECEIPT_RELEASE==='1' && (asset||relative==='apartment')){
        const remotePath=asset?'/'+relative:'/';
        if(!assets.has(remotePath)){
          const response=await fetch('https://prsznh.cn'+remotePath,{signal:AbortSignal.timeout(20000)});
          assert.equal(response.status,200);
          const bytes=Buffer.from(await response.arrayBuffer());
          assert.ok(bytes.equals(body),remotePath+' differs from build'); assets.set(remotePath,bytes);
        }
        body=assets.get(remotePath);
      }
      await route.fulfill({body,contentType:asset?(relative.endsWith('.css')?'text/css':relative.endsWith('.js')?'application/javascript':'application/octet-stream'):'text/html'});
    });
    await page.goto(origin+base+'apartment');
    await page.locator('.cashier-room-form .ant-select-selector').first().click();
    const opt=page.locator('.ant-cascader-dropdown:visible .ant-cascader-menu-item-content');
    await opt.filter({hasText:'测试公寓'}).first().click();
    await opt.filter({hasText:'34号楼'}).first().click();
    await opt.filter({hasText:'101'}).first().click();
    await page.locator('.cashier-fee-picker button').filter({hasText:'房租'}).click();
    await page.locator('.cashier-payment-method--cash').click();
    await page.getByRole('button',{name:'收费并生成小票'}).click();
    const dialog=page.getByRole('dialog');
    const print=dialog.locator('.ant-modal-footer .ant-btn-primary');
    async function verify(no,n){
      await dialog.getByText(no,{exact:true}).waitFor();
      await print.evaluate(el=>{el.click();el.click()});
      await page.waitForFunction(n=>window.printJobs.length===n,n);
      const content=await page.evaluate(()=>window.printJobs.at(-1));
      const proof=await browser.newPage();
      try{
        await proof.setContent(content);
        assert.equal(await proof.locator('article').count(),1);
        assert.match(await proof.locator('body').innerText(),new RegExp(no));
        assert.doesNotMatch(await proof.locator('body').innerText(),/收费工作台|收费并生成小票/);
        const pdf=await proof.pdf({preferCSSPageSize:true,displayHeaderFooter:false});
        assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,1);
        const box=pdf.toString('latin1').match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)/);
        assert.ok(box);const mm=+box[2]*25.4/72;
        const bottom=await proof.locator('article footer').evaluate(el=>el.getBoundingClientRect().bottom*25.4/96);
        assert.ok(Math.abs(mm-bottom)<2,'票尾余量 '+(mm-bottom)+' mm');
        console.log(no,'一页',(+box[1]*25.4/72).toFixed(1)+' × '+mm.toFixed(1)+' mm');
      }finally{await proof.close();}
      await print.click();
      await page.getByText(/重复打印|刚.*打印/).first().waitFor();
      assert.equal(await page.evaluate(()=>window.printJobs.length),n);
      await dialog.getByRole('button',{name:/^关\s*闭$/}).click();
    }
    await verify('CHARGE-01',1);
    const reprint=page.locator('.cashier-history__row').filter({hasText:'HISTORY-02'}).first().getByRole('button',{name:/补\s*打/});
    await reprint.click();await verify('HISTORY-02',2);
    historicalRemark='异常长备注'.repeat(1800);
    await reprint.click();await print.click();
    await page.getByText(/小票内容过长/).first().waitFor();
    assert.equal(await page.evaluate(()=>window.printJobs.length),2);
    await dialog.getByRole('button',{name:/^关\s*闭$/}).click();
    historyItemCount=41;historicalRemark='';
    await reprint.click();await print.click();
    await page.getByText(/小票内容过长/).first().waitFor();
    assert.equal(await page.evaluate(()=>window.printJobs.length),2);
    await dialog.getByRole('button',{name:/^关\s*闭$/}).click();
    // Advance the test cashier's clock beyond the duplicate window to exercise physical length independently.
    await page.clock.setFixedTime(new Date(Date.now()+60000));
    historyItemCount=1;historicalRemark='多行备注\n'.repeat(550);
    await reprint.click();await print.click();
    await page.getByText(/超过 500 毫米/).waitFor();
    assert.equal(await page.evaluate(()=>window.printJobs.length),2);
    assert.equal(charges,1);assert.equal(reprints,4);
    console.log('verified remote static resources',assets.size);
  }finally{await browser.close();}
});
