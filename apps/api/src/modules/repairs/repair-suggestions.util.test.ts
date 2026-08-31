import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SEED_CONTENT_SUGGESTIONS,
  extractContentGist,
  extractSpot,
  findSpotWord,
  stripAddress,
} from './repair-suggestions.util';
import { mergeSuggestions } from './repair-rule-template';

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

/**
 * 「猜你想输」归纳关键词前要把地址剥干净。
 * 2026-08-31 实测漏了一种：「17号201」里的 201 是**裸数字**室号（没有「室」字），
 * 剥完「17号」之后它成了孤零零的数字，归纳出来是「201家里灯不亮」。
 */
test('地址剥离：号后面紧跟的裸数字室号也要剥掉', () => {
  const places = ['枫桦景苑一期', '吴泾新村'];
  assert.equal(extractContentGist('枫桦景苑一期17号201家里灯不亮', places), '家里灯不亮');
  assert.equal(extractContentGist('吴泾新村7号102漏水，联系人张先生13800138000', places), '漏水');
  // 小区名没在名单里（语音听错成同音字）也照样剥：靠「苑/新村」这类后缀模式兜底
  assert.equal(extractContentGist('风华一期17号201家里灯不亮', places), '家里灯不亮');
});

test('地址剥离：原有行为不变', () => {
  assert.equal(extractContentGist('一期24号大门关不上'), '大门关不上');
  assert.equal(extractContentGist('3号楼电梯坏了'), '电梯坏了');
  // 「监控室2号」的 2 号不是门牌，场所词要留着
  assert.equal(extractContentGist('监控室2号显示屏不亮'), '监控室显示屏不亮');
});

test('内容抽取：电话多听一位时整串剥掉，不留孤零零的尾数', () => {
  /* 和端上 voice-extract 的同名用例配对：卡死 11 位的正则会在 12 位号里
     只吃掉前 11 位，内容就成了「家里灯不亮，0」（2026-08-31 实测）。 */
  const gist = extractContentGist(
    '风华一期17号201，家里灯不亮。联系人，张先生。电话，138000138000',
    ['风华一期'],
  );
  assert.ok(!/\d/.test(gist), `内容里还剩数字：${gist}`);
  assert.ok(gist.includes('灯不亮'), `故障词丢了：${gist}`);
});

test('种子关键词：同一个词不能落在两个报修类型里', () => {
  // 两个类型配同一个词时 classifyByKeywords 会打平，最后按 sortOrder 悄悄挑一个 ——
  // 后台已经硬拦这种配置（assertNoKeywordConflict），种子表自己更不能带头违规
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const [type, words] of Object.entries(SEED_CONTENT_SUGGESTIONS)) {
    for (const word of words) {
      const holder = owner.get(word);
      if (holder) clashes.push(`「${word}」同时在 ${holder} 和 ${type}`);
      else owner.set(word, type);
    }
  }
  assert.deepEqual(clashes, []);
});

test('关键词三层叠加：本处增补在前，屏蔽掉的模板词不出现', () => {
  assert.deepEqual(
    mergeSuggestions(['抬杆机不动'], ['道闸不抬杆', '门禁刷不开'], ['门禁刷不开']),
    ['抬杆机不动', '道闸不抬杆'],
  );
  // 本处把模板里已有的词又加了一遍：只留一个，位置以本处那份为准
  assert.deepEqual(
    mergeSuggestions(['门禁刷不开'], ['道闸不抬杆', '门禁刷不开'], []),
    ['门禁刷不开', '道闸不抬杆'],
  );
  // 管理处自建、模板里没有这个类型时，全靠本处增补
  assert.deepEqual(mergeSuggestions(['外墙渗水'], [], []), ['外墙渗水']);
  assert.deepEqual(mergeSuggestions([], null, undefined), []);
});
