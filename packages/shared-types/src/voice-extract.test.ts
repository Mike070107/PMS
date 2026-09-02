import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contactFillHint,
  extractContact,
  extractFaultDescription,
  mergeExtractedContact,
} from './voice-extract';

/**
 * 语音抽取一直没有测试，而它决定了工单上的「联系人 / 电话 / 故障描述」——
 * 抽错电话 = 维修工打空号跑一趟。这里锁住的都是实测踩过的。
 */

test('电话：正常 11 位手机号', () => {
  assert.equal(extractContact('一期17号201灯不亮，张先生13800138000').phone, '13800138000');
});

test('电话：语音多听出一位时，宁可不填也不给错号码', () => {
  // 「138000138000」是 12 位。没有边界的正则会截出「13800013800」——
  // 位数刚好、能通过校验，但根本不是那个人的号
  const r = extractContact('一期17号201灯不亮，张先生138000138000');
  assert.equal(r.phone, undefined);
});

test('电话：说的时候断开成几段也认得出来', () => {
  assert.equal(extractContact('电话 138 0013 8000').phone, '13800138000');
});

test('电话：中文数字报号', () => {
  assert.equal(extractContact('电话幺三八零零幺三八零零零').phone, '13800138000');
});

test('联系人：称谓式', () => {
  const r = extractContact('一期17号201灯不亮，找张师傅，13800138000');
  assert.equal(r.name, '张师傅');
});

test('联系人：动词不能粘进姓里', () => {
  // 实测抽出过「找张师傅」「人李女士」
  assert.equal(extractContact('联系人李女士 13800138000').name, '李女士');
});

test('故障描述：把地址、人名、电话都剥掉，只剩故障本身', () => {
  const text = '枫桦景苑一期17号201家里灯不亮，联系人张先生，电话13800138000';
  const desc = extractFaultDescription(text, {
    addressText: '一期17号201室',
    nameText: '张先生',
    phoneText: '13800138000',
  });
  assert.ok(desc.includes('灯不亮'), `实际：${desc}`);
  assert.ok(!desc.includes('13800138000'), `电话没剥掉：${desc}`);
  assert.ok(!desc.includes('张先生'), `人名没剥掉：${desc}`);
});

test('故障描述：地址没认出来时也不该把整句原样塞进描述', () => {
  // 地址识别失败（比如接口 403）时 addressText 为空 —— 这是 2026-08-31 的现象之一
  const desc = extractFaultDescription('一期17号201家里灯不亮', {});
  assert.equal(typeof desc, 'string');
});

test('故障描述：电话多听一位时整串剥掉，不留孤零零的尾数', () => {
  /* 「138000138000」是 12 位：extractContact 按边界规则正确地拒填（宁可不填也不给错号），
     于是 phoneText 是空的、剥描述时拿不到它。描述里这串数字同样不该留 ——
     旧的清理正则卡死 11 位，只吃掉前 11 位，描述就成了「家里灯不亮，0」（2026-08-31 实测）。 */
  const heard = '风华一期17号201，家里灯不亮。联系人，张先生。电话，138000138000';
  const desc = extractFaultDescription(heard, {
    addressText: '风华一期17号201',
    nameText: '张先生',
  });
  assert.equal(desc.trim(), '家里灯不亮');
});

test('故障描述：房号里的短数字不能被当成电话剥掉', () => {
  // 上一条把清理正则放宽成「≥10 位连续数字」，这条守住下限：
  // 「17号201」被单位字隔开，两段都远不到 10 位，必须原样留着给地址识别用
  const desc = extractFaultDescription('17号201的灯不亮', {});
  assert.ok(desc.includes('201'), `房号被误剥了：${desc}`);
});

// ---------------- 认出来的人/电话怎么合进表单 ----------------

/** 员工端「我要报修」的起手式：联系人/电话都是登录人的默认值 */
const defaults = {
  name: '张保安',
  phone: '13900000001',
  nameIsDefault: true,
  phoneIsDefault: true,
  nameTouched: false,
  phoneTouched: false,
};

