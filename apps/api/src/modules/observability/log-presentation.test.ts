import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityService } from './observability.service';
import { presentOperation } from './log-presentation';
import { resolveBusinessAction } from './business-action';

const present = (path: string, detail: any = {}, statusCode = 200, method = 'POST'): any => presentOperation(row(path, detail, statusCode, method));
test('请求与审批业务结果分开，拒绝访问绝不是审批通过，未知详情不编造', () => {
  const denied = present('/audits/4/approve', {}, 403);
  assert.equal(denied.requestResult, '无权操作，未执行');
  assert.equal(denied.businessResult, '未执行审批');
  assert.ok(!denied.actionLabel.includes('（通过）'));
  assert.equal(present('/vehicle-intakes/4/review', { decision: 'reject' }).businessResult, '拒绝');
  assert.equal(present('/stocktakes/4/review', { approved: false }).businessResult, '退回');
  assert.equal(present('/vehicle-intakes/4/review').businessResult, '审批结果未记录');
  assert.equal(present('/audits/4/approve').businessResult, '通过');
  assert.equal(present('/future/4/approve', {decision:'approve'}).businessResult, null);
  assert.match(present('/future/4/approve').actionLabel, /未标注/);
});
test('仅安全枚举留痕，不收集自由原因、凭据、手机号或前后值', () => {
  const event = resolveBusinessAction('POST', '/vehicle-intakes/4/review', { decision:'reject', approved:false, note:'SECRET', reason:'SECRET', password:'SECRET', ticket:'SECRET', phone:'SECRET', before:'SECRET', after:'SECRET' });
  assert.equal(event.detail?.decision, 'reject');
  assert.equal(event.detail?.approved, false);
  assert.ok(!JSON.stringify(event).includes('SECRET'));
  assert.equal(resolveBusinessAction('POST','/vehicle-intakes/4/review',{decision:'SECRET',approved:'false'}).detail?.decision, undefined);
  assert.equal(resolveBusinessAction('POST','/vehicle-intakes/4/review',{decision:'SECRET',approved:'false'}).detail?.approved, undefined);
});
test('真实创建、归档恢复与内网真删除口径独立，对象与历史未记录明确', () => {
  assert.equal(present('/houses/4', {}, 200, 'DELETE').actionLabel, '归档房屋');
  assert.equal(resolveBusinessAction('DELETE','/houses/4').code, 'house_delete');
  assert.equal(present('/houses/4/restore').auditClass, 'archive_delete');
  assert.equal(present('/external-access/apps/4', {}, 200, 'DELETE').actionLabel, '删除外部访问应用');
  assert.equal(present('/external-access/agents/4', {}, 200, 'DELETE').actionLabel, '删除内网连接代理');
  assert.equal(present('/roles/4', {}, 200, 'PATCH').auditClass, 'permission');
  const created: any = presentOperation({...row('/houses'), detail:{objectId:42}});
  assert.equal(created.actionLabel,'新增房屋'); assert.equal(created.objectId,42);
  assert.equal(created.objectType,'house');
  assert.match(created.historyNotice,/前后值未记录/);
  assert.match(present('/access-card-issuance/batches').completionNotice,/不代表.*设备.*送达.*打印/);
});

test('扩展字典的审批和删除有对象类型，未知对象不冒称已记录', () => {
  assert.equal(present('/vehicle-intakes/4/review').objectType,'vehicle_intake');
  assert.equal(present('/external-access/apps/4',{},200,'DELETE').objectType,'external_access_app');
  assert.equal(present('/external-access/agents/4',{},200,'DELETE').objectType,'external_access_agent');
});
test('新操作只保留枚举，凭据路由脱敏，403不把提交的决定当已执行结果', async () => {
  const saved:any[]=[];
  const repo:any={create:(v:any)=>v,save:async(v:any)=>{saved.push(v);return v;}};
  const service=new ObservabilityService(repo,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any);
  await service.recordOperation({tenantId:7,source:'admin-web',method:'POST',path:'/vehicle-intake-form/SECRET?ticket=SECRET',body:{password:'SECRET',reason:'SECRET',before:{password:'SECRET'}},statusCode:200,durationMs:1,actorUserId:1});
  assert.ok(!JSON.stringify(saved).includes('SECRET'));
  await service.recordOperation({tenantId:7,source:'admin-web',method:'POST',path:'/audits/4/approve',body:{decision:'approve',reason:'SECRET'},errorMessage:'自由原因 SECRET',statusCode:403,durationMs:1,actorUserId:1});
  const p:any=presentOperation(saved[1]); assert.equal(p.businessResult,'未执行审批');
  assert.ok(!saved[1].message.includes('（通过）'));
  assert.ok(!JSON.stringify(saved).includes('SECRET'));
});

function fixture(rows: any[]) {
  const calls: any[] = [];
  const qb: any = {};
  for (const method of ['where','andWhere','orderBy','skip','take']) qb[method] = (...args: any[]) => { calls.push([method,...args]); return qb; };
  qb.getManyAndCount = async () => [rows, rows.length];
  const service = new ObservabilityService({ createQueryBuilder: () => qb } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { service, calls };
}
const row = (path: string, detail: any = {}, statusCode = 200, method = 'POST') => ({ id: 1, tenantId: 7, category: 'operation', action: 'stable_old_code', message: '新增/提交账号', requestMethod: method, requestPath: path, detail, statusCode, success: statusCode < 400, actorUserId: null });
test('历史敏感接口的完整响应不含路径凭据或自由错误文本，且不回写原行',async()=>{
  for(const [route,prefix] of [['/external-access-agent/frp-plugin/','post_external_access_agent_frp_plugin_'],['/vehicle-intake-form/','post_vehicle_intake_form_']])for(const shape of ['path','legacy-action','generic-action','error']) {
    const original:any={...row('/api/v1'+route+'PRIVATE_FIXTURE_MARKER'),action:prefix+'PRIVATE_FIXTURE_MARKER',message:'旧错误 PRIVATE_FIXTURE_MARKER',detail:{errorMessage:'PRIVATE_FIXTURE_MARKER',password:'PRIVATE_FIXTURE_MARKER'},category:shape==='error'?'error':'operation'};
    if(shape==='legacy-action'){original.requestPath=null;original.requestMethod=null;original.action='POST '+route+'PRIVATE_FIXTURE_MARKER';}
    if(shape==='generic-action'){original.requestPath=null;original.requestMethod=null;}
    const before=JSON.stringify(original),{service}=fixture([original]);
    const response=await service.list({id:1,tenantId:7} as any,{} as any);
    assert.ok(!JSON.stringify(response).includes('PRIVATE_FIXTURE_MARKER'),shape+' 响应必须整体脱敏');
    assert.equal(JSON.stringify(original),before,'只读投影不能改原记录');
  }
});
test('历史扫码无论旧标签是否存在，按实际路由重解释而不改 action 或历史行', async () => {
  for (const [suffix,label] of [['scan','扫码查看网页登录请求'],['confirm','确认网页登录授权'],['cancel','取消网页登录授权']]) {
    const original = row('/api/v1/auth/qr-login/'+suffix, { operationLabel: '新增/提交账号' });
    const {service} = fixture([original]);
    const result = await service.list({id:1,tenantId:7} as any, {} as any);
    assert.equal((result.list[0] as any).presentation?.actionLabel, label);
    assert.equal(result.list[0].detail?.operationLabel, label);
    assert.equal(result.list[0].action, 'stable_old_code');
    assert.equal(original.detail.operationLabel, '新增/提交账号');
  }
});
