import test from 'node:test';
import assert from 'node:assert/strict';
import { FeesService } from './fees.service';
import { assertReceiptRefundable } from './cashier.util';
import { UserRole } from '../../common/enums';

test('独立退费或混合退费收据不能再按收费原单红冲', () => {
  assert.throws(() => assertReceiptRefundable([{status:'paid', amountCents:-100}] as any), /收费/);
  assert.throws(() => assertReceiptRefundable([{status:'paid', amountCents:200},{status:'paid',amountCents:-100}] as any), /收费/);
});

test('对账保留动态收款方式并只按发生日扣一次，原收费历史不变', async () => {
  const service = Object.create(FeesService.prototype) as any;
  const rows = [
    {day:'2026-10-14',method:'wechat',amountCents:'10000',chargedCents:'10000',refundedCents:'0',count:'1'},
    {day:'2026-10-15',method:'wechat',amountCents:'-10000',chargedCents:'0',refundedCents:'10000',count:'1'},
    {day:'2026-10-15',method:'新收款渠道',amountCents:'-2000',chargedCents:'0',refundedCents:'2000',count:'1'},
  ];
  const qb:any = {getRawMany:async()=>rows};
  for(const method of ['select','addSelect','groupBy','addGroupBy','orderBy']) qb[method]=()=>qb;
  service.paidBillsQuery=()=>qb;
  const result=await service.feeReconciliation({from:'2026-10-14',to:'2026-10-15'},{id:1,tenantId:1,role:UserRole.STAFF});
  assert.ok(result.methods.includes('新收款渠道'));
  assert.equal(result.rows[0].amountCents,10000);
  assert.equal(result.rows[1].amountCents,-12000);
  assert.equal(result.totals.amountCents,-2000);
});
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCashierChargeDto, FeeReportQueryDto } from './dto';

test('动态收款方式允许登记与筛选，同时拒绝空白和超长方式',()=>{
 const input={houseId:1,paymentMethod:'新渠道',items:[{feeCode:'rent',amountCents:-1000}]};
 assert.equal(validateSync(plainToInstance(CreateCashierChargeDto,input)).length,0);
 assert.equal(validateSync(plainToInstance(FeeReportQueryDto,{from:'2026-10-01',to:'2026-10-16',paymentMethod:'新渠道'})).length,0);
 for(const paymentMethod of ['','   ','x'.repeat(31)])assert.ok(validateSync(plainToInstance(CreateCashierChargeDto,{...input,paymentMethod})).length);
});
