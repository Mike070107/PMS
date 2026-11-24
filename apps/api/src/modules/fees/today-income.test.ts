import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { FeesController } from './fees.controller';
import { MisFeesService } from './mis-fees.service';
import { MisMirrorService } from './mis-mirror.service';
import { incomeMisCodes, incomePage } from './today-income';

test('income preserves bill-level amounts across sources, Beijing midnight, tenant and office scope', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE mis_mirror_bill(zj_id int, paid_date date, office_code text, fee_code text, period text, amount_cents int, receipt_paid_at text, receipt_remark text, refund_date date);
      INSERT INTO mis_mirror_bill SELECT n,'2026-11-20','01','14','202611',6750,NULL,'备注',NULL FROM generate_series(1,21)n;
      INSERT INTO mis_mirror_bill VALUES (81,'2026-11-20','01','14','202611',6750,NULL,NULL,'2026-11-20'),
        (82,'2026-11-20','02','14','202611',6750,NULL,NULL,NULL),(83,'2026-11-20','01','02','202611',6750,NULL,NULL,NULL);
      CREATE TABLE business_transactions(id int,tenant_id int,community_id int,service_type text,status text,amount_cents int,start_date date,end_date date,remark text,snapshot jsonb,created_at timestamptz);
      INSERT INTO business_transactions SELECT n,1,10,'parking_monthly','paid',6750,'2026-11-01','2026-11-30','登记',
        '{"estimate":{"vehicleClass":"产权车位"},"parking":{"plate":"沪A12345"}}',t::timestamptz FROM (VALUES
        (1,'2026-11-19 16:00Z'),(2,'2026-11-20 16:00Z'),(3,'2026-11-19 15:59Z')) a(n,t);
      INSERT INTO business_transactions VALUES(4,1,10,'access_card','paid',500,NULL,NULL,NULL,'{}','2026-11-20 01:00Z'),
        (5,2,10,'access_card','paid',300,NULL,NULL,NULL,'{}','2026-11-20 01:00Z'),
        (6,1,20,'access_card','paid',300,NULL,NULL,NULL,'{}','2026-11-20 01:00Z'),
        (7,1,10,'access_card','refunded',500,NULL,NULL,NULL,'{}','2026-11-20 01:00Z');
      CREATE TABLE work_orders(id int,tenant_id int,community_id int,fee_cents int,completed_at timestamptz,status text,action_note text,deleted_at timestamptz,request_id int);
      INSERT INTO work_orders VALUES(1,1,10,1200,'2026-11-20 01:00Z','completed','换灯',NULL,8),(2,1,10,500,'2026-11-20 01:00Z','voided',NULL,NULL,NULL);
      CREATE TABLE repair_requests(id int,tenant_id int,address_text text);
      INSERT INTO repair_requests VALUES(8,1,'某小区南门'),(8,2,'其他公司地址');
      CREATE TABLE houses(id int,tenant_id int,building_id int,room_no text);
      CREATE TABLE buildings(id int,tenant_id int,community_id int,lane text,building_no text);
      CREATE TABLE communities(id int,tenant_id int,name text);
      INSERT INTO houses VALUES(7,1,5,'501'),(7,2,5,'502');
      INSERT INTO buildings VALUES(5,1,10,'198弄','10号');
      INSERT INTO communities VALUES(10,1,'某小区');
      ALTER TABLE houses ADD COLUMN remark text, ADD COLUMN created_at timestamptz;
      UPDATE houses SET remark='房屋档案备注' WHERE id=7;
      ALTER TABLE mis_mirror_bill ADD COLUMN address text, ADD COLUMN room_no text, ADD COLUMN payment_method text;
      UPDATE mis_mirror_bill SET address=' 某小区198弄20号503室 ',room_no='503',payment_method=' 银联聚合收款 ' WHERE zj_id=21;
      UPDATE mis_mirror_bill SET address='  ',room_no=' 502 ',payment_method=' ' WHERE zj_id=20;
      ALTER TABLE business_transactions ADD COLUMN house_id int, ADD COLUMN payment_method text;
      UPDATE business_transactions SET house_id=7,payment_method='wechat' WHERE id=1;`);
    const svc = Object.assign(Object.create(MisMirrorService.prototype), {
      dataSource:{query:async (sql:string, args:unknown[]) => (await db.query(sql,args)).rows},
      assertReady:async()=>true,
    }) as MisMirrorService;
    const user = {tenantId:1} as any, access = {communityIds:[10]} as any, day='2026-11-20';
    const local = (offset:number,limit:number)=>svc.incomeFromPms('garage',day,user,access,undefined,offset,limit);
    const legacy = (offset:number,limit:number)=>svc.incomeFromMis(incomeMisCodes.garage,day,['01'],offset,limit,1);
    const pms = await incomePage(1,local);
    const total = await incomePage(undefined,legacy);
    const first = await incomePage(1,legacy), last = await incomePage(2,legacy);
    assert.equal(total.amountCents,21*6750); assert.equal(total.total,21); assert.equal(total.rows.length,0);
    assert.equal(pms.amountCents,6750); assert.equal(pms.total,1);
    assert.equal(pms.rows[0].plate,'沪A12345'); assert.equal(pms.rows[0].paidAt,'2026-11-20 00:00:00');
    assert.equal(pms.rows[0].address,'某小区/198弄/10号/501'); assert.equal(pms.rows[0].paymentMethod,'wechat');
    assert.equal(pms.rows[0].remark,'登记');
    assert.equal(first.rows[0].address,'某小区198弄20号503室'); assert.equal(first.rows[0].paymentMethod,'银联聚合收款');
    assert.equal(first.rows[1].address,'502'); assert.equal(first.rows[1].paymentMethod,null);
    assert.equal(pms.rows[0].samePlateCount, 1);
    await db.exec(`
      INSERT INTO business_transactions
      SELECT n,1,10,'parking_monthly','paid',100,NULL,NULL,NULL,
        jsonb_build_object('vehicle',jsonb_build_object('plateNo','TEST'||n)),'2026-11-20 01:00Z'
        FROM generate_series(10,29) n;
      INSERT INTO business_transactions VALUES
        (30,1,10,'parking_monthly','paid',75000,'2027-04-30','2027-04-30',NULL,'{"parking":{"plate":" su99999 "}}','2026-11-20 02:00Z'),
        (31,1,10,'parking_monthly','paid',75000,'2026-12-01','2027-04-30',NULL,'{"vehicle":{"plateNo":"SU99999"}}','2026-11-20 00:00Z'),
        (32,2,10,'parking_monthly','paid',75000,NULL,NULL,NULL,'{"vehicle":{"plateNo":"SU99999"}}','2026-11-20 00:00Z'),
        (33,1,20,'parking_monthly','paid',75000,NULL,NULL,NULL,'{"vehicle":{"plateNo":"SU99999"}}','2026-11-20 00:00Z'),
        (34,1,10,'parking_monthly','refunded',75000,NULL,NULL,NULL,'{"vehicle":{"plateNo":"SU99999"}}','2026-11-20 00:00Z');
    `);
    const berth = (offset: number, limit: number) => svc.incomeFromPms('berth',day,user,access,undefined,offset,limit);
    const berthFirst = await incomePage(1, berth), berthLast = await incomePage(2, berth);
    assert.equal(berthFirst.total, 22);
    assert.equal(berthFirst.amountCents, 152000);
    assert.equal(berthLast.amountCents, 152000);
    assert.equal(berthFirst.rows[0].samePlateCount, 2);
    assert.equal(berthLast.rows[1].samePlateCount, 2);
    assert.ok(berthFirst.rows.slice(1).every(row => row.samePlateCount === 1));
    await db.exec(`UPDATE business_transactions SET snapshot=snapshot || '{"reversedByTxnNo":"PKR-30"}'::jsonb WHERE id=30;
      INSERT INTO business_transactions VALUES
        (35,1,10,'parking_monthly','refunded',-75000,'2027-04-30','2027-04-30','红冲 PK-30',
         '{"vehicle":{"plateNo":"SU99999"},"reversal":{"originalTxnNo":"PK-30"}}','2026-11-20 03:00Z');`);
    const afterReversal = await incomePage(1,berth), afterReversalLast = await incomePage(2,berth);
    assert.equal(afterReversal.total,23);
    assert.equal(afterReversal.amountCents,77000);
    assert.equal(afterReversal.rows[0].amountCents,-75000);
    assert.match(afterReversal.rows[1].remark || '',/已红冲 PKR-30/);
    assert.equal(afterReversal.rows[1].samePlateCount,null);
    assert.equal(afterReversalLast.rows[2].samePlateCount,1);
    assert.equal(first.rows.length,20); assert.equal(last.rows.length,1);
    assert.equal([...first.rows,...last.rows].reduce((n,row)=>n+row.amountCents,0),total.amountCents);
    assert.equal(first.rows[0].remark,'备注');
    for (const [category,amount] of [['berth',77000],['card',500],['repair',1200]] as const) {
      assert.equal((await svc.incomeFromPms(category,day,user,access,undefined,0,20)).amountCents,amount);
    }
    assert.equal((await svc.incomeFromPms('repair',day,user,access,undefined,0,20)).rows[0].address,'某小区南门');
    await db.exec(`INSERT INTO business_transactions VALUES
      (36,1,10,'parking_monthly','paid',45000,NULL,NULL,NULL,'{"collectionDate":"2026-11-19","vehicle":{"plateNo":"沪A67890"}}','2026-11-20 02:00Z',NULL,'cash');`);
    const priorDay = await svc.incomeFromPms('berth','2026-11-19',user,access,undefined,0,20);
    assert.equal(priorDay.amountCents,45000);
    assert.equal(priorDay.rows[0].paidAt,'2026-11-19');
    assert.equal((await incomePage(1,berth)).amountCents,77000);
    await assert.rejects(svc.incomeFromPms('card',day,user,access,[20],0,20));
  } finally { await db.close(); }
});

test('直接读取 MIS 时按原账单读完整地址及收款方式', async () => {
  const service = Object.assign(Object.create(MisFeesService.prototype), {
    read: async (sql: string) => {
      assert.match(sql, /AS address/);
      assert.match(sql, /COALESCE\(NULLIF\(LTRIM\(RTRIM\(w\.收款方式\)\),N''\),NULLIF\(LTRIM\(RTRIM\(m\.收款方式\)\),N''\)\) AS paymentMethod/);
      return { recordsets: [[{ total: 1, cents: 100 }], [{ paidAt: '2026-11-20 00:00:00', address: '某小区501室', paymentMethod: '银联扫码', amountCents: 100 }]] };
    },
  }) as MisFeesService;
  assert.deepEqual((await service.exactIncome('01','2026-11-20',['01'],0,20)).rows[0], {
    paidAt:'2026-11-20',plate:null,address:'某小区501室',paymentMethod:'银联扫码',period:null,amountCents:100,remark:null,
  });
});

test('泊位费与车辆管理费各自按来源汇总；旧客户端默认只计 MIS', async () => {
  const mis = { total: 1, amountCents: 12000, rows: [] };
  const pms = { total: 2, amountCents: 15000, rows: [] };
  const fees = Object.assign(Object.create(FeesController.prototype), {
    misFeesService: { collectionCommunities: async () => [{offices:['01']}] },
    misRead: async (_user: unknown, _direct: unknown, mirror: () => Promise<unknown>) => mirror(),
    misMirrorService: {
      incomeFromMis: async (code:string) => { assert.ok(['04','14'].includes(code)); return mis; },
      incomeFromPms: async () => pms,
    },
  }) as FeesController;
  for (const category of ['berth','garage'] as const) {
    for (const source of [undefined,'mis','pms'] as const) {
      assert.deepEqual(await fees.todayIncome({category,source}, {tenantId:1} as any, {} as any), source==='pms' ? pms : mis);
    }
  }
});
