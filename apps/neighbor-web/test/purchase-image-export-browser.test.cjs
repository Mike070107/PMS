const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const build = createRequire(require.resolve('vite'))('esbuild').build;
const admin = path.resolve(__dirname, '../../admin-web');
const ExcelJS = createRequire(path.join(admin, 'package.json'))('exceljs');

test('采购单单张及批量下载使用可解码的内嵌 PNG，横竖图片完整落在对应行内', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purchase-xlsx-'));
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const { outputFiles } = await build({ stdin: { contents: "export * from './src/lib/purchaseRequestForm'", resolveDir: admin },
      bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'forms' });
    const page = await browser.newPage();
    await page.addScriptTag({ content: outputFiles[0].text });
    for (const count of [1, 2]) {
      const download = page.waitForEvent('download');
      await page.evaluate(async count => {
        const items = [[360, 90, 'webp'], [80, 320, 'jpeg'], [80, 80, 'png']].map(([w,h,fmt]) => {
          const c = document.createElement('canvas'); c.width=w; c.height=h;
          const ctx=c.getContext('2d'); ctx.fillStyle='#196bb2'; ctx.fillRect(0,0,w,h);
          return { name:fmt, qty:1, photoUrl:c.toDataURL('image/'+fmt) };
        });
        items.push({name:'损坏样图',qty:1,photoUrl:'data:image/webp;base64,YmFk'});
        const form = { items, requestNo:'采购样单', areaName:'测试', reason:'', applicantName:'', dateText:'' };
        if (count===1) await forms.downloadPurchaseRequestForm(form);
        else await forms.downloadPurchaseRequestForms([form,{...form,requestNo:'第二张'}]);
      }, count);
      const file = path.join(dir, count+'.xlsx'); await (await download).saveAs(file);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file);
      assert.equal(workbook.worksheets.length, count);
      for (const sheet of workbook.worksheets) {
        assert.equal(sheet.getImages().length, 3);
        for (const [i, img] of sheet.getImages().entries()) {
          const media = workbook.getImage(img.imageId);
          assert.equal(media.extension, 'png');
          assert.equal(media.buffer.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
          const { tl, ext } = img.range;
          assert.equal(tl.nativeCol, 5); assert.equal(tl.nativeRow, 4+i);
          const x=tl.nativeColOff/9525, y=tl.nativeRowOff/9525;
          assert.ok(x>=0 && x+ext.width < sheet.getColumn(6).width*7);
          // 桌面 Excel 在本机显示缩放下，实际可用行高约为声明值的 2/3。
          assert.ok(y>=0 && y+ext.height < sheet.getRow(5+i).height * (2/3) * 96/72);
          assert.ok(Math.abs(ext.width / ext.height - [4,.25,1][i]) < .1);
        }
        assert.equal(sheet.getCell('F8').value, '图片加载失败');
      }
      if (process.env.PMS_PURCHASE_SAMPLE && count===1) await fs.copyFile(file,process.env.PMS_PURCHASE_SAMPLE);
    }
  } finally { await browser.close(); await fs.rm(dir,{recursive:true,force:true}); }
});