test('电话换成了描述里那个号、又没说是谁 → 默认联系人必须一起清空', () => {
  // 2026-08-31 实际问题：工单上留下「张保安 + 业主的号」这种拼出来的假联系人
  const r = mergeExtractedContact(extractContact('一期17号201漏水，电话13800138000'), defaults);
  assert.equal(r.phone, '13800138000');
  assert.equal(r.name, '');
  assert.equal(r.clearedName, true);
  assert.match(contactFillHint(r), /联系人已清空/);
});

test('描述里说了是谁，就换成那个人，不清空', () => {
  const r = mergeExtractedContact(
    extractContact('一期17号201漏水，找李师傅，13800138000'),
    defaults,
  );
  assert.equal(r.name, '李师傅');
  assert.equal(r.phone, '13800138000');
  assert.equal(r.clearedName, false);
});

test('只认出姓名、没说电话 → 登录人的默认电话必须一起清空', () => {
  const r = mergeExtractedContact(extractContact('一期17号201漏水，找李师傅'), defaults);
  assert.equal(r.name, '李师傅');
  assert.equal(r.phone, '');
  assert.equal(r.clearedPhone, true);
  assert.match(contactFillHint(r), /默认电话已清空/);
});

test('只认出电话、但联系人是用户自己手填的 → 一个字都不许动', () => {
  const r = mergeExtractedContact(extractContact('一期17号201漏水，电话13800138000'), {
    ...defaults,
    name: '王阿姨',
    nameIsDefault: false,
    nameTouched: true,
  });
  assert.equal(r.name, undefined);
  assert.equal(r.clearedName, false);
});

test('说的就是登录人自己的号 → 联系人不动', () => {
  const r = mergeExtractedContact(extractContact('一期17号201漏水，电话13900000001'), defaults);
  assert.equal(r.phone, undefined);
  assert.equal(r.name, undefined);
  assert.equal(r.clearedName, false);
});

test('清空只做一次：再敲一个字不会把人刚补填的联系人又抹掉', () => {
  const first = mergeExtractedContact(
    extractContact('一期17号201漏水，电话13800138000'),
    defaults,
  );
  const second = mergeExtractedContact(extractContact('一期17号201漏水了，电话13800138000'), {
    name: '业主本人',
    phone: '13800138000',
    nameIsDefault: first.nameIsDefault,
    phoneIsDefault: first.phoneIsDefault,
    nameTouched: false,
    phoneTouched: false,
  });
  assert.equal(second.name, undefined);
  assert.equal(second.clearedName, false);
});

/**
 * 2026-09-01 线上实际说的那一句。四个字段各归各的，描述里不留门牌、不留催促语。
 * 房号「502」跟在「236号，」后面（语音断句断出来的逗号），地址那一段必须把它一起带走。
 */
test('一句话报修：门牌带停顿、末尾催促，描述只剩故障本身', () => {
  const raw = '5511弄，236号，502报修电子门里面，旋钮打滑，居民出不来。急急急，13818909545';
  const contact = extractContact(raw);
  assert.equal(contact.phone, '13818909545');
  const desc = extractFaultDescription(raw, {
    // 服务端撞库后给回的 matchedRaw 就是这一段（见 repair-address.util 的 sliceMatchedRaw）
    addressText: '5511弄，236号，502',
    phoneText: contact.phoneText,
    nameText: contact.nameText,
  });
  assert.ok(!desc.includes('502'), desc);
  assert.ok(!desc.includes('5511'), desc);
  assert.ok(!desc.includes('急急急'), desc);
  assert.ok(!desc.includes('13818909545'), desc);
  assert.ok(desc.includes('旋钮打滑'), desc);
  assert.ok(desc.includes('电子门'), desc);
});

test('「急修」是要办的事，不能跟着催促语一起剥掉', () => {
  const desc = extractFaultDescription('水管爆了要急修', {});
  assert.ok(desc.includes('急修'), desc);
});
