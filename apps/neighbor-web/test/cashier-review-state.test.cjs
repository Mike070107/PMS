const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = path.resolve(__dirname, '..');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const { chromium } = require('playwright-core');

test('收银结果只有正在执行的任务旋转，待经理审核显示静态感叹号', async () => {
  const source = fs.readFileSync(path.join(app, 'src/pages/Cashier.tsx'), 'utf8');
  const state = source.slice(source.indexOf('const taskLabels:'), source.indexOf('interface ChargeResult'));
  const row = source.match(/<div className="taskRow" key=\{i\}>[\s\S]+?<\/span>\s*<\/div>/)[0];
  const build = await esbuild.build({ stdin: { loader: 'tsx', resolveDir: app, contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import Icon from './src/components/Icon';
    ${state}
    const states=['review','awaiting_docs','running','queued','synced','manual'];
    createRoot(document.body.appendChild(document.createElement('main'))).render(states.map((status,i)=>{
      const t={title:status,note:'',state:resultState(status)};return (${row});
    }));` }, jsx:'automatic', bundle:true, write:false });
  const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  try {
    const page = await browser.newPage({ viewport:{width:390,height:700} });
    await page.setContent('<meta charset="utf-8"><body></body>');
    await page.addScriptTag({content:build.outputFiles[0].text});
    const review = page.locator('.taskRow').filter({ hasText:'待经理审核' });
    await review.waitFor();
    assert.equal(await review.locator('use').getAttribute('href'),'#pms-i-alert');
    assert.equal(await page.locator('.spin').count(),1);
    assert.match(await page.locator('.taskRow').filter({has:page.locator('.spin')}).innerText(),/执行中/);
  } finally { await browser.close(); }
});
