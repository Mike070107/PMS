import assert from 'node:assert/strict';import test from 'node:test';
import {resolveMisCollector} from './mis-collector.util';
test('MIS collector is explicitly mapped to the authenticated tenant/user and payment method',()=>{
 const config=JSON.stringify({tenants:{'1':{collectors:{'7':{id:'E007',name:'合成收款员'}},methods:{cash:{id:1,name:'现金'},alipay:{id:2,name:'支付宝'}}}}});
 assert.deepEqual(resolveMisCollector(config,1,7,'cash'),{collectorId:'E007',collectorName:'合成收款员',paymentMethodId:1,paymentMethod:'现金'});
 for(const [tenant,user,method] of [[2,7,'cash'],[1,8,'cash'],[1,7,'wechat'],[1,7,'现金']])assert.throws(()=>resolveMisCollector(config,tenant as number,user as number,method as string),/映射/);
 assert.throws(()=>resolveMisCollector('not json',1,7,'cash'),/映射/);
});
