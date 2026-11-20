import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeParkingFeeDetailRows, sanitizeParkingFeeRows } from './access-card-issuance.service';

test('完整 31 天、两期两类的 190 行汇总不被旧 100 行上限截断', () => {
  const rows: any[] = [];
  for (const category of ['renewal', 'temporary']) {
    for (const database of ['parking1', 'parking2']) {
      rows.push({ database, fields: { kind: 'summary', category, count: 31, amountCents: 3100 } });
      for (let day = 1; day <= 31; day += 1) rows.push({ database, fields: {
        kind: 'daily', category, day: `2026-01-${String(day).padStart(2, '0')}`,
        count: 1, amountCents: 100,
      } });
    }
    for (let day = 1; day <= 31; day += 1) rows.push({ database: 'both', fields: {
      kind: 'daily', category, day: `2026-01-${String(day).padStart(2, '0')}`,
      count: 2, amountCents: 200,
    } });
  }
  assert.equal(rows.length, 190);
  assert.equal(sanitizeParkingFeeRows(rows, '2026-01-01', '2026-01-31').length, 190);
  assert.throws(() => sanitizeParkingFeeRows([...rows, ...rows], '2026-01-01', '2026-01-31'), /上限/);
});

test('收费明细必须是所选类别和区间内，单页不能超过 50 条', () => {
  const row = { database: 'parking1', fields: { kind: 'detail', category: 'temporary',
    occurredAt: '2026-01-31 11:07:02', amountCents: 500, plate: '沪A12345', operator: '03' } };
  assert.equal(sanitizeParkingFeeDetailRows([row], 'temporary', '2026-01-01', '2026-01-31').length, 1);
  assert.throws(() => sanitizeParkingFeeDetailRows([row], 'renewal', '2026-01-01', '2026-01-31'), /字段不正确/);
  assert.throws(() => sanitizeParkingFeeDetailRows([row], 'temporary', '2026-02-01', '2026-02-28'), /字段不正确/);
  assert.throws(() => sanitizeParkingFeeDetailRows(Array(51).fill(row), 'temporary', '2026-01-01', '2026-01-31'), /50 条/);
});

test('出场应收要求两期完整汇总、同日出场、已识别车类和正金额', () => {
  const day='2026-11-20';
  const base={category:'exit_due',day};
  const s1={database:'parking1',fields:{...base,kind:'summary',count:2,amountCents:1500}};
  const s2={database:'parking2',fields:{...base,kind:'summary',count:0,amountCents:0}};
  const detail=(vehicleClass:string,amountCents:number)=>({database:'parking1',fields:{...base,kind:'detail',vehicleClass,amountCents,occurredAt:day+' 19:23:50',enteredAt:day+' 18:42:52'}});
  const read=(rows:Parameters<typeof sanitizeParkingFeeDetailRows>[0])=>sanitizeParkingFeeDetailRows(rows,'exit_due',day,day);
  assert.deepEqual(read([s1,s2,detail('临时车',1000),detail('亲情车',500)]).slice(2).map(r=>r.fields.vehicleClass),['临时车','亲情车']);
  assert.throws(()=>read([s1]),/缺少/);
  assert.throws(()=>read([s1,s2,detail('住户车',1000)]),/车类/);
  assert.throws(()=>read([s1,s2,detail('临时车',0)]),/应收/);
});
