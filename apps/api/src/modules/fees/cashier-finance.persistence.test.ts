import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { entities, FeeBill, FeeStandard, House, Community, User } from '../../entities';
import { FeesService } from './fees.service';
import { CashierReceiptLinks1792300000000 } from '../../migrations/1792300000000-CashierReceiptLinks';
import { UserRole } from '../../common/enums';
import { todayInTz } from './report.util';

/** 在内存PostgreSQL执行真实TypeORM查询/保存及迁移；不连接任何业务数据库。 */
async function fixture() {
  const pg = new PGlite();
  const ds = new DataSource({type:'postgres',entities,synchronize:false});
  await (ds as any).buildMetadatas();
  const runner = (connection:any, active=false):any => {
    const qr:any={connection:ds,isReleased:false,isTransactionActive:active,data:{},
      connect:async()=>{},release:async()=>{},
      query:async(sql:string,params:any[]=[],structured=false)=>{
        const out=await connection.query(sql,params);
        if(!structured)return out.rows;
        const result=new QueryResult();result.records=out.rows;result.raw=out.rows;result.affected=out.affectedRows;return result;
      },
    };
    qr.broadcaster=new Broadcaster(qr);
    qr.manager=ds.createEntityManager(qr);
    return qr;
  };
  (ds as any).isInitialized=true;
  ds.createQueryRunner=()=>runner(pg);
  ds.transaction=((callback:any)=>pg.transaction((tx:any)=>callback(runner(tx,true).manager))) as any;
  const table=ds.getMetadata(FeeBill);
  const columns=table.columns.filter(c=>!['original_receipt_no','reversal_receipt_no'].includes(c.databaseName)).map(c=>{
    const type=c.type===Number?'integer':c.type===String?'varchar':c.type;
    return `"${c.databaseName}" ${c.isPrimary?'serial PRIMARY KEY':type}${c.isNullable||c.isPrimary?'':' NOT NULL'}${c.databaseName==='created_at'||c.databaseName==='updated_at'?' DEFAULT now()':''}`;
  });
  await pg.exec(`CREATE TABLE fee_bills(${columns.join(',')});
    CREATE TABLE communities(id int,tenant_id int,name text);INSERT INTO communities VALUES(1,1,'测试公寓');
    CREATE TABLE buildings(id int,tenant_id int,community_id int,lane text,building_no text);INSERT INTO buildings VALUES(1,1,1,NULL,'A');
    CREATE TABLE houses(id int,tenant_id int,building_id int,room_no text,full_address text);INSERT INTO houses VALUES(1,1,1,'101','测试房');
    CREATE TABLE users(id int,tenant_id int,name text,phone text,house_id int,role text);`);
  const service=new FeesService(ds.getRepository(FeeBill),ds.getRepository(FeeStandard),ds.getRepository(House),ds.getRepository(Community),ds.getRepository(User),ds,{} as any);
  const user={id:1,tenantId:1,role:UserRole.STAFF};
  const insert=async(receiptNo:string,amount:number,paidAt:string,status='paid',remark:string|null=null,method='wechat')=>{
    await pg.query(`INSERT INTO fee_bills(tenant_id,community_id,house_id,owner_id,owner_name,fee_code,fee_name,period,amount_cents,status,paid_at,payment_method,receipt_no,source,remark,created_by,updated_by)
      VALUES(1,1,1,NULL,'测试住户','rent','房租','202610',$1,$2,$3,$4,$5,'manual',$6,1,1)`,[amount,status,paidAt,method,receiptNo,remark]);
  };
  return {pg,ds,service,user,insert};
}

test('真实SQL：迁移回填唯一红冲关联，金额日期不变且不把独立退费当红冲',async()=>{
  const {pg,insert}=await fixture();
  try{
    await insert('OLD',10000,'2026-10-14T10:00:00+08:00','refunded','【已被红冲】');
    await insert('REV',-10000,'2026-10-15T10:00:00+08:00','refunded','红冲 OLD；测试');
    await insert('REFUND',-2000,'2026-10-15T10:00:00+08:00');
    await new CashierReceiptLinks1792300000000().up({query:(sql:string)=>pg.query(sql)} as any);
    const rows=(await pg.query<any>('SELECT receipt_no,original_receipt_no,reversal_receipt_no,amount_cents FROM fee_bills ORDER BY id')).rows;
    assert.equal(rows[0].reversal_receipt_no,'REV');assert.equal(rows[1].original_receipt_no,'OLD');assert.equal(rows[2].original_receipt_no,null);
    assert.deepEqual(rows.map(r=>r.amount_cents),[10000,-10000,-2000]);
  }finally{await pg.close();}
});

