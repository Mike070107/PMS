import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ReceiptPrint1796700000000 } from '../../migrations/1796700000000-ReceiptPrint';
import {
  ReceiptPrintersController,
  ReceiptPrintAgentController,
} from './receipt-printers.controller';
import { issueAgentSecret } from '../access-card-issuance/agent-auth';

test('隔离 PostgreSQL：绑定、撤权、收费范围、防重复领取和结果不明保护', async () => {
  const pg = new PGlite();
  const manager = (client: any) => ({
    query: async (s: string, args?: unknown[]) =>
      (await client.query(s, args)).rows,
  });
  const db: any = {
    ...manager(pg),
    transaction: (cb: any) => pg.transaction((tx) => cb(manager(tx))),
  };
  try {
    await pg.exec(
      "CREATE TABLE users(id int primary key,tenant_id int,role text,status text,name text); INSERT INTO users VALUES(5,1,'staff','active','员工'),(6,2,'staff','active','其他租户')",
    );
    await new ReceiptPrint1796700000000().up({
      query: (s: string) => pg.exec(s),
    } as any);
    const cashier = { id: 5, tenantId: 1, role: 'staff' },
      other = { ...cashier, id: 6, tenantId: 2 };
    const all: any = { scopeAll: true, isTenantAdmin: true };
    const fees: any = {
      cashierReceipt: async (no: string, user: any) => {
        if (no === 'hidden' || user.tenantId !== 1) throw Error('无权');
        return {
          receiptNo: no,
          fullAddress: '合成地址',
          amountCents: 680,
          items: [{ feeName: '电费', amountCents: 680 }],
        };
      },
    };
    const ui = new ReceiptPrintersController(db, fees),
      agent = new ReceiptPrintAgentController(db);
    await assert.rejects(
      ui.register(cashier, { ...all, scopeAll: false }, '禁止'),
    );
    const p = await ui.register(cashier, all, '测试一号'),
      bind = 'Bearer ' + p.code;
    const token = 'Bearer ' + (await agent.bind(bind, '合成 XP-80C')).token;
    await assert.rejects(agent.bind(bind, '另一台'));
    await assert.rejects(agent.next('Bearer ' + issueAgentSecret().token));
    await assert.rejects(
      ui.grant(p.id, cashier, all, { employeeId: 6, allow: true }),
    );
    const b = {
      receiptNo: 'test-1',
      requestId: 'unique-request-1',
      reprint: false,
    };
    await assert.rejects(ui.enqueue(p.id, b, cashier, all));
    await ui.grant(p.id, cashier, all, { employeeId: 5, allow: true });
    assert.equal((await ui.list(other)).length, 0);
    assert.equal((await ui.employeePrinters(5,cashier,all))[0].allowed,true);
    await assert.rejects(ui.employeePrinters(6,cashier,all));
    await assert.rejects(ui.employeePrinters(5,cashier,{...all,scopeAll:false}));
    await assert.rejects(ui.enqueue(p.id, b, cashier, all));
    assert.equal((await agent.next(token)).job, null);
    await assert.rejects(
      ui.enqueue(p.id, { ...b, receiptNo: 'hidden' }, cashier, all),
    );
    const job = await ui.enqueue(p.id, b, cashier, all);
    assert.equal((await ui.enqueue(p.id, b, cashier, all)).id, job.id);
    await assert.rejects(
      ui.enqueue(p.id, { ...b, requestId: 'unique-request-2' }, cashier, all),
    );
    assert.equal((await agent.next(token)).job.id, job.id);
    assert.equal((await agent.next(token)).job, null);
    await agent.report(token, { id: job.id, state: 'unknown' });
    assert.equal((await ui.status(job.id, cashier)).state, 'unknown');
    await assert.rejects(
      ui.enqueue(
        p.id,
        { ...b, reprint: true, requestId: 'unique-request-3' },
        cashier,
        all,
      ),
    );
    await pg.query(
      "UPDATE receipt_print_jobs SET created_at=now()-interval '2 minutes'",
    );
    const copy = await ui.enqueue(
      p.id,
      { ...b, reprint: true, requestId: 'unique-request-4' },
      cashier,
      all,
    );
    await ui.grant(p.id, cashier, all, { employeeId: 5, allow: false });
    assert.equal((await agent.next(token)).job, null);
    assert.equal((await ui.status(copy.id, cashier)).state, 'cancelled');
    assert.equal((await ui.employeePrinters(5,cashier,all))[0].allowed,false);
    await ui.reset(p.id, cashier, all);
    await assert.rejects(agent.next(token));
  } finally {
    await pg.close();
  }
});
