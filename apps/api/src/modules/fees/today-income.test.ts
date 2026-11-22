import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { FeesController } from './fees.controller';
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
      CREATE TABLE work_orders(id int,tenant_id int,community_id int,fee_cents int,completed_at timestamptz,status text,action_note text,deleted_at timestamptz);
      INSERT INTO work_orders VALUES(1,1,10,1200,'2026-11-20 01:00Z','completed','换灯',NULL),(2,1,10,500,'2026-11-20 01:00Z','voided',NULL,NULL);`);
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
    assert.equal(first.rows.length,20); assert.equal(last.rows.length,1);
    assert.equal([...first.rows,...last.rows].reduce((n,row)=>n+row.amountCents,0),total.amountCents);
    assert.equal(first.rows[0].remark,'备注');
    for (const [category,amount] of [['berth',0],['card',500],['repair',1200]] as const) {
      assert.equal((await svc.incomeFromPms(category,day,user,access,undefined,0,20)).amountCents,amount);
    }
    await assert.rejects(svc.incomeFromPms('card',day,user,access,[20],0,20));
  } finally { await db.close(); }
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
