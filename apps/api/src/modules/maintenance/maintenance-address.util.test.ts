import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripAddrUnit } from './maintenance-address.util';

test('值里带了单位字就剥掉，纸上不会印成「永德路 路」', () => {
  assert.equal(stripAddrUnit('永德路', '路'), '永德');
  assert.equal(stripAddrUnit('228弄', '弄'), '228');
  assert.equal(stripAddrUnit('1101室', '室'), '1101');
  assert.equal(stripAddrUnit('枫桦景苑一村', '村'), '枫桦景苑一');
});

test('本来就没带单位字的原样保留', () => {
  assert.equal(stripAddrUnit('永德', '路'), '永德');
  assert.equal(stripAddrUnit('1101', '室'), '1101');
});

test('空值给 null，孤零零一个单位字不剥（剥完就没了）', () => {
  assert.equal(stripAddrUnit('', '路'), null);
  assert.equal(stripAddrUnit('   ', '路'), null);
  assert.equal(stripAddrUnit(null, '路'), null);
  assert.equal(stripAddrUnit(undefined, '路'), null);
  assert.equal(stripAddrUnit('村', '村'), '村');
});

test('只剥结尾那一个：中间的同名字不动', () => {
  assert.equal(stripAddrUnit('路南村', '村'), '路南');
  assert.equal(stripAddrUnit('大路口', '路'), '大路口');
});
