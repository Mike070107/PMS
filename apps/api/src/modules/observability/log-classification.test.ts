import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource } from 'typeorm';
import { SystemLog } from '../../entities/system-log.entity';
import { ObservabilityService } from './observability.service';
import { SystemLogQueryDto } from './dto';
import { validate } from 'class-validator';

test('审计分类参数仅接受固定枚举', async () => {
  const dto = Object.assign(new SystemLogQueryDto(), {auditClass:'invalid'});
  assert.ok((await validate(dto)).some(e => e.property === 'auditClass'));
});
test('服务端真实SQL先分类再tenant分页计数，历史泛化code按method/path识别', async () => {
  const db = new PGlite();
  const ds = new DataSource({type:'postgres',entities:[SystemLog]});
  await (ds as any).buildMetadatas();
  const repo = ds.getRepository(SystemLog), meta = repo.metadata;
  try {
    const columns = meta.columns.map(c => `${c.databaseName} ${c.type === 'jsonb' ? 'jsonb' : c.type === 'boolean' || c.propertyName === 'success' ? 'boolean' : ['id','tenantId','actorUserId','statusCode','durationMs','createdBy','updatedBy'].includes(c.propertyName) ? 'int' : c.propertyName.endsWith('At') ? 'timestamptz' : 'text'}`).join(',');
    await db.exec(`CREATE TABLE system_logs (${columns});`);
    for (let id=1;id<=36;id++) await db.query('INSERT INTO system_logs(id,tenant_id,category,action,request_method,request_path,success,status_code,detail,message) VALUES ($1,$2,$3,$4,$5,$6,true,200,$7,$8)',[id,id===36?2:1,'operation','post_old_generic','POST','/api/v1/audits/'+id+'/approve',JSON.stringify({operationLabel:'新增业务'}),'旧日志']);
    await db.exec(`INSERT INTO system_logs(id,tenant_id,category,action,request_method,request_path,success,status_code) VALUES (90,1,'operation','house_delete','DELETE','/houses/7',true,200),(91,1,'operation','patch_roles_id','PATCH','/roles/8',true,200),(92,1,'operation','post_unknown_approve','POST','/unknown/8/approve',true,200),(93,1,'operation','house_create','POST','/houses',true,200);`);
    const execute = async (qb:any) => {const [sql,args]=qb.getQueryAndParameters(); return (await db.query(sql,args)).rows;};
    const logRepo = {createQueryBuilder: () => {const qb:any=repo.createQueryBuilder('log'); qb.getManyAndCount=async()=>{
      const rows = await execute(qb);
      const count = await execute(qb.clone().skip(undefined).take(undefined).select('COUNT(*)','total').orderBy());
      return [rows.map((raw:any)=>Object.fromEntries(meta.columns.map(c=>[c.propertyName,raw['log_'+c.databaseName]]))),Number((count[0] as any).total)];
    };return qb;}};
    const service = new ObservabilityService(logRepo as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any);
    const user:any={id:1,tenantId:1};
    const second = await service.list(user,{auditClass:'approval',page:2,pageSize:30} as any);
    assert.equal(second.total,35); assert.deepEqual(second.list.map((r:any)=>r.id),[5,4,3,2,1]);
    assert.equal((await service.list(user,{auditClass:'archive_delete'} as any)).total,1);
    assert.equal((await service.list(user,{auditClass:'permission'} as any)).total,1);
    await assert.rejects(()=>service.list({id:1} as any,{} as any),/物业公司/);
  } finally {await db.close();}
});
