const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { chromium } = require('playwright-core');
const dist = path.resolve(__dirname, '../dist');
test('系统与设备登记打印机、授权与隐藏绑定码，桌面及手机', async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PMS_TEST_CHROME ||
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(6000);
      const user = { id: 3, tenantId: 1, name: '合成管理员' },
        access = {
          isTenantAdmin: true,
          scopeAll: true,
          pages: {},
          communityIds: [],
        };
      const printers = [];
      let granted = false;
      await page.addInitScript(
        ({ user, access }) => {
          sessionStorage.setItem(
            'pms.admin.token',
            'test.' +
              btoa(JSON.stringify({ exp: Date.now() / 1000 + 300 })) +
              '.test',
          );
          sessionStorage.setItem('pms.admin.user', JSON.stringify(user));
          sessionStorage.setItem('pms.admin.access', JSON.stringify(access));
        },
        { user, access },
      );
      await page.route('**/*', async (r) => {
        const u = new URL(r.request().url());
        if (u.origin !== 'https://isolated.test') return r.abort();
        const endpoint = u.pathname.split('/api/v1/')[1];
        if (endpoint) {
          if (endpoint === 'auth/me')
            return r.fulfill({ json: { user, access } });
          if (endpoint === 'receipt-printers/manage')
            return r.fulfill({
              json: { printers, employees: [{ id: 7, name: '合成收费员' }] },
            });
          if (endpoint === 'receipt-printers/register') {
            printers.push({
              id: 2,
              name: r.request().postDataJSON().name,
              grants: [],
              online: false,
              bound: false,
            });
            return r.fulfill({ json: { code: 'synthetic-pairing-only' } });
          }
          if(endpoint==='staff') return r.fulfill({json:[{id:7,name:'合成收费员',status:'active',assignments:[],roles:[],roleIds:[]}]});
          if(endpoint==='receipt-printers/employees/7') return r.fulfill({json:printers.map(p=>({id:p.id,name:p.name,allowed:granted}))});
          if (endpoint === 'receipt-printers/2/grants') {
            granted = r.request().postDataJSON().allow;
            printers[0].grants = granted ? [7] : [];
            return r.fulfill({ json: { ok: true } });
          }
          return r.fulfill({
            status: 503,
            json: { message: '隔离测试未连接其他设备' },
          });
        }
        const key = u.pathname.replace(/^\/beta\//, '/');
        const file = path.join(dist, ['/devices','/staff'].includes(key) ? 'index.html' : key);
        return fs.existsSync(file) && fs.statSync(file).isFile()
          ? r.fulfill({ path: file })
          : r.fulfill({ status: 404, body: '' });
      });
      const base = fs
        .readFileSync(path.join(dist, 'index.html'), 'utf8')
        .includes('/beta/assets/')
        ? '/beta'
        : '';
      await page.goto('https://isolated.test' + base + '/devices');
      await page.getByText('公寓小票打印机', { exact: true }).click();
      await page.getByRole('button', { name: '生成绑定码' }).click();
      const name = page.getByLabel('打印机名称');
      await page.getByText('请输入打印机名称').waitFor();
      assert.ok(await name.evaluate((el) => el === document.activeElement));
      await name.fill('合成收银台');
      await page.getByRole('button', { name: '生成绑定码' }).click();
      await page.getByText('synthetic-pairing-only').waitFor();
      await page.getByRole('button', { name: '隐藏绑定码' }).click();
      await page.getByText('合成收银台 · 待绑定').click();
      const link = page.getByRole('link', { name: '下载 Windows 打印助手' });
      assert.ok(
        (await link.getAttribute('href')).endsWith('/PmsReceiptPrinter.exe'),
      );
      assert.equal(await page.getByText('允许打印的员工').count(),0);
      const openEmployee=async()=>{
        await page.goto('https://isolated.test'+base+'/staff');
        await page.getByText('合成收费员',{exact:true}).click();
        await page.getByText('打印服务',{exact:true}).click();
      };
      granted=true;await openEmployee();
      await page.getByRole('checkbox',{name:'合成收银台',checked:true}).waitFor();
      await page.getByRole('checkbox',{name:'合成收银台'}).click();
      await page.getByRole('checkbox',{name:'合成收银台',checked:false}).waitFor();
      assert.equal(granted,false);
      await openEmployee();
      const emp = page.getByRole('checkbox',{name:'合成收银台'});
      await emp.click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('label')]
            .find((el) => el.textContent.includes('合成收银台'))
            ?.querySelector('input')?.checked,
      );
      assert.ok(granted);
      await emp.click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('label')]
            .find((el) => el.textContent.includes('合成收银台'))
            ?.querySelector('input')?.checked === false,
      );
      assert.equal(granted, false);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
