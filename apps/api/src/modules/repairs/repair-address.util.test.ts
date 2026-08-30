import assert from 'node:assert/strict';
import test from 'node:test';
import {
  correctCommunityNameInText,
  extractAddressCandidate,
  matchCommunityByName,
  phaseToCn,
  sameNo,
} from './repair-address.util';

/**
 * 地址解析是报修语音识别和后台录房产共用的那一层，之前一直没有测试。
 * 这里锁住的是「什么该认、什么坚决不认」——认错地址会让维修工白跑一趟。
 */

test('抽出期/弄/号/室：老式门牌「198弄3号301室」', () => {
  const c = extractAddressCandidate('剑川路198弄3号301室灯不亮');
  assert.equal(c?.roadName, '剑川路');
  assert.equal(c?.lane, '198');
  assert.equal(c?.buildingNo, '3');
  assert.equal(c?.roomNo, '301');
  assert.equal(c?.matchedText, '198弄3号301室');
});

test('路名后面直接跟号也认得出来', () => {
  const c = extractAddressCandidate('龙吴路5530弄12号101');
  assert.equal(c?.roadName, '龙吴路');
  assert.equal(c?.lane, '5530');
  assert.equal(c?.buildingNo, '12');
  assert.equal(c?.roomNo, '101');
});

test('小区名候选：数字前面那段中文切出来当候选', () => {
  assert.equal(extractAddressCandidate('枫桦一期17号201家里灯不亮')?.namePrefix, '枫桦');
  assert.equal(extractAddressCandidate('吴泾新村3号102漏水')?.namePrefix, '吴泾新村');
  // 前面的废话要剥掉，别把「我家在」当成小区名
  assert.equal(extractAddressCandidate('我家在锦川公寓5号302')?.namePrefix, '锦川公寓');
});

test('小区名候选：路名已单独抽走，不重复算进名字里', () => {
  const c = extractAddressCandidate('剑川路198弄3号301室');
  assert.equal(c?.roadName, '剑川路');
  assert.equal(c?.namePrefix, null);
});

test('小区名候选：太短或没有前缀时给 null，不硬凑', () => {
  assert.equal(extractAddressCandidate('17号201灯不亮')?.namePrefix, null);
});

/** 既有限制，记在这里免得以后当成新 bug：门牌号只认阿拉伯数字 */
test('中文数字门牌「三号楼」整条不认（既有行为）', () => {
  assert.equal(extractAddressCandidate('三号楼201室'), null);
});

test('撞库：说对了小区名能对上，同音字一律撞不上', () => {
  const communities = [
    { id: 1, name: '枫桦景苑一期' },
    { id: 2, name: '枫桦景苑二期' },
    { id: 13, name: '吴泾新村' },
  ];
  // 说「枫桦」→ 两个分期都命中，由调用方再用「一期」收敛
  assert.deepEqual(matchCommunityByName('枫桦', communities).map((c) => c.id), [1, 2]);
  assert.deepEqual(matchCommunityByName('吴泾新村', communities).map((c) => c.id), [13]);
  // 语音把「枫桦」听成「风华」：撞不上就是撞不上，绝不猜
  assert.deepEqual(matchCommunityByName('风华', communities), []);
  // 一个字判不出来，不认
  assert.deepEqual(matchCommunityByName('枫', communities), []);
});

test('原有行为不变：车位号不当门牌、裸数字不当室号', () => {
  assert.equal(extractAddressCandidate('车位24号被占了'), null);
  const c = extractAddressCandidate('24号3楼灯坏了');
  assert.equal(c?.buildingNo, '24');
  assert.equal(c?.roomNo, null);
});

test('phaseToCn / sameNo 原样', () => {
  assert.equal(phaseToCn('1'), '一');
  assert.equal(phaseToCn('12'), '十二');
  assert.equal(sameNo('024', '24'), true);
  assert.equal(sameNo('', '24'), false);
});

test('同音纠错：靠数字定位到的小区，把听错的名字换回正名', () => {
  const c = extractAddressCandidate('风华一期17号201家里灯不亮')!;
  // 「风华」撞不上库，地址靠「一期」定位 → 连分期一起换成库名
  assert.equal(
    correctCommunityNameInText('风华一期17号201家里灯不亮', c, '枫桦景苑一期', true),
    '枫桦景苑一期17号201家里灯不亮',
  );
});

test('同音纠错：说对了就不动人家的话', () => {
  const c = extractAddressCandidate('枫桦一期17号201')!;
  assert.equal(correctCommunityNameInText('枫桦一期17号201', c, '枫桦景苑一期', true), null);
});

test('同音纠错：只靠门牌号撞出来的小区不算数，不改', () => {
  const c = extractAddressCandidate('风华7号201漏水')!;
  assert.equal(correctCommunityNameInText('风华7号201漏水', c, '吴泾新村', false), null);
});

test('同音纠错：没说小区名时什么都不做', () => {
  const c = extractAddressCandidate('17号201灯不亮')!;
  assert.equal(correctCommunityNameInText('17号201灯不亮', c, '枫桦景苑一期', true), null);
});

test('同音纠错：库名不带分期时，分期要留着', () => {
  const c = extractAddressCandidate('五金新村二期3号101')!;
  assert.equal(
    correctCommunityNameInText('五金新村二期3号101', c, '吴泾新村', true),
    '吴泾新村二期3号101',
  );
});
