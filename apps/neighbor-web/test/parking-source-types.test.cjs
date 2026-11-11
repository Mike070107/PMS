const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function renderSourceCard(rows,cloud){
 const src=fs.readFileSync(path.join(__dirname,'../src/pages/Vehicles.tsx'),'utf8'),start=src.indexOf('<div className="veh-panel">',src.indexOf('<div className="veh-panels">')),end=src.indexOf('<div className="veh-panel">',start+1);
 assert.ok(start>=0&&end>start,'actual source information card must be present');
 const jsx=src.slice(start,end).trim(),code=ts.transpileModule('module.exports=(rows,cloud)=>(<>'+jsx+'</>);',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
 const m={exports:{}},f=fields();new Function('module','exports','React','field','dbLabel','note','deliyunVehicleIdentity',code)(m,m.exports,React,f.field,db=>db==='parking1'?'一期库':'二期库','',f.deliyunVehicleIdentity);
 return renderToStaticMarkup(m.exports(rows,cloud));
}
test('real source information card shows legacy model and cloud billing type separately',()=>{
 const html=renderSourceCard([{database:'parking1',fields:{Car_Lei:1,Car_Brand:'住户车',Owner__owner_Name:'198/37/401'}}],{cardType:'月票车',carType:'小型车'});
 assert.match(html,/旧库车型<\/dt><dd>住户车/);assert.match(html,/德立云计费类型<\/dt><dd>月票车/);assert.match(html,/对应PMS身份<\/dt><dd>住户车/);assert.match(html,/德立云车型<\/dt><dd>小型车/);
 const unknown=renderSourceCard([{database:'parking1',fields:{Car_Lei:1}}],null);assert.match(unknown,/旧库车型<\/dt><dd>未读取/);
});

function fields(){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/parking-fields.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:m,exports:m.exports});return m.exports;}
test('old model comes from Car_Brand/Car_Beand, never authorization code Car_Lei',()=>{const f=fields();assert.equal(f.field({Car_Lei:1,Car_Brand:'住户车'},'identity'),'住户车');assert.equal(f.field({Car_Lei:1,Car_Beand:'租户车'},'vehicleModel'),'租户车');assert.equal(f.field({Car_Lei:1},'vehicleModel'),'');});
test('Deliyun monthly-ticket billing type means PMS resident, not tenant or a price tier',()=>{const f=fields();assert.equal(typeof f.deliyunVehicleIdentity,'function');assert.equal(f.deliyunVehicleIdentity({cardType:'月票车',carType:'小型车'}),'住户车');assert.equal(f.deliyunVehicleIdentity({cardType:' 月票车 ',remark:'普通登记'}),'住户车');assert.equal(f.deliyunVehicleIdentity({cardType:'临时车',carType:'小型车'}),null);assert.equal(f.deliyunVehicleIdentity({cardType:'月租车'}),null);assert.equal(f.deliyunVehicleIdentity({cardType:'亲情车'}),'亲情车');});
