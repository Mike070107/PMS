import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractContentGist,
  extractSpot,
  findSpotWord,
  stripAddress,
} from './repair-suggestions.util';

const PLACES = ['枫桦景苑一期', '枫桦景苑二期'];

test('具体位置：整条地址只留位置本身', () => {
  assert.equal(extractSpot('枫桦景苑二期/228弄2号 大门', PLACES), '大门');
  assert.equal(extractSpot('枫桦景苑二期/228弄2号大门', PLACES), '大门');
  assert.equal(extractSpot('枫桦景苑一期 198弄47号 公共区域', PLACES), '');
  assert.equal(extractSpot('大门', PLACES), '大门');
  assert.equal(extractSpot('4楼电梯口', PLACES), '4楼电梯口');
  assert.equal(extractSpot('5号楼2单元 地下车库', []), '地下车库');
});

test('具体位置：没传小区名也能靠「苑/小区」这类字样剥掉', () => {
  assert.equal(stripAddress('阳光小区3期 12号楼 楼道', []), '楼道');
  assert.equal(stripAddress('枫桦景苑一期 198弄47号', []), '');
});

test('场所词：语音原话里认出场所，楼层跟着走', () => {
  assert.equal(findSpotWord('那个4楼电梯口的灯不亮'), '4楼电梯口');
  assert.equal(findSpotWord('地下车库积水了'), '地下车库');
  assert.equal(findSpotWord('水管漏水'), '');
});

test('报修内容：门牌、语气词、人名、电话都不进标签', () => {
  assert.equal(extractContentGist('对，一期47号大门关不上', PLACES), '大门关不上');
  assert.equal(
    extractContentGist(
      '按住说话，嗯，说没有吗？那个一期的47号大门关不上，一期47号大门关不上，苏庆军报修。电话，13800138000',
      PLACES,
    ),
    '大门关不上',
  );
  assert.equal(extractContentGist('楼道门锁不上', PLACES), '楼道门锁不上');
  assert.equal(extractContentGist('彭经理，报一期12号大门的密码，需要换一下', PLACES), '大门的密码需要换一下');
  assert.equal(extractContentGist('枫桦景苑一期 198弄47号 水管漏水了', PLACES), '水管漏水了');
});

test('报修内容：剥过头就给空，不把噪音当短语', () => {
  assert.equal(extractContentGist('嗯，那个，啊', PLACES), '');
  assert.equal(extractContentGist('', PLACES), '');
});
