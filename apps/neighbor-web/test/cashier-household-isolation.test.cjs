const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const app=path.resolve(__dirname,'..');function parse(file){return ts.createSourceFile(file,fs.readFileSync(path.join(app,'src',file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)}
function find(ast,name){let hit;function walk(n){if((ts.isVariableDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.getText(ast)===name)hit=n;ts.forEachChild(n,walk)}walk(ast);assert.ok(hit,name);return hit;}
const ca=parse('pages/Cashier.tsx'),pa=parse('components/cashier/ParkingTab.tsx');const house={id:1074,lane:'228',buildingNo:'31',roomNo:'302'};
function run(code,context){return vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)}
function cashier(){const state={parkPlate:'沪M03212'},noop=()=>{};const ctx={setErr:v=>state.error=v,setPicked:noop,navigationRevision:{current:0},setHouse:v=>state.house=v,setResult:noop,setDone:noop,setConfirmed:noop,setParkCarts:noop,setParkReady:noop,setCardEst:noop,setCardQty:noop,setCardFree:noop,setTab:v=>state.tab=v,setBills:noop,setParkPlate:v=>state.parkPlate=v,loadBills:noop};run('applyHouse='+find(ca,'applyHouse').initializer.getText(ca),ctx);run('onUniPick='+find(ca,'onUniPick').initializer.getText(ca),ctx);return{state,ctx};}
function cars({owner='198/03/301',selected=house,householdRoom='228/31/302',fromPlate=true,boundPlates=[],selectedVehicle,initialPlate=null}={}){const row={database:'parking1',fields:{P_id:3934,P_plate:'沪M03212',Owner__owner_Name:owner,P_Effective:'0000100',End_Time:'2027-12-31 00:00:00'}};const names=['normPlate','day','roomKey','sameRoom','field','channels','localGarages','spaceFromNote'];let code=names.map(name=>{const n=find(pa,name);return ts.isFunctionDeclaration(n)?n.getText(pa):'const '+n.getText(pa)+';';}).join('\n');code+='\nresult=('+find(pa,'cars').initializer.arguments[0].getText(pa)+')();';const context={selectedVehicle,initialPlate,hh:{boundPlates,room:householdRoom,localDatabases:['parking1'],deliyun:[]},local:{rows:fromPlate?[]:[row]},plateRows:fromPlate?[row]:[],house:selected,roomTermOf:h=>[h.lane,h.buildingNo,h.roomNo].join('/'),identityOf:()=>null};run(code,context);return context.result;}
test('switching or clearing household clears the previous searched plate',()=>{for(const h of [house,null]){const{state,ctx}=cashier();ctx.applyHouse(h,null);assert.equal(state.parkPlate,null);assert.equal(state.house,h);}});
test('explicit vehicle choice reselects only that result after resetting household',()=>{const{state,ctx}=cashier();const h={id:15,lane:'198',buildingNo:'3',roomNo:'301'};ctx.onUniPick({kind:'vehicle',vehicle:{houseId:15,plateNo:'沪M03212'},all:{houses:[h],vehicles:[],accessCards:[]}});assert.equal(state.house.id,15);assert.equal(state.parkPlate,'沪M03212');assert.equal(state.tab,'pk');});
test('plate-query results cannot bypass current household ownership',()=>{assert.equal(cars().length,0);assert.equal(cars({fromPlate:false}).length,0);assert.equal(cars({owner:''}).length,0);});
test('明确选中的本户车按完整车牌匹配，旧姓名不同仍可续费',()=>{
 const selectedVehicle={plateNo:'沪M03212',houseId:house.id}, initialPlate=selectedVehicle.plateNo;
 assert.equal(cars({selectedVehicle,initialPlate,owner:'旧登记姓名'}).length,1);
 assert.equal(cars({selectedVehicle,initialPlate:'沪A12345',owner:'旧登记姓名'}).length,0);
 assert.equal(cars({selectedVehicle:{...selectedVehicle,houseId:-1},initialPlate,owner:'旧登记姓名'}).length,0);
});
test('zero-padded matching legacy address is still visible',()=>{const result=cars({selected:{id:15,lane:'198',buildingNo:'3',roomNo:'301'},householdRoom:'198/3/301'});assert.equal(result.length,1);assert.equal(result[0].plate,'沪M03212');assert.equal(result[0].lots[0].endDate,'2027-12-31');});
test('a mismatched household response cannot override the selected address',()=>{assert.equal(cars({householdRoom:'198/03/301'}).length,0);});

test('重新打开商铺按房产绑定的完整车牌核对旧库，不依赖上次查询或姓名', () => {
 const selected = {id:729,buildingNo:'729',roomNo:'商铺'};
 const result = cars({selected,owner:'旧车主',boundPlates:['沪M03212']});
 assert.equal(result.length,1);
 assert.equal(result[0].lots.length,1);
 assert.equal(cars({selected,owner:'旧车主'}).length,0);
});
test('unresolved vehicle clears the prior charge and stays in cashier',()=>{
 const {state,ctx}=cashier();
 ctx.onUniPick({kind:'vehicle',vehicle:{plateNo:'沪A1C678',houseId:null},all:{houses:[],vehicles:[],accessCards:[]}});
 assert.equal(state.house,null);
 assert.equal(state.parkPlate,null);
 assert.match(state.error,/沪A1C678.*收银台/);
});

test('registered phone selection stays in cashier and opens the specific unpaid intake',()=>{
 const {ctx}=cashier();
 let destination;
 ctx.navigate=url=>{destination=url};
 ctx.onUniPick({kind:'vehicle',vehicle:{plateNo:'沪A1C678',houseId:902,openIntakeId:66},all:{houses:[],vehicles:[],accessCards:[]}});
 assert.equal(destination,'/cashier?intakeId=66');
});
