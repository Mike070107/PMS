const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
// Isolated hooks/handlers/JSX runner, NOT browser E2E or real React scheduling.
// Model the commit phase (controlled DOM value + refs) BEFORE passive effects,
// plus activeElement/selection replacement so typing cannot bypass the displayed value.
function harness(lane=null,buildingNo='2',roomNo='201'){
 let cursor=0,dirty=false,ui;const slots=[],effects=[],requests=[],picked=[];const timers=new Map();let timerId=0;
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={useState(init){const i=cursor++;if(!slots[i])slots[i]={v:typeof init==='function'?init():init};return[slots[i].v,v=>{const n=typeof v==='function'?v(slots[i].v):v;if(!Object.is(n,slots[i].v)){slots[i].v=n;dirty=true}}]},useRef(init){const i=cursor++;return(slots[i]??={v:{current:init}}).v},useMemo(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={deps,v:fn()};return slots[i].v},useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const prev=slots[i];slots[i]={deps,cleanup:prev?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn()})}}};
 const hit={id:9,communityId:21,communityName:'示例公寓颛桥店',lane,buildingNo,roomNo,owner:null};
 const props={communities:[{id:21,name:hit.communityName,buildings:[{id:6,lane,buildingNo,houses:[{id:9,roomNo,ownerName:null}]}]}],onPick:p=>picked.push(p),search:term=>new Promise((resolve,reject)=>requests.push({term,resolve,reject}))};
 const document={activeElement:null,addEventListener(){},removeEventListener(){}};
 const dom={value:'',selectionStart:0,selectionEnd:0,focusCalls:0,selectCalls:0,
  focus(){this.focusCalls++;if(document.activeElement!==this){document.activeElement=this;input().props.onFocus({currentTarget:this})}},
  select(){this.selectCalls++;this.selectionStart=0;this.selectionEnd=this.value.length},
  blur(){document.activeElement=null}};
 const module={exports:{}};const sandbox={module,exports:module.exports,Error,console,document,window:{setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)}},require(id){if(id==='react')return react;if(id==='react/jsx-runtime')return require(id);return{__esModule:true,default:id.includes('HouseAddressPicker')?'HouseAddressPicker':'Icon'}}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../src/components/cashier/UniSearch.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,sandbox);
 function render(){let n=0;do{dirty=false;cursor=0;ui=module.exports.default(props);
  if(dom.value!==input().props.value){dom.value=input().props.value;dom.selectionStart=dom.selectionEnd=dom.value.length}
  input().ref.current=dom;
  while(effects.length)effects.shift()();assert.ok(++n<25)}while(dirty);return ui}
 // Project the shared picker contract into the existing fake DOM; Cascader itself is tested separately.
 function project(p){
  const input={type:'input',ref:p.inputRef,props:{value:p.displayText??p.searchText??'',onFocus:e=>{p.onOpenChange(true);if(p.displayText)e.currentTarget.select()},onChange:e=>p.onSearchText(e.target.value),onKeyDown:e=>{if(e.key==='Enter')p.onSubmitText(p.searchText)}}};
  const buttons=[];for(const c of p.communities){buttons.push({type:'button',props:{children:c.name,onClick:()=>p.onPicked({communityId:c.id})}});for(const b of c.buildings){buttons.push({type:'button',props:{children:b.lane?`${b.lane}弄${b.buildingNo}号`:`${b.buildingNo}号楼`,onClick:()=>p.onPicked({communityId:c.id,buildingId:b.id})}});for(const h of b.houses)buttons.push({type:'button',props:{children:h.roomNo,onClick:()=>p.onPicked({communityId:c.id,buildingId:b.id,houseId:h.id,roomNo:h.roomNo})}})}}
  buttons.push({type:'button',props:{title:'清空',onMouseDown:()=>{p.onChange([]);p.onPicked(null)}}});
  return[input,...buttons,p.extraResults];
 }
 function nodes(node=ui,out=[]){if(Array.isArray(node))node.forEach(n=>nodes(n,out));else if(node&&typeof node==='object'){out.push(node);if(node.type==='HouseAddressPicker')nodes(project(node.props),out);else if(node.props?.children!==undefined)nodes(node.props.children,out)}return out}
 const input=()=>nodes().find(n=>n.type==='input');
 const click=s=>{const e=nodes().find(n=>n.type==='button'&&text(n).replace(/›/g,'')===s);assert.ok(e,'missing '+s);e.props.onClick();render()};
 function focus(){dom.focus();render()}
 function type(chars){assert.equal(document.activeElement,dom);dom.value=dom.value.slice(0,dom.selectionStart)+chars+dom.value.slice(dom.selectionEnd);dom.selectionStart=dom.selectionEnd=dom.selectionStart+chars.length;input().props.onChange({target:dom});render()}
 function enter(){input().props.onKeyDown({key:'Enter',preventDefault(){}});render()}
 function clear(){nodes().find(n=>n.type==='button'&&n.props.title==='清空').props.onMouseDown({preventDefault(){},stopPropagation(){}});render()}
 function flushTimers(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());render()}
 function begin(){render();focus();click(hit.communityName);click(lane?`${lane}弄${buildingNo}号`:`${buildingNo}号楼`);click(roomNo)}
 async function complete(rows=[hit]){requests.at(-1).resolve({houses:rows,vehicles:[],accessCards:[]});await new Promise(r=>setImmediate(r));render()}
 return{begin,render,input,click,complete,hit,requests,picked,dom,document,focus,type,enter,clear,flushTimers,props,unmount(){for(const slot of slots)slot?.cleanup?.()}};
}
function text(n){if(n==null||typeof n==='boolean')return'';if(typeof n==='string'||typeof n==='number')return String(n);if(Array.isArray(n))return n.map(text).join('');return text(n.props?.children)}
test('只选楼栋即使查到唯一住户也不擅自选户，保留第三列供明确点室号',async()=>{const h=harness();h.render();h.focus();h.click(h.hit.communityName);h.click('2号楼');await h.complete();assert.equal(h.picked.length,0)});
test('无弄号公寓选户后回填小区和完整房号，不出现空前缀斜杠',async()=>{const h=harness();h.begin();assert.equal(h.requests.at(-1).term,'2/201');await h.complete();assert.equal(h.input().props.value,'示例公寓颛桥店 / 2号楼 / 201室');assert.equal(h.picked[0].hit.id,9)});
test('住宅回填保留真实弄号，查询词仍为原数字短写',async()=>{const h=harness('228','3','502');h.begin();assert.equal(h.requests.at(-1).term,'228/3/502');await h.complete();assert.equal(h.input().props.value,'示例公寓颛桥店 / 228弄3号楼 / 502室')});
test('房号查询返回同室号其他户时，不替换用户点选的房屋',async()=>{const h=harness();h.begin();await h.complete([{...h.hit,id:88,communityId:22,communityName:'其他小区'}]);assert.equal(h.picked.length,0)});
test('回车选户不失焦，继续键入按 DOM 选区替换展示地址',async()=>{
 const h=harness();h.render();h.focus();h.type('2/201');h.enter();
 assert.equal(h.requests.at(-1).term,'2/201');await h.complete();
 assert.equal(h.document.activeElement,h.dom);
 assert.equal(h.dom.value,'示例公寓颛桥店 / 2号楼 / 201室');
 h.type('3');assert.equal(h.dom.value,'3');h.type('01');
 assert.equal(h.input().props.value,'301');h.flushTimers();
 assert.equal(h.requests.at(-1).term,'301');
 assert.ok(h.requests.every(r=>!r.term.includes('示例公寓')));
});
test('点选请求晚于用户新输入返回时，不回填旧户',async()=>{const h=harness();h.begin();h.dom.select();h.type('301');await h.complete();assert.equal(h.input().props.value,'301');assert.equal(h.picked.length,0)});
test('异步选户回填时未聚焦，不抢其他元素焦点或修改选区',async()=>{
 const h=harness();h.render();h.focus();h.type('2/201');h.enter();
 const other={};h.document.activeElement=other;
 const focusCalls=h.dom.focusCalls,selectCalls=h.dom.selectCalls;
 await h.complete();assert.equal(h.dom.value,'示例公寓颛桥店 / 2号楼 / 201室');
 assert.equal(h.document.activeElement,other);
 assert.equal(h.dom.focusCalls,focusCalls);assert.equal(h.dom.selectCalls,selectCalls);
});
test('姓名查询重复Enter选中同一户，提交后再次全选供续输替换',async()=>{
 const h=harness();h.render();h.focus();h.type('张三');h.enter();await h.complete();
 h.dom.selectionStart=h.dom.selectionEnd=h.dom.value.length;h.enter();await h.complete();
 h.type('3');assert.equal(h.dom.value,'3');
});
test('选户后再次聚焦仍全选展示地址，普通重渲染不重置手动选区',async()=>{
 const h=harness();h.begin();await h.complete();h.dom.blur();
 h.dom.selectionStart=h.dom.selectionEnd=h.dom.value.length;
 h.focus();assert.equal(h.dom.selectionStart,0);assert.equal(h.dom.selectionEnd,h.dom.value.length);
 h.dom.selectionStart=h.dom.selectionEnd=2;h.render();assert.equal(h.dom.selectionStart,2);
});
test('地址数据范围更新后旧请求不得选回已移除住户',async()=>{
 const h=harness();h.begin();const old=h.requests.at(-1);h.props.communities=[];h.render();
 old.resolve({houses:[h.hit],vehicles:[],accessCards:[]});await new Promise(r=>setImmediate(r));h.render();assert.equal(h.picked.length,0);
});
for(const mode of ['columns','submit'])for(const result of ['success','failure'])test(`改选小区使${mode}旧查询失效：${result}`,async()=>{
 const h=harness();h.props.communities.push({id:22,name:'张三小区乙',buildings:[{id:8,lane:null,buildingNo:'2',houses:[{id:11,roomNo:'201',ownerName:'张三'}]}]});
 if(mode==='columns')h.begin();else{h.render();h.focus();h.type('张三');h.enter()}
 const old=h.requests.at(-1);h.click('张三小区乙');const value=h.dom.value;
 if(result==='success')old.resolve({houses:[h.hit],vehicles:[],accessCards:[]});else old.reject(new Error('旧小区查询失败'));
 await new Promise(r=>setImmediate(r));h.render();assert.equal(h.picked.length,0);assert.equal(h.dom.value,value);assert.ok(!text(h.render()).includes('旧小区查询失败'));
});
for(const kind of ['new-input','new-selection','unmount','late-failure'])test(`姓名回车查询过期：${kind} 不得更新结果或触发旧户`,async()=>{
 const h=harness();h.render();h.focus();h.type('张三');h.enter();const old=h.requests.at(-1);
 if(kind==='new-input'){h.dom.select();h.type('李四')}
 if(kind==='new-selection'){h.dom.select();h.type('2/201');h.enter();await h.complete()}
 if(kind==='unmount')h.unmount();
 if(kind==='late-failure')h.clear();
 const previous=h.dom.value,picks=h.picked.length;
 if(kind==='late-failure')old.reject(new Error('旧查询失败'));else old.resolve({houses:[h.hit],vehicles:[],accessCards:[]});
 await new Promise(r=>setImmediate(r));h.render();assert.equal(h.dom.value,previous);assert.equal(h.picked.length,picks);assert.ok(!text(h.render()).includes('旧查询失败'));
});
test('新输入立即移除上一住户的可点击结果',async()=>{
 const h=harness();h.render();h.focus();h.type('张三');h.enter();
 await h.complete([{...h.hit,owner:{id:1,name:'原住户',phone:null}}]);
 h.type('李四');assert.ok(!text(h.render()).includes('原住户'));
});
test('清空后防抖查询迟到，不显示旧车牌结果',async()=>{
 const h=harness();h.render();h.focus();h.type('旧车');h.flushTimers();const old=h.requests.at(-1);
 h.clear();old.resolve({houses:[],vehicles:[{id:3,plateNo:'沪TEST123',houseId:9}],accessCards:[]});
 await new Promise(r=>setImmediate(r));assert.ok(!text(h.render()).includes('沪TEST123'));
});
test('姓名回车查询中清空，迟到唯一住户不得回填或选中',async()=>{
 const h=harness();h.render();h.focus();h.type('张三');h.enter();
 h.clear();await h.complete();assert.equal(h.dom.value,'');assert.equal(h.picked.length,0);
});
test('清空后点选请求迟到，不回填展示地址或触发选户',async()=>{
 const h=harness();h.render();h.focus();h.type('2/201');h.enter();
 h.clear();assert.equal(h.dom.value,'');await h.complete();
 assert.equal(h.dom.value,'');assert.equal(h.input().props.value,'');assert.equal(h.picked.length,0);
});
