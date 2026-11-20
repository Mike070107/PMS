import assert from 'node:assert/strict';
import automator from 'miniprogram-automator';

const timeout = setTimeout(() => {
  console.error('收费页滚动验收超时，请检查开发者工具和员工会话');
  process.exit(1);
}, 90000);

async function checkBottom(app, page, expanded) {
  await app.callWxMethod('pageScrollTo', { scrollTop: 999999, duration: 0 });
  await page.waitFor(600);
  const bounds = await app.evaluate((expanded) => new Promise(resolve => {
    const page = getCurrentPages().slice(-1)[0];
    const bar = page.selectComponent('#cashier-tabbar');
    wx.createSelectorQuery().in(page)
      .selectAll(expanded ? '.record-row' : '.daily-details-toggle').boundingClientRect()
      .exec(([rows]) => wx.createSelectorQuery().in(bar).select('.tabbar').boundingClientRect()
        .exec(([barRect]) => {
          const last = rows[rows.length - 1];
          const { windowWidth, windowHeight } = wx.getWindowInfo();
          resolve({ windowWidth, windowHeight, top: last?.top, bottom: last?.bottom, barTop: barRect?.top });
        }));
  }), expanded);
  console.log(expanded ? '末条收费记录' : '展开明细按钮', bounds);
  assert.ok(bounds.top >= 0 && bounds.bottom > bounds.top && bounds.bottom <= bounds.barTop, '末项未完整露出');
}

let app;
try {
  app = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:' + (process.env.AUTO_PORT || '9438') });
  const page = await app.reLaunch('/pages/apartment-cashier/apartment-cashier');
  await page.waitFor('.cashier-tabs');
  await (await page.$$('.cashier-tab'))[2].tap();
  await page.waitFor('.daily-details-toggle');
  await page.waitFor(() => page.data().then(data => !data.todaySummaryLoading));
  await checkBottom(app, page, false);
  await (await page.$('.daily-details-toggle')).tap();
  await page.waitFor('.record-row');
  await checkBottom(app, page, true);
  const expected = (await page.data()).todayRows.at(-1).receiptNo;
  await (await page.$$('.record-row')).at(-1).tap();
  await page.waitFor('.receipt__amount');
  assert.equal((await page.data()).recordDetail?.receiptNo, expected);
  await page.callMethod('onCloseRecord');
} finally {
  clearTimeout(timeout);
  app?.disconnect();
}
