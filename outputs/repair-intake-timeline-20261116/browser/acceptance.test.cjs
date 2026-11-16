const {fixture,shot,publicCommunity,uploadFile,png,delay,test,assert}=require('./browser.test.cjs');
const wait=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await delay(50);}assert.fail('condition did not settle');};
async function transfer(page,selector,event){await page.locator(selector).evaluate((el,{event,bytes})=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],event+'.png',{type:'image/png'}));el.dispatchEvent(event==='paste'?new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));},{event,bytes:[...png]});}
async function realPaste(page){await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=4;c.height=4;c.getContext('2d').fillRect(0,0,4,4);const b=await new Promise(r=>c.toBlob(r,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':b})]);});await page.keyboard.press('Control+V');}
const formZone='.new-order-form .photo-drop';
test('实际报修组件：公区与照片完整边界、两屏、失败重试、单粘贴目标及迟到隔离',{timeout:120000},async()=>fixture(async(page,url,state)=>{
 await page.goto(url);await publicCommunity(page);await shot(page,'desktop-community-public');
 assert.equal(await page.getByRole('button',{name:'提交报修',exact:true}).isEnabled(),true);
 // Whole-zone click reaches the real hidden file input and file chooser once.
 const chooser=page.waitForEvent('filechooser');await page.locator(formZone).click();await(await chooser).setFiles(uploadFile('click.png'));
 await wait(()=>state.uploads.length===1);await page.locator('.new-order-form .photo-item').waitFor();await wait(()=>page.locator('.new-order-form .photo-item img').first().evaluate(el=>el.complete&&el.naturalWidth===240));
 assert.match(state.uploads[0].contentType,/multipart\/form-data; boundary=/);assert.equal(state.uploads[0].authorization,'Bearer synthetic-token');assert.equal(state.uploads[0].tenant,'7');
 // Drag and wait: submit and destructive clear stay disabled until the upload settles.
 state.slowUpload=true;await transfer(page,formZone,'drop');await wait(()=>state.held.length===1);
 assert.equal(await page.getByRole('button',{name:'提交报修',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'清空',exact:true}).isDisabled(),true);
 await shot(page,'desktop-upload-wait');state.slowUpload=false;state.held.splice(0).forEach(f=>f());await wait(()=>page.locator('.new-order-form .photo-item').count().then(n=>n===2));
 // Failed original file is held, previous success retained, and explicit retry works.
 state.failUpload=true;await page.locator('.new-order-form input[type=file]').setInputFiles(uploadFile('retry-original.png'));
 await page.getByRole('button',{name:'重试上传',exact:true}).waitFor();assert.equal(await page.locator('.new-order-form .photo-item').count(),2);
 assert.equal(await page.getByRole('button',{name:'提交报修',exact:true}).isDisabled(),true);assert.match(await page.locator('.photo-upload-errors').innerText(),/retry-original.png/);
 await shot(page,'desktop-upload-error');await page.getByRole('button',{name:'重试上传',exact:true}).click();await wait(()=>page.locator('.new-order-form .photo-item').count().then(n=>n===3));
 // Clipboard event follows focused actual field and must consume exactly once.
 const beforePaste=state.uploads.length;await page.locator(formZone).focus();await realPaste(page);await wait(()=>page.locator('.new-order-form .photo-item').count().then(n=>n===4));assert.equal(state.uploads.length,beforePaste+1);
 // Submission failure retains all input and successful URL list; narrow rendering too.
 state.failCreate=true;await page.getByRole('button',{name:'提交报修',exact:true}).click();await page.getByText('合成提交失败，请核对后重试',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'问题描述',exact:true}).inputValue(),'合成公共区域灯不亮');assert.equal(await page.getByLabel('具体位置',{exact:true}).inputValue(),'大门');assert.equal(await page.getByLabel('联系人',{exact:true}).inputValue(),'合成联系人');assert.equal(await page.locator('.new-order-form .photo-item').count(),4);
 await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('.sh-b').evaluate(el=>el.scrollTop=0);await shot(page,'narrow-submit-error-retained');await page.locator('.new-order-form .photo-field').scrollIntoViewIfNeeded();await shot(page,'narrow-retained-photos');
 await page.getByRole('button',{name:'提交报修',exact:true}).click();await page.getByRole('button',{name:'提交中…',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'提交中…',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'登记报修',exact:true}).count(),1);
 await page.locator('.tabs').waitFor();const payload=state.creates.at(-1);assert.equal(state.creates.length,2);assert.equal(payload.communityId,81);assert.equal(payload.buildingId,undefined);assert.equal(payload.houseId,undefined);assert.equal(payload.locationText,'大门');assert.equal(payload.attachments.length,4);assert.match(payload.addressText,/合成空楼小区.*公共区域.*大门/);assert.ok(payload.attachments.every(x=>x.startsWith('/fixture-upload/upload/file?key=uploads%2F')));
 await page.locator('.sh-b .photos a').first().waitFor();assert.equal(await page.locator('.sh-b .photos a').count(),4);assert.deepEqual(await page.locator('.sh-b .photos a').evaluateAll(es=>es.map(e=>e.getAttribute('href'))),payload.attachments);await shot(page,'narrow-created-detail');
 await page.goto(url+'/?detail');await page.locator('.sh-b .photos a').first().waitFor();assert.equal(await page.locator('.sh-b .photos a').count(),4);assert.ok(state.details>=2);
 await page.getByRole('button',{name:'处理进度',exact:true}).click();assert.match(await page.locator('.tl .e').first().innerText(),/最新处理记录/);assert.match(await page.locator('.tl .e').last().innerText(),/较早记录/);await shot(page,'narrow-timeline-newest-first');await page.setViewportSize({width:1440,height:1000});await shot(page,'desktop-timeline-newest-first');
 // Two real PhotoFields: explicit target moves and screenshot uploads to one field only.
 await page.setViewportSize({width:1440,height:1000});await page.goto(url+'/?multi');await publicCommunity(page);
 const other='#other-photos .photo-drop';await page.locator(other).focus();await wait(()=>page.locator(other).getAttribute('data-paste-target').then(x=>x==='active'));
 let n=state.uploads.length;await transfer(page,'body','paste');await wait(()=>page.locator('#other-photos .photo-item').count().then(x=>x===1));assert.equal(state.uploads.length,n+1);assert.equal(await page.locator('.new-order-form .photo-item').count(),0);
 await page.locator(formZone).focus();n=state.uploads.length;await transfer(page,'body','paste');await wait(()=>page.locator('.new-order-form .photo-item').count().then(x=>x===1));assert.equal(state.uploads.length,n+1);assert.equal(await page.locator('#other-photos .photo-item').count(),1);assert.equal(await page.locator('[data-paste-target=active]').count(),1);await shot(page,'desktop-single-paste-target');
 // Plain text clipboard in an input is not consumed as a photo, even with mixed clipboard contents.
 n=state.uploads.length;await page.getByRole('textbox',{name:'问题描述',exact:true}).focus();const prevented=await page.getByRole('textbox',{name:'问题描述',exact:true}).evaluate(el=>{const dt=new DataTransfer();dt.setData('text/plain','合成文本');dt.items.add(new File(['synthetic'],'mixed.png',{type:'image/png'}));const e=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});el.dispatchEvent(e);return e.defaultPrevented;});assert.equal(prevented,false);await delay(100);assert.equal(state.uploads.length,n);
 // Failed attachment may be explicitly discarded and doesn't remove prior successes.
 state.failUpload=true;await page.locator('.new-order-form input[type=file]').setInputFiles(uploadFile('discard.png'));await page.getByRole('button',{name:'放弃失败照片',exact:true}).waitFor();await page.getByRole('button',{name:'放弃失败照片',exact:true}).click();await wait(()=>page.getByRole('button',{name:'提交报修',exact:true}).isEnabled());assert.equal(await page.locator('.new-order-form .photo-item').count(),1);
 // Closing and reopening creates a fresh photo field; late URL must not enter new draft.
 state.slowUpload=true;await transfer(page,formZone,'drop');await wait(()=>state.held.length===1);await page.keyboard.press('Escape');await page.getByRole('button',{name:'重新登记',exact:true}).click();await page.locator(formZone).waitFor();state.slowUpload=false;state.held.splice(0).forEach(f=>f());await delay(200);assert.equal(await page.locator('.new-order-form .photo-item').count(),0);assert.equal(await page.getByRole('textbox',{name:'问题描述',exact:true}).inputValue(),'');
 // House and building public paths preserve IDs; fixed prefill doesn't infer either ID.
 for(const mode of ['house','building','fixed']){
  await page.goto(url+(mode==='fixed'?'/?fixed':''));
  if(mode!=='fixed'){
   await page.locator('.hp input').click();await page.locator('.ant-cascader-menu-item').filter({hasText:'合成永南140弄'}).click();await page.locator('.ant-cascader-menu').nth(1).locator('.ant-cascader-menu-item').filter({hasText:'6号'}).click();
   await page.locator('.ant-cascader-menu-item').filter({hasText:mode==='house'?'502 · 合成住户':'本楼栋公共区域'}).click();
  }
  await page.getByRole('textbox',{name:'问题描述',exact:true}).fill('合成'+mode);await page.getByRole('button',{name:'提交报修',exact:true}).click();await page.locator('.tabs').waitFor();const d=state.creates.at(-1);assert.equal(d.communityId,82);assert.equal(d.buildingId,mode==='fixed'?undefined:821);assert.equal(d.houseId,mode==='house'?8211:undefined);
 }
 // Actual narrow empty-community selection, not just resizing a previously selected form.
 await page.setViewportSize({width:375,height:812});await page.goto(url);await publicCommunity(page);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await shot(page,'narrow-community-public');
 require('node:fs').writeFileSync(require('node:path').join(__dirname,'result.json'),JSON.stringify({passed:true,synthetic:true,widths:[1440,375],assertions:['community-public-no-building-house','click-filechooser','drop','paste-once','upload-wait-gates','failed-file-retry','failed-file-discard','submission-error-preserves','success-payload','actual-detail-readback-reload','two-fields-active-paste','plain-text-paste-not-stolen','late-upload-isolated','house-and-building-ids','fixed-no-inferred-ids'],uploadCount:state.uploads.length,createCount:state.creates.length,detailReadCount:state.details},null,2));
}));
