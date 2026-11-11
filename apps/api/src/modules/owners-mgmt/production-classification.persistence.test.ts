import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const scope = JSON.parse(readFileSync(resolve(__dirname, '../../../../../deploy/production-apartment-scope.json'), 'utf8'));
const apply = async (pg: any) => {
  const { applyClassification } = require('../../../../../deploy/property-archive-release.cjs');
  return pg.transaction((tx: any) => applyClassification(tx, scope));
};
async function fixture() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE communities(id int,tenant_id int,name text,community_type text DEFAULT 'community',PRIMARY KEY(tenant_id,id))`);
  for (const item of [...scope.apartments,...scope.communities]) {
    await pg.query('INSERT INTO communities(id,tenant_id,name) VALUES($1,$2,$3)',[item.id,scope.tenantId,item.name]);
    await pg.query('INSERT INTO communities(id,tenant_id,name) VALUES($1,2,$2)',[item.id,'同编号其他公司']);
  }
  await pg.query('INSERT INTO communities(id,tenant_id,name) VALUES(99,1,$1)',['名称带公寓但未经确认']);
  return pg;
}
test('确认范围：吴泾一村和馨香臣寓四店为公寓；锦川及其他租户不变，重跑幂等', async()=>{
 const pg=await fixture();try{
  const first=await apply(pg);assert.equal(first.changed.length,scope.apartments.length);
  const r=await pg.query<any>('SELECT id,community_type FROM communities WHERE tenant_id=1 ORDER BY id');
  assert.deepEqual(r.rows.filter(x=>x.community_type==='apartment').map(x=>x.id),[19,20,21,22,23]);
  assert.equal(r.rows.find(x=>x.id===14)?.community_type,'community');
  assert.equal(r.rows.find(x=>x.id===99)?.community_type,'community');
  assert.equal((await pg.query<any>("SELECT COUNT(*)::int AS n FROM communities WHERE tenant_id=2 AND community_type='apartment'")).rows[0].n,0);
  assert.equal((await apply(pg)).changed.length,0);
 }finally{await pg.close();}
});
test('主数据名称与批准ID不符时整批拒绝，不留下部分分类修改',async()=>{
 const pg=await fixture();try{
  await pg.query('UPDATE communities SET name=$1 WHERE tenant_id=1 AND id=23',['不同档案']);
  await assert.rejects(()=>apply(pg),/批准的主数据不一致/);
  assert.equal((await pg.query<any>("SELECT COUNT(*)::int AS n FROM communities WHERE community_type='apartment'")).rows[0].n,0);
 }finally{await pg.close();}
});
