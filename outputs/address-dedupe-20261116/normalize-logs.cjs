const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
for (const name of ['intake-before', 'regression', 'frontend-tests', 'cli-upload-staff', 'cli-upload-owner', 'compiled-api-smoke', 'web-build-protocol', 'web-build', 'web-build-retry', 'upload-audit']) {
  const src = path.join(__dirname, name + '.log');
  const target = path.join(__dirname, name + '.utf8.log');
  const bytes = fs.readFileSync(src);
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8';
  const text = bytes.toString(encoding).replace(/^\uFEFF/, '');
  if (fs.existsSync(target)) assert.equal(fs.readFileSync(target, 'utf8'), text, 'Never overwrite different prior evidence');
  else fs.writeFileSync(target, text, 'utf8');
  console.log(name + ': ' + encoding + ' -> UTF-8 evidence copy');
}
