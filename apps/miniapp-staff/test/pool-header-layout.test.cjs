const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../miniprogram/pages/pool');
const read = ext => fs.readFileSync(path.join(root, 'pool.' + ext), 'utf8');
test('排序放标题同行右上，不再额外占一行，保留原生选择和加载锁', () => {
  const xml = read('wxml');
  const top = xml.slice(xml.indexOf('<view class="work-hero__top">'), xml.indexOf('<!-- 三个数字可点'));
  assert.match(top, /class="work-hero__right"[\s\S]*<picker[\s\S]*bindchange="onPickSort"[\s\S]*disabled="\{\{loading\}\}"/);
  assert.doesNotMatch(xml, /order-sort-row|work-hero__count|head-help|work-hero__hint/);
  assert.equal((xml.match(/bindchange="onPickSort"/g) || []).length, 1);
  assert.match(top, /wx:if="\{\{mainTab === 'pool'\}\}"/);
});
test('删除计数胶囊和问号的页面专属数据、处理器及提示，不影响待办与统计筛选', () => {
  const source = read('ts'), xml = read('wxml'), css = read('wxss');
  assert.doesNotMatch(source + xml, /leadText|guideHandlers|syncGuide|onToggleGuide|\{\{guide\}\}|guide: false/);
  assert.doesNotMatch(css, /order-sort-row|assign-speech__desc/);
  assert.match(source, /if \(isDefaultView\) setTabBadge/);
  assert.equal((xml.match(/bindtap="onTapMetric"/g) || []).length, 3);
});
test('统计卡片采用紧凑布局但保留至少44px触达，排序也不缩小触控区域', () => {
  const css = read('wxss');
  assert.match(css, /\.work-metric\s*\{[^}]*min-height:\s*88rpx[^}]*padding:\s*8rpx/);
  assert.match(css, /\.order-sort-control\s*\{[^}]*min-height:\s*88rpx/);
  assert.match(css, /\.work-metrics\s*\{[^}]*margin-top:\s*12rpx/);
  assert.match(css, /@media screen and \(max-width:\s*374px\)[\s\S]*\.order-sort-control,\s*\.work-metric\s*\{\s*min-height:\s*44px/);
  assert.doesNotMatch(css, /waiting-group/);
});
