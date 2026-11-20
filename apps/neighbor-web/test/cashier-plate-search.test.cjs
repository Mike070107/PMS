const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const esbuild=require('node:module').createRequire(require.resolve('vite'))('esbuild');
function productionSearch(deps){const source=fs.readFileSync(path.join(__dirname,'../src/pages/Cashier.tsx'),'utf8');const start=source.indexOf('  const normSearch ='),end=source.indexOf('\n  const loadBills',start);assert.ok(start>0&&end>start);const js=esbuild.transformSync(source.slice(start,end)+'\nglobalThis.search=searchByQ;', {loader:'ts',target:'es2022'}).code;const ctx={...deps,useCallback:f=>f,setTimeout:f=>{f();return 1;}};vm.runInNewContext(js,ctx);return ctx.search;}
const house={id:6,communityId:1,communityName:'合成一期',buildingNo:'6',lane:'198',roomNo:'601',owner:null};
function fixture(query){const calls=[];const deps={request:async args=>{calls.push(args);return {houses:[house],vehicles:[],accessCards:[]}},accessCardIssuance:{createParkingQuery:async term=>{assert.equal(term,'03212');return query},parkingQuery:async()=>query}};return {search:productionSearch(deps),calls};}
for(const fields of [{p_plate:'沪A03212',Owner__room:'198/6/601',p_note:null},{P_plate:'沪A03212',Owner__owner_Name:'198/6/601'},{p_plate:'沪A03212',p_note:'198/6/601'}])test('cashier tail 03212 keeps onsite row '+Object.keys(fields).join(','),async()=>{const{search,calls}=fixture({id:1,status:'completed',rows:[{database:'parking1',fields}]});const result=await search('03212');assert.equal(result.vehicles[0]?.plateNo,'沪A03212');assert.equal(result.vehicles[0]?.houseId,6);assert.ok(calls.some(c=>c.query.q==='198/6/601'));});
test('onsite zero-padded building 198/03/301 resolves canonical house instead of dropping plate',async()=>{const canonical={...house,id:15,buildingNo:'3',roomNo:'301'};const search=productionSearch({request:async({query})=>({houses:query.q==='198/3/301'?[canonical]:[],vehicles:[],accessCards:[]}),accessCardIssuance:{createParkingQuery:async()=>({id:1,status:'completed',rows:[{fields:{P_plate:'沪A03212',Owner__owner_Name:'198/03/301'}}]})}});const result=await search('03212');assert.equal(result.vehicles[0]?.houseId,15);});
test('actual shared address resolver distinguishes padded legacy address from canonical address',()=>{const m={exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.resolve(__dirname,'../../api/src/common/address.shared.ts'),'utf8'),{loader:'ts',format:'cjs'}).code,{module:m,exports:m.exports});const tree=[{id:1,name:'合成一期',mainLane:'198',buildings:[{id:3,lane:'198',buildingNo:'3',houses:[{id:15,roomNo:'301'}]}]}];assert.equal(m.exports.resolveAddressQuery('198/03/301',tree),null);assert.deepEqual(Array.from(m.exports.resolveAddressQuery('198/3/301',tree).houseIds),[15]);});
test('ambiguous or wrong household is never silently selected',async()=>{for(const houses of [[{...house,buildingNo:'9'}],[house,{...house,id:99}]]){const search=productionSearch({request:async()=>({houses,vehicles:[],accessCards:[]}),accessCardIssuance:{createParkingQuery:async()=>({id:1,status:'completed',rows:[{fields:{P_plate:'沪A03212',Owner__owner_Name:'198/6/601'}}]})}});const r=await search('03212');assert.equal(r.vehicles[0].plateNo,'沪A03212');assert.equal(r.vehicles[0].houseId,null);}});
test('onsite failure is not reported as no matching vehicle',async()=>{const{search}=fixture({id:2,status:'failed',error:'现场查询失败',rows:[]});await assert.rejects(search('03212'),/现场查询失败/);});
test('still running query is not reported as empty result',async()=>{const{search}=fixture({id:3,status:'running',rows:[]});await assert.rejects(search('03212'),/未完成|查询中/);});

test('2199 优先返回真实车牌和所属房屋；其他户附带车辆及电话命中不混入',async()=>{
 const right={...house,id:20,buildingNo:'20',roomNo:'802'};
 const search=productionSearch({
  request:async({query})=>query.q==='2199'?{houses:[house,right],vehicles:[{id:10,plateNo:'沪B12345',houseId:6}],accessCards:[]}:{houses:[right],vehicles:[],accessCards:[]},
  accessCardIssuance:{createParkingQuery:async()=>({status:'completed',rows:[
   {fields:{P_plate:'沪A02199',Owner__owner_Name:'198/20/802'}},
   {fields:{P_plate:'沪B12345',Owner__owner_Name:'198/6/601'}}]})}
 });
 const r=await search('2199');
 assert.deepEqual(Array.from(r.vehicles,v=>v.plateNo),['沪A02199']);
 assert.deepEqual(Array.from(r.houses,h=>h.id),[20]);
 assert.equal(r.plateMatches,true);
});
