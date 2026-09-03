import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchReceiptMaterials,
  normalizeReceiptName,
  parseReceiptMentions,
  type ReceiptCatalogItem,
} from './material-receipt.ai';

const CATALOG: ReceiptCatalogItem[] = [
  { id: 1, code: 'SG001', name: 'PPR弯头', spec: '25', unit: '个' },
  { id: 2, code: 'SG002', name: 'PPR弯头', spec: '20', unit: '个' },
  { id: 3, code: 'SG003', name: '生料带', spec: '', unit: '卷' },
  { id: 4, code: 'DQ001', name: '断路器', spec: 'C16', unit: '个' },
  { id: 5, code: 'DQ002', name: '断路器', spec: 'C32', unit: '个' },
];

test('模型返回的脏数据一律洗干净：非法数量/单价当没说，条数收口', () => {
  const rows = parseReceiptMentions([
    { name: ' PPR弯头 ', spec: ' 25 ', qty: '10', unit: '个', unitPriceYuan: 3.5 },
    { name: '生料带', qty: 0, unit: '卷', unitPriceYuan: -2 },
    { name: '', qty: 5 },
    { nope: 1 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'PPR弯头', spec: '25', qty: 10, unit: '个', unitPriceYuan: 3.5 });
  // 数量 0、单价负数都属于「没说」，绝不能当成 0 填进单价栏
  assert.deepEqual(rows[1], { name: '生料带', spec: '', qty: null, unit: '卷', unitPriceYuan: null });
});

test('名称+规格都对上才算精确命中，可以预选 SKU', () => {
  const [row] = matchReceiptMaterials(
    [{ name: 'PPR 弯头', spec: '25', qty: 10, unit: '个', unitPriceYuan: 3.5 }],
    CATALOG,
  );
  assert.equal(row.match, 'exact');
  assert.equal(row.materialId, 1);
  assert.equal(row.unitPriceCents, 350);
  assert.equal(row.needsCreate, false);
});

test('同名多条规格、口述又没说规格时不许替人选，降级成候选', () => {
  const [row] = matchReceiptMaterials(
    [{ name: '断路器', spec: '', qty: 2, unit: '个', unitPriceYuan: null }],
    CATALOG,
  );
  // 断路器 C16 / C32 是两种货，替人挑一个就是 2026-08-31 那笔对不上的账
  assert.equal(row.match, 'candidate');
  assert.equal(row.materialId, null);
  assert.deepEqual(row.candidates.map((item) => item.code), ['DQ001', 'DQ002']);
});

test('库里只有一条同名 SKU、口述没说规格时算精确命中', () => {
  const [row] = matchReceiptMaterials(
    [{ name: '生料带', spec: '', qty: 2, unit: '卷', unitPriceYuan: 2 }],
    CATALOG,
  );
  assert.equal(row.match, 'exact');
  assert.equal(row.materialId, 3);
  assert.equal(row.unitPriceCents, 200);
});

test('说了规格但库里那条规格对不上：不算命中，走建档', () => {
  const [row] = matchReceiptMaterials(
    [{ name: 'PPR弯头', spec: '32', qty: 1, unit: '个', unitPriceYuan: null }],
    CATALOG,
  );
  assert.equal(row.match, 'none');
  assert.equal(row.needsCreate, true);
  assert.deepEqual(row.candidates, []);
});

test('库里压根没有这样材料：标记要建档，名称规格原样带出来给人填', () => {
  const [row] = matchReceiptMaterials(
    [{ name: '不锈钢法兰', spec: 'DN50', qty: 3, unit: '片', unitPriceYuan: 18 }],
    CATALOG,
  );
  assert.equal(row.match, 'none');
  assert.equal(row.needsCreate, true);
  assert.equal(row.spokenName, '不锈钢法兰');
  assert.equal(row.spokenSpec, 'DN50');
  assert.equal(row.unitPriceCents, 1800);
});

test('口述的乘号要能对上库里的 *：50乘50 = 50*50，否则会建出重复 SKU', () => {
  const catalog: ReceiptCatalogItem[] = [{ id: 9, code: 'SL0001', name: '铁井盖', spec: '50*50', unit: '套' }];
  for (const spoken of ['50乘50', '50 x 50', '50×50']) {
    const [row] = matchReceiptMaterials(
      [{ name: '铁井盖', spec: spoken, qty: 2, unit: '套', unitPriceYuan: 320 }],
      catalog,
    );
    assert.equal(row.match, 'exact', `「${spoken}」应命中 50*50`);
    assert.equal(row.materialId, 9);
  }
  // 但不能把 box / max 这类词里的 x 也吃掉
  assert.equal(normalizeReceiptName('maxbox'), 'maxbox');
});

test('比对前抹掉标点空格和「型号/规格」这类垫字', () => {
  assert.equal(normalizeReceiptName('PPR 弯头（25）'), 'ppr弯头25');
  assert.equal(normalizeReceiptName('规格 DN-50'), 'dn50');
});
