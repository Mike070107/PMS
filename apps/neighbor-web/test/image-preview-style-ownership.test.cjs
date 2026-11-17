const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = path.resolve(__dirname, '../src');
const read = name => fs.readFileSync(path.join(src, name), 'utf8');

test('shared image/video preview styles have one owner, not a cashier copy', () => {
  const cashier = read('components/cashier/plate-review.css');
  assert.doesNotMatch(cashier, /\.np-(?:image-preview|preview-)/, 'cashier must not redefine shared preview selectors');
  assert.match(cashier, /\.np-review \.np-review-steps/);
  assert.match(cashier, /prefers-reduced-motion/);
  const shared = read('components/image-preview.css');
  for (const selector of ['.np-image-preview', '.np-preview-shell', '.np-preview-header', '.np-preview-stage', '.np-preview-footer']) assert.ok(shared.includes(selector));
  assert.match(shared, /focus-visible/);
  assert.match(shared, /prefers-reduced-motion/);
  assert.match(shared, /max-width: 600px/);
  for (const component of ['ImagePreview.tsx', 'WorkOrderMedia.tsx']) assert.match(read(`components/${component}`), /import ['"]\.\/image-preview\.css['"]/);
  assert.match(read('components/cashier/NewPlateCard.tsx'), /import ImagePreview from ['"]@\/components\/ImagePreview['"]/);
});
