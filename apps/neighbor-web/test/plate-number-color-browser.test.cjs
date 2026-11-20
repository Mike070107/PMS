const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');

test('车牌点选、键入、回填与退位同步牌面颜色', async () => {
  const bundle = await esbuild.build({ stdin: { resolveDir: path.resolve(__dirname,'..'), loader:'tsx',
    contents:`import {createRoot} from 'react-dom/client';import {useState} from 'react';
      import Field from './src/components/PlateNumberField';import './src/styles/app.css';
      function Form(){const [value,set]=useState('沪AD12345'); return <Field value={value} onChange={set}/>;}
      createRoot(document.getElementById('web')).render(<Form/>);` },
    bundle:true,write:false,jsx:'automatic',outfile:'fixture.js',define:{'process.env.NODE_ENV':'"test"'} });
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for (const width of [1440,375]) {
      const page=await browser.newPage({viewport:{width,height:750}});
      await page.setContent('<div id="web"></div>');
      await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css')).text});
      await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
      const input=page.getByRole('textbox');
      const finish=()=>input.evaluate(el=>getComputedStyle(el).backgroundImage);
      assert.match(await finish(),/linear-gradient/,'已有八位车牌应显示绿牌');
      await input.fill('沪AD1234');
      assert.equal(await finish(),'none');
      await input.press('End'); await input.press('5');
      assert.match(await finish(),/linear-gradient/);
      await page.getByRole('button',{name:'点选车牌'}).click();
      await page.getByRole('button',{name:'退一位'}).click(); assert.equal(await finish(),'none');
      await page.getByRole('button',{name:'6',exact:true}).click(); assert.match(await finish(),/linear-gradient/);
      assert.equal(await input.inputValue(),'沪AD12346');
      assert.ok(await input.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await page.getByRole('button',{name:'清空车牌'}).click(); assert.equal(await finish(),'none');
      await page.close();
    }
  } finally {await browser.close();}
});
