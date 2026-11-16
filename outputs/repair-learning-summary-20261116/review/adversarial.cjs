const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { RepairsService } = require(path.join(process.cwd(), 'src/modules/repairs/repairs.service.ts'));
const { ExtractSamplesService } = require(path.join(process.cwd(), 'src/modules/ai/extract-samples.service.ts'));
const { RepairTextAiService } = require(path.join(process.cwd(), 'src/modules/ai/repair-text.ai.ts'));
const types = [{ repairType: 'intercom', label: '智能化', keywords: ['话机'] }, { repairType: 'electric', label: '电气', keywords: ['插座'] }];
function fixture() {
  let id = 1; const rows = [];
  function matches(row, where) { return Object.entries(where || {}).every(([k,v]) => v?._type === 'in' ? v._value.includes(row[k]) : v?._type === 'raw' ? row.expected?._officeId === undefined || row.expected?._officeId === v._objectLiteralParameters.sampleOfficeId : row[k] === v); }
  const repo = {
    create: r => ({...r}),
    count: async ({where}) => rows.filter(r => matches(r,where)).length,
    find: async ({where,take}={}) => rows.filter(r => matches(r,where)).sort((a,b)=>b.id-a.id).slice(0,take || 10000),
    findOne: async ({where}) => rows.find(r=>matches(r,where)),
    save: async function(input) { if(Array.isArray(input))return Promise.all(input.map(r=>repo.save(r))); const r={...input,id:input.id||id++,updatedAt:new Date()}; const n=rows.findIndex(v=>v.id===r.id); if(n<0)rows.push(r);else rows[n]=r;return r; },
    remove: async row => { const i=rows.findIndex(r=>r.id===row.id);if(i>=0)rows.splice(i,1); }
  };
  const samples = new ExtractSamplesService(repo);
  const service = Object.create(RepairsService.prototype);
  service.resolveTenantId = () => 7;
  service.listPublicRepairTypes = async () => types;
  service.accessService = { officeIdOfCommunity: async (_t,c) => c === 100 ? 10 : 20 };
  service.parseAddressByRule = async () => ({ matched:true,level:'house',communityId:200,roomNo:'201',addressText:'B小区10号201室',matchedRaw:'B小区10号201' });
  service.findTypeRule = async type => types.find(r=>r.repairType===type);
  service.logger={warn:()=>{}};
  service.extractSamples=samples;
  service.repairTextAi = new RepairTextAiService({askJson:async()=>({repairType:'intercom',description:'家里话机没信号'})}, samples);
  return {service,samples,rows,repo};
}
test('最终地址是office B时不得保留context office A分类样例', async () => {
  const {service,samples}=fixture();
  await samples.rememberRepairType(7,8,10,1,'家里话机没信号','electric');
  const result=await service.parseRepairAddress({text:'家里话机没信号',communityId:100},{id:8,tenantId:7});
  assert.equal(result.communityId,200);
  assert.equal(result.ai.repairType,'intercom','B没有electric样例，应使用B的普通AI识别，不沿用A学习覆盖');
});
test('lite规则撞到房号时，带门牌同类报修仍使用本office学习', async()=>{
  const {service,samples}=fixture();
  await samples.rememberRepairType(7,8,20,1,'家里话机没信号','electric');
  const result=await service.parseRepairAddress({text:'B小区10号201家里话机没信号',communityId:200,lite:true},{id:8,tenantId:7});
  assert.equal(result.ai?.repairType,'electric','带门牌同类短句不能因为命中原关键词而跳过人工更正学习');
});
test('AI地址重试跨office后，类别重判异常必须清除旧scope类别且保留地址', async()=>{
  const {service}=fixture(); let parses=0; let addresses=0;
  service.parseAddressByRule=async()=> ++addresses === 1 ? {matched:true,level:'community',communityId:100,addressText:'A小区'} : {matched:true,level:'house',communityId:200,addressText:'B小区10号201室',roomNo:'201',matchedRaw:'B小区10号201'};
  service.repairTextAi={parse:async()=> { if(++parses===1)return {repairType:'electric',sampleMatched:true,addressText:'B小区10号201',description:'家里话机没信号'}; throw new Error('temporary model failure'); }};
  const result=await service.parseRepairAddress({text:'B小区10号201家里话机没信号',communityId:100},{id:8,tenantId:7});
  assert.equal(result.communityId,200);
  assert.equal(result.ai.repairType,'','重判失败不能保留A scope类别');
  assert.equal(result.ai.sampleMatched,false);
  assert.equal(result.ai.description,'家里话机没信号');
});
test('无office不读取office学习，另租户同句不读取', async()=>{
  const {samples}=fixture();
  await samples.rememberRepairType(7,8,10,1,'家里话机没信号','electric');
  assert.equal(await samples.findExact(7,'家里话机没信号','repair',null),null);
  assert.equal(await samples.findExact(8,'家里话机没信号','repair',10),null);
});
