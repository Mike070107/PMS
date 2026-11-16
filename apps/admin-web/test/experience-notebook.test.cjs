const { test } = require('node:test');
const { runBrowser } = require('../../neighbor-web/test/experience-notebook.test.cjs');
test('admin notebook actual component: private save, independent sharing, secure uploads, ACL and retained drafts', { timeout: 120000 }, () => runBrowser('admin'));
