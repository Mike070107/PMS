const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'srv-deploy-api.sh'), 'utf8');

test('full API package validates Linux native dependencies before touching the live runtime', () => {
  const preflight = source.indexOf('FULL_PREFLIGHT=$(mktemp -d');
  const replace = source.indexOf('mv api/.env "$KEEP"');
  assert.ok(preflight > source.indexOf('exit 0\nfi'));
  assert.ok(preflight < replace);
  assert.ok(source.indexOf('tar -xzf "$PKG" -C "$FULL_PREFLIGHT"', preflight) < replace);
  assert.ok(source.indexOf('node --check "$FULL_PREFLIGHT/api/dist/main.js"', preflight) < replace);
  for (const check of ["process.platform, 'linux'", "process.arch, 'x64'", 'glibcVersionRuntime', "node_modules/sharp", ".webp().toBuffer()", "'RIFF'", "'WEBP'", 'sharp(webp).metadata()', 'sharp(webp).raw().toBuffer({ resolveWithObject: true })', 'pixels.data.length, 2 * 2 * pixels.info.channels']) {
    assert.ok(source.indexOf(check, preflight) > preflight, check);
    assert.ok(source.indexOf(check, preflight) < replace, check);
  }
});

test('native preflight rejects packaged secrets, aborts on error and constrains cleanup to its own stage', () => {
  assert.match(source, /set -e/);
  assert.match(source, /\[ ! -f "\$FULL_PREFLIGHT\/api\/\.env" \] \|\| \{[^\n]+exit 1;/);
  assert.match(source, /trap cleanup_full_preflight EXIT/);
  assert.match(source, /case "\$FULL_PREFLIGHT" in\s+"\$BK"\/pms-api-preflight\.\*\) rm -rf -- "\$FULL_PREFLIGHT"/);
  assert.match(source, /catch\(error => \{ console\.error\(error\); process\.exitCode = 1;/);
  assert.ok(source.indexOf('cleanup_full_preflight\ntrap - EXIT') < source.indexOf('mv api/.env "$KEEP"'));
});