test('真实服务/SQL：跨日红冲、独立退费、动态方式、报表对账今日一致，刷新双向查看且拒绝重复红冲',async()=>{
  const {pg,ds,service,user,insert}=await fixture();
  try{
    await new CashierReceiptLinks1792300000000().up({query:(sql:string)=>pg.query(sql)} as any);
    const today=todayInTz(new Date());
    await insert('ORIGINAL',10000,'2026-10-01T10:00:00+08:00');
    await insert('NEW',8000,`${today}T01:00:00+08:00`,'paid',null,'新渠道');
    await insert('REFUND',-2000,`${today}T02:00:00+08:00`,'paid',null,'新渠道');
    (service as any).nextCashierVoucherNo=async()=>'REVERSAL';(service as any).operatorName=async()=>'测试收费员';
    await service.refundReceipt('ORIGINAL',{},user);
    await assert.rejects(service.refundReceipt('ORIGINAL',{},user),/已经红冲/);
    await assert.rejects(service.refundReceipt('REFUND',{},user),/只有纯收费/);
    const old=await service.cashierReceipt('ORIGINAL',user);
    const reversal=await service.cashierReceipt('REVERSAL',user);
    assert.equal(old.reversalReceiptNo,'REVERSAL');assert.equal(reversal.originalReceiptNo,'ORIGINAL');
    assert.equal(new Date(old.paidAt!).toISOString(),'2026-10-01T02:00:00.000Z');assert.equal(old.amountCents,10000);
    const past=await service.feeReport({from:'2026-10-01',to:'2026-10-01'},user);
    assert.equal(past.totals.netCents,10000);
    assert.equal((await service.billSummary({paidFrom:'2026-10-01',paidTo:'2026-10-01'},user)).paidCents,10000);
    const query={from:today,to:today};
    const report=await service.feeReport(query,user);
    const recon=await service.feeReconciliation(query,user);
    const daily=await service.cashierToday({},user);
    assert.equal((await service.billSummary({paidFrom:today,paidTo:today},user)).paidCents,-4000);
    assert.equal(report.totals.netCents,-4000);assert.equal(recon.totals.amountCents,-4000);assert.equal(daily.totalCents,-4000);
    assert.ok(recon.methods.includes('新渠道'));assert.equal(recon.totals.byMethod['新渠道'].amountCents,6000);
    assert.equal((await service.cashierHistory(1,1,user)).total,4);
    assert.equal((await ds.getRepository(FeeBill).count()),4);
    const originalBill=await ds.getRepository(FeeBill).findOneByOrFail({receiptNo:'ORIGINAL'});
    await assert.rejects(service.deleteBill(originalBill.id,user),/必须保留/);
    await assert.rejects(service.updateBill(originalBill.id,{amountCents:1},user),/必须保留/);
    await assert.rejects(service.cancelBills({ids:[originalBill.id]},user),/必须保留/);
    await assert.rejects(service.payBills({ids:[originalBill.id],paymentMethod:'cash'},user),/必须保留/);
    assert.ok((await service.cashierPaymentMethods(user)).includes('新渠道'));
    assert.equal((await service.feeReport({...query,paymentMethod:'新渠道'},user)).totals.netCents,6000);
    await assert.rejects(service.cashierReceipt('ORIGINAL', {...user,tenantId:2}),/不存在/);
    await assert.rejects(service.cashierReceipt('ORIGINAL', user, {scopeAll:false,communityIds:[2]} as any),/权限|无权|范围/);

  }finally{await pg.close();}
});

test('真实收费保存：独立退费无需旧账单；同日收费红冲抵消且拒绝重复请求',async()=>{
 const {pg,ds,service,user}=await fixture();
 try{
  await new CashierReceiptLinks1792300000000().up({query:(sql:string)=>pg.query(sql)} as any);
  // 住户同步及模板已有专属回归；本例隔离它们，收费明细走实际事务和TypeORM保存。
  (service as any).saveCashierContact=async()=>null;
  (service as any).feeTemplates={resolve:async()=>null};
  let seq=0;(service as any).nextCashierVoucherNo=async()=>`TEST${++seq}`;
  (service as any).operatorName=async()=>'测试收费员';
  const refund=await service.createCashierCharge({houseId:1,paymentMethod:'新渠道',items:[{feeCode:'rent',amountCents:-2000}]},user);
  assert.equal(refund.amountCents,-2000);
  assert.equal((await service.cashierReceipt(refund.receiptNo,user)).originalReceiptNo,null);
  const charge=await service.createCashierCharge({houseId:1,paymentMethod:'新渠道',items:[{feeCode:'rent',amountCents:10000}]},user);
  await service.refundReceipt(charge.receiptNo,{},user);
  await assert.rejects(service.refundReceipt(charge.receiptNo,{},user),/已经红冲/);
  assert.equal(await ds.getRepository(FeeBill).count(),3);
  const today=todayInTz(new Date());
  assert.equal((await service.feeReport({from:today,to:today},user)).totals.netCents,-2000);
  assert.equal((await service.cashierToday({},user)).totalCents,-2000);
 }finally{await pg.close();}
});
