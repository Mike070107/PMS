import assert from 'node:assert/strict';
import test from 'node:test';
import {
  correctCommunityNameInText,
  extractAddressCandidate,
  matchCommunityByName,
  matchSpotsInText,
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

// ---------------- 公区点位（监控室、门卫室…） ----------------

test('「监控室2号」里的 2 号不是门牌号', () => {
  // 2026-08-31 线上实测：不拦的话「监控室2号显示屏不亮」撞上 228弄2号楼，
  // 维修工按地址去 2 号楼白跑一趟
  assert.equal(extractAddressCandidate('监控室2号显示屏不亮'), null);
  assert.equal(extractAddressCandidate('机房3号柜子坏了'), null);
  // 真门牌不受影响
  assert.equal(extractAddressCandidate('228弄2号楼道灯不亮')?.buildingNo, '2');
  assert.equal(extractAddressCandidate('二期24号302漏水')?.roomNo, '302');
});

test('点位按名字认，最长的那个赢', () => {
  const spots = [
    { id: 1, name: '监控室', communityId: 2, buildingId: null },
    { id: 2, name: '机房', communityId: 2, buildingId: null },
    { id: 3, name: '电梯机房', communityId: 2, buildingId: 82 },
  ];
  assert.deepEqual(
    matchSpotsInText('监控室2号显示屏不亮', spots).map((s) => s.id),
    [1],
  );
  // 「机房」和「电梯机房」都命中时取更精确的那个
  assert.deepEqual(
    matchSpotsInText('电梯机房漏水了', spots).map((s) => s.id),
    [3],
  );
  assert.deepEqual(matchSpotsInText('楼道灯不亮', spots), []);
});

test('同名点位在多个小区：全部返回，交给调用方按所在小区收敛', () => {
  const spots = [
    { id: 1, name: '门卫室', communityId: 1, buildingId: null },
    { id: 2, name: '门卫室', communityId: 2, buildingId: null },
  ];
  assert.deepEqual(
    matchSpotsInText('门卫室的灯不亮', spots).map((s) => s.communityId),
    [1, 2],
  );
});

/**
 * matchedRaw = 地址在原话里占的那一段。
 * 剥故障描述必须用它，用归一化的 matchedText 会把小区名剩在描述里 ——
 * 2026-08-31 实际现象：「枫桦景苑一期17号201家里灯不亮」的描述抽成了
 * 「枫桦景苑家里灯不亮」。
 */
test('matchedRaw：把小区名到室号整段圈进去', () => {
  const c = extractAddressCandidate('枫桦景苑一期17号201家里灯不亮')!;
  assert.equal(c.matchedRaw, '枫桦景苑一期17号201');
  // 归一化的那份不含小区名，正是它剥不干净
  assert.equal(c.matchedText, '一期17号201室');
});

test('matchedRaw：带路名和弄的老式门牌', () => {
  const c = extractAddressCandidate('剑川路198弄3号301室灯不亮')!;
  assert.equal(c.matchedRaw, '剑川路198弄3号301室');
});

test('matchedRaw：没说小区名时就从数字开始', () => {
  const c = extractAddressCandidate('17号201灯不亮')!;
  assert.equal(c.matchedRaw, '17号201');
});

test('matchedRaw：室号带「室」字时把它一起圈进去，别剩个孤字', () => {
  const c = extractAddressCandidate('吴泾新村7号102室漏水')!;
  assert.equal(c.matchedRaw, '吴泾新村7号102室');
});

test('剥描述：用 matchedRaw 剥完只剩故障本身', () => {
  const raw = '枫桦景苑一期17号201家里灯不亮';
  const c = extractAddressCandidate(raw)!;
  const desc = raw.replace(c.matchedRaw, '').trim();
  assert.equal(desc, '家里灯不亮');
});

/**
 * 语音转文字会在门牌各段之间断出逗号：「5511弄，236号，502报修电子门…」。
 * 认不出 502 的后果是三重的（2026-09-01 线上实际发生）：地址落成「公共区域」、
 * 502 留在故障描述里、师傅拿到单不知道去哪一户。
 */
test('门牌各段之间有逗号停顿，房号照样认得出来', () => {
  const c = extractAddressCandidate('5511弄，236号，502报修电子门里面，旋钮打滑，居民出不来');
  assert.equal(c?.lane, '5511');
  assert.equal(c?.buildingNo, '236');
  assert.equal(c?.roomNo, '502');
  // 剥描述要按这一段剥，502 必须被圈进去，否则它会留在描述里
  assert.ok(c!.matchedRaw.includes('502'), c!.matchedRaw);
});

test('空格断句同理', () => {
  assert.equal(extractAddressCandidate('198弄 17号 201 灯不亮')?.roomNo, '201');
});

test('停顿后面跟的不是房号就别认：年份、量词都不算', () => {
  assert.equal(extractAddressCandidate('12号，2024年装的水管漏了')?.roomNo, null);
  assert.equal(extractAddressCandidate('3号，200个灯泡要换')?.roomNo, null);
  // 隔太远的数字也不算：中间还有别的话，说的多半不是这栋楼的房号
  assert.equal(extractAddressCandidate('24号楼下的 302 路公交站牌歪了')?.roomNo, null);
});
